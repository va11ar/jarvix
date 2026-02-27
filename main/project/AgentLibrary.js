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
    revision_target: meta.revision_target || null,
    max_revision_loops: meta.max_revision_loops || 5,
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
async function create({ name, reads, revision_target, max_revision_loops, timeout_seconds, allowedCommands, excludedCommands, prompt }) {
  const AGENTS_DIR = await getAgentsDir()
  const id = crypto.randomUUID()
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filePath = path.join(AGENTS_DIR, `${safeName}.md`)

  const frontMatter = yaml.dump({
    id,
    name,
    reads: reads || [],
    revision_target: revision_target || null,
    max_revision_loops: max_revision_loops || 5,
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
async function createBoilerplate({ name, reads, revision_target, max_revision_loops, timeout_seconds, allowedCommands, excludedCommands, prompt }) {
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
    revision_target: revision_target || null,
    max_revision_loops: max_revision_loops || 5,
    timeout_seconds: timeout_seconds || 300,
    allowedCommands: allowedCommands || [],
    excludedCommands: excludedCommands || [],
  }).trim()

  // Boilerplate content with helpful comments
  const boilerplateContent = `# This is a boilerplate agent file created by JARVIX
# Replace the values below with your own configuration.
# Do not edit the 'id' field — it is used to track this agent across projects.

---
# DO NOT EDIT — app identifier
${frontMatter}
---

# Agent Prompt Instructions
# -------------------------
# Write your agent's prompt below. This is the instructions that will be
# given to the AI coding agent when it runs.
#
# The agent will:
# 1. Read the files listed in 'reads' from the Context/ folder
# 2. Execute the task described in your prompt
# 3. Write its output to Context/<agentname>.md
#
# The last line of the output file must be:
# PIPELINE_STATUS: DONE | ISSUES: false
# or
# PIPELINE_STATUS: DONE | ISSUES: true
# or
# PIPELINE_STATUS: ERROR | REASON: <description>
#
# Example prompt:
# "Read the project brief and architecture document. Implement the described
# system and write a summary to Context/programmer.md."

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
