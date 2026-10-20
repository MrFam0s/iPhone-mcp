import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { simulatorEnv } from './simulator-env.js'

const execute = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function resolvePath(relative: string, fallback: string): string {
  for (const root of ['.blitz-iphone-mcp', '.blitz']) {
    const path = join(homedir(), root, relative)
    if (existsSync(path)) return path
  }
  return fallback
}

export function selectBootedSimulator(data: { devices: Record<string, {udid: string; state: string}[]> }): string {
  const devices = Object.values(data.devices).flat().filter(d => d.state === 'Booted')
  if (!devices.length) throw new Error('No booted simulator found')
  if (devices.length !== 1) throw new Error('Multiple simulators are booted; provide an explicit udid')
  return devices[0].udid
}

export async function resolveBootedUdid(): Promise<string> {
  const { stdout } = await execute('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'],
    { env: simulatorEnv(), timeout: 10000 })
  return selectBootedSimulator(JSON.parse(stdout))
}

function parseSimctlAppList(raw: string): { bundleId: string; name: string; type: 'System' | 'User' }[] {
  const apps: { bundleId: string; name: string; type: 'System' | 'User' }[] = []
  const entryRegex = /"([^"]+)"\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g
  let match
  while ((match = entryRegex.exec(raw)) !== null) {
    const bundleId = match[1]
    const block = match[2]
    const nameMatch = block.match(/CFBundleDisplayName\s*=\s*(?:"([^"]+)"|([^;]+));/)
    const typeMatch = block.match(/ApplicationType\s*=\s*(\w+);/)
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? bundleId).trim()
    const type = typeMatch?.[1] === 'User' ? 'User' : 'System'
    apps.push({ bundleId, name, type })
  }
  return apps
}

export interface IDBOptions {
  idbPath?: string
  companionPath?: string
  pythonPath?: string
  environment?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  commandTimeoutMs?: number
}

export class IDBClient {
  private static instances = new Map<string, IDBClient>()
  private companion: ChildProcess | null = null
  private directory: string | null = null
  private companionUdid: string | null = null
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  private controller = new AbortController()
  private readonly env: NodeJS.ProcessEnv
  private readonly idbPath: string
  private readonly companionPath: string
  private readonly pythonPath: string

  constructor(private udid: string, private options: IDBOptions = {}) {
    this.env = simulatorEnv(options.environment)
    this.idbPath = options.idbPath ?? resolvePath('python/bin/idb', 'idb')
    this.companionPath = options.companionPath ?? resolvePath('idb-companion/bin/idb_companion', 'idb_companion')
    this.pythonPath = options.pythonPath ?? resolvePath('python/bin/python3', 'python3')
  }

  static getInstance(udid = 'booted'): IDBClient {
    if (!this.instances.has(udid)) this.instances.set(udid, new IDBClient(udid))
    return this.instances.get(udid)!
  }

