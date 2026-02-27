const path = require('path')
const crypto = require('crypto')
const { PIPELINE_STATES, STEP_STATUSES, IPC } = require('../constants')
const Checkpoint = require('../checkpoint/Checkpoint')
const ActivityLog = require('./ActivityLog')
const AgentLibrary = require('../project/AgentLibrary')
const AgentProcess = require('./AgentProcess').AgentProcess

class PipelineRunner {
  constructor() {
    this.currentProjectPath = null
    this.currentWin = null
    this.state = PIPELINE_STATES.IDLE
    this.steps = []
    this.currentStepIndex = -1
    this.currentAgentProcess = null
    this.agentSnapshots = new Map() // agentId -> agent definition at pipeline start
    this.abortController = null
    this.pausePromise = null
    this.resumeCallback = null
  }

  /**
   * Start the pipeline
   * @param {string} projectPath - Project path
   * @param {number|null} resumeFrom - Step index to resume from, or null for fresh start
   * @param {BrowserWindow} win - BrowserWindow instance
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async start(projectPath, resumeFrom, win) {
    try {
      if (this.state === PIPELINE_STATES.RUNNING) {
        return { error: 'Pipeline already running' }
      }

      this.currentProjectPath = projectPath
      this.currentWin = win
      this.state = PIPELINE_STATES.RUNNING

      // Load pipeline configuration
      const pipelineJson = await require('fs/promises').readFile(
        path.join(projectPath, 'Pipeline', 'pipeline.json'),
        'utf8'
      )
      const pipeline = JSON.parse(pipelineJson)
      this.steps = pipeline.steps || []

      // Load all agent definitions into memory (snapshot at pipeline start)
      this.agentSnapshots.clear()
      for (const step of this.steps) {
        const agent = await AgentLibrary.getById(step.agent_id)
        if (agent) {
          this.agentSnapshots.set(step.agent_id, agent)
        }
      }

      // Determine starting step
      let startIndex = 0
      if (resumeFrom !== null && resumeFrom !== undefined) {
        startIndex = resumeFrom
      }

      // Create initial checkpoint
      const runId = new Date().toISOString()
      const projectJson = JSON.parse(
        await require('fs/promises').readFile(path.join(projectPath, 'project.json'), 'utf8')
      )
      const checkpointSteps = this.steps.map((step, i) => {
        const agent = this.agentSnapshots.get(step.agent_id)
        return {
          agent_id: step.agent_id,
          agent_name: agent?.name || 'Unknown',
          started_at: null,
          completed_at: null,
          status: i < startIndex ? STEP_STATUSES.COMPLETE : STEP_STATUSES.IDLE,
        }
      })

      await Checkpoint.save(projectPath, {
        run_id: runId,
        pipeline: projectJson.name,
        steps: checkpointSteps,
        revision_loop_count: 0,
      })

      // Log pipeline start
      await ActivityLog.append(projectPath, `Pipeline started — ${this.steps.length} agents queued`, 'start')

      // Notify renderer
      this._notifyStatus()

      // Start execution loop
      await this._runLoop(startIndex)

      return { ok: true }
    } catch (e) {
      this.state = PIPELINE_STATES.ERROR
      return { error: e.message }
    }
  }

  /**
   * Main execution loop
   * @param {number} startIndex - Step index to start from
   * @returns {Promise<void>}
   */
  async _runLoop(startIndex) {
    for (let i = startIndex; i < this.steps.length; i++) {
      if (this.abortController) {
        this.state = PIPELINE_STATES.IDLE
        return
      }

      // Check for pause
      if (this.pausePromise) {
        await this.pausePromise
      }

      this.currentStepIndex = i
      const step = this.steps[i]
      const agent = this.agentSnapshots.get(step.agent_id)

      if (!agent) {
        await ActivityLog.append(this.currentProjectPath, `Agent not found: ${step.agent_id}`, 'error')
        this.state = PIPELINE_STATES.ERROR
        return
      }

      // Update checkpoint
      await Checkpoint.updateStep(this.currentProjectPath, i, {
        status: STEP_STATUSES.RUNNING,
        started_at: new Date().toISOString(),
      })

      // Log agent start
      await ActivityLog.append(this.currentProjectPath, `${agent.name} started`, 'info')
      this._notifyStatus()

      // Get output file path
      const outputFileName = path.basename(agent.filePath, '.md') + '.md'
      const outputFilePath = path.join(this.currentProjectPath, 'Context', outputFileName)

      // Spawn agent
      this.currentAgentProcess = new AgentProcess(agent, this.currentProjectPath, outputFilePath, this.currentWin)
      const spawnResult = await this.currentAgentProcess.spawn()

      if (!spawnResult.ok) {
        await ActivityLog.append(this.currentProjectPath, `Failed to spawn agent: ${spawnResult.error}`, 'error')
        this.state = PIPELINE_STATES.ERROR
        await Checkpoint.updateStep(this.currentProjectPath, i, {
          status: STEP_STATUSES.ERROR,
          completed_at: new Date().toISOString(),
        })
        this._notifyStatus()
        return
      }

      // Wait for completion
      const result = await this.currentAgentProcess.waitForCompletion()

      // Settle (restore settings)
      const settleResult = await this.currentAgentProcess.settle()
      this.currentAgentProcess = null

      // Determine outcome
      let stepStatus = STEP_STATUSES.COMPLETE
      let logType = 'ok'

      if (settleResult.exitReason === 'timeout') {
        stepStatus = STEP_STATUSES.ERROR
        logType = 'warn'
        await ActivityLog.append(this.currentProjectPath, `${agent.name} timed out`, logType)
      } else if (settleResult.exitCode !== 0 && !settleResult.status) {
        stepStatus = STEP_STATUSES.ERROR
        logType = 'error'
        await ActivityLog.append(this.currentProjectPath, `${agent.name} exited with code ${settleResult.exitCode}`, logType)
      } else if (settleResult.status && settleResult.status.includes('ERROR')) {
        stepStatus = STEP_STATUSES.ERROR
        logType = 'error'
        const reason = settleResult.status.match(/REASON:\s*(.+)/)?.[1] || 'Unknown error'
        await ActivityLog.append(this.currentProjectPath, `${agent.name} error: ${reason}`, logType)
      } else if (settleResult.status && settleResult.status.includes('DONE')) {
        const hasIssues = settleResult.status.includes('ISSUES: true')
        if (hasIssues) {
          // Check if this is a revision agent
          if (agent.revision_target) {
            await ActivityLog.append(this.currentProjectPath, `${agent.name} — revision loop triggered`, 'warn')
            // Handle revision loop logic here if needed
          }
        }
        await ActivityLog.append(this.currentProjectPath, `${agent.name} completed`, logType)
      }

      // Update checkpoint
      await Checkpoint.updateStep(this.currentProjectPath, i, {
        status: stepStatus,
        completed_at: new Date().toISOString(),
      })

      this._notifyStatus()

      // Check for revision loop
      if (stepStatus === STEP_STATUSES.COMPLETE && settleResult.status?.includes('ISSUES: true')) {
        if (agent.revision_target) {
          // Find the revision target step
          const targetIndex = this.steps.findIndex(s => s.agent_id === agent.revision_target)
          if (targetIndex !== -1 && targetIndex < i) {
            const loopCount = await Checkpoint.incrementRevisionLoop(this.currentProjectPath)
            if (loopCount < agent.max_revision_loops) {
              // Jump back to revision target
              i = targetIndex - 1 // Will be incremented by for loop
              continue
            } else {
              await ActivityLog.append(this.currentProjectPath, `${agent.name} — max revision loops (${agent.max_revision_loops}) reached`, 'warn')
            }
          }
        }
      }

      if (stepStatus !== STEP_STATUSES.COMPLETE) {
        this.state = PIPELINE_STATES.ERROR
        return
      }
    }

    // Pipeline complete
    this.state = PIPELINE_STATES.COMPLETE
    await ActivityLog.append(this.currentProjectPath, 'Pipeline complete', 'ok')
    this._notifyStatus()
    this.currentStepIndex = -1
  }

