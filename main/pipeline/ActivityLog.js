const fs = require('fs/promises')
const path = require('path')

/**
 * Get the monitor.md file path for a project
 * @param {string} projectPath - Project path
 * @returns {string}
 */
function getMonitorPath(projectPath) {
  return path.join(projectPath, 'Context', 'monitor.md')
}

/**
 * Format a timestamp for log entries
 * @param {Date} date - Date to format
 * @returns {string}
 */
function formatTimestamp(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

/**
 * Append a log entry to monitor.md
 * @param {string} projectPath - Project path
 * @param {string} message - Log message
 * @param {'start'|'info'|'ok'|'warn'|'error'} type - Log type (determines CSS class)
 * @returns {Promise<void>}
 */
async function append(projectPath, message, type = 'info') {
  const monitorPath = getMonitorPath(projectPath)
  const timestamp = formatTimestamp()
  const entry = `[${timestamp}] ${message}\n`

  await fs.mkdir(path.dirname(monitorPath), { recursive: true })
  await fs.appendFile(monitorPath, entry, 'utf8')
}

/**
 * Read the full monitor.md content
 * @param {string} projectPath - Project path
 * @returns {Promise<string>}
 */
async function read(projectPath) {
  try {
    return await fs.readFile(getMonitorPath(projectPath), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Log types with their CSS classes for the renderer
 */
const LOG_TYPES = {
  START: 'start',
  INFO: 'info',
  OK: 'ok',
  WARN: 'warn',
  ERROR: 'error',
}

module.exports = { append, read, LOG_TYPES }
