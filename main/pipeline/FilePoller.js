const fs = require('fs/promises')
const { EventEmitter } = require('events')

/**
 * FilePoller — polls a file for a regex match and emits events
 * Extends EventEmitter to allow event-driven usage
 */
class FilePoller extends EventEmitter {
  constructor(filePath, pattern, intervalMs = 2000) {
    super()
    this.filePath = filePath
    this.pattern = pattern
    this.intervalMs = intervalMs
    this.intervalId = null
    this.lastSize = 0
    this.lastMatch = null
  }

  /**
   * Start polling
   */
  start() {
    if (this.intervalId) return

    // Initial check immediately
    this._checkFile()

    this.intervalId = setInterval(() => {
      this._checkFile()
    }, this.intervalMs)
  }

  /**
   * Check file for changes and pattern match
   * @private
   */
  async _checkFile() {
    try {
      const stat = await fs.stat(this.filePath)
      const newSize = stat.size

      // Read if file has grown OR if we haven't read it yet (initial check)
      if (newSize > this.lastSize || this.lastSize === 0) {
        const content = await fs.readFile(this.filePath, 'utf8')
        const match = this.pattern.exec(content)

        if (match) {
          const fullMatch = match[0]
          // Only emit if it's a new match (different from last)
          if (fullMatch !== this.lastMatch) {
            this.lastMatch = fullMatch
            this.emit('match', fullMatch, match)
          }
        }

        this.lastSize = newSize
      }
    } catch (e) {
      // File doesn't exist yet or read error — continue polling
      this.emit('error', e)
    }
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Get the last matched value
   * @returns {string|null}
   */
  getLastMatch() {
    return this.lastMatch
  }
}

/**
 * Create and start a file poller
 * @param {string} filePath - Path to file to poll
 * @param {RegExp} pattern - Regex pattern to match
 * @param {number} intervalMs - Polling interval in ms
 * @returns {FilePoller}
 */
function createPoller(filePath, pattern, intervalMs = 2000) {
  const poller = new FilePoller(filePath, pattern, intervalMs)
  poller.start()
  return poller
}

module.exports = { FilePoller, createPoller }
