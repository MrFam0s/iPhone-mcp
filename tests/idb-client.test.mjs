import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {IDBClient, selectBootedSimulator} from '../dist/idb/idb-client.js';
import {simulatorEnv} from '../dist/idb/simulator-env.js';
import {isPhysicalIOSDevice} from '../dist/wda/device-discovery.js';
import {regionToCommand} from '../dist/idb/ax-scan-client.js';
const UDID = '00000000-0000-4000-8000-000000000001';

async function fixture(t, options={}) {
  const root=await mkdtemp(join(tmpdir(),'mcp-idb-test-'));
  const record=join(root,'events.jsonl');
  const source=`#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2), record=${JSON.stringify(record)};
const log=value=>fs.appendFileSync(record,JSON.stringify(value)+'\\n');
if (args.includes('--grpc-domain-sock')) {
  log({kind:'companion',pid:process.pid,args,env:process.env});
  fs.writeFileSync(args[args.indexOf('--grpc-domain-sock')+1],'ready');
  setInterval(()=>{},1000);
} else {
  let input; if(args[0]?.endsWith('type-text.py')) { input='';for await(const chunk of process.stdin) input+=chunk; }
  log({kind:'start',pid:process.pid,args,env:process.env,input});
  if(input==='unsupported-fixture') process.exit(43);
  if(args.includes('777')) { console.error('private text must not leak'); process.exit(7); }
  if(args.includes('888')) { setInterval(()=>{},1000); }
  else {
    if(args.includes('999')) await new Promise(r=>setTimeout(r,180));
    log({kind:'end',args});
    if(args.includes('describe')) console.log(JSON.stringify({screen_dimensions:{width:1206,height:2622,width_points:402,height_points:874,density:3}}));
    else console.log('{}');
  }
}
`;
  const fake=join(root,'helper.mjs');await writeFile(fake,source,{mode:0o755});
  const client=new IDBClient(UDID,{idbPath:fake,companionPath:fake,pythonPath:fake,
    environment:{PATH:process.env.PATH,HOME:root,OPENAI_API_KEY:'test-only',PYTHONPATH:'test-only',IDB_SECRET:'test-only'},...options});
  t.after(async()=>{await client.shutdown();await rm(root,{recursive:true,force:true});});
  const events=async()=>existsSync(record)?(await readFile(record,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];
  return {client,events,root,fake};
}

test('ambiguous booted devices are rejected instead of selecting another project',()=>{
  const device=udid=>({udid,state:'Booted'});
  assert.equal(selectBootedSimulator({devices:{ios:[device(UDID)]}}),UDID);
  assert.throws(()=>selectBootedSimulator({devices:{ios:[device(UDID),device('other')]}}),/explicit udid/);
  assert.throws(()=>selectBootedSimulator({devices:{ios:[]}}),/No booted/);
});
test('credential and injection variables are omitted',()=>{
  assert.deepEqual(simulatorEnv({HOME:'/tmp',PATH:'/bin',OPENAI_API_KEY:'test-only',PYTHONPATH:'bad',DYLD_INSERT_LIBRARIES:'bad'}),{HOME:'/tmp',PATH:'/bin'});
});
test('real subprocess boundary uses private socket, exact device and safe environment',async t=>{
  const {client,events}=await fixture(t);await client.tap(1,2);
  const all=await events(),companion=all.find(x=>x.kind==='companion');
  assert.equal(all.filter(x=>x.kind==='companion').length,1);
  assert.deepEqual(companion.args.slice(0,4),['--udid',UDID,'--only','simulator']);
  const socket=companion.args.at(-1);assert.ok(socket.length<104);
  assert.equal((await stat(join(socket,'..'))).mode & 0o777,0o700);
  for(const event of all.filter(x=>x.env)) {
    assert.equal(event.env.OPENAI_API_KEY,undefined);assert.equal(event.env.PYTHONPATH,undefined);assert.equal(event.env.IDB_SECRET,undefined);
  }
  const command=all.find(x=>x.kind==='start').args;
  assert.deepEqual(command.slice(0,2),['--companion',socket]);
  assert.deepEqual(command.slice(-2),['--udid',UDID]);
  await client.shutdown();assert.equal(existsSync(join(socket,'..')),false);
});
test('action waits for acknowledgement and simultaneous calls share one companion',async t=>{
  const {client,events}=await fixture(t);
  let finished=false;const first=client.tap(999,2).then(()=>{finished=true});
  await delay(60);assert.equal(finished,false);
  await Promise.all([first,client.tap(3,4)]);
  const all=await events();assert.equal(all.filter(x=>x.kind==='companion').length,1);
  assert.deepEqual(all.filter(x=>x.kind!=='companion').map(x=>x.kind),['start','end','start','end']);
});
test('failed input is reported without sensitive diagnostics or automatic replay',async t=>{
  const {client,events}=await fixture(t);
  await assert.rejects(client.tap(777,2),error=>/exit 7/.test(error.message)&&!error.message.includes('private text'));
  assert.equal((await events()).filter(x=>x.kind==='start').length,1);
  await client.tap(1,2);assert.equal((await events()).filter(x=>x.kind==='companion').length,2);
});
test('timeout releases owned helpers and leaves unrelated processes alive',async t=>{
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>foreign.kill());
  const {client,events}=await fixture(t,{commandTimeoutMs:80});
  await assert.rejects(client.tap(888,2),/timed out/);
  assert.equal(foreign.exitCode,null);assert.equal(foreign.signalCode,null);
  const all=await events();assert.equal(all.filter(x=>x.kind==='start').length,1);
  assert.equal(all.some(x=>x.args.includes('kill')),false);
  assert.equal(existsSync(join(all.find(x=>x.kind==='companion').args.at(-1),'..')),false);
});
test('shutdown cancels running work and rejects queued and late input',async t=>{
  const {client,events}=await fixture(t);
  const pending=client.tap(888,2);const failure=assert.rejects(pending,/cancelled|closed/);
  while(!(await events()).some(x=>x.kind==='start')) await delay(20);
  const queued=assert.rejects(client.tap(3,4),/closed/);
  await client.shutdown();await failure;await queued;
  await assert.rejects(client.tap(5,6),/closed/);
  assert.equal((await events()).filter(x=>x.kind==='start').length,1);
});
test('text travels literally on stdin, never in process arguments',async t=>{
  const {client,events}=await fixture(t);const text='quotes " \' $HOME $(touch nope)\nnext';
  await client.inputText(text);
  const args=(await events()).find(x=>x.kind==='start').args;
  assert.equal((await events()).find(x=>x.kind==='start').input,text);
  assert.equal(args.includes(text),false);
});
test('unsupported text is an actionable failure and is never replayed',async t=>{
  const {client,events}=await fixture(t);
  await assert.rejects(client.inputText('unsupported-fixture'),/text was not sent: unsupported character or keyboard layout/);
  assert.equal((await events()).filter(x=>x.kind==='start').length,1);
});
test('mixed key sequence supports text and numeric HID codes in order',async t=>{
  const {client,events}=await fixture(t);await client.pressKeySequence(['ab',42,'c']);
  const args=(await events()).filter(x=>x.kind==='start').map(x=>x.input===undefined?x.args.slice(2,5):['ui','text',x.input]);
  assert.deepEqual(args,[['ui','text','ab'],['ui','key','42'],['ui','text','c']]);
});
test('screen dimensions come from companion points, independent of simulator name',async t=>{
  const {client}=await fixture(t);assert.deepEqual(await client.getScreenSize(),{width:402,height:874});
});
test('invalid UUID fails before launching any helper',async t=>{
  const {fake,events}=await fixture(t);const client=new IDBClient('invalid; touch nope',{idbPath:fake,companionPath:fake});
  await assert.rejects(client.tap(1,2),/Invalid/);await client.shutdown();assert.deepEqual(await events(),[]);
});
test('missing companion gives bounded startup failure',async t=>{
  const {client}=await fixture(t,{companionPath:'/nonexistent/blitz-companion',startupTimeoutMs:100});
  await assert.rejects(client.tap(1,2),/failed to start/);
});
test('scan region bounds retain correct bottom-right device coordinates',()=>{
  assert.deepEqual(regionToCommand('bottom-right',402,874,0),{grid_step:0,x_start:201,y_start:437,x_end:402,y_end:874});
});

