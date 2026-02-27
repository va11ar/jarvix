const fs = require('fs/promises')
const path = require('path')
const { app } = require('electron')

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')

/**
 * Load application settings from userData/settings.json
 * @returns {Promise<{agentsDir?: string, hasLaunchedBefore?: boolean}>}
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

module.exports = { load, save, isFirstLaunch, markLaunched }
