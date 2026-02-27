const { app, BrowserWindow } = require('electron')
const path = require('path')
const { registerIpcHandlers } = require('./ipc')
const ProjectManager = require('./project/ProjectManager')
const Checkpoint = require('./checkpoint/Checkpoint')
const Settings = require('./settings')

let win

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  registerIpcHandlers(win)

  // Forward focus events to renderer for editor change detection
  win.on('focus', () => win.webContents.send('window:focus'))
}

app.whenReady().then(async () => {
  createWindow()

  // Startup: validate Qwen auth settings
  const settings = await Settings.load()
  const authValid = await validateQwenAuth()
  if (!authValid) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('startup:auth-invalid')
    })
  }

  // Startup: detect incomplete runs across all known projects
  const projects = await ProjectManager.listAll()
  for (const project of projects) {
    const incomplete = await Checkpoint.detect(project.projectPath)
    if (incomplete) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('pipeline:incomplete-run-detected', {
          projectPath: project.projectPath,
          projectName: project.name,
          incompleteStep: incomplete.incompleteStep,
        })
      })
      break
    }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// If the window is closed while a pipeline is paused, _waitForResume() holds an
// unresolved Promise. The before-quit handler ensures abort() is called so the
// Promise resolves, the loop exits, and the process terminates cleanly.
app.on('before-quit', () => {
  const runner = require('./pipeline/PipelineRunner')
  if (runner.running) runner.abort()
})

// Validate that ~/.qwen/settings.json exists and has required fields
async function validateQwenAuth() {
  const fs = require('fs/promises')
  const os = require('os')
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.qwen', 'settings.json'), 'utf8')
    const s = JSON.parse(raw)
    const hasAuth = s?.security?.auth?.selectedType || s?.selectedType
    const hasModel = s?.model?.name || s?.modelProviders
    return !!(hasAuth && hasModel)
  } catch {
    return false
  }
}

module.exports = { getWin: () => win }
