'use strict'

const { EventEmitter }    = require('events')
const { desktopCapturer } = require('electron')
const net                 = require('net')
const fs                  = require('fs/promises')
const path                = require('path')

// How long to wait for the socket file to appear after Qwen Code spawns the server
const CONNECT_TIMEOUT_MS = 60000
const CONNECT_POLL_MS    = 200

class QaMcpRunner extends EventEmitter {
  constructor(projectPath) {
    super()
    this.projectPath     = projectPath
    this._socket         = null
    this._socketInfoPath = path.join(projectPath, '.jarvix-qa-socket')
    this._screenshotsDir = path.join(projectPath, 'Context', 'screenshots')
    this._buffer         = ''
  }

  // Waits for QaMcpServer to write its socket path, then connects.
  // Resolves when the connection is established.
  // Rejects if CONNECT_TIMEOUT_MS passes without a connection.
  async connect() {
    const socketPath = await this._waitForSocketInfo()
    await this._connectToSocket(socketPath)
  }

  // Polls for the .jarvix-qa-socket file written by QaMcpServer on startup.
  async _waitForSocketInfo() {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        return (await fs.readFile(this._socketInfoPath, 'utf8')).trim()
      } catch {
        // File not written yet — keep polling
      }
      await new Promise(r => setTimeout(r, CONNECT_POLL_MS))
    }
    throw new Error(
      `QA MCP server did not start within ${CONNECT_TIMEOUT_MS / 1000} seconds`
    )
  }

  _connectToSocket(socketPath) {
    return new Promise((resolve, reject) => {
      this._socket = net.createConnection(socketPath)

      this._socket.once('connect', resolve)
      this._socket.once('error', reject)

      this._socket.on('data', (chunk) => {
        this._buffer += chunk.toString()
        const lines = this._buffer.split('\n')
        this._buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            this._handleMessage(JSON.parse(line))
          } catch (e) {
            // Ignore malformed messages
          }
        }
      })

      this._socket.on('error', (err) => {
        // Post-connect errors — log but do not crash
        console.error('[QaMcpRunner] Socket error:', err.message)
      })
    })
  }

  _handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'screenshot-taken') {
      // Bubble up to AgentProcess, which forwards to the renderer
      this.emit('screenshot-taken', {
        filename:  msg.filename,
        note:      msg.note,
        flagged:   msg.flagged,
        timestamp: msg.timestamp,
      })
      return
    }

    if (msg.type === 'capture-request') {
      // QaMcpServer needs a screenshot. Capture it here in the Electron main
      // process (which holds the macOS Screen Recording permission) and send
      // the result back over the socket.
      this._captureScreenshot(msg.note || '', Boolean(msg.flagged))
        .then((filename) => {
          this._send({
            type:      'capture-done',
            filename,
            timestamp: new Date().toISOString(),
            note:      msg.note   || '',
            flagged:   Boolean(msg.flagged),
          })
        })
        .catch((err) => {
          this._send({ type: 'capture-error', message: err.message })
        })
    }
  }

  // Uses Electron's desktopCapturer to take a full-screen PNG.
  // Saves to <projectPath>/Context/screenshots/ and returns the filename.
  async _captureScreenshot(note, flagged) {
    const timestamp = new Date().toISOString()
    const filename  = 'screenshot_' + timestamp.replace(/:/g, '-') + '.png'
    const filepath  = path.join(this._screenshotsDir, filename)

    await fs.mkdir(this._screenshotsDir, { recursive: true })

    // Get all screens. Use the first screen's thumbnail as the full-screen capture.
    // thumbnailSize drives resolution — use actual screen size for full quality.
    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width, height } = primaryDisplay.size

    const sources = await desktopCapturer.getSources({
      types:         ['screen'],
      thumbnailSize: { width, height },
    })

    if (!sources.length) {
      throw new Error('desktopCapturer returned no sources — Screen Recording permission may not be granted')
    }

    const png = sources[0].thumbnail.toPNG()
    await fs.writeFile(filepath, png)

    return filename
  }

  _send(msg) {
    if (this._socket && !this._socket.destroyed) {
      this._socket.write(JSON.stringify(msg) + '\n')
    }
  }

  // Signals the server to unblock qa_wait_for_user
  signalUserDone() {
    this._send({ type: 'user-done' })
  }

  // Signals the server to unblock qa_wait_for_user with allGood=true
  signalAllGood() {
    this._send({ type: 'user-all-good' })
  }

  // Requests a flagged screenshot with a note.
  // The actual capture happens here in QaMcpRunner; the server sends a
  // capture-request which triggers _handleMessage above.
  // For the Shift+S hotkey path, Wazear calls this directly — it triggers
  // the same capture-request/capture-done round-trip as agent tool calls.
  captureWithNote(note) {
    // Directly capture here (we are already in the main process) and send
    // capture-done back to the server so it stores the metadata.
    // The server responds with 'screenshot-taken' which triggers the event
    // via _handleMessage() — do not emit here or it will be duplicated.
    this._captureScreenshot(note || '', true)
      .then((filename) => {
        const timestamp = new Date().toISOString()
        this._send({
          type:      'capture-done',
          filename,
          timestamp,
          note:      note || '',
          flagged:   true,
        })
      })
      .catch((err) => {
        console.error('[QaMcpRunner] Hotkey capture failed:', err.message)
      })
  }

  // Closes the socket connection and removes the socket info file
  async disconnect() {
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    await fs.unlink(this._socketInfoPath).catch(() => {})
  }
}

module.exports = QaMcpRunner
