#!/usr/bin/env node
'use strict'

const { Server }                      = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const http = require('http')
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js')
const net    = require('net')
const path   = require('path')
const crypto = require('crypto')

// ── Argument parsing ──────────────────────────────────────────────────────────
const argv        = process.argv.slice(2)
const projectPath = argv[argv.indexOf('--project-path') + 1]
if (!projectPath) {
  console.error('[QaMcpServer] --project-path is required')
  process.exit(1)
}

const port = parseInt(argv[argv.indexOf('--port') + 1], 10)
if (!port) {
  console.error('[QaMcpServer] --port is required')
  process.exit(1)
}

const screenshotsDir = path.join(projectPath, 'Context', 'screenshots')

// Socket path: cross-platform.
// On Windows, use a named pipe. On Unix, use a socket file.
const SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\jarvix-qa-' + crypto.randomUUID()
  : path.join(projectPath, '.jarvix-qa.sock')

// ── In-memory session store ───────────────────────────────────────────────────
const screenshots = []

// ── User-done coordination ────────────────────────────────────────────────────
let userDone    = false
let userAllGood = false
let doneResolve = null

function waitForUserDone() {
  if (userDone) return Promise.resolve({ allGood: userAllGood })
  return new Promise((resolve) => { doneResolve = resolve })
}

// ── Pending capture coordination ──────────────────────────────────────────────
// When the server needs a screenshot, it sends a capture-request to Jarvix and
// waits for a capture-done response. Only one capture can be in-flight at a time.
let pendingCaptureResolve = null
let pendingCaptureReject  = null
const CAPTURE_TIMEOUT_MS  = 10000

function requestCapture(note, flagged) {
  return new Promise((resolve, reject) => {
    pendingCaptureResolve = resolve
    pendingCaptureReject  = reject

    const timeout = setTimeout(() => {
      pendingCaptureResolve = null
      pendingCaptureReject  = null
      reject(new Error('Screenshot capture timed out — no response from Jarvix'))
    }, CAPTURE_TIMEOUT_MS)

    sendToJarvix({ type: 'capture-request', note: note || '', flagged: Boolean(flagged) })

    // Wrap resolve to also clear the timeout
    const originalResolve = pendingCaptureResolve
    pendingCaptureResolve = (entry) => {
      clearTimeout(timeout)
      originalResolve(entry)
    }
  })
}

// ── Unix socket server (Jarvix control channel) ───────────────────────────────
// Messages are newline-delimited JSON objects.
//
// Inbound (from Jarvix):
//   { type: 'user-done' }
//   { type: 'capture-done', filename, timestamp }
//   { type: 'capture-error', message }
//
// Outbound (to Jarvix):
//   { type: 'capture-request', note, flagged }
//   { type: 'screenshot-taken', filename, note, flagged, timestamp }
//
// NOTE: There is NO 'ready' message sent over the socket.
// QaMcpRunner learns the server is ready by polling for the .jarvix-qa-socket file,
// not by waiting for a socket message. Do not add a 'ready' send here.

let controlSocket = null   // The connected Jarvix socket, once it connects

function startSocketServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      controlSocket = socket
      let buffer = ''

      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()   // last element may be incomplete
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            handleControlMessage(JSON.parse(line))
          } catch (e) {
            console.error('[QaMcpServer] Bad control message:', line)
          }
        }
      })

      socket.on('error', (err) => {
        console.error('[QaMcpServer] Control socket error:', err.message)
      })

      socket.on('close', () => {
        controlSocket = null
      })
    })

    server.on('error', reject)

    server.listen(SOCKET_PATH, () => {
      resolve()
    })
  })
}

function sendToJarvix(msg) {
  if (controlSocket && !controlSocket.destroyed) {
    controlSocket.write(JSON.stringify(msg) + '\n')
  }
}

function handleControlMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return

  if (msg.type === 'user-all-good') {
    userDone    = true
    userAllGood = true
    if (doneResolve) {
      doneResolve({ allGood: true })
      doneResolve = null
    }
    return
  }

  if (msg.type === 'user-done') {
    userDone = true
    if (doneResolve) {
      doneResolve({ allGood: false })
      doneResolve = null
    }
    return
  }

  if (msg.type === 'capture-done') {
    // Check if this filename already exists (update case)
    const existingIndex = screenshots.findIndex(s => s.filename === msg.filename)
    
    const entry = {
      id:        existingIndex >= 0 ? screenshots[existingIndex].id : crypto.randomUUID(),
      filename:  msg.filename,
      filepath:  path.join(screenshotsDir, msg.filename),  // for reference only
      timestamp: msg.timestamp,
      note:      msg.note     || '',
      flagged:   Boolean(msg.flagged),
    }

    if (existingIndex >= 0) {
      // Update existing entry
      screenshots[existingIndex] = entry
    } else {
      // Add new entry
      screenshots.push(entry)
    }

    // Notify Jarvix UI so it can flash a confirmation
    sendToJarvix({
      type:      'screenshot-taken',
      filename:  entry.filename,
      note:      entry.note,
      flagged:   entry.flagged,
      timestamp: entry.timestamp,
    })

    if (pendingCaptureResolve) {
      const resolve = pendingCaptureResolve
      pendingCaptureResolve = null
      pendingCaptureReject  = null
      resolve(entry)
    }
    return
  }

  if (msg.type === 'capture-error') {
    if (pendingCaptureReject) {
      const reject = pendingCaptureReject
      pendingCaptureResolve = null
      pendingCaptureReject  = null
      reject(new Error(msg.message || 'Screenshot capture failed'))
    }
    return
  }

  // Legacy inbound: direct 'capture' trigger (Shift+S via hotkey path)
  // The hotkey path now goes through capture-request/capture-done,
  // but this handler is kept for safety. It does nothing — the capture
  // was already initiated by QaMcpRunner before sending this message.
}

