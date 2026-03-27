const fs = require('fs/promises')
const path = require('path')
const yaml = require('js-yaml')
const crypto = require('crypto')
const { app } = require('electron')

// UUID regex pattern for validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Check if a string is a valid UUID format
 * @param {string} str - String to validate
 * @returns {boolean}
 */
function isValidUuid(str) {
  return typeof str === 'string' && UUID_REGEX.test(str)
}

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

  if (!meta.name) throw new Error(`Agent file missing 'name' field: ${filePath}`)

  // If agent is missing UUID or has a placeholder/invalid UUID, assign a real one
  if (!meta.id || !isValidUuid(meta.id)) {
    await assignUuidIfMissing(filePath, raw, fmMatch, meta, prompt)
    meta.id = await readAssignedUuid(filePath)
  }

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
    // Agent role — 'producer' triggers pre-flight discovery and Output folder injection.
    // 'producer-reviewer' triggers Output folder injection for reviewers.
    // 'qa' triggers QA MCP integration.
    // 'fixer' triggers Fixer-specific pipeline behavior (runs after QA finds issues).
    // null or omitted = Regular agent (no special behavior).
    role: (meta.role === 'producer' || meta.role === 'producer-reviewer' || meta.role === 'qa' || meta.role === 'fixer') ? meta.role : null,
    prompt,
  }
}

/**
 * Assign a UUID to an agent file that is missing one
 * @param {string} filePath - Path to agent file
 * @param {string} raw - Original file content
 * @param {RegExpMatchArray} fmMatch - Front matter regex match
 * @param {Object} meta - Parsed YAML metadata
 * @param {string} prompt - Prompt body
 */
async function assignUuidIfMissing(filePath, raw, fmMatch, meta, prompt) {
  const id = crypto.randomUUID()
  meta.id = id

  // Rebuild front matter with the new ID
  const frontMatter = yaml.dump({
    id,
    name: meta.name,
    reads: meta.reads || [],
    review_target: meta.review_target || null,
    loop: meta.loop || null,
    timeout_seconds: meta.timeout_seconds || 300,
    allowedCommands: meta.allowedCommands || [],
    excludedCommands: meta.excludedCommands || [],
    role: meta.role || null,
  }).trim()

  // Preserve the original comment if present, otherwise add the standard comment
  const hasComment = fmMatch[1].includes('# DO NOT EDIT')
  const comment = hasComment ? '' : '# DO NOT EDIT — app identifier\n'
  const content = `---\n${comment}${frontMatter}\n---\n\n${prompt}`
  
  await fs.writeFile(filePath, content, 'utf8')
}

/**
 * Read the assigned UUID from an agent file after it has been written
 * @param {string} filePath - Path to agent file
 * @returns {Promise<string>}
 */
async function readAssignedUuid(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
  if (!fmMatch) throw new Error(`Agent file missing YAML front matter: ${filePath}`)
  const meta = yaml.load(fmMatch[1])
  return meta.id
}

/**
 * Create a new agent
 * @param {Object} definition - Agent definition
 * @returns {Promise<{id: string, filePath: string}>}
 */
