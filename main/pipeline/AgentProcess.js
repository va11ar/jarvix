const { app } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const net = require('net')
const { EventEmitter } = require('events')
const { HARDCODED_EXCLUDE } = require('../constants')
const { createPoller } = require('./FilePoller')
const ActivityLog = require('./ActivityLog')
const QaMcpRunner = require('../mcp/QaMcpRunner')

require('events').setMaxListeners(20)

/**
 * Read and parse the agent's status JSON file.
 * Returns a normalised status string compatible with existing PipelineRunner
 * checks (e.g. "PIPELINE_STATUS: DONE | ISSUES: false"), or null if the file
 * does not exist or cannot be parsed.
 *
 * @param {string} statusFilePath - Absolute path to the <agentname>-status.json file
 * @returns {Promise<string|null>}
 */
async function readStatusJson(statusFilePath) {
  try {
    const raw = await fs.readFile(statusFilePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.status === 'DONE') {
      return `PIPELINE_STATUS: DONE | ISSUES: ${parsed.issues === true ? 'true' : 'false'}`
    }
    if (parsed.status === 'ERROR') {
      return `PIPELINE_STATUS: ERROR | REASON: ${parsed.reason || 'unknown'}`
    }
    return null
  } catch {
    return null
  }
}

class AgentProcess extends EventEmitter {
  constructor(agent, projectPath, outputFilePath, win, useSandbox = false, oauthEnabled = false, qwenPath = null) {
    super()
    this.agent = agent
    this.projectPath = projectPath
    this.outputFilePath = outputFilePath
    this.win = win
    this.useSandbox = useSandbox
    this.oauthEnabled = oauthEnabled
    this.qwenPath = qwenPath
    this.process = null
    this.poller = null
    this.timeoutId = null
    this.exitCode = null
    this.status = null // PIPELINE_STATUS value
    this.exitReason = null
    this.statusFilePath = null  // set in spawn() / _spawnQaAgent()
    this._completionPromise = null
    this._completionResolve = null
    // QA MCP
    this.qaMcpRunner = null   // QaMcpRunner — non-null only during a QA agent run
    this.appProcess  = null   // Target app process — non-null only if launch_command was used
    this.mcpServerProcess = null  // QaMcpServer.js process — spawned by Wazear, killed by Wazear
  }

