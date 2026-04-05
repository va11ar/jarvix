const path = require('path')
const crypto = require('crypto')
const { ipcMain } = require('electron')
const { PIPELINE_STATES, STEP_STATUSES, IPC, AGENT_ROLES, STACK_DEFAULTS, PIPE_TO_SHELL_PATTERNS } = require('../constants')
const Checkpoint = require('../checkpoint/Checkpoint')
const ActivityLog = require('./ActivityLog')
const AgentLibrary = require('../project/AgentLibrary')
const AgentProcess = require('./AgentProcess').AgentProcess
const { runDiscovery } = require('./CommandDiscovery')
const ProjectManager = require('../project/ProjectManager')
const Settings = require('../settings')
const { spawn } = require('child_process')
const fs = require('fs/promises')
const { registerQaHotkey, unregisterQaHotkey } = require('../qaHotkey')

class PipelineRunner {
  constructor() {
    this.currentProjectPath = null
    this.currentWin = null
    this.state = PIPELINE_STATES.IDLE
    this.steps = []
    this.currentStepIndex = -1
    this.currentAgentProcess = null
    this.currentAgent = null  // The active AgentProcess instance, or null when idle
    this.agentSnapshots = new Map() // agentId -> agent definition at pipeline start
    this.abortController = null
    this.pausePromise = null
    this.resumeCallback = null
    // Pre-flight discovery state per §8
    this.producerStepIndex = null
    this.commandDiscoveryDone = false
    this.useSandboxMode = false
    this.discoveryCommands = null
    this.qaLoopActive = false
    this.qaHasRun = false
    this.noFixerWarningShown = false
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

      // Find the first producer step index per §3
      this.producerStepIndex = null
      for (let i = 0; i < this.steps.length; i++) {
        const agent = this.agentSnapshots.get(this.steps[i].agent_id)
        if (agent && agent.role === AGENT_ROLES.PRODUCER) {
          this.producerStepIndex = i
          await ActivityLog.append(this.currentProjectPath, `DEBUG: Found producer agent at step index ${i} (${agent.name})`, 'warn')
          break
        }
      }
      if (this.producerStepIndex === null) {
        await ActivityLog.append(this.currentProjectPath, 'DEBUG: No producer agent found in pipeline', 'warn')
      }

      // Reset discovery state for this run
      this.commandDiscoveryDone = false
      this.useSandboxMode = false
      this.discoveryCommands = null
      this.qaLoopActive = false
      this.qaHasRun = false
      this.noFixerWarningShown = false

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
          if (existingStatus === STEP_STATUSES.SKIPPED) {
            // Preserve explicit user skip intent across runs
            status = existingStatus
          } else if (i < startIndex) {
            // Resuming mid-pipeline: mark prior steps as complete
            status = STEP_STATUSES.COMPLETE
          }
          // COMPLETE and ERROR from prior runs reset to IDLE — they will re-run unless skipped
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

      await ActivityLog.append(this.currentProjectPath, `DEBUG: Processing step ${i}, agent=${agent?.name}, role=${agent?.role}, producerStepIndex=${this.producerStepIndex}, commandDiscoveryDone=${this.commandDiscoveryDone}`, 'warn')

      if (!agent) {
        await ActivityLog.append(this.currentProjectPath, `Agent not found: ${step.agent_id}`, 'error')
        this.state = PIPELINE_STATES.ERROR
        return
      }

      // Skip Fixer agents when QA has not yet run and found issues
      if (agent.role === AGENT_ROLES.FIXER && !this.qaHasRun) {
        await ActivityLog.append(this.currentProjectPath, `${agent.name} skipped — QA has not run yet`, 'info')
        step.status = STEP_STATUSES.SKIPPED
        await Checkpoint.updateStep(this.currentProjectPath, i, {
          status: STEP_STATUSES.SKIPPED,
          completed_at: new Date().toISOString(),
        })
        this._notifyStatus()
        continue
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

      // Pre-flight hook for producer agent per §3 and §8
      if (i === this.producerStepIndex && !this.commandDiscoveryDone) {
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

      // Get output file path
      const outputFileName = path.basename(agent.filePath, '.md') + '.md'
      const outputFilePath = path.join(this.currentProjectPath, 'Context', outputFileName)
      const statusFileName = path.basename(agent.filePath, '.md') + '-status.json'
      const statusFilePath = path.join(this.currentProjectPath, 'Context', statusFileName)

      // Clear output file before spawning (important for review loops - prevents stale status detection)
      try {
        await require('fs/promises').unlink(outputFilePath)
      } catch {
        // File doesn't exist - that's fine
      }

      // Clear status file before spawning
      try {
        await require('fs/promises').unlink(statusFilePath)
      } catch {
        // File doesn't exist - that's fine
      }

      // Log agent start
      await ActivityLog.append(this.currentProjectPath, `${agent.name} started`, 'info')
      await ActivityLog.append(this.currentProjectPath, `Expected output file: ${outputFilePath}`, 'info')
      this._notifyStatus()

      // Spawn agent — use sandbox mode if pre-flight selected it
      // Also check if OAuth is enabled
      const settings = await Settings.load()
      const oauthEnabled = !!settings.oauthEnabled
      const qwenPath = settings.qwenPath || null

      this.currentAgentProcess = new AgentProcess(
        agent,
        this.currentProjectPath,
        outputFilePath,
        this.currentWin,
        this.useSandboxMode,
        oauthEnabled,
        qwenPath
      )
      this.currentAgent = this.currentAgentProcess

      // QA agent branch
      const isQaAgent = agent.role === 'qa'
      let settleResult

      if (isQaAgent) {
        // QA Pre-flight pause: ask user to launch their app before QA agent starts
        const win = this.currentWin
        const projectPath = this.currentProjectPath

        // Send notification to renderer to show pre-flight dialog
        win.webContents.send(IPC.QA_PREFLIGHT_SHOW)

        // Wait for user response via IPC
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            ipcMain.removeListener(IPC.QA_PREFLIGHT_READY, onReady)
            ipcMain.removeListener(IPC.QA_PREFLIGHT_ABORT, onAbort)
          }

          const onReady = () => {
            cleanup()
            resolve()
          }

          const onAbort = () => {
            cleanup()
            reject(new Error('User aborted QA pre-flight'))
          }

          ipcMain.once(IPC.QA_PREFLIGHT_READY, onReady)
          ipcMain.once(IPC.QA_PREFLIGHT_ABORT, onAbort)
        })

        // Instructions dialog pause: show QA instructions if not seen before
        const projectJson = JSON.parse(
          await fs.readFile(path.join(projectPath, 'project.json'), 'utf8')
        )

        if (projectJson.qaInstructionsSeen !== true) {
          await new Promise((resolve) => {
            win.webContents.send(IPC.QA_INSTRUCTIONS_SHOW)
            ipcMain.once(IPC.QA_INSTRUCTIONS_CONFIRM, resolve)
          })
        }

        // Wire up QA events
        this.currentAgentProcess.on('qa:waiting-for-user', () => {
          registerQaHotkey(this.currentWin)
          this.currentWin.webContents.send('pipeline:status', {
            state:            PIPELINE_STATES.WAITING_FOR_USER,
            agentId:          agent.id,
            isQaAgent:        true,
            currentStepIndex: this.currentStepIndex,
            steps:            this.steps.map((step, idx) => {
              const agentSnap = this.agentSnapshots.get(step.agent_id)
              return {
                ...step,
                agent_name:    agentSnap?.name || 'Unknown',
                status:        step.status || STEP_STATUSES.IDLE,
                loop:          agentSnap?.loop || null,
                review_target: agentSnap?.review_target || null,
              }
            }),
          })
        })

        this.currentAgentProcess.on('qa:teardown-complete', () => {
          unregisterQaHotkey()
        })

        // Spawn QA agent (includes MCP server setup)
        const spawnResult = await this.currentAgentProcess._spawnQaAgent()
        if (!spawnResult.ok) {
          await ActivityLog.append(this.currentProjectPath, `Failed to spawn QA agent: ${spawnResult.error}`, 'error')
          this.state = PIPELINE_STATES.ERROR
          await Checkpoint.updateStep(this.currentProjectPath, i, {
            status: STEP_STATUSES.ERROR,
            completed_at: new Date().toISOString(),
          })
          this._notifyStatus()
          this.currentAgent = null
          return
        }

        // Wait for completion (same as normal flow)
        const result = await this.currentAgentProcess.waitForCompletion()

        // Teardown QA agent
        await this.currentAgentProcess._teardownQaAgent()
        settleResult = result
        this.currentAgentProcess = null
        this.currentAgent = null
      } else {
        // Normal agent flow
        const extraReads = this.qaLoopActive
          ? [path.join(this.currentProjectPath, 'Context', 'qa-report.md')]
          : []
        const spawnResult = await this.currentAgentProcess.spawn(extraReads)

        if (!spawnResult.ok) {
          await ActivityLog.append(this.currentProjectPath, `Failed to spawn agent: ${spawnResult.error}`, 'error')
          this.state = PIPELINE_STATES.ERROR
          await Checkpoint.updateStep(this.currentProjectPath, i, {
            status: STEP_STATUSES.ERROR,
            completed_at: new Date().toISOString(),
          })
          this._notifyStatus()
          this.currentAgent = null
          return
        }

        // Wait for completion
        const result = await this.currentAgentProcess.waitForCompletion()

        // Settle (restore settings)
        settleResult = await this.currentAgentProcess.settle()
        this.currentAgentProcess = null
        this.currentAgent = null

        // Reset qaLoopActive after producer or fixer completes during a QA loop re-run
        if ((agent.role === AGENT_ROLES.PRODUCER || agent.role === AGENT_ROLES.FIXER) && this.qaLoopActive) {
          this.qaLoopActive = false
        }
      }

