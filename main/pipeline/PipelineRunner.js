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

      // Set window reference for ActivityLog IPC notifications
      ActivityLog.setWindow(win)

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

      // Load existing checkpoint if it exists (to preserve skipped status)
      const existingCheckpoint = await Checkpoint.load(projectPath)

      // Create initial checkpoint (or update existing)
      const runId = new Date().toISOString()
      const projectJson = JSON.parse(
        await require('fs/promises').readFile(path.join(projectPath, 'project.json'), 'utf8')
      )
      const checkpointSteps = this.steps.map((step, i) => {
        const agent = this.agentSnapshots.get(step.agent_id)
        
        // Check if there's existing status from a previous run/skip
        let status = STEP_STATUSES.IDLE
        if (existingCheckpoint?.steps?.[i]) {
          // Preserve existing status (skipped, complete, error) from checkpoint
          const existingStatus = existingCheckpoint.steps[i].status
          if (existingStatus === STEP_STATUSES.SKIPPED || 
              existingStatus === STEP_STATUSES.COMPLETE || 
              existingStatus === STEP_STATUSES.ERROR) {
            status = existingStatus
          } else if (i < startIndex) {
            status = STEP_STATUSES.COMPLETE
          }
        } else if (i < startIndex) {
          status = STEP_STATUSES.COMPLETE
        }
        
        // Initialize step status in memory
        step.status = status
        return {
          agent_id: step.agent_id,
          agent_name: agent?.name || 'Unknown',
          started_at: null,
          completed_at: null,
          status: step.status,
        }
      })

      await Checkpoint.save(projectPath, {
        run_id: runId,
        pipeline: projectJson.name,
        steps: checkpointSteps,
        revision_loop_count: existingCheckpoint?.revision_loop_count || 0,
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

      // Skip agents marked as SKIPPED
      if (step.status === STEP_STATUSES.SKIPPED) {
        await ActivityLog.append(this.currentProjectPath, `${agent.name} skipped`, 'warn')
        await Checkpoint.updateStep(this.currentProjectPath, i, {
          status: STEP_STATUSES.SKIPPED,
          completed_at: new Date().toISOString(),
        })
        this._notifyStatus()
        continue
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

      // Update in-memory status
      this.steps[i].status = stepStatus

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
    console.log('[PipelineRunner] pause() called, current state:', this.state)
    if (this.state !== PIPELINE_STATES.RUNNING) {
      console.log('[PipelineRunner] pause() aborted: state is not RUNNING')
      return
    }

    this.state = PIPELINE_STATES.PAUSED
    this.pausePromise = new Promise((resolve) => {
      this.resumeCallback = resolve
    })
    console.log('[PipelineRunner] Pipeline paused, notifying renderer')
    this._notifyStatus()
  }

  /**
   * Resume a paused pipeline
   * @returns {Promise<void>}
   */
  async resume() {
    console.log('[PipelineRunner] resume() called, current state:', this.state)
    if (this.state !== PIPELINE_STATES.PAUSED) {
      console.log('[PipelineRunner] resume() aborted: state is not PAUSED')
      return
    }
    if (this.resumeCallback) {
      this.resumeCallback()
      this.resumeCallback = null
      this.pausePromise = null
    }
    this.state = PIPELINE_STATES.RUNNING
    console.log('[PipelineRunner] Pipeline resumed, notifying renderer')
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
    // After killing, pause the pipeline and notify renderer
    this.state = PIPELINE_STATES.PAUSED
    this._notifyStatus()
  }

  /**
   * Skip a specific agent by step index
   * @param {number} stepIndex - Index of the step to skip
   * @param {string} projectPath - Project path (optional, uses currentProjectPath if not provided)
   * @returns {Promise<{ok: boolean, error?: string, agentName?: string}>}
   */
  async skipAgent(stepIndex, projectPath) {
    // Can only skip when pipeline is NOT running (idle, paused, or complete)
    if (this.state === PIPELINE_STATES.RUNNING) {
      return { ok: false, error: 'Pipeline must not be running to skip an agent' }
    }

    const targetPath = projectPath || this.currentProjectPath

    // If steps not loaded (pipeline never started), load from disk
    if (this.steps.length === 0 && targetPath) {
      try {
        const fs = require('fs/promises')
        const pipelineJson = JSON.parse(
          await fs.readFile(require('path').join(targetPath, 'Pipeline', 'pipeline.json'), 'utf8')
        )
        this.steps = (pipelineJson.steps || []).map(step => ({
          ...step,
          status: STEP_STATUSES.IDLE,
        }))
        // Load agent snapshots
        this.agentSnapshots.clear()
        const AgentLibrary = require('../project/AgentLibrary')
        for (const step of this.steps) {
          const agent = await AgentLibrary.getById(step.agent_id)
          if (agent) this.agentSnapshots.set(step.agent_id, agent)
        }
      } catch (e) {
        return { ok: false, error: 'Failed to load pipeline configuration' }
      }
    }

    // Validate step index
    if (stepIndex < 0 || stepIndex >= this.steps.length) {
      return { ok: false, error: 'Invalid step index' }
    }

    const step = this.steps[stepIndex]

    // Can't skip already completed or skipped agents
    if (step.status === STEP_STATUSES.COMPLETE || step.status === STEP_STATUSES.ERROR) {
      return { ok: false, error: 'Cannot skip a completed agent' }
    }

    if (step.status === STEP_STATUSES.SKIPPED) {
      return { ok: false, error: 'Agent is already skipped' }
    }

    const agent = this.agentSnapshots.get(step.agent_id)

    // Update in-memory status
    step.status = STEP_STATUSES.SKIPPED

    // Initialize checkpoint if needed and update
    let checkpoint = await Checkpoint.load(targetPath)
    if (!checkpoint) {
      const fs = require('fs/promises')
      const projectJson = JSON.parse(
        await fs.readFile(require('path').join(targetPath, 'project.json'), 'utf8')
      )
      await Checkpoint.save(targetPath, {
        run_id: new Date().toISOString(),
        pipeline: projectJson.name,
        steps: this.steps.map(s => ({
          agent_id: s.agent_id,
          agent_name: this.agentSnapshots.get(s.agent_id)?.name || 'Unknown',
          started_at: null,
          completed_at: null,
          status: s.status || STEP_STATUSES.IDLE,
        })),
        revision_loop_count: 0,
      })
    } else {
      await Checkpoint.updateStep(targetPath, stepIndex, {
        status: STEP_STATUSES.SKIPPED,
        completed_at: new Date().toISOString(),
      })
    }

    // Log the skip
    const ActivityLog = require('./ActivityLog')
    await ActivityLog.append(targetPath, `${agent?.name || 'Unknown'} skipped`, 'warn')

    // Notify renderer if we have a window
    if (this.currentWin) {
      this._notifyStatus()
    }

    return { ok: true, agentName: agent?.name || 'Unknown' }
  }

  /**
   * Unskip a specific agent by step index
   * @param {number} stepIndex - Index of the step to unskip
   * @param {string} projectPath - Project path (optional, uses currentProjectPath if not provided)
   * @returns {Promise<{ok: boolean, error?: string, agentName?: string}>}
   */
  async unskipAgent(stepIndex, projectPath) {
    // Can only unskip when pipeline is NOT running (idle, paused, or complete)
    if (this.state === PIPELINE_STATES.RUNNING) {
      return { ok: false, error: 'Pipeline must not be running to unskip an agent' }
    }

    const targetPath = projectPath || this.currentProjectPath

    // If steps not loaded (pipeline never started), load from disk
    if (this.steps.length === 0 && targetPath) {
      try {
        const fs = require('fs/promises')
        const pipelineJson = JSON.parse(
          await fs.readFile(require('path').join(targetPath, 'Pipeline', 'pipeline.json'), 'utf8')
        )
        this.steps = (pipelineJson.steps || []).map(step => ({
          ...step,
          status: STEP_STATUSES.IDLE,
        }))
        // Load agent snapshots
        this.agentSnapshots.clear()
        const AgentLibrary = require('../project/AgentLibrary')
        for (const step of this.steps) {
          const agent = await AgentLibrary.getById(step.agent_id)
          if (agent) this.agentSnapshots.set(step.agent_id, agent)
        }
      } catch (e) {
        return { ok: false, error: 'Failed to load pipeline configuration' }
      }
    }

    // Validate step index
    if (stepIndex < 0 || stepIndex >= this.steps.length) {
      return { ok: false, error: 'Invalid step index' }
    }

    const step = this.steps[stepIndex]

    // Can only unskip skipped agents
    if (step.status !== STEP_STATUSES.SKIPPED) {
      return { ok: false, error: 'Agent is not skipped' }
    }

    const agent = this.agentSnapshots.get(step.agent_id)

    // Update in-memory status
    step.status = STEP_STATUSES.IDLE

    // Update checkpoint (create if doesn't exist)
    let checkpoint = await Checkpoint.load(targetPath)
    if (!checkpoint) {
      const fs = require('fs/promises')
      const projectJson = JSON.parse(
        await fs.readFile(require('path').join(targetPath, 'project.json'), 'utf8')
      )
      await Checkpoint.save(targetPath, {
        run_id: new Date().toISOString(),
        pipeline: projectJson.name,
        steps: this.steps.map(s => ({
          agent_id: s.agent_id,
          agent_name: this.agentSnapshots.get(s.agent_id)?.name || 'Unknown',
          started_at: null,
          completed_at: null,
          status: s.status || STEP_STATUSES.IDLE,
        })),
        revision_loop_count: 0,
      })
    } else {
      await Checkpoint.updateStep(targetPath, stepIndex, {
        status: STEP_STATUSES.IDLE,
        completed_at: null,
      })
    }

    // Log the unskip
    const ActivityLog = require('./ActivityLog')
    await ActivityLog.append(targetPath, `${agent?.name || 'Unknown'} unskipped`, 'info')

    // Notify renderer if we have a window
    if (this.currentWin) {
      this._notifyStatus()
    }

    return { ok: true, agentName: agent?.name || 'Unknown' }
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
        status: step.status || STEP_STATUSES.IDLE,
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
