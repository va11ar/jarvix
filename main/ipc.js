const { ipcMain, dialog, shell } = require('electron')
const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const ProjectManager = require('./project/ProjectManager')
const AgentLibrary = require('./project/AgentLibrary')
const PipelineRunner = require('./pipeline/PipelineRunner')
const AgentEditor = require('./editor/AgentEditor')
const Settings = require('./settings')
const { validateQwenAuth, configureQwenAuth, testQwenAuth } = require('./auth')
const CONSTANTS = require('./constants')

// Every handler follows the same pattern: async, try/catch, return { error } on failure.
const h = (fn) => async (_, ...args) => {
  try { return await fn(...args) } catch (e) { return { error: e.message } }
}

function registerIpcHandlers(win) {
  // ── Project ──────────────────────────────────────────────────────────────
  ipcMain.handle('project:create',       h((args) => ProjectManager.create(args)))
  ipcMain.handle('project:open',         h((folderPath) => ProjectManager.open(folderPath)))
  ipcMain.handle('project:validate',     h((folderPath) => ProjectManager.validate(folderPath)))
  ipcMain.handle('project:list',         h(() => ProjectManager.listAll()))
  ipcMain.handle('project:stack-defaults', h(() => ({
    stacks: CONSTANTS.STACK_DEFAULTS,
    hardcodedExclude: CONSTANTS.HARDCODED_EXCLUDE,
  })))

  // Native folder picker — returns selected path or null
  ipcMain.handle('dialog:open-folder', h(async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  }))

  // ── Agents ───────────────────────────────────────────────────────────────
  ipcMain.handle('agents:list',       h(() => AgentLibrary.list()))
  ipcMain.handle('agents:get',        h((agentId) => AgentLibrary.getById(agentId)))
  ipcMain.handle('agents:create',     h((definition) => AgentLibrary.create(definition)))
  ipcMain.handle('agents:usageCount', h((agentId) => AgentLibrary.usageCount(agentId)))

  // ── First Launch ─────────────────────────────────────────────────────────
  ipcMain.handle('first-launch:check', h(async () => {
    const isFirst = await Settings.isFirstLaunch()
    return { isFirst }
  }))

  ipcMain.handle('first-launch:mark-done', h(async () => {
    await Settings.markLaunched()
    return { ok: true }
  }))

  ipcMain.handle('first-launch:create-boilerplate', h(async () => {
    // Create a minimal boilerplate agent
    const definition = {
      name: 'MyAgent',
      reads: ['Context/brief.md'],
      review_target: null,
      loop: null,
      timeout_seconds: 300,
      allowedCommands: [],
      excludedCommands: [],
      prompt: '',
      isBoilerplate: true,
    }
    const result = await AgentLibrary.createBoilerplate(definition)
    if (result.error) return result
    // Open the agent in the default editor
    await shell.openPath(result.filePath)
    return { ok: true, agentId: result.id, filePath: result.filePath }
  }))

  // ── Pipeline ─────────────────────────────────────────────────────────────
  ipcMain.handle('pipeline:start',        h((args) => PipelineRunner.start(args.projectPath, args.resumeFrom, win)))
  ipcMain.handle('pipeline:pause',        h(() => PipelineRunner.pause()))
  ipcMain.handle('pipeline:resume',       h(() => PipelineRunner.resume()))
  ipcMain.handle('pipeline:abort',        h(() => PipelineRunner.abort()))
  ipcMain.handle('pipeline:update-steps', h(({ steps }) => PipelineRunner.updateSteps(steps)))
  ipcMain.handle('pipeline:skip-agent',   h(({ stepIndex, projectPath }) => PipelineRunner.skipAgent(stepIndex, projectPath)))
  ipcMain.handle('pipeline:unskip-agent', h(({ stepIndex, projectPath }) => PipelineRunner.unskipAgent(stepIndex, projectPath)))
  ipcMain.handle('agent:kill',            h(() => PipelineRunner.killCurrent()))

  // ── Editor ───────────────────────────────────────────────────────────────
  ipcMain.handle('editor:open',           h(({ agentId }) => AgentEditor.open(agentId, win)))
  ipcMain.handle('editor:check-changes',  h(({ agentId }) => AgentEditor.checkForChanges(agentId)))
  ipcMain.handle('editor:confirm-changes',h(({ agentId }) => AgentEditor.confirmChanges(agentId, win)))
  ipcMain.handle('editor:cancel-changes', h(({ agentId }) => AgentEditor.cancelChanges(agentId)))

  // ── Context file I/O ─────────────────────────────────────────────────────
  ipcMain.handle('context:read',  h(({ filePath }) => fs.readFile(filePath, 'utf8').catch(() => '')))
  ipcMain.handle('context:list',  h(({ dirPath }) => fs.readdir(dirPath).catch(() => [])))
  ipcMain.handle('context:write', h(async ({ filePath, content }) => {
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true }
  }))
  ipcMain.handle('context:agent-output-path', h(({ projectPath, agentFilePath }) => {
    const outputFileName = path.basename(agentFilePath, '.md') + '.md'
    return path.join(projectPath, 'Context', outputFileName)
  }))
  ipcMain.handle('context:open-output', h(async ({ projectPath, agentFilePath }) => {
    const outputFileName = path.basename(agentFilePath, '.md') + '.md'
    const outputPath = path.join(projectPath, 'Context', outputFileName)
    if (!fsSync.existsSync(outputPath)) {
      return { exists: false }
    }
    await shell.openPath(outputPath)
    return { exists: true, ok: true }
  }))

  // ── Settings ─────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', h(() => Settings.load()))
  ipcMain.handle('settings:set', h((data) => Settings.save(data)))

  // ── Authentication ───────────────────────────────────────────────────────
  ipcMain.handle('auth:check', h(async () => {
    const isValid = await validateQwenAuth()
    return { configured: isValid }
  }))
  ipcMain.handle('auth:configure', h((config) => configureQwenAuth(config)))
  ipcMain.handle('auth:test', h((config) => testQwenAuth(config)))

  // ── Qwen Installation ────────────────────────────────────────────────────
  ipcMain.handle('qwen:check-installed', h(async (customPath) => {
    const Settings = require('./settings')
    return await Settings.checkQwenInstalled(customPath)
  }))
  ipcMain.handle('qwen:browse-installation', h(async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Qwen CLI Installation Folder',
    })
    return result.canceled ? null : result.filePaths[0]
  }))
  ipcMain.handle('qwen:set-path', h(async (qwenPath) => {
    const settings = await Settings.load()
    settings.qwenPath = qwenPath
    return await Settings.save(settings)
  }))

  // Listen for Qwen dialog user response
  ipcMain.on('qwen:user-response', (event, response) => {
    // Forward to PipelineRunner via a handler set on the win object
    if (win && win.qwenResponseCallback) {
      win.qwenResponseCallback(response)
    }
  })

  // ── Window controls (custom frame) ────────────────────────────────────────
  ipcMain.handle('window:minimize', h(() => win.minimize()))
  ipcMain.handle('window:maximize', h(() => { win.isMaximized() ? win.unmaximize() : win.maximize() }))
  ipcMain.handle('window:close',    h(() => win.close()))
}

module.exports = { registerIpcHandlers }
