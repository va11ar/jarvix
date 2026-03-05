const path = require('path')
const crypto = require('crypto')
const { ipcMain } = require('electron')
const { PIPELINE_STATES, STEP_STATUSES, IPC, AGENT_ROLES } = require('../constants')
const Checkpoint = require('../checkpoint/Checkpoint')
const ActivityLog = require('./ActivityLog')
const AgentLibrary = require('../project/AgentLibrary')
const AgentProcess = require('./AgentProcess').AgentProcess
const { runDiscovery } = require('./CommandDiscovery')
const ProjectManager = require('../project/ProjectManager')
const Settings = require('../settings')
const { spawn } = require('child_process')
const fs = require('fs/promises')

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
    // Pre-flight discovery state per §8
    this.programmerStepIndex = null
    this.commandDiscoveryDone = false
    this.useSandboxMode = false
    this.discoveryCommands = null
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
      // Reset abort controller from any previous run
      this.abortController = null
      
      // Check state SYNCHRONOUSLY before any async operation to prevent race condition
      // This must happen before any await to ensure only one instance can start
      if (this.state === PIPELINE_STATES.RUNNING) {
        const ActivityLog = require('./ActivityLog')
        await ActivityLog.append(projectPath, 'Pipeline start blocked - pipeline already running', 'error')
        return { error: 'Pipeline already running' }
      }

      // Set state to RUNNING immediately (before any await) to block concurrent calls
      this.state = PIPELINE_STATES.RUNNING

      // Check if Qwen CLI is installed before starting
      const settings = await Settings.load()
      const qwenPath = settings.qwenPath || 'qwen'
      const qwenCheck = await Settings.checkQwenInstalled(qwenPath)

      // Qwen not found — show dialog and wait for response
      // State is already RUNNING, will be set to IDLE if user cancels
      if (!qwenCheck.installed) {
        // Send notification to renderer to show dialog
        win.webContents.send(IPC.QWEN_NOT_FOUND, { command: qwenCheck.command })

        // Wait for user response via callback
        return await new Promise((resolve) => {
          win.qwenResponseCallback = async (response) => {
            win.qwenResponseCallback = null

            if (response.action === 'cancel') {
              // User clicked OK without browsing - abort pipeline start
              this.state = PIPELINE_STATES.IDLE
              resolve({ error: 'Qwen CLI not found' })
              return
            }

            if (response.action === 'browse' && response.path) {
              // User browsed and selected a path
              // Save the path
              await Settings.save({ ...settings, qwenPath: response.path })

              // Re-check with the new path
              const recheck = await Settings.checkQwenInstalled(response.path)
              if (!recheck.installed) {
                // Still not found - show error and abort
                this.state = PIPELINE_STATES.IDLE
                resolve({ error: 'Selected path does not contain Qwen CLI' })
                return
              }

              // Path is valid - continue with pipeline start
              resolve(await this._continueStart(projectPath, resumeFrom, win))
              return
            }

            // Fallback - abort
            this.state = PIPELINE_STATES.IDLE
            resolve({ error: 'Qwen CLI not found' })
          }
        })
      }

      // Qwen is installed - continue with normal start
      return await this._continueStart(projectPath, resumeFrom, win)
    } catch (e) {
      this.state = PIPELINE_STATES.ERROR
      return { error: e.message }
    }
  }

  /**
   * Continue pipeline start after Qwen check passes
   * @param {string} projectPath - Project path
   * @param {number|null} resumeFrom - Step index to resume from, or null for fresh start
   * @param {BrowserWindow} win - BrowserWindow instance
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _continueStart(projectPath, resumeFrom, win) {
    try {
      this.currentProjectPath = projectPath
      this.currentWin = win
      // State is already set to RUNNING in start() — no need to set again

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

      // Find the first programmer step index per §3
      this.programmerStepIndex = null
      for (let i = 0; i < this.steps.length; i++) {
        const agent = this.agentSnapshots.get(this.steps[i].agent_id)
        if (agent && agent.role === AGENT_ROLES.PROGRAMMER) {
          this.programmerStepIndex = i
          await ActivityLog.append(this.currentProjectPath, `DEBUG: Found programmer agent at step index ${i} (${agent.name})`, 'warn')
          break
        }
      }
      if (this.programmerStepIndex === null) {
        await ActivityLog.append(this.currentProjectPath, 'DEBUG: No programmer agent found in pipeline', 'warn')
      }

      // Reset discovery state for this run
      this.commandDiscoveryDone = false
      this.useSandboxMode = false
      this.discoveryCommands = null

      // Determine starting step
      let startIndex = 0
      if (resumeFrom !== null && resumeFrom !== undefined) {
        startIndex = resumeFrom
      }

      // Load existing checkpoint if it exists (to preserve skipped status)
      const existingCheckpoint = await Checkpoint.load(projectPath)
      // Support both old loop_count and new loop_counts structure
      const legacyLoopCount = existingCheckpoint?.loop_count || 0
      const loopCounts = existingCheckpoint?.loop_counts || {}
      await ActivityLog.append(this.currentProjectPath, `Pipeline starting — legacy loop_count=${legacyLoopCount}, loop_counts=${JSON.stringify(loopCounts)}`, 'info')
      if (existingCheckpoint) {
        await ActivityLog.append(this.currentProjectPath, `Checkpoint loaded — ${existingCheckpoint.steps?.length || 0} steps`, 'info')
        // Log first few step statuses for debugging
        const statusSummary = (existingCheckpoint.steps || []).slice(0, 3).map(s => `${s.agent_name}:${s.status}`).join(', ')
        await ActivityLog.append(this.currentProjectPath, `Checkpoint step statuses: ${statusSummary}...`, 'info')
      }

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
        loop_counts: {}, // Fresh per-agent loop counts
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
    const ActivityLog = require('./ActivityLog')
    await ActivityLog.append(this.currentProjectPath, `_runLoop starting at index ${startIndex}, total steps: ${this.steps.length}`, 'info')
    
    for (let i = startIndex; i < this.steps.length; i++) {
      await ActivityLog.append(this.currentProjectPath, `_runLoop: iteration i=${i}, state=${this.state}, abortController=${!!this.abortController}`, 'info')
      
      if (this.abortController) {
        this.state = PIPELINE_STATES.IDLE
        await ActivityLog.append(this.currentProjectPath, '_runLoop: abort detected, exiting', 'warn')
        return
      }

      // Check for pause
      if (this.pausePromise) {
        await this.pausePromise
      }

      this.currentStepIndex = i
      const step = this.steps[i]
      const agent = this.agentSnapshots.get(step.agent_id)

      await ActivityLog.append(this.currentProjectPath, `DEBUG: Processing step ${i}, agent=${agent?.name}, role=${agent?.role}, programmerStepIndex=${this.programmerStepIndex}, commandDiscoveryDone=${this.commandDiscoveryDone}`, 'warn')

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

      // Pre-flight hook for programmer agent per §3 and §8
      if (i === this.programmerStepIndex && !this.commandDiscoveryDone) {
        const preflightResult = await this._runPreflight(agent)
        this.commandDiscoveryDone = true
        await ActivityLog.append(this.currentProjectPath, `Pre-flight completed`, 'info')

        if (preflightResult.aborted) {
          // User declined and aborted in State E
          this.state = PIPELINE_STATES.IDLE
          await ActivityLog.append(this.currentProjectPath, 'Pipeline aborted — user declined command approval at programmer pre-flight', 'warn')
          return
        }

        if (preflightResult.error) {
          await ActivityLog.append(this.currentProjectPath, `Pre-flight error: ${preflightResult.error}`, 'error')
          this.state = PIPELINE_STATES.ERROR
          return
        }
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

      // Clear output file before spawning (important for review loops - prevents stale status detection)
      try {
        await require('fs/promises').unlink(outputFilePath)
      } catch {
        // File doesn't exist - that's fine
      }

      // Spawn agent — use sandbox mode if pre-flight selected it
      // Also check if OAuth is enabled
      const settings = await Settings.load()
      const oauthEnabled = !!settings.oauthEnabled
      
      this.currentAgentProcess = new AgentProcess(
        agent,
        this.currentProjectPath,
        outputFilePath,
        this.currentWin,
        this.useSandboxMode,
        oauthEnabled
      )
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
          // Check if this is a review agent
          if (agent.review_target) {
            await ActivityLog.append(this.currentProjectPath, `${agent.name} — review loop triggered`, 'warn')
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

      // Check for review loop
      if (stepStatus === STEP_STATUSES.COMPLETE && settleResult.status?.includes('ISSUES: true')) {
        if (agent.review_target && agent.loop && agent.loop.type) {
          // Find the review target step
          const targetIndex = this.steps.findIndex(s => s.agent_id === agent.review_target)
          const loopCount = await Checkpoint.incrementLoopCount(this.currentProjectPath, agent.id)
          await ActivityLog.append(this.currentProjectPath, `LOOP DEBUG: reviewer=${agent.name}, targetIndex=${targetIndex}, currentStepIndex=${i}, loopCount=${loopCount}`, 'warn')
          if (targetIndex !== -1 && targetIndex < i) {
            const isRevision = agent.loop.type === 'revision'
            const maxLoops = isRevision ? (agent.loop.max_revision_loops || 5) : Infinity

            if (isRevision && loopCount >= maxLoops) {
              await ActivityLog.append(this.currentProjectPath, `${agent.name} — max review loops (${maxLoops}) reached`, 'warn')
              // Emit max-loops-reached state to renderer (include loopCount for display)
              if (this.currentWin) {
                this.currentWin.webContents.send(IPC.PIPELINE_STATUS, {
                  state: 'max-loops-reached',
                  agentId: agent.id,
                  loopCount,
                  maxLoops: isRevision ? maxLoops : undefined,
                  loopType: agent.loop.type,
                })
              }
            } else {
              // Emit review-loop state to renderer
              if (this.currentWin) {
                this.currentWin.webContents.send(IPC.PIPELINE_STATUS, {
                  state: 'review-loop',
                  agentId: agent.id,
                  loopType: agent.loop.type,
                  loopCount,
                  maxLoops: isRevision ? maxLoops : undefined,
                })
              }
              await ActivityLog.append(this.currentProjectPath, `LOOP DEBUG: Jumping back to step ${targetIndex} (${this.steps[targetIndex].agent_name})`, 'warn')
              // Jump back to review target
              i = targetIndex - 1 // Will be incremented by for loop
              // Notify renderer of the jump so highlight shows on target
              this._notifyStatus()
              continue
            }
          } else {
            await ActivityLog.append(this.currentProjectPath, `LOOP DEBUG: targetIndex=${targetIndex}, i=${i}, condition=${targetIndex !== -1 && targetIndex < i}`, 'warn')
          }
        } else {
          await ActivityLog.append(this.currentProjectPath, `LOOP DEBUG: agent.review_target=${agent.review_target}, agent.loop=${JSON.stringify(agent.loop)}`, 'warn')
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
    if (this.state !== PIPELINE_STATES.RUNNING) {
      return
    }

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
    if (this.state !== PIPELINE_STATES.PAUSED) {
      return
    }
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
    this.currentStepIndex = -1 // Reset so UI doesn't show stale "running" state
    this.abortController = null // Reset for next run
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
    this.currentStepIndex = -1 // Reset so UI doesn't show stale "running" state
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
        loop_counts: {},
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
        loop_counts: {},
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
   * @param {string|null} projectPath - Optional project path (uses currentProjectPath if not provided)
   * @returns {Promise<void>}
   */
  async updateSteps(steps, projectPath = null) {
    this.steps = steps
    const savePath = projectPath || this.currentProjectPath
    if (savePath) {
      const ProjectManager = require('../project/ProjectManager')
      await ProjectManager.updatePipeline(savePath, steps)
    }
  }

  /**
   * Run the pre-flight discovery flow before the programmer agent spawns
   * Per §5 (States A through F) and §6
   * @param {Object} programmerAgent - The programmer agent snapshot
   * @returns {Promise<{aborted?: boolean, error?: string, sandbox?: boolean}>}
   */
  async _runPreflight(programmerAgent) {
    const projectPath = this.currentProjectPath
    const win = this.currentWin

    await ActivityLog.append(projectPath, `_runPreflight started for agent ${programmerAgent.name}`, 'warn')

    try {
      // State B — Show choice modal FIRST (before discovery runs)
      win.webContents.send(IPC.DISCOVERY_COMPLETE, { delta: [] })

      // Wait for user choice
      const choice = await new Promise((resolve) => {
        const cleanup = () => {
          ipcMain.removeListener('discovery:user-approve', onInfer)
          ipcMain.removeListener('discovery:user-sandbox', onSandbox)
          ipcMain.removeListener('discovery:user-abort', onAbort)
        }

        const onInfer = (event) => {
          cleanup()
          resolve({ action: 'infer' })
        }

        const onSandbox = (event) => {
          cleanup()
          resolve({ action: 'sandbox' })
        }

        const onAbort = (event) => {
          cleanup()
          resolve({ action: 'abort' })
        }

        ipcMain.once('discovery:user-approve', onInfer)
        ipcMain.once('discovery:user-sandbox', onSandbox)
        ipcMain.once('discovery:user-abort', onAbort)
      })

      await ActivityLog.append(projectPath, `DEBUG: User chose: ${choice.action}`, 'warn')

      // Handle user choice
      if (choice.action === 'abort') {
        return { aborted: true }
      }

      if (choice.action === 'sandbox') {
        // Check Docker availability
        const dockerAvailable = await this._checkDocker()
        if (!dockerAvailable) {
          // Send Docker error
          win.webContents.send(IPC.DISCOVERY_ERROR, {
            message: 'Sandbox mode requires Docker. Docker was not detected on this system.',
            dockerRequired: true,
          })
          // Wait for retry or choose differently
          return await new Promise((resolve) => {
            const onRetry = async () => {
              ipcMain.removeListener('discovery:user-sandbox', onRetry)
              ipcMain.removeListener('discovery:user-abort', onChooseDifferently)
              const retryDocker = await this._checkDocker()
              if (retryDocker) {
                this.useSandboxMode = true
                resolve({ sandbox: true })
              } else {
                win.webContents.send(IPC.DISCOVERY_ERROR, {
                  message: 'Sandbox mode requires Docker. Docker was not detected on this system.',
                  dockerRequired: true,
                })
                ipcMain.once('discovery:user-sandbox', onRetry)
                ipcMain.once('discovery:user-abort', onChooseDifferently)
              }
            }
            const onChooseDifferently = () => {
              ipcMain.removeListener('discovery:user-sandbox', onRetry)
              ipcMain.removeListener('discovery:user-abort', onChooseDifferently)
              // Go back to choice
              win.webContents.send(IPC.DISCOVERY_COMPLETE, { delta: [] })
              ipcMain.once('discovery:user-approve', onInfer)
              ipcMain.once('discovery:user-sandbox', onSandbox)
              ipcMain.once('discovery:user-abort', onAbort)
            }
            ipcMain.once('discovery:user-sandbox', onRetry)
            ipcMain.once('discovery:user-abort', onChooseDifferently)
          })
        }
        this.useSandboxMode = true
        return { sandbox: true }
      }

      // User chose 'infer' — State A: Loading screen
      win.webContents.send(IPC.DISCOVERY_STARTED)

      // Run discovery agent
      const settings = await Settings.load()
      const qwenPath = settings.qwenPath || 'qwen'

      let commands
      try {
        const result = await runDiscovery(projectPath, programmerAgent, qwenPath)
        commands = result.commands
      } catch (e) {
        // Discovery failed
        win.webContents.send(IPC.DISCOVERY_ERROR, { message: e.message })
        return await new Promise((resolve) => {
          const handler = (_, data) => {
            if (data.action === 'abort') {
              win.webContents.removeListener('discovery:user-abort', handler)
              resolve({ aborted: true })
            }
          }
          win.webContents.on('discovery:user-abort', handler)
        })
      }

      // Load baseline to compute delta
      const baselinePath = path.join(projectPath, '.qwen', 'baseline.json')
      const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
      const existingAllowed = new Set(baseline.tools?.allowed || [])

      // Compute delta: commands not already in baseline
      const delta = commands.filter(cmd => !existingAllowed.has(`run_shell_command(${cmd})`))

      await ActivityLog.append(projectPath, `Discovery found ${commands.length} commands, ${delta.length} need approval`, 'info')

      // If delta is empty, auto-approve and continue
      if (delta.length === 0) {
        // Tell renderer to close overlay and continue
        win.webContents.send(IPC.DISCOVERY_COMPLETE, { delta })
        return {}
      }

      // State D — Show approval list
      win.webContents.send(IPC.DISCOVERY_COMPLETE, { delta })

      // Wait for approve or decline
      return await new Promise((resolve) => {
        const cleanup = () => {
          ipcMain.removeListener('discovery:user-approve', onApprove)
          ipcMain.removeListener('discovery:user-abort', onAbort)
        }

        const onApprove = async () => {
          cleanup()
          try {
            const result = await ProjectManager.addApprovedCommands(projectPath, delta)
            if (result.error) {
              resolve({ error: result.error })
              return
            }
            resolve({})
          } catch (e) {
            resolve({ error: e.message })
          }
        }

        const onAbort = () => {
          cleanup()
          resolve({ aborted: true })
        }

        ipcMain.once('discovery:user-approve', onApprove)
        ipcMain.once('discovery:user-abort', onAbort)
      })
    } catch (e) {
      await ActivityLog.append(projectPath, `DEBUG: _runPreflight error: ${e.message}`, 'warn')
      return { error: e.message }
    }
  }

  /**
   * Check if Docker is available
   * @returns {Promise<boolean>}
   */
  async _checkDocker() {
    return await new Promise((resolve) => {
      const proc = spawn('docker', ['info'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      proc.on('error', () => resolve(false))
      proc.on('close', (code) => resolve(code === 0))
    })
  }

  /**
   * Notify renderer of status change
   */
  _notifyStatus() {
    if (!this.currentWin) return

    const checkpoint = {
      state: this.state,
      currentStepIndex: this.currentStepIndex,
      steps: this.steps.map((step, i) => {
        const agent = this.agentSnapshots.get(step.agent_id)
        return {
          ...step,
          agent_name: agent?.name || 'Unknown',
          status: step.status || STEP_STATUSES.IDLE,
          // Include loop config and review_target from agent snapshot for canvas rendering
          loop: agent?.loop || null,
          review_target: agent?.review_target || null,
        }
      }),
    }

    this.currentWin.webContents.send(IPC.PIPELINE_STATUS, checkpoint)
  }

  /**
   * Check if the pipeline has run before (checkpoint exists)
   * @param {string} projectPath - Project path
   * @returns {Promise<{hasRunBefore: boolean}>}
   */
  async hasRunBefore(projectPath) {
    try {
      const Checkpoint = require('../checkpoint/Checkpoint')
      const checkpoint = await Checkpoint.load(projectPath)
      return { hasRunBefore: !!checkpoint }
    } catch (e) {
      return { hasRunBefore: false }
    }
  }

  /**
   * Reset the pipeline - delete context files (except brief.md), delete Output/, reset checkpoint
   * @param {string} projectPath - Project path
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async reset(projectPath) {
    try {
      const fs = require('fs/promises')
      const path = require('path')
      const Checkpoint = require('../checkpoint/Checkpoint')
      const ActivityLog = require('./ActivityLog')

      // If pipeline is running, abort it first
      if (this.state === PIPELINE_STATES.RUNNING) {
        await ActivityLog.append(projectPath, 'Pipeline is running - aborting before reset', 'warn')
        await this.abort()
      }
      
      // Ensure abort controller is reset
      this.abortController = null

      await ActivityLog.append(projectPath, 'Pipeline reset requested - clearing Context/ and Output/', 'warn')

      // Delete all files in Context/ folder except brief.md
      const contextDir = path.join(projectPath, 'Context')
      try {
        const files = await fs.readdir(contextDir)
        for (const file of files) {
          if (file.toLowerCase() === 'brief.md') continue
          const filePath = path.join(contextDir, file)
          const stat = await fs.stat(filePath)
          if (stat.isFile()) {
            await fs.unlink(filePath)
            await ActivityLog.append(projectPath, `Deleted: Context/${file}`, 'info')
          }
        }
      } catch (e) {
        // Context folder doesn't exist - nothing to delete
      }

      // Delete all files in Output/ folder
      const outputDir = path.join(projectPath, 'Output')
      try {
        const files = await fs.readdir(outputDir)
        for (const file of files) {
          const filePath = path.join(outputDir, file)
          const stat = await fs.stat(filePath)
          if (stat.isFile()) {
            await fs.unlink(filePath)
            await ActivityLog.append(projectPath, `Deleted: Output/${file}`, 'info')
          }
        }
      } catch (e) {
        // Output folder doesn't exist - nothing to delete
      }

      // Reset checkpoint - create fresh one with all steps as IDLE
      const pipelineJson = await fs.readFile(
        path.join(projectPath, 'Pipeline', 'pipeline.json'),
        'utf8'
      )
      const pipeline = JSON.parse(pipelineJson)
      const steps = pipeline.steps || []

      // Load agent snapshots for names
      const AgentLibrary = require('../project/AgentLibrary')
      const checkpointSteps = []
      for (const step of steps) {
        const agent = await AgentLibrary.getById(step.agent_id)
        checkpointSteps.push({
          agent_id: step.agent_id,
          agent_name: agent?.name || 'Unknown',
          started_at: null,
          completed_at: null,
          status: STEP_STATUSES.IDLE,
        })
      }

      await Checkpoint.save(projectPath, {
        run_id: new Date().toISOString(),
        pipeline: path.basename(projectPath),
        steps: checkpointSteps,
        loop_counts: {},
      })

      await ActivityLog.append(projectPath, `Pipeline reset complete - ${checkpointSteps.length} steps set to IDLE`, 'ok')

      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
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
