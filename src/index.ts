import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './mcp-server.js'
import { createViewerServer } from './viewer/server.js'
import { shutdownAllIDBClients } from './idb/idb-client.js'
import { log } from './logger.js'

const DEFAULT_VIEWER_PORT = 5150

export async function startServer(): Promise<void> {
  log('Server', 'log', 'Starting blitz-iphone-mcp...')

  let viewerPort = 0
  try {
    const { start } = createViewerServer()
    viewerPort = await start(DEFAULT_VIEWER_PORT)
    log('Server', 'log', `Viewer server listening on http://localhost:${viewerPort}`)
  } catch (e) {
    log('Server', 'warn', `Viewer server failed to start (non-fatal): ${e}`)
  }

  const server = createMcpServer(viewerPort)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stdin.once('end', () => { void server.close() })
  server.server.onclose = () => {
    // EOF must release this server's simulator helpers, even if its optional
    // viewer HTTP server would otherwise keep Node alive.
    void shutdownAllIDBClients().finally(() => process.exit(0))
  }

  log('Server', 'log', `MCP server running (stdio).${viewerPort ? ` Viewer at http://localhost:${viewerPort}` : ''}`)
}
