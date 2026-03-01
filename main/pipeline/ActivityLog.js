const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const CONSTANTS = require('../constants')

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5 MB

// Reference to BrowserWindow for IPC notifications (set by PipelineRunner)
let currentWindow = null

// Track which projects have had a session marker added in this session
const sessionMarkersAdded = new Set()

/**
 * Set the window reference for IPC notifications
 * @param {import('electron').BrowserWindow} win
 */
function setWindow(win) {
  currentWindow = win
}

/**
 * Get the logs folder path for a project
 * @param {string} projectPath - Project path
 * @returns {string}
 */
function getLogsFolder(projectPath) {
  return path.join(projectPath, 'logs')
}

/**
 * Get the log.md file path for a project
 * @param {string} projectPath - Project path
 * @returns {string}
 */
function getLogPath(projectPath) {
  return path.join(getLogsFolder(projectPath), 'log.md')
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
 * Get current Unix timestamp
 * @returns {number}
 */
function getUnixTimestamp() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Check if log file exists and get its size
 * @param {string} logPath - Path to log file
 * @returns {Promise<number>} File size in bytes, or 0 if doesn't exist
 */
async function getLogFileSize(logPath) {
  try {
    const stats = await fs.stat(logPath)
    return stats.size
  } catch {
    return 0
  }
}

/**
 * Rotate log file if it exceeds max size
 * @param {string} projectPath - Project path
 * @returns {Promise<void>}
 */
async function rotateLogIfNeeded(projectPath) {
  const logPath = getLogPath(projectPath)
  const size = await getLogFileSize(logPath)

  if (size >= MAX_LOG_SIZE) {
    const timestamp = getUnixTimestamp()
    const archivedPath = path.join(getLogsFolder(projectPath), `log_${timestamp}.md`)
    await fs.rename(logPath, archivedPath)
  }
}

/**
 * Check if log file already has content from a previous session
 * and we haven't added a session marker for this session yet
 * @param {string} logPath - Path to log file
 * @param {string} projectPath - Project path (for tracking)
 * @returns {Promise<boolean>} True if session marker should be added
 */
async function checkSessionMarkerNeeded(logPath, projectPath) {
  // If we already added a session marker for this project, don't add another
  if (sessionMarkersAdded.has(projectPath)) {
    return false
  }
  
  // Check if file has content (from a previous session)
  try {
    const content = await fs.readFile(logPath, 'utf8')
    return content.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Append a log entry to log.md
 * @param {string} projectPath - Project path
 * @param {string} message - Log message
 * @param {'start'|'info'|'ok'|'warn'|'error'} type - Log type (determines CSS class)
 * @returns {Promise<{ time: string, message: string, type: string }>}
 */
async function append(projectPath, message, type = 'info') {
  const logPath = getLogPath(projectPath)
  const logsFolder = getLogsFolder(projectPath)

  // Ensure logs folder exists
  await fs.mkdir(logsFolder, { recursive: true })

  // Check if rotation is needed before writing
  await rotateLogIfNeeded(projectPath)

  const timestamp = formatTimestamp()
  const entry = `[${timestamp}] ${message}\n`

  // Check if we need to add a session marker (only once per session)
  const needsMarker = await checkSessionMarkerNeeded(logPath, projectPath)
  if (needsMarker) {
    const sessionMarker = `[New session -- ${getUnixTimestamp()}]\n\n`
    await fs.appendFile(logPath, sessionMarker, 'utf8')
    sessionMarkersAdded.add(projectPath)
  }

  // Write the log entry
  await fs.appendFile(logPath, entry, 'utf8')

  // Notify renderer if window is set
  if (currentWindow) {
    currentWindow.webContents.send(CONSTANTS.IPC.LOG_UPDATED, {
      time: timestamp,
      message,
      type,
    })
  }

  return { time: timestamp, message, type }
}

/**
 * Read the full log.md content
 * @param {string} projectPath - Project path
 * @returns {Promise<string>}
 */
async function read(projectPath) {
  try {
    return await fs.readFile(getLogPath(projectPath), 'utf8')
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

module.exports = { append, read, setWindow, LOG_TYPES }
