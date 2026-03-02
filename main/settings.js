const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const { app } = require('electron')

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')

/**
 * Load application settings from userData/settings.json
 * @returns {Promise<{agentsDir?: string, hasLaunchedBefore?: string, qwenPath?: string}>}
 */
async function load() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    // File doesn't exist or is malformed — return defaults
    return {}
  }
}

/**
 * Save application settings to userData/settings.json
 * @param {Object} data - Settings data to save
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function save(data) {
  try {
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Check if this is the first launch of the app
 * @returns {Promise<boolean>}
 */
async function isFirstLaunch() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    const settings = JSON.parse(raw)
    return !settings.hasLaunchedBefore
  } catch {
    // File doesn't exist — this is the first launch
    return true
  }
}

/**
 * Mark the app as having been launched
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function markLaunched() {
  const settings = await load()
  settings.hasLaunchedBefore = true
  return save(settings)
}

/**
 * Check if Qwen CLI is installed and accessible
 * @param {string|null} customPath - Optional custom path to Qwen CLI
 * @returns {Promise<{installed: boolean, command: string, error?: string}>}
 */
async function checkQwenInstalled(customPath) {
  const command = customPath || 'qwen'
  
  try {
    // Use fsSync.existsSync to check if the path exists and is accessible
    // For a path like 'qwen' (not absolute), we need to check if it's in PATH
    if (path.isAbsolute(command)) {
      // If it's an absolute path, check directly
      if (fsSync.existsSync(command)) {
        return { installed: true, command }
      }
      return { installed: false, command, error: 'File not found' }
    }
    
    // For non-absolute paths, try to find the executable using process.env.PATH
    // We'll use a simple approach: try to spawn 'which' (Unix) or 'where' (Windows)
    const { spawnSync } = require('child_process')
    const isWindows = process.platform === 'win32'
    const result = spawnSync(isWindows ? 'where' : 'which', [command], { 
      encoding: 'utf8',
      timeout: 5000 
    })
    
    if (result.status === 0 && result.stdout.trim()) {
      return { installed: true, command }
    }
    
    return { installed: false, command, error: 'Command not found in PATH' }
  } catch (e) {
    return { installed: false, command, error: e.message }
  }
}

module.exports = { load, save, isFirstLaunch, markLaunched, checkQwenInstalled }