      // QA routing logic — route back to nearest preceding producer if issues found
      if (isQaAgent) {
        // Guard: only run this block if QA completed without error
        const skipRouting = settleResult.exitReason === 'timeout' ||
          (settleResult.exitCode !== 0 && !settleResult.status) ||
          (settleResult.status && settleResult.status.includes('ERROR'))

        if (!skipRouting) {
          const hasIssues = settleResult.status && settleResult.status.includes('ISSUES: true')

          // Read screenshot directory for hasScreenshots check
          let screenshotFiles = []
          try {
            screenshotFiles = (await fs.readdir(path.join(this.currentProjectPath, 'Context', 'screenshots'))).filter(f => f.endsWith('.png'))
          } catch {
            screenshotFiles = []
          }
          const hasScreenshots = screenshotFiles.length > 0

          // Find nearest preceding producer step
          // Prefer fixer; fall back to producer
          // NOTE: role lives on the agent snapshot, not on the step object.
          let nearestProducerIndex = -1
          for (const preferredRole of [AGENT_ROLES.FIXER, AGENT_ROLES.PRODUCER]) {
            for (let j = i - 1; j >= 0; j--) {
              if (this.agentSnapshots.get(this.steps[j].agent_id)?.role === preferredRole) {
                nearestProducerIndex = j
                break
              }
            }
            if (nearestProducerIndex !== -1) break
          }

          if (nearestProducerIndex !== -1) {
            if (hasIssues) {
              if (!hasScreenshots) {
                // Case B: Agent found issues, user took no screenshots
                // Prompt user for confirmation via modal
                const userConfirmed = await this._showQaRoutingConfirmation(this.currentWin)
                if (!userConfirmed) {
                  // User said No — update checkpoint directly and continue to next step.
                  await Checkpoint.updateStep(this.currentProjectPath, i, {
                    status: STEP_STATUSES.SKIPPED,
                    completed_at: new Date().toISOString(),
                  })
                  this.steps[i].status = STEP_STATUSES.SKIPPED
                  await ActivityLog.append(this.currentProjectPath, 'QA routing declined by user — continuing pipeline', 'warn')
                  this._notifyStatus()
                  continue  // skip outcome block and review loop block
                }
              }

              // Route back to fixer or producer (with or without screenshots)
              const resolvedRole = this.agentSnapshots.get(this.steps[nearestProducerIndex].agent_id)?.role
              if (resolvedRole === AGENT_ROLES.PRODUCER && !this.noFixerWarningShown) {
                this.noFixerWarningShown = true
                await new Promise((resolve) => {
                  ipcMain.once(IPC.QA_NO_FIXER_WARN_ACK, resolve)
                  this.currentWin.webContents.send(IPC.QA_NO_FIXER_WARN)
                })
              }
              this.qaLoopActive = true
              this.qaHasRun = true
              this.steps[nearestProducerIndex].status = STEP_STATUSES.IDLE
              await Checkpoint.updateStep(this.currentProjectPath, nearestProducerIndex, {
                status: STEP_STATUSES.IDLE,
                completed_at: null,
              })
              await ActivityLog.append(this.currentProjectPath, `${agent.name} — routing back for fixes`, 'warn')
              this._notifyStatus()
              i = nearestProducerIndex - 1  // will be incremented by for loop
              continue  // skip outcome block and review loop block
            }
          }
          // hasIssues is false — fall through to outcome block
        }
      }

