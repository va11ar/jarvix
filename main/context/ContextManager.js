const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const { shell } = require('electron')

// Private — not exported. Called by read, list, and write to enforce path confinement.
function assertProjectPath(filePath, projectPath) {
  const resolved = path.resolve(filePath)
  const base = path.resolve(projectPath)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path outside project directory: ${filePath}`)
  }
}

// Retry logic for transient file locks — retries up to 3 times with 200ms delay
async function retryOpenPath(filePath, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await shell.openPath(filePath)
    } catch (e) {
      if (i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

// Timeout wrapper — rejects with file path if operation doesn't complete in time
const withTimeout = (promise, ms, filePath) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`File operation timed out after ${ms}ms: ${filePath}`)), ms)
    )
  ])

async function read({ filePath, projectPath }) {
  if (projectPath) assertProjectPath(filePath, projectPath)
  return fs.readFile(filePath, 'utf8').catch(() => '')
}

async function list({ dirPath, projectPath }) {
  if (projectPath) assertProjectPath(dirPath, projectPath)
  return fs.readdir(dirPath).catch(() => [])
}

async function write({ filePath, content, projectPath }) {
  if (projectPath) assertProjectPath(filePath, projectPath)
  await fs.writeFile(filePath, content, 'utf8')
  return { ok: true }
}

function agentOutputPath({ projectPath, agentFilePath }) {
  const outputFileName = path.basename(agentFilePath, '.md') + '.md'
  return path.join(projectPath, 'Context', outputFileName)
}

async function openOutput({ projectPath, agentFilePath }) {
  const outputFileName = path.basename(agentFilePath, '.md') + '.md'
  const outputPath = path.join(projectPath, 'Context', outputFileName)
  if (!fsSync.existsSync(outputPath)) {
    return { exists: false }
  }
  await shell.openPath(outputPath)
  return { exists: true, ok: true }
}

async function openAgentFile({ projectPath, agentFilePath }) {
  const agentFileName = path.basename(agentFilePath)
  const agentContextPath = path.join(projectPath, 'Context', agentFileName)
  if (!fsSync.existsSync(agentContextPath)) {
    return { exists: false }
  }
  try {
    await withTimeout(retryOpenPath(agentContextPath), 5000, agentContextPath)
    return { exists: true, ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

async function openBrief({ projectPath }) {
  const briefPath = path.join(projectPath, 'Context', 'brief.md')
  if (!fsSync.existsSync(briefPath)) {
    return { exists: false }
  }
  await shell.openPath(briefPath)
  return { exists: true, ok: true }
}

module.exports = { read, list, write, agentOutputPath, openOutput, openAgentFile, openBrief }
