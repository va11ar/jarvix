const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const { createPoller } = require('./FilePoller')
const ActivityLog = require('./ActivityLog')

// Discovery output file path relative to project
const DISCOVERY_OUTPUT_SUBPATH = '.jarvix/discovery-output.json'

// Hardcoded discovery prompt per §4.2 — do not modify
const DISCOVERY_PROMPT = `You are performing a command discovery task only. Do not write any code. Do not modify any files.

Read the documents provided. Based solely on their content, infer which shell commands a
programmer agent will need to execute to implement the described project.

Output a JSON array of shell command strings and nothing else. No explanation, no preamble,
no markdown formatting. Example output format:

["npm install", "npm run build", "npm test", "pip install -r requirements.txt"]

If you cannot infer any commands from the documents, output an empty array: []`

/**
 * Run the discovery agent to infer required shell commands
 * @param {string} projectPath - Absolute path to the project folder
 * @param {Object} programmerAgent - The programmer agent snapshot (includes reads and role)
 * @param {string} qwenPath - Path to the Qwen CLI binary
 * @returns {Promise<{ commands: string[] }>} - Array of inferred command strings
 * @throws {Error} On timeout, spawn failure, or malformed output
 */
async function runDiscovery(projectPath, programmerAgent, qwenPath) {
  const discoveryOutputPath = path.join(projectPath, DISCOVERY_OUTPUT_SUBPATH)
  const jarvixDir = path.join(projectPath, '.jarvix')

  try {
    // Ensure .jarvix directory exists
    await fs.mkdir(jarvixDir, { recursive: true })

    // Collect input files per §4.1:
    // 1. Programmer agent's declared reads
    // 2. Context/architect.md (if exists)
    // 3. Context/planner.md (if exists)
    const inputFiles = []

    // Add agent's declared reads
    if (Array.isArray(programmerAgent.reads)) {
      for (const readPath of programmerAgent.reads) {
        const fullPath = path.join(projectPath, readPath)
        try {
          await fs.access(fullPath)
          inputFiles.push(fullPath)
        } catch {
          // File doesn't exist — skip silently
        }
      }
    }

    // Add architect.md if exists
    const architectPath = path.join(projectPath, 'Context', 'architect.md')
    try {
      await fs.access(architectPath)
      inputFiles.push(architectPath)
    } catch {
      // Doesn't exist — skip
    }

    // Add planner.md if exists
    const plannerPath = path.join(projectPath, 'Context', 'planner.md')
    try {
      await fs.access(plannerPath)
      inputFiles.push(plannerPath)
    } catch {
      // Doesn't exist — skip
    }

    // Build the prompt: @/path/to/file references first, then the instruction prompt
    const promptParts = []
    for (const filePath of inputFiles) {
      promptParts.push(`@${filePath}`)
    }
    promptParts.push(DISCOVERY_PROMPT)
    const fullPrompt = promptParts.join('\n\n')

    // Write prompt to temp file (avoid CLI length limits)
    const tempPromptPath = path.join(jarvixDir, 'discovery-prompt.txt')
    await fs.writeFile(tempPromptPath, fullPrompt, 'utf8')

    // Spawn Qwen CLI process per §4.3
    return await new Promise((resolve, reject) => {
      const qwenArgs = [
        '-p',
        fullPrompt,
        '--approval-mode',
        'auto-edit',
        '--output-format',
        'stream-json',
      ]

      const proc = spawn(qwenPath, qwenArgs, {
        cwd: projectPath,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      if (process.platform !== 'win32') {
        proc.unref()
      }

      let resolved = false

      const settle = async (result) => {
        if (resolved) return
        resolved = true

        // Kill process if still running
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'])
          } else {
            process.kill(-proc.pid, 'SIGKILL')
          }
        } catch {
          // Already dead
        }

        if (result.error) {
          // Delete output file on failure so next run re-discovers
          try {
            await fs.unlink(discoveryOutputPath)
          } catch {
            // Doesn't exist or unreadable
          }
          reject(new Error(result.error))
        } else {
          resolve(result)
        }
      }

      // 60 second timeout per §4.3
      const timeoutId = setTimeout(() => {
        settle({ error: 'Discovery timeout' })
      }, 60000)

      // Handle stdout for errors
      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            if (json.type === 'error' || json.error) {
              ActivityLog.append(projectPath, `Discovery error: ${json.error || json.message}`, 'error')
            }
          } catch {
            // Not JSON — ignore
          }
        }
      })

      // Handle stderr
      proc.stderr.on('data', (data) => {
        ActivityLog.append(projectPath, `Discovery stderr: ${data.toString().trim()}`, 'warn')
      })

      // Process exited — poll for output file
      proc.on('close', async (code) => {
        if (resolved) return

        if (code !== 0 && code !== null) {
          settle({ error: `Discovery process exited with code ${code}` })
          return
        }

        // Poll for output file
        const poller = createPoller(discoveryOutputPath, /^[\s\S]*$/, 2000)
        let pollerRunning = true

        const stopPoller = () => {
          if (pollerRunning) {
            poller.stop()
            pollerRunning = false
          }
        }

        poller.start(async () => {
          if (!pollerRunning) return
          stopPoller()

          try {
            const content = await fs.readFile(discoveryOutputPath, 'utf8')
            const commands = JSON.parse(content)

            if (!Array.isArray(commands)) {
              stopPoller()
              settle({ error: 'Discovery output is not a JSON array' })
              return
            }

            // Validate all elements are strings
            const valid = commands.every(cmd => typeof cmd === 'string')
            if (!valid) {
              stopPoller()
              settle({ error: 'Discovery output contains non-string elements' })
              return
            }

            // Success — delete temp prompt file, keep output for now (deleted on approval or abort)
            try {
              await fs.unlink(tempPromptPath)
            } catch {
              // Ignore
            }

            clearTimeout(timeoutId)
            stopPoller()
            settle({ commands })
          } catch (e) {
            stopPoller()
            settle({ error: `Failed to parse discovery output: ${e.message}` })
          }
        })

        // Poller timeout (30s max for file to appear after process exit)
        setTimeout(() => {
          stopPoller()
          if (!resolved) {
            settle({ error: 'Discovery output file not found' })
          }
        }, 30000)
      })

      proc.on('error', (err) => {
        settle({ error: `Failed to spawn discovery: ${err.message}` })
      })
    })
  } catch (e) {
    throw new Error(`Discovery setup failed: ${e.message}`)
  }
}

module.exports = { runDiscovery }
