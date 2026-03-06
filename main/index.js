const { app, BrowserWindow } = require('electron')
const path = require('path')
const { registerIpcHandlers } = require('./ipc')
const ProjectManager = require('./project/ProjectManager')
const Checkpoint = require('./checkpoint/Checkpoint')
const Settings = require('./settings')
const { validateQwenAuth } = require('./auth')

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

  // Block renderer-initiated navigation away from the app's local file
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  // Deny all programmatic new-window opens from renderer
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  registerIpcHandlers(win)

  // Forward focus events to renderer for editor change detection
  win.on('focus', () => win.webContents.send('window:focus'))
}

app.whenReady().then(async () => {
  createWindow()

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

module.exports = { getWin: () => win }
