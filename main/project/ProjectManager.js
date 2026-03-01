const fs = require('fs/promises')
const path = require('path')
const { app } = require('electron')
const { HARDCODED_EXCLUDE, STACK_DEFAULTS } = require('../constants')

const REGISTRY_PATH = path.join(app.getPath('userData'), 'projects-registry.json')

async function readRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function writeRegistry(registry) {
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8')
}

/**
 * Create a new project
 * @param {Object} args - Project creation arguments
 * @param {string} args.name - Project name
 * @param {string} args.folderPath - Parent folder path
 * @param {Array} args.steps - Pipeline steps
 * @param {Array} args.allowedCommands - Allowed shell commands
 * @param {string} args.brief - Project brief/description
 * @returns {Promise<{projectPath: string, projectJson: Object, pipelineJson: Object}>}
 */
async function create({ name, folderPath, steps, allowedCommands, brief }) {
  const projectPath = path.join(folderPath, name)
  await fs.mkdir(path.join(projectPath, 'Context'), { recursive: true })
  await fs.mkdir(path.join(projectPath, 'Pipeline'), { recursive: true })
  await fs.mkdir(path.join(projectPath, '.qwen'), { recursive: true })
  await fs.mkdir(path.join(projectPath, 'Output'), { recursive: true })

  // project.json — identity only
  const projectJson = { name, created: new Date().toISOString() }
  await fs.writeFile(
    path.join(projectPath, 'project.json'),
    JSON.stringify(projectJson, null, 2), 'utf8'
  )

  // pipeline.json — step configuration
  const pipelineJson = { steps: steps || [] }
  await fs.writeFile(
    path.join(projectPath, 'Pipeline', 'pipeline.json'),
    JSON.stringify(pipelineJson, null, 2), 'utf8'
  )

  // Context/brief.md — project description
  if (brief && brief.trim()) {
    await fs.writeFile(
      path.join(projectPath, 'Context', 'brief.md'),
      brief.trim(),
      'utf8'
    )
  }

  // .qwen/settings.json — project-level command whitelist
  const qwenSettings = {
    tools: {
      approvalMode: 'auto-edit',
      allowed: (allowedCommands || []).map(cmd => `run_shell_command(${cmd})`),
      exclude: HARDCODED_EXCLUDE,
    }
  }
  const qwenSettingsJson = JSON.stringify(qwenSettings, null, 2)
  await fs.writeFile(
    path.join(projectPath, '.qwen', 'settings.json'),
    qwenSettingsJson, 'utf8'
  )

  // .qwen/baseline.json — immutable copy of the user-approved baseline
  await fs.writeFile(
    path.join(projectPath, '.qwen', 'baseline.json'),
    qwenSettingsJson, 'utf8'
  )

  const registry = await readRegistry()
  if (!registry.includes(projectPath)) {
    registry.push(projectPath)
    await writeRegistry(registry)
  }

  return { projectPath, projectJson, pipelineJson }
}

/**
 * Open an existing project
 * @param {string} folderPath - Project folder path
 * @returns {Promise<{projectPath: string, projectJson: Object, pipelineJson: Object}>}
 */
async function open(folderPath) {
  try {
    const projectJson = JSON.parse(
      await fs.readFile(path.join(folderPath, 'project.json'), 'utf8')
    )
    const pipelineJson = JSON.parse(
      await fs.readFile(path.join(folderPath, 'Pipeline', 'pipeline.json'), 'utf8')
    )

    // Ensure Output folder exists (for projects created before Output was added)
    await fs.mkdir(path.join(folderPath, 'Output'), { recursive: true })

    // Crash recovery: if settings.json differs from baseline.json, restore from baseline
    try {
      const settingsPath = path.join(folderPath, '.qwen', 'settings.json')
      const baselinePath = path.join(folderPath, '.qwen', 'baseline.json')
      const [settingsRaw, baselineRaw] = await Promise.all([
        fs.readFile(settingsPath, 'utf8'),
        fs.readFile(baselinePath, 'utf8'),
      ])
      if (settingsRaw.trim() !== baselineRaw.trim()) {
        await fs.writeFile(settingsPath, baselineRaw, 'utf8')
      }
    } catch {
      // baseline.json missing or unreadable — leave settings.json as-is
    }

    const registry = await readRegistry()
    if (!registry.includes(folderPath)) {
      registry.push(folderPath)
      await writeRegistry(registry)
    }

    return { projectPath: folderPath, projectJson, pipelineJson }
  } catch (e) {
    throw new Error(`Failed to open project at "${folderPath}": ${e.message}`)
  }
}

/**
 * Validate a project folder
 * @param {string} folderPath - Project folder path
 * @returns {Promise<{valid: boolean}>}
 */
async function validate(folderPath) {
  try {
    await fs.access(path.join(folderPath, 'project.json'))
    await fs.access(path.join(folderPath, 'Pipeline', 'pipeline.json'))
    return { valid: true }
  } catch {
    return { valid: false }
  }
}

/**
 * List all known projects
 * @returns {Promise<Array>}
 */
async function listAll() {
  const registry = await readRegistry()
  const projects = []
  for (const p of registry) {
    try {
      const projectJson = JSON.parse(await fs.readFile(path.join(p, 'project.json'), 'utf8'))
      const pipelineJson = JSON.parse(await fs.readFile(path.join(p, 'Pipeline', 'pipeline.json'), 'utf8'))
      projects.push({ projectPath: p, ...projectJson, steps: pipelineJson.steps })
    } catch {
      // Project folder moved or deleted — skip silently
    }
  }
  return projects
}

/**
 * Update pipeline steps for a project
 * @param {string} projectPath - Project path
 * @param {Array} steps - New pipeline steps
 * @returns {Promise<void>}
 */
async function updatePipeline(projectPath, steps) {
  const filePath = path.join(projectPath, 'Pipeline', 'pipeline.json')
  await fs.writeFile(filePath, JSON.stringify({ steps }, null, 2), 'utf8')
}

module.exports = { create, open, validate, listAll, updatePipeline }