test('fractional coordinates are rounded for the integer IDB CLI',async t=>{
  const {client,events}=await fixture(t);await client.tap(10.6,20.3);await client.swipe(1.2,2.9,3.6,4.1,0.3,5.8);
  const args=(await events()).filter(x=>x.kind==='start').map(x=>x.args);
  assert.deepEqual(args[0].slice(2,6),['ui','tap','11','20']);
  assert.deepEqual(args[1].slice(2,12),['ui','swipe','1','3','4','4','--duration','0.3','--delta','6']);
});

test('Xcode 27 simulated devicectl entries are never classified as physical USB phones',()=>{
  const base={hardwareProperties:{udid:'device-hardware-id',platform:'iOS',reality:'physical'},connectionProperties:{transportType:'wired'}};
  assert.equal(isPhysicalIOSDevice(base),true);
  assert.equal(isPhysicalIOSDevice({...base,hardwareProperties:{...base.hardwareProperties,reality:'simulated'}}),false);
  assert.equal(isPhysicalIOSDevice({...base,connectionProperties:{transportType:'sameMachine'}}),false);
  assert.equal(isPhysicalIOSDevice({...base,hardwareProperties:{...base.hardwareProperties,platform:'macOS'}}),false);
  assert.equal(isPhysicalIOSDevice({}),false);
});

test('MCP server exits promptly when its stdio client closes input',async t=>{
  const child=spawn(process.execPath,['dist/cli.js'],{stdio:['pipe','pipe','ignore'],env:simulatorEnv()});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const initialized=new Promise((resolve,reject)=>{
    let buffer='';
    child.stdout.on('data',data=>{
      buffer+=data;
      if(buffer.includes('\n')) { try {const message=JSON.parse(buffer.split('\n')[0]);assert.equal(message.result.serverInfo.version,'0.1.18-blitz.1');resolve()} catch(error){reject(error)} }
    });
    child.once('error',reject);
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  await Promise.race([initialized,delay(3000).then(()=>{throw new Error('initialize timeout')})]);
  child.stdin.end();
  const result=await Promise.race([exited,delay(2000).then(()=>{throw new Error('EOF cleanup timed out')})]);
  assert.equal(result.code,0);
});