  /**
   * Spawn the agent process
   * @param {string[]} [extraReads=[]] - Optional array of file paths to inject into the prompt
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async spawn(extraReads = []) {
    try {
      // Write merged settings.json for this agent
      await this._writeAgentSettings()

      // Ensure Output folder exists (for projects created before Output was added)
      const outputDir = path.join(this.projectPath, 'Output')
      await fs.mkdir(outputDir, { recursive: true })

      // Derive file names once, use throughout spawn()
      const outputFileName = path.basename(this.outputFilePath)
      const statusFileName = path.basename(this.outputFilePath, '.md') + '-status.json'
      const outputRelativePath = `Context/${outputFileName}`
      const statusRelativePath = `Context/${statusFileName}`
      this.statusFilePath = path.join(path.dirname(this.outputFilePath), statusFileName)

      // File-writing anchor injected at the very beginning of the prompt (attention primacy)
      const fileAnchor = `CRITICAL: When your task is complete, you must write two files using your file writing tools — not print to terminal:\n1. Your output to \`${outputRelativePath}\`\n2. Your status to \`${statusRelativePath}\` as JSON: {"status":"DONE","issues":false} or {"status":"ERROR","reason":"..."}\n\n`

      // Construct the prompt by reading all files in agent.reads
      const promptParts = [fileAnchor, this.agent.prompt]

      // Inject global instruction: Do NOT ask questions
      const noQuestionsPrompt = `\n\nDo NOT ask questions, use best assumption with the information you have.`
      promptParts.push(noQuestionsPrompt)

      for (const readFile of this.agent.reads) {
        // Agent read files may or may not have Context/ prefix - handle both cases
        let fullPath
        if (readFile.startsWith('Context/')) {
          fullPath = path.join(this.projectPath, readFile)
        } else {
          fullPath = path.join(this.projectPath, 'Context', readFile)
        }
        try {
          let content = await fs.readFile(fullPath, 'utf8')
          // Strip PIPELINE_STATUS lines to prevent Qwen confusion on review loops
          content = content.replace(/^PIPELINE_STATUS:.*$/gm, '').trim()
          // For reviewer files (-reviewer.md), strip lines that might confuse the agent
          // about which file to write to (e.g., "written to `Context/xxx-reviewer.md`")
          if (readFile.includes('-reviewer.md') || readFile.includes('_reviewer.md')) {
            content = content.replace(/^.*written to `?[^`]+`?\.?$/gmi, '').trim()
            content = content.replace(/^Done\..*$/gmi, '').trim()
          }
          promptParts.push(`\n\n@${readFile}:\n${content}`)
        } catch (e) {
          // File doesn't exist — log warning and skip
          ActivityLog.append(this.projectPath, `Missing read file: ${readFile}`, 'warn')
        }
      }

      // Inject extra reads (e.g., QA report for producer re-run)
      for (const readPath of extraReads) {
        try {
          let content = await fs.readFile(readPath, 'utf8')
          // Strip PIPELINE_STATUS lines to prevent Qwen confusion on review loops
          content = content.replace(/^PIPELINE_STATUS:.*$/gm, '').trim()
          // For reviewer files, strip lines that might confuse the agent about output file
          const readFileName = path.basename(readPath)
          if (readFileName.includes('-reviewer.md') || readFileName.includes('_reviewer.md')) {
            content = content.replace(/^.*written to `?[^`]+`?\.?$/gmi, '').trim()
            content = content.replace(/^Done\..*$/gmi, '').trim()
          }
          const rel = path.relative(this.projectPath, readPath)
          promptParts.push(`\n\n--- ${rel} ---\n\n${content}`)
        } catch {
          ActivityLog.append(this.projectPath, `QA report not found for injection: ${readPath}`, 'warn')
        }
      }

      // Append the injected footer
      const footerPrompt = `\n\nWhen you finish your task, write your progress notes to \`${outputRelativePath}\` as normal.

You must also write a separate status file to \`${statusRelativePath}\`. This file must contain only valid JSON — nothing else. Use one of these exact structures:

If completed with no issues:
{"status":"DONE","issues":false}

If completed but issues were found:
{"status":"DONE","issues":true}

If an error occurred:
{"status":"ERROR","reason":"brief description"}

Write the status file last, after your progress notes are complete.`
      promptParts.push(footerPrompt)

      // Inject Output folder instructions for producer and producer-reviewer roles
      if (this.agent.role === 'producer') {
        const outputFolderPrompt = `\n\nOUTPUT FOLDER INSTRUCTIONS (OVERRIDE):
Regardless of any path mentioned earlier in this prompt, the following rules govern where you write files.
All artifacts you create (code files, articles, images, or any other deliverables)
must be written to the Output/ subdirectory. For example:
- Correct: Output/my-code.js, Output/article.md, Output/screenshot.png
- Wrong: my-code.js (project root), Context/my-code.js

Do NOT write artifacts to the project root directory. Do NOT write artifacts to
the Context/ folder.

When you need to read existing artifacts to iterate on feedback, read them from
the Output/ subdirectory.

Your progress tracking file (Context/${outputFileName}) stays in the Context/ folder —
only user-facing artifacts go to Output/.

EXECUTION ORDER (MANDATORY):
Do not narrate your plan. Do not summarize what you are about to do. Do not print
outlines, component lists, or architecture notes to the terminal.

The first tool call you make must be a file write to Output/. Writing your first
output artifact is your only permitted starting action. Plan in your internal
reasoning only — never in terminal output.`
        promptParts.push(outputFolderPrompt)
      } else if (this.agent.role === 'producer-reviewer') {
        const reviewerPrompt = `\n\nREVIEWER ARTIFACT LOCATION:
When reviewing the producer's work, read all artifacts from the Output/ subdirectory.
Do not read artifacts from the project root or Context/ folder — only Output/
contains the producer's deliverables.

If you find artifacts in the project root (outside Output/), flag this as an error
in your review output. The producer must place all deliverables in Output/.

The producer's progress file (Context/${outputFileName}) remains in Context/ for
tracking purposes — do not review this file as an artifact.`
        promptParts.push(reviewerPrompt)
      }

      const fullPrompt = promptParts.join('')

      // Spawn the Qwen process
      return await this._spawnQwen(fullPrompt)
    } catch (e) {
      return { error: e.message }
    }
  }

  /**
   * Spawn the Qwen Code CLI process with the given prompt
   * @param {string} fullPrompt - The complete prompt to pass to Qwen
   * @param {string|null} allowedMcpServerNames - MCP server names to allow (comma-separated), or null
   * @param {string[]|null} allowedTools - Tool names to allow in non-interactive mode, or null
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _spawnQwen(fullPrompt, allowedMcpServerNames = null, allowedTools = null) {
    try {
      // Create completion promise for efficient waiting
      this._completionPromise = new Promise((resolve) => {
        this._completionResolve = resolve
      })

      // Ensure Output folder exists (for projects created before Output was added)
      const outputDir = path.join(this.projectPath, 'Output')
      await fs.mkdir(outputDir, { recursive: true })

      // Spawn the Qwen process
      // useSandbox: spawn with --approval-mode yolo (per §6.2)
      const approvalMode = this.useSandbox ? 'yolo' : 'auto-edit'

      // Pass prompt via stdin to avoid shell escaping issues with special characters
      // Use --prompt flag which appends to stdin input
      const qwenArgs = [
        '--approval-mode',
        approvalMode,
      ]

      // Add allowed MCP server names if specified (for QA agent)
      if (allowedMcpServerNames) {
        qwenArgs.push('--allowed-mcp-server-names', allowedMcpServerNames)
      }

      // Add allowed tools if specified (for QA agent MCP tools in non-interactive mode)
      if (allowedTools && allowedTools.length > 0) {
        qwenArgs.push('--allowed-tools', allowedTools.join(','))
      }

      // Only add --auth-type if OAuth is not enabled
      // When OAuth is enabled, Qwen CLI uses credentials from ~/.qwen/.env
      if (!this.oauthEnabled) {
        qwenArgs.push('--auth-type', 'openai')
      }

      // Log spawn info
      const qwenCommand = this.qwenPath || 'qwen'
      await ActivityLog.append(this.projectPath, `Spawning: ${qwenCommand} ${qwenArgs.slice(0, 3).join(' ')}... (prompt length: ${fullPrompt.length} chars)`, 'info')

      this.process = spawn(qwenCommand, qwenArgs, {
        cwd: this.projectPath,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: (() => {
          const e = {
            PATH: process.env.PATH,
            HOME: os.homedir(),
            TMPDIR: process.env.TMPDIR || (process.platform === 'win32' ? process.env.TEMP : '/tmp'),
            USER: process.env.USER || process.env.USERNAME,
            SHELL: process.env.SHELL,
            LANG: process.env.LANG,
            TERM: process.env.TERM,
          }
          // Remove keys with undefined values — passing undefined to a child process env causes errors
          Object.keys(e).forEach(k => { if (e[k] === undefined) delete e[k] })
          return e
        })(),
      })

      // Write prompt to stdin and close it to signal end of input
      this.process.stdin.write(fullPrompt)
      this.process.stdin.end()

      // Handle stdout for errors and general output
      const stdoutLines = []
      this.process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          stdoutLines.push(line)
          try {
            const json = JSON.parse(line)
            if (json.type === 'error' || json.error) {
              ActivityLog.append(this.projectPath, `Agent error: ${json.error || json.message}`, 'error')
            } else if (json.type) {
              ActivityLog.append(this.projectPath, `Agent stdout: ${JSON.stringify(json)}`, 'qwen')
            }
          } catch {
            // Not JSON - log as qwen output
            ActivityLog.append(this.projectPath, `Agent stdout: ${line}`, 'qwen')
          }
        }
      })

      // Handle stderr - collect for potential error reporting
      const stderrLines = []
      let approvalError = false
      this.process.stderr.on('data', (data) => {
        const line = data.toString().trim()
        stderrLines.push(line)
        // Detect approval-related errors
        if (line.includes('requires user approval') || line.includes('non-interactive mode')) {
          approvalError = true
        }
        ActivityLog.append(this.projectPath, `Agent stderr: ${line}`, 'qwen')
      })

      // Handle process exit
      this.process.on('exit', async (code) => {
        this.exitCode = code
        // Read status from JSON file
        if (!this.status) {
          const statusFromJson = await readStatusJson(this.statusFilePath)
          if (statusFromJson) {
            this.status = statusFromJson
          }
        }

        // If still no status, attempt stdout recovery
        if (!this.status) {
          await this._recoverFromStdout(stdoutLines, stderrLines)
        }

        this._cleanup()
        if (this._completionResolve) {
          this._completionResolve({ exitCode: this.exitCode, status: this.status, exitReason: this.exitReason })
        }
      })

      this.process.on('error', async (err) => {
        this.exitReason = err.message
        // Read status from JSON file
        if (!this.status) {
          const statusFromJson = await readStatusJson(this.statusFilePath)
          if (statusFromJson) {
            this.status = statusFromJson
          }
        }

        // If still no status, attempt stdout recovery
        if (!this.status) {
          await this._recoverFromStdout(stdoutLines, stderrLines)
        }

        this._cleanup()
        if (this._completionResolve) {
          this._completionResolve({ exitCode: this.exitCode, status: this.status, exitReason: this.exitReason })
        }
      })

      // Start polling the status JSON file
      this.poller = createPoller(this.statusFilePath, null, 2000)
      this.poller.on('match', (fullMatch) => {
        this.status = fullMatch.trim()
        ActivityLog.append(this.projectPath, `Poller detected status: ${this.status}`, 'info')
        this._cleanup()
        if (this._completionResolve) {
          this._completionResolve({ exitCode: this.exitCode, status: this.status, exitReason: this.exitReason })
        }
      })
      this.poller.on('error', () => {
        // File doesn't exist yet — continue polling
      })

      // Set timeout
      const timeoutMs = this.agent.timeout_seconds * 1000
      this.timeoutId = setTimeout(() => {
        this.exitReason = 'timeout'
        ActivityLog.append(this.projectPath, `Agent timed out after ${this.agent.timeout_seconds}s`, 'warn')
        this._cleanup()
        if (this._completionResolve) {
          this._completionResolve({ exitCode: this.exitCode, status: this.status, exitReason: this.exitReason })
        }
      }, timeoutMs)

      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  }

  /**
   * Attempt to recover when an agent exits without writing its output or status files.
   *
   * Strategy:
   * 1. If stdout has substantive content (>= 8 lines), write it to the output file
   *    and synthesise a status JSON from it. This handles the Qwen3-Coder pattern
   *    of printing output to terminal instead of writing files.
   * 2. If stdout is empty or thin (< 8 lines), spawn one retry with a short focused
   *    prompt. The retry reads the same source files as the original run.
   * 3. If the retry also produces no files, set this.status to ERROR and stop.
   *
   * @param {string[]} stdoutLines - Lines captured from the agent's stdout
   * @param {string[]} stderrLines - Lines captured from the agent's stderr
   */
  async _recoverFromStdout(stdoutLines, stderrLines) {
    const STDOUT_VIABLE_THRESHOLD = 8

    const viableLines = stdoutLines.filter(l => l.trim().length > 0)

    if (viableLines.length >= STDOUT_VIABLE_THRESHOLD) {
      // Stdout has substantive content — recover by writing it to the output file
      await ActivityLog.append(this.projectPath, `Stdout recovery: ${viableLines.length} lines captured, writing to output file`, 'warn')

      const stdoutContent = viableLines.join('\n')

      try {
        await fs.writeFile(this.outputFilePath, stdoutContent, 'utf8')
        await ActivityLog.append(this.projectPath, `Stdout recovery: output file written to ${this.outputFilePath}`, 'info')
      } catch (writeErr) {
        await ActivityLog.append(this.projectPath, `Stdout recovery: failed to write output file — ${writeErr.message}`, 'error')
        this.status = 'PIPELINE_STATUS: ERROR | REASON: stdout recovery failed to write output file'
        return
      }

      // Synthesise status from stdout content
      // If stdout mentions error keywords, treat as error. Otherwise DONE.
      const lower = stdoutContent.toLowerCase()
      const hasError = /\berror\b|\bfailed\b|\bfailure\b|\bcannot\b|\bunable\b/.test(lower)
      const synthesisedStatus = hasError
        ? 'PIPELINE_STATUS: ERROR | REASON: agent printed errors to stdout instead of writing files'
        : 'PIPELINE_STATUS: DONE | ISSUES: false'

      // Write the status JSON too
      try {
        const statusFileName = path.basename(this.outputFilePath, '.md') + '-status.json'
        const statusFilePath = path.join(path.dirname(this.outputFilePath), statusFileName)
        const statusObj = hasError
          ? { status: 'ERROR', reason: 'agent printed errors to stdout instead of writing files' }
          : { status: 'DONE', issues: false }
        await fs.writeFile(statusFilePath, JSON.stringify(statusObj), 'utf8')
        await ActivityLog.append(this.projectPath, `Stdout recovery: status JSON written`, 'info')
      } catch (statusErr) {
        await ActivityLog.append(this.projectPath, `Stdout recovery: failed to write status JSON — ${statusErr.message}`, 'warn')
      }

      this.status = synthesisedStatus
      return
    }

    // Stdout is empty or thin — trigger one retry
    await ActivityLog.append(this.projectPath, `Stdout recovery: insufficient stdout (${viableLines.length} lines), triggering retry`, 'warn')
    await this._retryWriteFiles()
  }

