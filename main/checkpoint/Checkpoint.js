const fs = require('fs/promises')
const path = require('path')
const { PIPELINE_STATES, STEP_STATUSES } = require('../constants')

/**
 * Get the checkpoint file path for a project
 * @param {string} projectPath - Project path
 * @returns {string}
 */
function getCheckpointPath(projectPath) {
  return path.join(projectPath, 'Pipeline', 'checkpoint.json')
}

/**
 * Load checkpoint for a project
 * @param {string} projectPath - Project path
 * @returns {Promise<Object|null>}
 */
async function load(projectPath) {
  try {
    const raw = await fs.readFile(getCheckpointPath(projectPath), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Save checkpoint for a project
 * @param {string} projectPath - Project path
 * @param {Object} data - Checkpoint data
 * @returns {Promise<void>}
 */
async function save(projectPath, data) {
  const checkpointPath = getCheckpointPath(projectPath)
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true })
  await fs.writeFile(checkpointPath, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Detect if there's an incomplete run for a project
 * @param {string} projectPath - Project path
 * @returns {Promise<{incompleteStep: Object}|null>}
 */
async function detect(projectPath) {
  const checkpoint = await load(projectPath)
  if (!checkpoint) return null

  // Find the first step that's not complete
  for (const step of checkpoint.steps) {
    if (step.status !== STEP_STATUSES.COMPLETE && step.status !== STEP_STATUSES.SKIPPED) {
      return { incompleteStep: step }
    }
  }
  return null
}

/**
 * Create initial checkpoint for a pipeline run
 * @param {string} projectPath - Project path
 * @param {string} runId - Unique run identifier
 * @param {string} pipelineName - Project/pipeline name
 * @param {Array} steps - Pipeline steps
 * @returns {Promise<void>}
 */
async function createInitial(projectPath, runId, pipelineName, steps) {
  const checkpoint = {
    run_id: runId,
    pipeline: pipelineName,
    steps: steps.map(step => ({
      agent_id: step.agent_id,
      agent_name: step.agent_name || 'Unknown',
      started_at: null,
      completed_at: null,
      status: STEP_STATUSES.IDLE,
    })),
    loop_counts: {}, // Per-agent loop counts: { agentId: count }
  }
  await save(projectPath, checkpoint)
}

/**
 * Update step status in checkpoint
 * @param {string} projectPath - Project path
 * @param {number} stepIndex - Step index
 * @param {Object} updates - Fields to update
 * @returns {Promise<void>}
 */
async function updateStep(projectPath, stepIndex, updates) {
  const checkpoint = await load(projectPath)
  if (!checkpoint) return

  if (checkpoint.steps[stepIndex]) {
    Object.assign(checkpoint.steps[stepIndex], updates)
    await save(projectPath, checkpoint)
  }
}

/**
 * Increment loop count for a specific reviewer agent
 * @param {string} projectPath - Project path
 * @param {string} agentId - The reviewer agent's ID
 * @returns {Promise<number>} - New count for this agent
 */
async function incrementLoopCount(projectPath, agentId) {
  const checkpoint = await load(projectPath)
  if (!checkpoint) return 0

  if (!checkpoint.loop_counts) {
    // Migrate from old single loop_count to per-agent loop_counts
    checkpoint.loop_counts = {}
    if (checkpoint.loop_count) {
      // Preserve old count for backward compatibility
      checkpoint.loop_counts.migrated = checkpoint.loop_count
    }
    delete checkpoint.loop_count
  }
  if (!checkpoint.loop_counts[agentId]) {
    checkpoint.loop_counts[agentId] = 0
  }
  checkpoint.loop_counts[agentId]++
  await save(projectPath, checkpoint)
  return checkpoint.loop_counts[agentId]
}

module.exports = { load, save, detect, createInitial, updateStep, incrementLoopCount }
