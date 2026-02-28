const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { HARDCODED_EXCLUDE } = require('../constants')
const { createPoller } = require('./FilePoller')
const ActivityLog = require('./ActivityLog')

// PIPELINE_STATUS regex for polling agent output
const PIPELINE_STATUS_REGEX = /^PIPELINE_STATUS:\s*(DONE|ERROR)\s*\|?\s*(ISSUES:\s*(true|false)|REASON:\s*.+)?$/m

class AgentProcess {
  constructor(agent, projectPath, outputFilePath, win) {
    this.agent = agent
    this.projectPath = projectPath
    this.outputFilePath = outputFilePath
    this.win = win
    this.process = null
    this.poller = null
    this.timeoutId = null
    this.exitCode = null
    this.status = null // PIPELINE_STATUS value
    this.exitReason = null
  }

  /**
   * Spawn the agent process
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async spawn() {
    try {
      // Write merged settings.json for this agent
      await this._writeAgentSettings()

      // Construct the prompt by reading all files in agent.reads
      const promptParts = [this.agent.prompt]
      for (const readFile of this.agent.reads) {
        const fullPath = path.join(this.projectPath, readFile)
        try {
          const content = await fs.readFile(fullPath, 'utf8')
          promptParts.push(`\n\n--- Content of ${readFile} ---\n${content}`)
        } catch {
          // File doesn't exist — skip silently
        }
      }

      // Append the injected footer
      const outputFileName = path.basename(this.outputFilePath)
      promptParts.push(`\n\nYou must write your complete output to \`${outputFileName}\`. Use your file writing tools to do this — do not print your output to the terminal.\n\nThe very last line of the file you write must be exactly one of:\n\n\`PIPELINE_STATUS: DONE | ISSUES: false\` — task complete, no issues found\n\n\`PIPELINE_STATUS: DONE | ISSUES: true\` — task complete, issues found (revision agents only)\n\n\`PIPELINE_STATUS: ERROR | REASON: <brief description>\` — task could not be completed\n\nDo not omit this line. Do not paraphrase it. Do not add anything after it.`)

      const fullPrompt = promptParts.join('')

      // Spawn the Qwen process
      const qwenArgs = [
        '-p',
        fullPrompt,
        '--approval-mode',
        'auto-edit',
        '--output-format',
        'stream-json',
      ]

      this.process = spawn('qwen', qwenArgs, {
        cwd: this.projectPath,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Handle stdout for errors
      this.process.stdout.on('data', (data) => {
        // Log stdout for debugging — pipeline status comes from file polling
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            if (json.type === 'error' || json.error) {
              ActivityLog.append(this.projectPath, `Agent error: ${json.error || json.message}`, 'error')
            }
          } catch {
            // Not JSON — ignore
          }
        }
      })

      // Handle stderr
      this.process.stderr.on('data', (data) => {
        ActivityLog.append(this.projectPath, `Agent stderr: ${data.toString().trim()}`, 'warn')
      })

      // Handle process exit
      this.process.on('exit', (code) => {
        this.exitCode = code
        this._cleanup()
      })

      this.process.on('error', (err) => {
        this.exitReason = err.message
        this._cleanup()
      })

      // Start polling the output file for PIPELINE_STATUS
      this.poller = createPoller(this.outputFilePath, PIPELINE_STATUS_REGEX, 2000)
      this.poller.on('match', (fullMatch) => {
        this.status = fullMatch.trim()
        this._cleanup()
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
      }, timeoutMs)

      return { ok: true }
    } catch (e) {
      return { error: e.message }
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
    return new Promise((resolve) => {
      const checkComplete = () => {
        if (this.exitCode !== null || this.status || this.exitReason) {
          resolve({
            exitCode: this.exitCode,
            status: this.status,
            exitReason: this.exitReason,
          })
        } else {
          setImmediate(checkComplete)
        }
      }
      checkComplete()
    })
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
}

module.exports = { AgentProcess }