  /**
   * Spawn one retry when the agent exited without writing its output file.
   * The retry prompt is short and task-specific: re-read the source files,
   * produce the output, write it. No full task description is repeated.
   *
   * If the retry succeeds, this.status is set from the status JSON.
   * If the retry fails, this.status is set to ERROR.
   */
  async _retryWriteFiles() {
    const outputFileName = path.basename(this.outputFilePath)
    const statusFileName = path.basename(this.outputFilePath, '.md') + '-status.json'
    const outputRelativePath = `Context/${outputFileName}`
    const statusRelativePath = `Context/${statusFileName}`

    // Build the list of source files this agent reads, same as spawn()
    const readList = (this.agent.reads || []).map(f => {
      if (f.startsWith('Context/')) return f
      return `Context/${f}`
    }).join(', ')

    const retryPrompt = `Your previous run ended without writing the required output files. Complete the task now.

Read these files for context: ${readList || 'none'}

Write your output to \`${outputRelativePath}\` using your file writing tools.
Write your status to \`${statusRelativePath}\` using your file writing tools.

Status file must be valid JSON only:
{"status":"DONE","issues":false}
{"status":"DONE","issues":true}
{"status":"ERROR","reason":"brief description"}

Do not print output to the terminal. Write the files.`

    await ActivityLog.append(this.projectPath, `Retry: spawning recovery run for ${this.agent.name}`, 'warn')

    // Spawn a fresh Qwen process. Reuse _spawnQwen() with the retry prompt.
    // _cleanup() has already been called before this method runs — reset the
    // completion promise so waitForCompletion() works for the retry.
    this._completionPromise = new Promise((resolve) => {
      this._completionResolve = resolve
    })

    const spawnResult = await this._spawnQwen(retryPrompt)
    if (spawnResult.error) {
      await ActivityLog.append(this.projectPath, `Retry: spawn failed — ${spawnResult.error}`, 'error')
      this.status = 'PIPELINE_STATUS: ERROR | REASON: retry spawn failed'
      return
    }

    // Wait for the retry to complete
    const retryResult = await this._completionPromise

    // Check if the retry wrote the status JSON
    const statusFilePath = path.join(path.dirname(this.outputFilePath), statusFileName)
    const retryStatus = await readStatusJson(statusFilePath)

    if (retryStatus) {
      this.status = retryStatus
      await ActivityLog.append(this.projectPath, `Retry: succeeded — ${retryStatus}`, 'info')
    } else {
      this.status = 'PIPELINE_STATUS: ERROR | REASON: retry completed but no status file written'
      await ActivityLog.append(this.projectPath, `Retry: failed — no status file after retry`, 'error')
    }
  }

