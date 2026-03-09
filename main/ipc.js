const { ipcMain, dialog, shell } = require('electron')
const fs = require('fs/promises')
const path = require('path')
const ProjectManager = require('./project/ProjectManager')
const AgentLibrary = require('./project/AgentLibrary')
const PipelineRunner = require('./pipeline/PipelineRunner')
const AgentEditor = require('./editor/AgentEditor')
const Settings = require('./settings')
const { validateQwenAuth, configureQwenAuth, testQwenAuth, isOAuthEnabled, setOAuthEnabled, restoreQwenSettingsToOAuthDefaults } = require('./auth')
const CONSTANTS = require('./constants')
const ContextManager = require('./context/ContextManager')

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
  ipcMain.handle(CONSTANTS.IPC.AGENTS_LIST,       h(() => AgentLibrary.list()))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_GET,        h((agentId) => AgentLibrary.getById(agentId)))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_CREATE,     h((definition) => AgentLibrary.create(definition)))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_USAGE_COUNT, h((agentId) => AgentLibrary.usageCount(agentId)))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_UPDATE_REVIEW_TARGET, h(({ agentId, reviewTargetId }) => AgentLibrary.updateReviewTarget(agentId, reviewTargetId)))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_UPDATE_LOOP_CONFIG, h(({ agentId, loopType, maxRevisionLoops }) => AgentLibrary.updateLoopConfig(agentId, loopType, maxRevisionLoops)))
  ipcMain.handle(CONSTANTS.IPC.AGENTS_UPDATE_ROLE, h(({ agentId, role }) => AgentLibrary.updateRole(agentId, role)))

  // ── First Launch ─────────────────────────────────────────────────────────
  ipcMain.handle(CONSTANTS.IPC.FIRST_LAUNCH_CHECK, h(async () => {
    const isFirst = await Settings.isFirstLaunch()
    return { isFirst }
  }))

  ipcMain.handle(CONSTANTS.IPC.FIRST_LAUNCH_MARK_DONE, h(async () => {
    await Settings.markLaunched()
    return { ok: true }
  }))

  ipcMain.handle(CONSTANTS.IPC.FIRST_LAUNCH_CREATE_BOILERPLATE, h(async () => {
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
  ipcMain.handle('pipeline:start', h((args) => PipelineRunner.start(args.projectPath, args.resumeFrom, win)))
  ipcMain.handle('pipeline:pause',        h(() => PipelineRunner.pause()))
  ipcMain.handle('pipeline:resume',       h(() => PipelineRunner.resume()))
  ipcMain.handle('pipeline:abort',        h(() => PipelineRunner.abort()))
  ipcMain.handle('pipeline:update-steps', h(({ steps, projectPath }) => PipelineRunner.updateSteps(steps, projectPath)))
  ipcMain.handle('pipeline:skip-agent',   h(({ stepIndex, projectPath }) => PipelineRunner.skipAgent(stepIndex, projectPath)))
  ipcMain.handle('pipeline:unskip-agent', h(({ stepIndex, projectPath }) => PipelineRunner.unskipAgent(stepIndex, projectPath)))
  ipcMain.handle('agent:kill',            h(() => PipelineRunner.killCurrent()))
  ipcMain.handle('pipeline:has-run-before', h(({ projectPath }) => PipelineRunner.hasRunBefore(projectPath)))
  ipcMain.handle('pipeline:reset',        h(({ projectPath }) => PipelineRunner.reset(projectPath)))

  // ── Editor ───────────────────────────────────────────────────────────────
  ipcMain.handle('editor:open',           h(({ agentId }) => AgentEditor.open(agentId, win)))
  ipcMain.handle('editor:check-changes',  h(({ agentId }) => AgentEditor.checkForChanges(agentId)))
  ipcMain.handle('editor:confirm-changes',h(({ agentId }) => AgentEditor.confirmChanges(agentId, win)))
  ipcMain.handle('editor:cancel-changes', h(({ agentId }) => AgentEditor.cancelChanges(agentId)))

  // ── Context file I/O ─────────────────────────────────────────────────────
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_READ,              h((args) => ContextManager.read(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_LIST,              h((args) => ContextManager.list(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_WRITE,             h((args) => ContextManager.write(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_AGENT_OUTPUT_PATH, h((args) => ContextManager.agentOutputPath(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_OPEN_OUTPUT,       h((args) => ContextManager.openOutput(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_OPEN_AGENT_FILE,   h((args) => ContextManager.openAgentFile(args)))
  ipcMain.handle(CONSTANTS.IPC.CONTEXT_OPEN_BRIEF,        h((args) => ContextManager.openBrief(args)))

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
  ipcMain.handle('auth:get-settings', h(async () => {
    const { getAuthSettings } = require('./auth')
    return await getAuthSettings()
  }))
  ipcMain.handle(CONSTANTS.IPC.AUTH_OAUTH_ENABLED, h(async () => {
    const enabled = await isOAuthEnabled()
    return { enabled }
  }))
  ipcMain.handle(CONSTANTS.IPC.AUTH_SET_OAUTH_ENABLED, h((enabled) => setOAuthEnabled(enabled)))
  ipcMain.handle(CONSTANTS.IPC.AUTH_RESTORE_OAUTH_DEFAULTS, h(async () => restoreQwenSettingsToOAuthDefaults()))

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

  // ── External ─────────────────────────────────────────────────────────────
  ipcMain.handle('external:open', h((url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('Only https:// URLs may be opened externally')
    }
    return shell.openExternal(url)
  }))

  // ── QA MCP ───────────────────────────────────────────────────────────────
  // Re-register the Shift+S hotkey after the note overlay closes.
  ipcMain.on(CONSTANTS.IPC.QA_HOTKEY_REREGISTER, () => {
    const PipelineRunner = require('./pipeline/PipelineRunner')
    const { registerQaHotkey } = require('./qaHotkey')
    if (PipelineRunner.currentAgent && PipelineRunner.currentAgent.qaMcpRunner) {
      registerQaHotkey(win)
    }
  })

  // User clicked "Done — Write Report" (called from pipeline button).
  ipcMain.handle(CONSTANTS.IPC.QA_USER_DONE, h(async () => {
    const PipelineRunner = require('./pipeline/PipelineRunner')
    const agent = PipelineRunner.currentAgent
    if (!agent || !agent.qaMcpRunner) return { error: 'No active QA session' }
    agent.qaMcpRunner.signalUserDone()
    return { ok: true }
  }))

  // User clicked "All Good — Complete" (called from pipeline button).
  ipcMain.handle(CONSTANTS.IPC.QA_USER_ALL_GOOD, h(async () => {
    const PipelineRunner = require('./pipeline/PipelineRunner')
    const agent = PipelineRunner.currentAgent
    if (!agent || !agent.qaMcpRunner) return { error: 'No active QA session' }
    agent.qaMcpRunner.signalAllGood()
    return { ok: true }
  }))

  // User submitted note via Shift+S modal — captures screenshot with note atomically
  ipcMain.handle(CONSTANTS.IPC.QA_SUBMIT_NOTE, h(async ({ note }) => {
    const PipelineRunner = require('./pipeline/PipelineRunner')
    const agent = PipelineRunner.currentAgent
    if (!agent || !agent.qaMcpRunner) return { error: 'No active QA session' }
    agent.qaMcpRunner.captureWithNote(note || '')
    return { ok: true }
  }))

  // User cancelled note modal — just re-register hotkey
  ipcMain.on(CONSTANTS.IPC.QA_CANCEL_NOTE, () => {
    // Hotkey re-registered by renderer via qaHotkeyReregister
  })

  // QA Pre-flight dialog handlers
  ipcMain.on(CONSTANTS.IPC.QA_PREFLIGHT_READY, () => {})

  ipcMain.on(CONSTANTS.IPC.QA_PREFLIGHT_ABORT, () => {})

  ipcMain.on(CONSTANTS.IPC.QA_NO_FIXER_WARN_ACK, () => {})

  ipcMain.on(CONSTANTS.IPC.QA_INSTRUCTIONS_CONFIRM, (_, data) => {
    if (data && data.suppress && PipelineRunner.currentProjectPath) {
      ProjectManager.setQaInstructionsSeen(PipelineRunner.currentProjectPath)
        .catch(err => console.error('[ipc] Failed to set qaInstructionsSeen:', err.message))
    }
  })
}

module.exports = { registerIpcHandlers }
