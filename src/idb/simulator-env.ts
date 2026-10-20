// Older IDB companions print their launch environment. Pass only OS/tool paths.
export function simulatorEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'DEVELOPER_DIR'])
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key)))
}
