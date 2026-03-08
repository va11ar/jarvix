'use strict'

const { globalShortcut } = require('electron')

// Registers Shift+S for the duration of a QA session.
// The hotkey self-unregisters on each press to prevent double-triggering.
// When pressed, it sends 'qa:request-note' to the renderer, which shows
// a modal dialog for the user to enter a note before capturing.
// Pass win explicitly — do not rely on a global BrowserWindow reference.
function registerQaHotkey(win) {
  globalShortcut.register('Shift+S', () => {
    globalShortcut.unregister('Shift+S')
    win.webContents.send('qa:request-note')
  })
}

// Unregisters Shift+S. Safe to call when already unregistered.
function unregisterQaHotkey() {
  globalShortcut.unregister('Shift+S')
}

module.exports = { registerQaHotkey, unregisterQaHotkey }
