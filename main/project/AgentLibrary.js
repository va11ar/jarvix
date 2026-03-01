const fs = require('fs/promises')
const path = require('path')
const yaml = require('js-yaml')
const crypto = require('crypto')
const { app } = require('electron')

// AGENTS_DIR is resolved at call time — not at module load — so that the overridable
// agentsDir setting in settings.json is always respected.
async function getAgentsDir() {
  const Settings = require('../settings')
  const settings = await Settings.load()
  return settings.agentsDir || path.join(app.getPath('userData'), 'Agents')
}

/**
 * Parse an agent .md file with YAML front matter
 * @param {string} filePath - Path to agent file
 * @returns {Promise<Object>}
 */
async function parseAgentFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')

  // Front matter: content between first and second '---' line
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
  if (!fmMatch) throw new Error(`Agent file missing YAML front matter: ${filePath}`)

  const meta = yaml.load(fmMatch[1])
  const prompt = fmMatch[2].trim()

  if (!meta.id) throw new Error(`Agent file missing 'id' field: ${filePath}`)
  if (!meta.name) throw new Error(`Agent file missing 'name' field: ${filePath}`)

  return {
    id: meta.id,
    name: meta.name,
    filePath,
    reads: Array.isArray(meta.reads) ? meta.reads : [],
    review_target: meta.review_target || null,
    loop: meta.loop || null,
    timeout_seconds: meta.timeout_seconds || 300,
    allowedCommands: Array.isArray(meta.allowedCommands) ? meta.allowedCommands : [],
    excludedCommands: Array.isArray(meta.excludedCommands) ? meta.excludedCommands : [],
    prompt,
  }
}

/**
 * Create a new agent
 * @param {Object} definition - Agent definition
 * @returns {Promise<{id: string, filePath: string}>}
 */
async function create({ name, reads, review_target, loop, timeout_seconds, allowedCommands, excludedCommands, prompt }) {
  const AGENTS_DIR = await getAgentsDir()
  const id = crypto.randomUUID()
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filePath = path.join(AGENTS_DIR, `${safeName}.md`)

  const frontMatter = yaml.dump({
    id,
    name,
    reads: reads || [],
    review_target: review_target || null,
    loop: loop || null,
    timeout_seconds: timeout_seconds || 300,
    allowedCommands: allowedCommands || [],
    excludedCommands: excludedCommands || [],
  }).trim()

  const content = `---\n# DO NOT EDIT — app identifier\n${frontMatter}\n---\n\n${prompt || ''}`
  await fs.mkdir(AGENTS_DIR, { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  return { id, filePath }
}

/**
 * Create a boilerplate agent for first-time users
 * @param {Object} definition - Agent definition
 * @returns {Promise<{id: string, filePath: string, error?: string}>}
 */
async function createBoilerplate({ name, reads, review_target, loop, timeout_seconds, allowedCommands, excludedCommands, prompt }) {
  const AGENTS_DIR = await getAgentsDir()
  const id = crypto.randomUUID()
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  // Check for existing files and generate unique name
  await fs.mkdir(AGENTS_DIR, { recursive: true })
  const existingFiles = (await fs.readdir(AGENTS_DIR)).filter(f => f.endsWith('.md'))
  const existingNames = new Set(existingFiles.map(f => f.replace(/\.md$/, '')))

  let uniqueName = safeName
  let counter = 1
  while (existingNames.has(uniqueName)) {
    uniqueName = `${safeName}-${counter}`
    counter++
  }

  const filePath = path.join(AGENTS_DIR, `${uniqueName}.md`)

  const frontMatter = yaml.dump({
    id,
    name: name + (counter > 1 ? ` (${counter})` : ''),
    reads: reads || [],
    review_target: review_target || null,
    loop: loop || null,
    timeout_seconds: timeout_seconds || 300,
    allowedCommands: allowedCommands || [],
    excludedCommands: excludedCommands || [],
  }).trim()

  // Boilerplate content with helpful comments
  const boilerplateContent = `# JARVIX Agent Definition
# ========================
# id: DO NOT EDIT — used by Jarvix to track this agent across projects.
# name: Human-readable label shown in the pipeline UI.
#
# reads: List of Context/ files this agent reads as input.
#   Example: [architect.md, programmer.md]
#
# review_target: UUID of the agent this agent reviews (for review loops).
#   Set to null if this agent does not trigger review loops.
#
# loop: Configuration for review loop behavior. Only used if review_target is set.
#   type: "revision" (bounded loop with max_revision_loops) or "iteration" (unbounded)
#   max_revision_loops: Required only if type is "revision". Default: 5
#
# timeout_seconds: Time limit before Jarvix kills the agent and surfaces an error.
#   Default: 300
#
# allowedCommands: Shell commands this agent is permitted to run.
# excludedCommands: Shell commands this agent is explicitly blocked from running.

---
# DO NOT EDIT — app identifier
${frontMatter}
---

# Agent Prompt
# ============
# Write your agent's instructions below.
#
# WHAT TO INCLUDE — only what the agent cannot infer from reading the codebase:
#   - Its specific role and what it is responsible for outputting
#   - Non-obvious constraints or ordering requirements
#   - What it must NOT do
#
# WHAT TO OMIT — these increase cost and reduce agent performance (ICSE 2026):
#   - Architecture overviews or explanations of the codebase
#   - Descriptions of what good output looks like
#   - Anything the agent can discover by reading files itself
#
# OUTPUT: The agent must write its output to Context/<agentname>.md
#
# Jarvix automatically appends the required PIPELINE_STATUS signal to your prompt
# at runtime — you do not need to include it. For reference, the agent must write
# one of the following as the last line of its output file:
#
#   PIPELINE_STATUS: DONE | ISSUES: false
#   PIPELINE_STATUS: DONE | ISSUES: true
#   PIPELINE_STATUS: ERROR | REASON: <description>
`

  try {
    await fs.writeFile(filePath, boilerplateContent, 'utf8')
    return { id, filePath }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * List all agents
 * @returns {Promise<Array>}
 */
async function list() {
  const AGENTS_DIR = await getAgentsDir()
  await fs.mkdir(AGENTS_DIR, { recursive: true })
  const files = (await fs.readdir(AGENTS_DIR)).filter(f => f.endsWith('.md'))
  const agents = []
  for (const file of files) {
    try {
      const agent = await parseAgentFile(path.join(AGENTS_DIR, file))
      agents.push(agent)
    } catch (e) {
      console.error(`Skipping malformed agent file: ${file}`, e.message)
    }
  }
  return agents
}

/**
 * Get agent by ID
 * @param {string} id - Agent ID
 * @returns {Promise<Object|null>}
 */
async function getById(id) {
  const all = await list()
  return all.find(a => a.id === id) || null
}

/**
 * Count how many projects use this agent
 * Uses lazy require() to prevent circular dependency with ProjectManager
 * @param {string} agentId - Agent ID
 * @returns {Promise<number>}
 */
async function usageCount(agentId) {
  const ProjectManager = require('./ProjectManager')
  const projects = await ProjectManager.listAll()
  return projects.filter(p =>
    Array.isArray(p.steps) && p.steps.some(step => step.agent_id === agentId)
  ).length
}

module.exports = { parseAgentFile, create, createBoilerplate, list, getById, usageCount }