async function create({ name, reads, review_target, loop, timeout_seconds, allowedCommands, excludedCommands, role, prompt }) {
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
    role: role || null,
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
async function createBoilerplate({ name, reads, review_target, loop, timeout_seconds, allowedCommands, excludedCommands, role, prompt }) {
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
    role: role || null,
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
 * @returns {Promise<{agents: Array, errors: Array}>}
 */
async function list() {
  const AGENTS_DIR = await getAgentsDir()
  await fs.mkdir(AGENTS_DIR, { recursive: true })
  const files = (await fs.readdir(AGENTS_DIR)).filter(f => f.endsWith('.md'))
  const agents = []
  const errors = []
  const idMap = new Map() // Track UUIDs to detect duplicates

  for (const file of files) {
    try {
      const agent = await parseAgentFile(path.join(AGENTS_DIR, file))

      // Check for duplicate UUIDs and fix them
      if (idMap.has(agent.id)) {
        // Duplicate UUID found — assign a new one to this agent
        const newId = crypto.randomUUID()
        await reassignUuid(agent.filePath, newId)
        agent.id = newId
        console.log(`Reassigned duplicate UUID for ${file}: ${newId}`)
      }
      idMap.set(agent.id, agent.filePath)

      agents.push(agent)
    } catch (e) {
      console.error(`Skipping malformed agent file: ${file}`, e.message)
      errors.push({ file, error: e.message })
    }
  }
  return { agents, errors }
}

/**
 * Reassign a UUID to an agent file
 * @param {string} filePath - Path to agent file
 * @param {string} newId - New UUID to assign
 */
async function reassignUuid(filePath, newId) {
  const raw = await fs.readFile(filePath, 'utf8')
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
  if (!fmMatch) throw new Error(`Agent file missing YAML front matter: ${filePath}`)

  const meta = yaml.load(fmMatch[1])
  const prompt = fmMatch[2].trim()

  // Update the ID
  meta.id = newId

  // Rebuild front matter with the new ID
  const frontMatter = yaml.dump({
    id: newId,
    name: meta.name,
    reads: meta.reads || [],
    review_target: meta.review_target || null,
    loop: meta.loop || null,
    timeout_seconds: meta.timeout_seconds || 300,
    allowedCommands: meta.allowedCommands || [],
    excludedCommands: meta.excludedCommands || [],
    role: meta.role || null,
  }).trim()

  const hasComment = fmMatch[1].includes('# DO NOT EDIT')
  const comment = hasComment ? '' : '# DO NOT EDIT — app identifier\n'
  const content = `---\n${comment}${frontMatter}\n---\n\n${prompt}`
  
  await fs.writeFile(filePath, content, 'utf8')
}

/**
 * Get agent by ID
 * @param {string} id - Agent ID
 * @returns {Promise<Object|null>}
 */
async function getById(id) {
  const all = await list()
  return all.agents.find(a => a.id === id) || null
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

/**
 * Update the review_target field in an agent's YAML file
 * @param {string} agentId - Agent ID to update
 * @param {string|null} reviewTargetId - UUID of the target agent (or null to clear)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function updateReviewTarget(agentId, reviewTargetId) {
  try {
    const agent = await getById(agentId)
    if (!agent) {
      return { error: 'Agent not found' }
    }

    const raw = await fs.readFile(agent.filePath, 'utf8')
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
    if (!fmMatch) {
      return { error: 'Agent file missing YAML front matter' }
    }

    const meta = yaml.load(fmMatch[1])
    const prompt = fmMatch[2].trim()

    // Update the review_target
    meta.review_target = reviewTargetId

    // Rebuild front matter with updated review_target
    const frontMatter = yaml.dump({
      id: meta.id,
      name: meta.name,
      reads: meta.reads || [],
      review_target: reviewTargetId || null,
      loop: meta.loop || null,
      timeout_seconds: meta.timeout_seconds || 300,
      allowedCommands: meta.allowedCommands || [],
      excludedCommands: meta.excludedCommands || [],
      role: meta.role || null,
    }).trim()

    const hasComment = fmMatch[1].includes('# DO NOT EDIT')
    const comment = hasComment ? '' : '# DO NOT EDIT — app identifier\n'
    const content = `---\n${comment}${frontMatter}\n---\n\n${prompt}`

    await fs.writeFile(agent.filePath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Update the loop.type and loop.max_revision_loops fields in an agent's YAML file
 * @param {string} agentId - Agent ID to update
 * @param {string|null} loopType - "revision", "iteration", or null for "None"
 * @param {number|null} maxRevisionLoops - Max loops for revision type (optional)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function updateLoopConfig(agentId, loopType, maxRevisionLoops) {
  try {
    const agent = await getById(agentId)
    if (!agent) {
      return { error: 'Agent not found' }
    }

    const raw = await fs.readFile(agent.filePath, 'utf8')
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
    if (!fmMatch) {
      return { error: 'Agent file missing YAML front matter' }
    }

    const meta = yaml.load(fmMatch[1])
    const prompt = fmMatch[2].trim()

    // Update loop configuration
    if (loopType === null || loopType === 'None') {
      // Set loop.type to null but keep the loop object structure
      meta.loop = { type: null }
    } else {
      // Set loop.type to the selected value
      meta.loop = {
        type: loopType,
      }
      // Only set max_revision_loops for revision type
      if (loopType === 'revision' && typeof maxRevisionLoops === 'number' && maxRevisionLoops > 0) {
        meta.loop.max_revision_loops = maxRevisionLoops
      }
    }

    // Rebuild front matter with updated loop config
    const frontMatter = yaml.dump({
      id: meta.id,
      name: meta.name,
      reads: meta.reads || [],
      review_target: meta.review_target || null,
      loop: meta.loop || null,
      timeout_seconds: meta.timeout_seconds || 300,
      allowedCommands: meta.allowedCommands || [],
      excludedCommands: meta.excludedCommands || [],
      role: meta.role || null,
    }).trim()

    const hasComment = fmMatch[1].includes('# DO NOT EDIT')
    const comment = hasComment ? '' : '# DO NOT EDIT — app identifier\n'
    const content = `---\n${comment}${frontMatter}\n---\n\n${prompt}`

    await fs.writeFile(agent.filePath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Update an agent's role field
 * @param {string} agentId - Agent ID
 * @param {string|null} role - Role value: 'producer', 'producer-reviewer', 'qa', or null
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function updateRole(agentId, role) {
  const agent = await getById(agentId)
  if (!agent) {
    return { error: 'Agent not found' }
  }

  try {
    const raw = await fs.readFile(agent.filePath, 'utf8')
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
    if (!fmMatch) {
      return { error: 'Agent file missing YAML front matter' }
    }

    const meta = yaml.load(fmMatch[1])
    const prompt = fmMatch[2].trim()

    // Update role field — null or omitted = Regular agent
    if (role === null || role === '' || role === 'null') {
      // Remove role field for Regular agents
      delete meta.role
    } else {
      meta.role = role
    }

    // Rebuild front matter
    const frontMatter = yaml.dump({
      id: meta.id,
      name: meta.name,
      reads: meta.reads || [],
      review_target: meta.review_target || null,
      loop: meta.loop || null,
      timeout_seconds: meta.timeout_seconds || 300,
      allowedCommands: meta.allowedCommands || [],
      excludedCommands: meta.excludedCommands || [],
      role: meta.role || null,
    }).trim()

    const hasComment = fmMatch[1].includes('# DO NOT EDIT')
    const comment = hasComment ? '' : '# DO NOT EDIT — app identifier\n'
    const content = `---\n${comment}${frontMatter}\n---\n\n${prompt}`

    await fs.writeFile(agent.filePath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Copy bundled agents from agent-samples/ to the user's Agents library
 * Only copies agents that don't already exist in the library (by name)
 * @returns {Promise<{ok: boolean, copied?: number, skipped?: number, error?: string}>}
 */
async function copyBundledAgentsToLibrary() {
  try {
    const fsSync = require('fs')
    const userAgentsDir = await getAgentsDir()

    // Ensure user agents directory exists
    await fs.mkdir(userAgentsDir, { recursive: true })

    // Determine bundled agents directory path
    // In development: app.getAppPath() returns the project root
    // In production: agent-samples should be copied to app resources
    let bundledAgentsDir = path.join(app.getAppPath(), 'agent-samples')
    
    // If not found, try the resources/app path (for packaged app)
    if (!fsSync.existsSync(bundledAgentsDir)) {
      bundledAgentsDir = path.join(process.resourcesPath, 'app', 'agent-samples')
    }

    // Check if bundled agents directory exists
    if (!fsSync.existsSync(bundledAgentsDir)) {
      return { error: 'Bundled agents directory not found' }
    }

    // Get list of bundled agent files
    const bundledFiles = await fs.readdir(bundledAgentsDir)
    const agentFiles = bundledFiles.filter(f => f.endsWith('.md'))

    // Get list of existing user agents (by name)
    const existingAgents = await list()
    const existingNames = new Set(existingAgents.map(a => a.name.toLowerCase()))

    let copied = 0
    let skipped = 0

    for (const file of agentFiles) {
      const bundledPath = path.join(bundledAgentsDir, file)
      const userPath = path.join(userAgentsDir, file)

      // Skip if agent with same name already exists
      const agentName = path.basename(file, '.md')
      if (existingNames.has(agentName.toLowerCase())) {
        skipped++
        continue
      }

      // Copy the file
      const content = await fs.readFile(bundledPath, 'utf8')
      await fs.writeFile(userPath, content, 'utf8')
      copied++
    }

    return { ok: true, copied, skipped }
  } catch (e) {
    return { error: e.message }
  }
}

module.exports = { parseAgentFile, create, createBoilerplate, list, getById, usageCount, updateReviewTarget, updateLoopConfig, updateRole, copyBundledAgentsToLibrary }
