const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const ActivityLog = require('./ActivityLog')

// Hardcoded discovery prompt per §4.2 — do not modify
const DISCOVERY_PROMPT = `You are performing a command discovery task only. Do not write any code. Do not modify any files.

Read the documents provided. Based solely on their content, infer which shell commands a
programmer agent will need to execute to implement the described project.

Output ONLY a JSON array of shell command strings to stdout. No explanation, no preamble,
no markdown formatting, no backticks. Example output:

["npm install", "npm run build", "npm test", "pip install -r requirements.txt"]

If you cannot infer any commands from the documents, output an empty array: []

Output ONLY the JSON array — no other text before or after.`

/**
 * Run the discovery agent to infer required shell commands
 * @param {string} projectPath - Absolute path to the project folder
 * @param {Object} programmerAgent - The programmer agent snapshot (includes reads and role)
 * @param {string} qwenPath - Path to the Qwen CLI binary
 * @returns {Promise<{ commands: string[] }>} - Array of inferred command strings
 * @throws {Error} On timeout, spawn failure, or malformed output
 */
async function runDiscovery(projectPath, programmerAgent, qwenPath) {
  try {
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

    await ActivityLog.append(projectPath, `DEBUG: Collected ${inputFiles.length} input files for discovery`, 'warn')

    // Build the prompt: embed file contents first, then the instruction prompt
    const promptParts = []

    // Add content of each input file
    for (const filePath of inputFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf8')
        const relativePath = path.relative(projectPath, filePath)
        promptParts.push(`\n\n--- ${relativePath} ---\n\n${content}`)
      } catch {
        // File unreadable — skip
      }
    }

    promptParts.push(DISCOVERY_PROMPT)
    const fullPrompt = promptParts.join('')

    // Spawn Qwen CLI process per §4.3
    return await new Promise((resolve, reject) => {
      const qwenArgs = [
        '-p',
        fullPrompt,
        '--approval-mode',
        'auto-edit',
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
      let stdoutData = ''

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
          reject(new Error(result.error))
        } else {
          resolve(result)
        }
      }

      // 60 second timeout per §4.3
      const timeoutId = setTimeout(() => {
        settle({ error: 'Discovery timeout' })
      }, 60000)

      // Capture stdout
      proc.stdout.on('data', (data) => {
        const text = data.toString()
        stdoutData += text
        ActivityLog.append(projectPath, `Discovery: ${text.trim()}`, 'info')
      })

      // Handle stderr
      proc.stderr.on('data', (data) => {
        ActivityLog.append(projectPath, `Discovery stderr: ${data.toString().trim()}`, 'warn')
      })

      // Process exited — parse stdout for JSON
      proc.on('close', async (code) => {
        if (resolved) return

        await ActivityLog.append(projectPath, `DEBUG: Discovery process closed with code ${code}`, 'warn')
        await ActivityLog.append(projectPath, `DEBUG: Captured stdout (${stdoutData.length} chars): ${stdoutData.substring(0, 500)}`, 'warn')

        if (code !== 0 && code !== null) {
          settle({ error: `Discovery process exited with code ${code}` })
          return
        }

        // Parse JSON from stdout
        try {
          // Try to find JSON array in output
          const jsonMatch = stdoutData.match(/\[[\s\S]*\]/)
          if (!jsonMatch) {
            settle({ error: 'No JSON array found in output' })
            return
          }

          const commands = JSON.parse(jsonMatch[0])

          if (!Array.isArray(commands)) {
            settle({ error: 'Parsed output is not a JSON array' })
            return
          }

          // Validate all elements are strings
          const valid = commands.every(cmd => typeof cmd === 'string')
          if (!valid) {
            settle({ error: 'Output contains non-string elements' })
            return
          }

          await ActivityLog.append(projectPath, `DEBUG: Successfully parsed ${commands.length} commands`, 'warn')

          clearTimeout(timeoutId)
          settle({ commands })
        } catch (e) {
          settle({ error: `Failed to parse output: ${e.message}` })
        }
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