  /**
   * Pause the pipeline at the next transition
   * @returns {Promise<void>}
   */
  async pause() {
    if (this.state !== PIPELINE_STATES.RUNNING) return

    this.state = PIPELINE_STATES.PAUSED
    this.pausePromise = new Promise((resolve) => {
      this.resumeCallback = resolve
    })
    this._notifyStatus()
  }

  /**
   * Resume a paused pipeline
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.state !== PIPELINE_STATES.PAUSED) return
    if (this.resumeCallback) {
      this.resumeCallback()
      this.resumeCallback = null
      this.pausePromise = null
    }
    this.state = PIPELINE_STATES.RUNNING
    this._notifyStatus()
  }

  /**
   * Abort the pipeline
   * @returns {Promise<void>}
   */
  async abort() {
    this.abortController = true
    if (this.currentAgentProcess) {
      await this.currentAgentProcess.kill()
      this.currentAgentProcess = null
    }
    if (this.resumeCallback) {
      this.resumeCallback()
      this.resumeCallback = null
      this.pausePromise = null
    }
    this.state = PIPELINE_STATES.IDLE
    this._notifyStatus()
  }

  /**
   * Kill the current running agent
   * @returns {Promise<void>}
   */
  async killCurrent() {
    if (this.currentAgentProcess) {
      await this.currentAgentProcess.kill()
      this.currentAgentProcess = null
    }
  }

  /**
   * Update pipeline steps (for mid-run modifications)
   * @param {Array} steps - New steps array
   * @returns {Promise<void>}
   */
  async updateSteps(steps) {
    this.steps = steps
    if (this.currentProjectPath) {
      const ProjectManager = require('../project/ProjectManager')
      await ProjectManager.updatePipeline(this.currentProjectPath, steps)
    }
  }

  /**
   * Notify renderer of status change
   */
  _notifyStatus() {
    if (!this.currentWin) return

    const checkpoint = {
      state: this.state,
      currentStepIndex: this.currentStepIndex,
      steps: this.steps.map((step, i) => ({
        ...step,
        agent_name: this.agentSnapshots.get(step.agent_id)?.name || 'Unknown',
      })),
    }

    this.currentWin.webContents.send(IPC.PIPELINE_STATUS, checkpoint)
  }

  /**
   * Check if pipeline is running
   * @returns {boolean}
   */
  get running() {
    return this.state === PIPELINE_STATES.RUNNING || this.state === PIPELINE_STATES.PAUSED
  }
}

// Export as singleton
module.exports = new PipelineRunner()