      // Determine outcome (shared by both QA and normal agents)
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
      } else if (!settleResult.status) {
        // Agent exited without writing PIPELINE_STATUS line
        stepStatus = STEP_STATUSES.ERROR
        logType = 'error'
        const exitInfo = settleResult.exitCode !== null ? `exited with code ${settleResult.exitCode}` : 'exited unexpectedly'
        await ActivityLog.append(this.currentProjectPath, `${agent.name} ${exitInfo} without writing status - output file missing or malformed`, logType)
      } else {
        // Agent wrote an unexpected status line
        stepStatus = STEP_STATUSES.ERROR
        logType = 'error'
        await ActivityLog.append(this.currentProjectPath, `${agent.name} wrote unexpected status: ${settleResult.status}`, logType)
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
        this._notifyStatus()
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

    // Can only skip agents that are not already skipped.
    // COMPLETE agents from a prior run CAN be skipped for the next iteration.
    // RUNNING agents cannot be skipped here (blocked by the state === RUNNING guard above).
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
   * Retry a failed agent by resetting its status to IDLE
   * @param {number} stepIndex - Index of the step to retry
   * @param {string} projectPath - Project path (optional, uses currentProjectPath if not provided)
   * @returns {Promise<{ok: boolean, error?: string, agentName?: string}>}
   */
  async retryAgent(stepIndex, projectPath) {
    // Can only retry when pipeline is NOT running (idle, paused, or complete/error)
    if (this.state === PIPELINE_STATES.RUNNING) {
      return { ok: false, error: 'Pipeline must not be running to retry an agent' }
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

    // Can only retry agents with ERROR status
    if (step.status !== STEP_STATUSES.ERROR) {
      return { ok: false, error: 'Agent must have ERROR status to retry' }
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

    // Log the retry
    const ActivityLog = require('./ActivityLog')
    await ActivityLog.append(targetPath, `${agent?.name || 'Unknown'} reset for retry`, 'info')

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
   *
   * DEADLOCK TRACE (fixed):
   * ─────────────────────────────────────────────────────────────────────────────
   * 1. Main sends DISCOVERY_SHOW_CHOICE → renderer shows choice modal.
   *    Main waits on Promise with listeners: user-approve, user-sandbox, user-abort.
   *
   * 2. User clicks "Use Sandbox Mode" → renderer sends discovery:user-sandbox.
   *    Main's onSandbox fires, runs _checkDocker(), finds Docker unavailable.
   *
   * 3. Main sends DISCOVERY_ERROR { dockerRequired: true }.
   *    Main enters NEW Promise with listeners: user-sandbox (retry), show-choice-ack,
   *    user-abort (abort from docker).
   *
   * 4. Renderer's handleDiscoveryError sets preflightPhase = 'sandbox-warning'.
   *
   * 5. User clicks "Choose Differently" → renderer sends discovery:show-choice-ack.
   *    Main's onChooseDifferently fires, cleans up Docker-error listeners,
   *    sends DISCOVERY_SHOW_CHOICE, re-registers original choice listeners.
   *
   * 6. Renderer receives DISCOVERY_SHOW_CHOICE → handleDiscoveryShowChoice()
   *    resets state and re-renders choice modal. Pipeline can continue.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  async _runPreflight(programmerAgent) {
    const projectPath = this.currentProjectPath
    const win = this.currentWin

    await ActivityLog.append(projectPath, `_runPreflight started for agent ${programmerAgent.name}`, 'warn')

    try {
      // State B — Show choice modal FIRST (before discovery runs)
      win.webContents.send(IPC.DISCOVERY_SHOW_CHOICE)

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
              ipcMain.removeListener('discovery:show-choice-ack', onChooseDifferently)
              ipcMain.removeListener('discovery:user-abort', onAbortFromDocker)
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
                ipcMain.once('discovery:show-choice-ack', onChooseDifferently)
                ipcMain.once('discovery:user-abort', onAbortFromDocker)
              }
            }
            const onChooseDifferently = () => {
              ipcMain.removeListener('discovery:user-sandbox', onRetry)
              ipcMain.removeListener('discovery:show-choice-ack', onChooseDifferently)
              ipcMain.removeListener('discovery:user-abort', onAbortFromDocker)
              // Go back to choice
              win.webContents.send(IPC.DISCOVERY_SHOW_CHOICE)
            }
            const onAbortFromDocker = () => {
              ipcMain.removeListener('discovery:user-sandbox', onRetry)
              ipcMain.removeListener('discovery:show-choice-ack', onChooseDifferently)
              resolve({ aborted: true })
            }
            ipcMain.once('discovery:user-sandbox', onRetry)
            ipcMain.once('discovery:show-choice-ack', onChooseDifferently)
            ipcMain.once('discovery:user-abort', onAbortFromDocker)
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
        commands = result.commands // Array<{ command: string, reason: string }>
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

      // --- Stack completion (deterministic) ---
      // If the inferred commands imply a known stack, merge in any standard commands
      // for that stack that were not already inferred. Uses the first token of each
      // default command as the stack signal (e.g. "npm" for nodejs defaults).
      const inferredSet = new Set(commands.map(c => c.command))

      for (const [stack, defaults] of Object.entries(STACK_DEFAULTS)) {
        if (stack === 'common') continue
        const stackImplied = defaults.some(def =>
          commands.some(c => c.command.startsWith(def.split(' ')[0]))
        )
        if (stackImplied) {
          for (const def of defaults) {
            if (!inferredSet.has(def)) {
              commands.push({ command: def, reason: `Standard ${stack} build tool command.` })
              inferredSet.add(def)
            }
          }
        }
      }

      // Always merge common (git) commands — safe for every project.
      for (const def of STACK_DEFAULTS.common) {
        if (!inferredSet.has(def)) {
          commands.push({ command: def, reason: 'Standard version control command.' })
          inferredSet.add(def)
        }
      }

      // --- Safety filter ---
      // Drop commands that match pipe-to-shell patterns before user sees them.
      // Log each drop so it is visible in ActivityLog for debugging.
      commands = commands.filter(({ command }) => {
        const isDangerous = PIPE_TO_SHELL_PATTERNS.some(p => p.test(command))
        if (isDangerous) {
          ActivityLog.append(projectPath, `Discovery: dropped pipe-to-shell pattern: ${command}`, 'warn')
        }
        return !isDangerous
      })

      // Load baseline to compute delta
      const baselinePath = path.join(projectPath, '.qwen', 'baseline.json')
      const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
      const existingAllowed = new Set(baseline.tools?.allowed || [])

      // Compute delta: commands not already in baseline
      const delta = commands.filter(({ command }) =>
        !existingAllowed.has(`run_shell_command(${command})`)
      )

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
            const commandStrings = delta.map(({ command }) => command)
            const result = await ProjectManager.addApprovedCommands(projectPath, commandStrings)
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

      // Verify the path is a known registered project before deleting anything
      const registered = await ProjectManager.listAll()
      const isKnown = registered.some(
        p => path.resolve(p.projectPath) === path.resolve(projectPath)
      )
      if (!isKnown) {
        return { error: 'Cannot reset an unregistered project path' }
      }

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
   * Show QA routing confirmation modal and wait for user response
   * @param {BrowserWindow} win - BrowserWindow instance
   * @returns {Promise<boolean>} - true if user confirmed, false otherwise
   */
  _showQaRoutingConfirmation(win) {
    return new Promise((resolve) => {
      const cleanup = () => {
        ipcMain.removeListener(IPC.QA_ROUTING_CONFIRM_YES, onYes)
        ipcMain.removeListener(IPC.QA_ROUTING_CONFIRM_NO, onNo)
      }
      const onYes = () => { cleanup(); resolve(true) }
      const onNo  = () => { cleanup(); resolve(false) }
      ipcMain.once(IPC.QA_ROUTING_CONFIRM_YES, onYes)
      ipcMain.once(IPC.QA_ROUTING_CONFIRM_NO,  onNo)
      win.webContents.send(IPC.QA_ROUTING_CONFIRM_SHOW)
    })
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
