const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Project
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  openProject: (folderPath) => ipcRenderer.invoke('project:open', folderPath),
  validateProject: (folderPath) => ipcRenderer.invoke('project:validate', folderPath),
  listProjects: () => ipcRenderer.invoke('project:list'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  getStackDefaults: () => ipcRenderer.invoke('project:stack-defaults'),

  // Agents
  listAgents: () => ipcRenderer.invoke('agents:list'),
  getAgent: (id) => ipcRenderer.invoke('agents:get', id),
  createAgent: (def) => ipcRenderer.invoke('agents:create', def),
  agentUsageCount: (id) => ipcRenderer.invoke('agents:usageCount', id),

  // First Launch
  checkFirstLaunch: () => ipcRenderer.invoke('first-launch:check'),
  markFirstLaunchDone: () => ipcRenderer.invoke('first-launch:mark-done'),
  createBoilerplateAgent: () => ipcRenderer.invoke('first-launch:create-boilerplate'),

  // Pipeline
  startPipeline: (projectPath, resumeFrom) => ipcRenderer.invoke('pipeline:start', { projectPath, resumeFrom }),
  pausePipeline: () => ipcRenderer.invoke('pipeline:pause'),
  resumePipeline: () => ipcRenderer.invoke('pipeline:resume'),
  abortPipeline: () => ipcRenderer.invoke('pipeline:abort'),
  updatePipelineSteps: (steps) => ipcRenderer.invoke('pipeline:update-steps', { steps }),
  skipNextAgent: () => ipcRenderer.invoke('pipeline:skip-next'),
  killAgent: () => ipcRenderer.invoke('agent:kill'),

  // Editor
  openAgentEditor: (agentId) => ipcRenderer.invoke('editor:open', { agentId }),
  checkAgentChanges: (agentId) => ipcRenderer.invoke('editor:check-changes', { agentId }),
  confirmAgentChanges: (agentId) => ipcRenderer.invoke('editor:confirm-changes', { agentId }),
  cancelAgentChanges: (agentId) => ipcRenderer.invoke('editor:cancel-changes', { agentId }),

  // Context file I/O
  readContextFile: (filePath) => ipcRenderer.invoke('context:read', { filePath }),
  contextListFiles: (dirPath) => ipcRenderer.invoke('context:list', { dirPath }),
  writeContextFile: (filePath, content) => ipcRenderer.invoke('context:write', { filePath, content }),
  getAgentOutputPath: (projectPath, agentFilePath) =>
    ipcRenderer.invoke('context:agent-output-path', { projectPath, agentFilePath }),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:set', data),

  // Authentication
  checkAuth: () => ipcRenderer.invoke('auth:check'),
  configureAuth: (config) => ipcRenderer.invoke('auth:configure', config),
  testAuth: (config) => ipcRenderer.invoke('auth:test', config),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // Main → Renderer push events
  onPipelineStatus: (cb) => ipcRenderer.on('pipeline:status', (_, data) => cb(data)),
  onAgentOutputUpdated: (cb) => ipcRenderer.on('agent:output-updated', (_, data) => cb(data)),
  onLogUpdated: (cb) => ipcRenderer.on('log:updated', (_, data) => cb(data)),
  onAgentDefinitionChanged: (cb) => ipcRenderer.on('agent:definition-changed', (_, data) => cb(data)),
  onIncompleteRunDetected: (cb) => ipcRenderer.on('pipeline:incomplete-run-detected', (_, data) => cb(data)),
  onWindowFocus: (cb) => ipcRenderer.on('window:focus', (_, data) => cb(data)),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
})