  /**
   * Clean up resources when agent completes
   */
  _cleanup() {
    if (this.poller) {
      this.poller.stop()
      this.poller = null
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    // Settings restore happens in settle()
  }

  /**
   * Wait for the agent to complete (exit or status detected)
   * @returns {Promise<{exitCode: number|null, status: string|null, exitReason?: string}>}
   */
  async waitForCompletion() {
    if (!this._completionPromise) {
      // Already completed or never spawned
      return {
        exitCode: this.exitCode,
        status: this.status,
        exitReason: this.exitReason,
      }
    }
    return await this._completionPromise
  }

  /**
   * Kill the agent process
   * @returns {Promise<void>}
   */
  async kill() {
    if (!this.process) return

    try {
      // Kill process group
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(this.process.pid), '/T', '/F'])
      } else {
        try {
          process.kill(-this.process.pid, 'SIGKILL')
        } catch {
          // Fallback to killing just the main process
          this.process.kill('SIGKILL')
        }
      }
    } catch {
      // Process already dead
    }

    // Set exitReason and resolve completion promise to stop waitForCompletion()
    this.exitReason = 'killed'
    if (this._completionResolve) {
      this._completionResolve({ exitCode: this.exitCode, status: this.status, exitReason: this.exitReason })
    }
    await this._restoreProjectSettings()
    this._cleanup()
  }

  /**
   * Settle the agent — restore settings and return final state
   * @returns {Promise<{exitCode: number|null, status: string|null, exitReason?: string}>}
   */
  async settle() {
    await this._restoreProjectSettings()
    return {
      exitCode: this.exitCode,
      status: this.status,
      exitReason: this.exitReason,
    }
  }

  /**
   * Write merged settings.json for this agent
   * Project baseline + agent overrides, with HARDCODED_EXCLUDE always present
   * Also merges global model settings to prevent CLI config errors
   */
  async _writeAgentSettings() {
    const settingsPath = path.join(this.projectPath, '.qwen', 'settings.json')
    const baselinePath = path.join(this.projectPath, '.qwen', 'baseline.json')

    // Read baseline
    let baseline
    try {
      const raw = await fs.readFile(baselinePath, 'utf8')
      baseline = JSON.parse(raw)
    } catch {
      baseline = { tools: { approvalMode: 'auto-edit', allowed: [], exclude: [] } }
    }

    // Read global settings to merge model config
    let globalSettings = {}
    try {
      const globalSettingsPath = path.join(os.homedir(), '.qwen', 'settings.json')
      const globalRaw = await fs.readFile(globalSettingsPath, 'utf8')
      globalSettings = JSON.parse(globalRaw)
    } catch {
      // Global settings not found - continue without
    }

    // Merge agent overrides
    const allowed = new Set(baseline.tools.allowed || [])
    const excluded = new Set(baseline.tools.exclude || [])

    // Agent allowedCommands — add to allowed, remove from excluded if present
    for (const cmd of this.agent.allowedCommands || []) {
      const wrapped = `run_shell_command(${cmd})`
      excluded.delete(wrapped)
      allowed.add(wrapped)
    }

    // Agent excludedCommands — add to excluded, remove from allowed if present
    for (const cmd of this.agent.excludedCommands || []) {
      const wrapped = `run_shell_command(${cmd})`
      allowed.delete(wrapped)
      excluded.add(wrapped)
    }

    // Always include HARDCODED_EXCLUDE
    for (const pattern of HARDCODED_EXCLUDE) {
      allowed.delete(pattern)
      excluded.add(pattern)
    }

    const merged = {
      tools: {
        approvalMode: 'auto-edit',
        allowed: Array.from(allowed),
        exclude: Array.from(excluded),
      },
    }

    // Merge global model settings if present
    if (globalSettings?.model) {
      merged.model = globalSettings.model
    }

    // Note: Do NOT merge security.auth - the CLI has a bug where having security.auth
    // in settings.json causes resolveModelConfig to fail. Auth comes from ~/.qwen/.env instead.

    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8')
  }

  /**
   * Restore settings.json to baseline after agent completes
   */
  async _restoreProjectSettings() {
    const settingsPath = path.join(this.projectPath, '.qwen', 'settings.json')
    const baselinePath = path.join(this.projectPath, '.qwen', 'baseline.json')

    try {
      const baselineRaw = await fs.readFile(baselinePath, 'utf8')
      await fs.writeFile(settingsPath, baselineRaw, 'utf8')
    } catch {
      // Baseline doesn't exist — leave settings as-is
    }
  }

  /**
   * Launch target app for QA agent
   * @param {string} command - Shell command to run
   * @param {string|null} readyPattern - Regex pattern to wait for, or null for 3s delay
   * @returns {Promise<void>}
   */
  async _launchTargetApp(command, readyPattern) {
    return new Promise((resolve, reject) => {
      let launchTimeout = null
      let settled       = false

      const settle = (fn, val) => {
        if (settled) return
        settled = true
        clearTimeout(launchTimeout)
        fn(val)
      }

      this.appProcess = spawn(command, [], {
        cwd:   this.projectPath,
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
      })

      this.appProcess.on('error', (err) => {
        settle(reject, new Error(`Failed to launch target app: ${err.message}`))
      })

      this.appProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          settle(reject, new Error(`Target app exited with code ${code} before becoming ready`))
        }
      })

      if (!readyPattern) {
        setTimeout(() => settle(resolve, undefined), 3000)
        return
      }

      const pattern = new RegExp(readyPattern)
      const onData  = (data) => {
        if (pattern.test(data.toString())) {
          this.appProcess.stdout.off('data', onData)
          settle(resolve, undefined)
        }
      }
      this.appProcess.stdout.on('data', onData)

      launchTimeout = setTimeout(
        () => settle(reject, new Error(
          `Target app did not emit "${readyPattern}" within 30 seconds`
        )),
        30000
      )
    })
  }

  /**
   * Spawn QaMcpServer.js directly and wait for it to signal readiness.
   * Resolves with the port number the server is listening on.
   * Readiness is signalled by the server writing .jarvix-qa-socket to disk.
   */
  async _spawnMcpServer() {
    // Pick a free port by asking the OS for one.
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address()
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    // Remove any stale socket info file from a previous session.
    const socketInfoPath = path.join(this.projectPath, '.jarvix-qa-socket')
    await fs.unlink(socketInfoPath).catch(() => {})

    this.mcpServerProcess = spawn(
      'node',
      [
        app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'main', 'mcp', 'QaMcpServer.js')
          : path.join(__dirname, '../mcp/QaMcpServer.js'),
        '--project-path', this.projectPath,
        '--port', String(port),
      ],
      {
        cwd:   this.projectPath,
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )

    this.mcpServerProcess.stderr.on('data', (data) => {
      ActivityLog.append(
        this.projectPath,
        `MCP server: ${data.toString().trim()}`,
        'qwen'
      )
    })

    this.mcpServerProcess.on('error', (err) => {
      ActivityLog.append(
        this.projectPath,
        `MCP server process error: ${err.message}`,
        'error'
      )
    })

    // Wait for .jarvix-qa-socket to appear — that is the server's ready signal.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        await fs.readFile(socketInfoPath, 'utf8')
        await ActivityLog.append(this.projectPath, `MCP server ready on port ${port}`, 'info')
        return port
      } catch {
        // Not ready yet — keep polling
      }
      await new Promise(r => setTimeout(r, 100))
    }

    throw new Error('QaMcpServer did not start within 10 seconds')
  }

  /**
   * Write the MCP server URL into .qwen/settings.json.
   * Qwen Code connects to the already-running server — it does not spawn it.
   * trust: true bypasses tool call confirmation for jarvix-qa tools only.
   *
   * Note: the old version of this method also mutated settings.tools.allowed
   * to permit a shell spawn of node. That mutation is intentionally absent here
   * because Wazear now spawns the server directly — Qwen never runs a shell
   * command for this purpose.
   */
  async _appendMcpServerConfig(port) {
    const settingsPath = path.join(this.projectPath, '.qwen', 'settings.json')
    const settings     = JSON.parse(await fs.readFile(settingsPath, 'utf8'))

    // Use HTTP transport - Wazear spawns the server, Qwen connects via HTTP.
    // trust: true bypasses tool call confirmation for jarvix-qa tools.
    // httpUrl: tells Qwen this is an HTTP-based MCP server (not SSE or stdio).
    settings.mcpServers = {
      'jarvix-qa': {
        httpUrl: `http://127.0.0.1:${port}/mcp`,
        trust: true,
      }
    }

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  }

  /**
   * Spawn QA agent with MCP server
   */
  async _spawnQaAgent() {
    try {
      // Clear screenshots from any previous run
      const screenshotsDir = path.join(this.projectPath, 'Context', 'screenshots')
      await fs.rm(screenshotsDir, { recursive: true, force: true })
      await fs.mkdir(screenshotsDir, { recursive: true })

      // 1. Launch target app if configured.
      if (this.agent.launch_command) {
        await this._launchTargetApp(
          this.agent.launch_command,
          this.agent.launch_ready_pattern || null
        )
      }

      // 2. Write merged settings.json for this agent.
      await this._writeAgentSettings()

      // 3. Spawn QaMcpServer.js directly. Resolves with the port it is
      //    listening on. The server writes .jarvix-qa-socket as its ready signal.
      const mcpPort = await this._spawnMcpServer()

      // 4. Write MCP server URL into settings.json. Qwen connects to the
      //    already-running server — it spawns nothing.
      await this._appendMcpServerConfig(mcpPort)
      await ActivityLog.append(this.projectPath, `MCP server config written (port ${mcpPort})`, 'info')

      // 4b. Wait for MCP server HTTP to be fully ready before spawning Qwen.
      //     This ensures tool discovery works correctly.
      await new Promise(resolve => setTimeout(resolve, 1000))
      await ActivityLog.append(this.projectPath, `MCP server connection delay complete`, 'info')

      // 5. Create QaMcpRunner and subscribe to screenshot events before
      //    connecting, so no events are missed during the connection window.
      this.qaMcpRunner = new QaMcpRunner(this.projectPath)
      this.qaMcpRunner.on('screenshot-taken', (msg) => {
        this.win.webContents.send('qa:screenshot-taken', msg)
      })

      // 6. Connect QaMcpRunner to the Unix socket. The server is already
      //    running so connect() resolves immediately.
      await this.qaMcpRunner.connect()

      // 7. Build the prompt (same logic as spawn()).
      // Derive file names once, use throughout _spawnQaAgent()
      const outputFileName = path.basename(this.outputFilePath)
      const statusFileName = path.basename(this.outputFilePath, '.md') + '-status.json'
      const outputRelativePath = `Context/${outputFileName}`
      const statusRelativePath = `Context/${statusFileName}`
      this.statusFilePath = path.join(path.dirname(this.outputFilePath), statusFileName)

      // File-writing anchor injected at the very beginning of the prompt (attention primacy)
      const fileAnchor = `CRITICAL: When your task is complete, you must write two files using your file writing tools — not print to terminal:\n1. Your output to \`${outputRelativePath}\`\n2. Your status to \`${statusRelativePath}\` as JSON: {"status":"DONE","issues":false} or {"status":"ERROR","reason":"..."}\n\n`

      const promptParts = [fileAnchor, this.agent.prompt]
      for (const readFile of this.agent.reads) {
        let fullPath
        if (readFile.startsWith('Context/')) {
          fullPath = path.join(this.projectPath, readFile)
        } else {
          fullPath = path.join(this.projectPath, 'Context', readFile)
        }
        try {
          let content = await fs.readFile(fullPath, 'utf8')
          // Strip PIPELINE_STATUS lines to prevent Qwen confusion on review loops
          content = content.replace(/^PIPELINE_STATUS:.*$/gm, '').trim()
          promptParts.push(`\n\n@${readFile}:\n${content}`)
        } catch (e) {
          ActivityLog.append(this.projectPath, `Missing read file: ${readFile}`, 'warn')
        }
      }

      // Inject role-specific instructions
      if (this.agent.role === 'qa') {
        const qaStatusFileName = path.basename(this.outputFilePath, '.md') + '-status.json'
        const qaStatusRelativePath = `Context/${qaStatusFileName}`
        const qaPrompt = `\n\nQA FILE WORKFLOW:
Write your defect report to \`Context/qa-report.md\`.
Write your status to \`${qaStatusRelativePath}\` — valid JSON only, nothing else.

Determine ISSUES solely from the count returned by \`qa_get_flagged\`:
- Count > 0: {"status":"DONE","issues":true}
- Count = 0: {"status":"DONE","issues":false}

Write the status file last.`
        promptParts.push(qaPrompt)
      } else if (this.agent.role === 'producer') {
        const outputFolderPrompt = `\n\nOUTPUT FOLDER INSTRUCTIONS:
All artifacts you create (code files, articles, images, or any other deliverables)
must be written to the Output/ subdirectory. For example:
- Correct: Output/my-code.js, Output/article.md, Output/screenshot.png
- Wrong: my-code.js (project root), Context/my-code.js

Do NOT write artifacts to the project root directory. Do NOT write artifacts to
the Context/ folder.

When you need to read existing artifacts to iterate on feedback, read them from
the Output/ subdirectory.

Your progress tracking file (Context/${outputFileName}) stays in the Context/ folder —
only user-facing artifacts go to Output/.`
        promptParts.push(outputFolderPrompt)
      } else if (this.agent.role === 'producer-reviewer') {
        const reviewerPrompt = `\n\nREVIEWER ARTIFACT LOCATION:
When reviewing the producer's work, read all artifacts from the Output/ subdirectory.
Do not read artifacts from the project root or Context/ folder — only Output/
contains the producer's deliverables.

If you find artifacts in the project root (outside Output/), flag this as an error
in your review output. The producer must place all deliverables in Output/.

The producer's progress file (Context/${outputFileName}) remains in Context/ for
tracking purposes — do not review this file as an artifact.`
        promptParts.push(reviewerPrompt)
      } else {
        // Default footer for other agents
        const footerPrompt = `\n\nWhen you finish your task, write your progress notes to \`${outputRelativePath}\` as normal.

You must also write a separate status file to \`${statusRelativePath}\`. This file must contain only valid JSON — nothing else. Use one of these exact structures:

If completed with no issues:
{"status":"DONE","issues":false}

If completed but issues were found:
{"status":"DONE","issues":true}

If an error occurred:
{"status":"ERROR","reason":"brief description"}

Write the status file last, after your progress notes are complete.`
        promptParts.push(footerPrompt)
      }

      const fullPrompt = promptParts.join('')

      // 8. Spawn Qwen. It connects to the MCP server via HTTP.
      // Do NOT pass --allowed-mcp-server-names - let Qwen discover all available
      // MCP servers from settings.json.
      // Pass --allowed-tools for QA agent MCP tools to bypass non-interactive gate
      await ActivityLog.append(this.projectPath, `Spawning Qwen with MCP server (port ${mcpPort})`, 'info')
      await ActivityLog.append(this.projectPath, `QA agent MCP tools available: qa_wait_for_user, qa_take_screenshot, qa_get_screenshots, qa_get_flagged`, 'info')
      const QA_MCP_TOOLS = [
        'mcp__jarvix-qa__qa_wait_for_user',
        'mcp__jarvix-qa__qa_take_screenshot',
        'mcp__jarvix-qa__qa_get_screenshots',
        'mcp__jarvix-qa__qa_get_flagged',
      ]
      await this._spawnQwen(fullPrompt, null, QA_MCP_TOOLS)

      // 9. Signal PipelineRunner to enter waiting-for-user state.
      this.emit('qa:waiting-for-user')

      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /**
   * Teardown QA agent
   */
  async _teardownQaAgent() {
    // 1. Disconnect from the control socket.
    if (this.qaMcpRunner) {
      await this.qaMcpRunner.disconnect()
      this.qaMcpRunner = null
    }

    // 2. Kill QaMcpServer.js — Wazear spawned it, Wazear kills it.
    if (this.mcpServerProcess) {
      this.mcpServerProcess.kill()
      this.mcpServerProcess = null
    }

    // 3. Kill target app if Wazear launched it.
    if (this.appProcess) {
      this.appProcess.kill()
      this.appProcess = null
    }

    // 4. Restore .qwen/settings.json from baseline.
    await this._restoreProjectSettings()

    // 5. Signal PipelineRunner to unregister hotkey.
    this.emit('qa:teardown-complete')
  }
}

module.exports = { AgentProcess }
