const fs = require('fs/promises')
const path = require('path')
const { shell, BrowserWindow } = require('electron')
const AgentLibrary = require('../project/AgentLibrary')

// In-memory snapshot of files being edited
const editSnapshots = new Map()

/**
 * Open an agent file in the system default editor
 * @param {string} agentId - Agent ID
 * @param {BrowserWindow} win - BrowserWindow instance
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function open(agentId, win) {
  try {
    const agent = await AgentLibrary.getById(agentId)
    if (!agent) {
      return { error: 'Agent not found' }
    }

    // Snapshot the current file state
    const stat = await fs.stat(agent.filePath)
    const content = await fs.readFile(agent.filePath, 'utf8')
    editSnapshots.set(agentId, {
      filePath: agent.filePath,
      mtimeMs: stat.mtimeMs,
      content,
    })

    // Open in system default editor
    await shell.openPath(agent.filePath)
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Check if an agent file has been modified since snapshot
 * @param {string} agentId - Agent ID
 * @returns {Promise<{changed: boolean, hasSnapshot: boolean, error?: string}>}
 */
async function checkForChanges(agentId) {
  try {
    const snapshot = editSnapshots.get(agentId)
    if (!snapshot) {
      return { changed: false, hasSnapshot: false }
    }

    const stat = await fs.stat(snapshot.filePath)
    if (stat.mtimeMs !== snapshot.mtimeMs) {
      // File was modified — check if content differs
      const currentContent = await fs.readFile(snapshot.filePath, 'utf8')
      return { changed: currentContent !== snapshot.content, hasSnapshot: true }
    }

    return { changed: false, hasSnapshot: true }
  } catch (e) {
    return { error: e.message, changed: false, hasSnapshot: false }
  }
}

/**
 * Confirm changes — reload agent definitions and reset pipeline
 * @param {string} agentId - Agent ID
 * @param {BrowserWindow} win - BrowserWindow instance
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function confirmChanges(agentId, win) {
  try {
    // Remove the snapshot — changes are accepted
    editSnapshots.delete(agentId)

    // Notify renderer that agent definition changed
    // The renderer will handle reloading and pipeline reset
    win.webContents.send('agent:definition-changed', { agentId })
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Cancel changes — restore file to snapshot state
 * @param {string} agentId - Agent ID
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function cancelChanges(agentId) {
  try {
    const snapshot = editSnapshots.get(agentId)
    if (!snapshot) {
      return { error: 'No snapshot found' }
    }

    // Restore the original content
    await fs.writeFile(snapshot.filePath, snapshot.content, 'utf8')
    editSnapshots.delete(agentId)
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

module.exports = { open, checkForChanges, confirmChanges, cancelChanges }