  private async resolvedUdid(): Promise<string> {
    if (this.closed) throw new Error('IDB client is closed')
    const udid = this.udid === 'booted' ? await resolveBootedUdid() : this.udid
    if (!UUID.test(udid)) throw new Error('Invalid simulator udid')
    return udid
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error('IDB client is closed')
      return operation()
    })
    this.queue = result.catch(() => {})
    return result
  }

  private async stopCompanion(): Promise<void> {
    const proc = this.companion
    const directory = this.directory
    this.companion = null
    this.companionUdid = null
    this.directory = null
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const stopped = new Promise<void>(resolve => proc.once('close', () => resolve()))
      proc.kill('SIGTERM')
      await Promise.race([stopped, delay(500)])
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
        await Promise.race([stopped, delay(500)])
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  }

  private async ensureCompanion(udid: string): Promise<string> {
    if (this.companionUdid === udid && this.companion?.exitCode === null && this.companion.signalCode === null && this.directory) {
      return join(this.directory, 'companion.sock')
    }
    await this.stopCompanion()
    if (this.closed) throw new Error('IDB client is closed')
    // Keep the UNIX socket well below macOS's short socket path limit.
    this.directory = await mkdtemp('/tmp/blitz-mcp-idb-')
    await chmod(this.directory, 0o700)
    if (this.closed) { await this.stopCompanion(); throw new Error('IDB client is closed') }
    const socket = join(this.directory, 'companion.sock')
    const proc = spawn(this.companionPath,
      ['--udid', udid, '--only', 'simulator', '--grpc-domain-sock', socket],
      { env: this.env, stdio: 'ignore' })
    this.companion = proc
    this.companionUdid = udid
    let spawnError = false
    proc.on('error', () => { spawnError = true })
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 10000)
    try {
      while (!existsSync(socket)) {
        if (this.closed) throw new Error('IDB client is closed')
        if (spawnError || proc.exitCode !== null || proc.signalCode !== null) throw new Error('IDB companion failed to start')
        if (Date.now() >= deadline) throw new Error('IDB companion startup timed out')
        await delay(50, undefined, { signal: this.controller.signal })
      }
      return socket
    } catch (error) {
      await this.stopCompanion()
      throw error
    }
  }

  private async run(args: string[], inputText?: string): Promise<string> {
    return this.serialize(async () => {
      const udid = await this.resolvedUdid()
      const socket = await this.ensureCompanion(udid)
      if (this.closed) throw new Error('IDB client is closed')
      try {
        // execFile preserves text literally; success requires a completed CLI
        // response. Never replay an uncertain input or invoke global `idb kill`.
        const pending = execute(inputText === undefined ? this.idbPath : this.pythonPath,
          inputText === undefined ? ['--companion', socket, ...args, '--udid', udid]
            : [fileURLToPath(new URL('./type-text.py', import.meta.url)), socket, udid],
          { env: this.env, timeout: this.options.commandTimeoutMs ?? 20000,
            signal: this.controller.signal, maxBuffer: 8 * 1024 * 1024,
            killSignal: 'SIGKILL' })
        if (inputText !== undefined) pending.child.stdin?.end(inputText, 'utf8')
        const { stdout } = await pending
        return stdout.trim()
      } catch (error) {
        await this.stopCompanion()
        const failure = error as { killed?: boolean; code?: unknown; name?: string }
        if (inputText !== undefined && failure.code === 43) {
          throw new Error('Simulator text was not sent: unsupported character or keyboard layout. Focus a text field with the German QWERTZ or US QWERTY keyboard; inspect the active layout before retrying.')
        }
        const reason = failure.name === 'AbortError' ? 'cancelled'
          : failure.killed ? 'timed out' : `failed (exit ${String(failure.code ?? 'unknown')})`
        // Node's execFile error includes the entire command and text. Do not
        // expose that, inherited environments, or raw subprocess diagnostics.
        throw new Error(`IDB ${args.slice(0, 2).join(' ')} ${reason}; action was not retried`)
      }
    })
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.controller.abort()
    await this.queue
    await this.stopCompanion()
    if (IDBClient.instances.get(this.udid) === this) IDBClient.instances.delete(this.udid)
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    await this.run(['ui', 'tap', String(Math.round(x)), String(Math.round(y)), ...durationArgs(duration), '--json'])
  }
  async swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number, delta?: number): Promise<void> {
    await this.run(['ui', 'swipe', ...[fromX, fromY, toX, toY].map(value => String(Math.round(value))), ...durationArgs(duration),
      ...(delta === undefined ? [] : ['--delta', String(Math.round(delta))]), '--json'])
  }
  async pressButton(button: 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'APPLE_PAY' | 'SIRI', duration?: number): Promise<void> {
    await this.run(['ui', 'button', button, ...durationArgs(duration), '--json'])
  }
  async inputText(text: string): Promise<void> {
    await this.run(['ui', 'text'], text)
  }
  async pressKey(key: number | string, duration?: number): Promise<void> {
    if (typeof key === 'string') return this.inputText(key)
    await this.run(['ui', 'key', String(key), ...durationArgs(duration), '--json'])
  }
  async pressKeySequence(keys: (number | string)[]): Promise<void> {
    // The CLI accepts numeric HID codes only; string entries represent text.
    for (const key of keys) await this.pressKey(key)
  }
  async describeAll(nested?: boolean): Promise<unknown> {
    return JSON.parse(await this.run(['ui', 'describe-all', '--json', ...(nested ? ['--nested'] : [])]))
  }
  async describePoint(x: number, y: number, nested?: boolean): Promise<unknown> {
    return JSON.parse(await this.run(['ui', 'describe-point', String(Math.round(x)), String(Math.round(y)),
      '--json', ...(nested ? ['--nested'] : [])]))
  }
  async getScreenSize(): Promise<{ width: number; height: number }> {
    const description = JSON.parse(await this.run(['describe', '--json']))
    const dimensions = description.screen_dimensions
    const width = dimensions?.width_points ?? dimensions?.width / dimensions?.density
    const height = dimensions?.height_points ?? dimensions?.height / dimensions?.density
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
      throw new Error('IDB did not return valid simulator screen dimensions')
    }
    return { width, height }
  }
  async screenshot(): Promise<Buffer> {
    const udid = await this.resolvedUdid()
    const directory = await mkdtemp('/tmp/blitz-mcp-image-')
    const file = join(directory, 'screen.png')
    try {
      await execute('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file],
        { env: this.env, timeout: 10000, signal: this.controller.signal })
      return await readFile(file)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  async listApps(): Promise<{ bundleId: string; name: string; type: 'System' | 'User' }[]> {
    const udid = await this.resolvedUdid()
    const { stdout } = await execute('xcrun', ['simctl', 'listapps', udid],
      { env: this.env, timeout: 10000, signal: this.controller.signal, maxBuffer: 8 * 1024 * 1024 })
    return parseSimctlAppList(stdout)
  }
  async launch(bundleId: string): Promise<void> {
    const udid = await this.resolvedUdid()
    await execute('xcrun', ['simctl', 'launch', udid, bundleId],
      { env: this.env, timeout: 10000, signal: this.controller.signal })
  }
  static async shutdownAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map(client => client.shutdown()))
  }
}
function durationArgs(duration?: number): string[] {
  return duration === undefined ? [] : ['--duration', String(duration)]
}
export function getIDBClient(udid = 'booted'): IDBClient { return IDBClient.getInstance(udid) }
export async function shutdownAllIDBClients(): Promise<void> { await IDBClient.shutdownAll() }
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { shutdownAllIDBClients().finally(() => process.exit(0)) })
}