// ── Path helper ───────────────────────────────────────────────────────────────
// Returns the path the agent uses in markdown image links.
// Always forward slashes — markdown renderers do not handle backslashes.
function relPath(filename) {
  return ['Context', 'screenshots', filename].join('/')
}

// ── MCP server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'jarvix-qa', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'qa_wait_for_user',
      description:
        'Block until the user signals they have finished testing by clicking ' +
        '"Done — Write Report" in Jarvix. ' +
        'ALWAYS call this tool first, before any other QA tool. ' +
        'Do not write the report or call qa_get_screenshots until this returns.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'qa_take_screenshot',
      description:
        'Capture a full-screen screenshot and store it with an optional note. ' +
        'Use this to document the state of the application at a specific moment.',
      inputSchema: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: 'Short description of what this screenshot shows.',
          },
        },
        required: [],
      },
    },
    {
      name: 'qa_get_screenshots',
      description:
        'Retrieve metadata for all screenshots captured during this session, ' +
        'including those flagged by the user via Shift+S. ' +
        'Use relativePath to reference screenshots in the markdown report.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'qa_get_flagged',
      description:
        'Retrieve only the screenshots the user explicitly flagged via Shift+S. ' +
        'Each entry includes the user\'s note. ' +
        'Treat these as the highest-priority items in the report.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params

  try {
    if (name === 'qa_wait_for_user') {
      const result = await waitForUserDone()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok:               true,
            allGood:          result.allGood,
            message:          result.allGood
              ? 'User confirmed all good. Write PIPELINE_STATUS: DONE | ISSUES: false to Context/qa-report.md and stop.'
              : 'User has finished testing. Proceed to retrieve screenshots and write the report.',
            totalScreenshots: screenshots.length,
            flaggedCount:     screenshots.filter(s => s.flagged).length,
          }),
        }],
      }
    }

    if (name === 'qa_take_screenshot') {
      const entry = await requestCapture(args.note || '', false)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok:           true,
            filename:     entry.filename,
            relativePath: relPath(entry.filename),
            timestamp:    entry.timestamp,
            note:         entry.note,
          }),
        }],
      }
    }

    if (name === 'qa_get_screenshots') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            screenshots.map(s => ({
              id:           s.id,
              filename:     s.filename,
              relativePath: relPath(s.filename),
              timestamp:    s.timestamp,
              note:         s.note,
              flagged:      s.flagged,
            }))
          ),
        }],
      }
    }

    if (name === 'qa_get_flagged') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            screenshots
              .filter(s => s.flagged)
              .map(s => ({
                id:           s.id,
                filename:     s.filename,
                relativePath: relPath(s.filename),
                timestamp:    s.timestamp,
                note:         s.note,
              }))
          ),
        }],
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    }

  } catch (err) {
    console.error(`[QaMcpServer] Tool "${name}" threw:`, err.message)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    }
  }
})

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  const fs = require('fs/promises')
  await fs.mkdir(screenshotsDir, { recursive: true })

  // Remove stale socket file from a previous crashed session (Unix only)
  if (process.platform !== 'win32') {
    await fs.unlink(SOCKET_PATH).catch(() => {})
  }

  // Start the Jarvix control socket first, before connecting MCP stdio.
  // This ensures the socket is ready before Jarvix tries to connect.
  await startSocketServer()

  // Start HTTP server for Streamable HTTP transport.
  // Qwen Code connects here. Jarvix does not use this channel.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => require('crypto').randomUUID(),
  })

  const httpServer = http.createServer(async (req, res) => {
    await transport.handleRequest(req, res)
  })

  await new Promise((resolve, reject) => {
    httpServer.on('error', (err) => {
      console.error('[QaMcpServer] HTTP server error:', err.message)
      reject(err)
    })
    httpServer.listen(port, '127.0.0.1', resolve)
  })

  // Log HTTP server details for debugging
  const httpAddress = httpServer.address()
  console.error('[QaMcpServer] HTTP server listening on:', httpAddress)

  // HTTP server is now listening. Write the socket info file to signal
  // that BOTH the Unix socket AND HTTP server are ready.
  // QaMcpRunner waits for this file before connecting.
  const socketInfoPath = path.join(projectPath, '.jarvix-qa-socket')
  await fs.writeFile(socketInfoPath, SOCKET_PATH, 'utf8')

  await server.connect(transport)
}

main().catch((err) => {
  console.error('[QaMcpServer] Fatal startup error:', err.message)
  process.exit(1)
})
