// Authentication management for Qwen Code CLI
// Handles reading/writing ~/.qwen/settings.json and ~/.qwen/.env

const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const https = require('https')
const http = require('http')

/**
 * Validate that ~/.qwen/settings.json exists and has required fields
 * @returns {Promise<boolean>}
 */
async function validateQwenAuth() {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.qwen', 'settings.json'), 'utf8')
    const s = JSON.parse(raw)
    const hasAuth = s?.security?.auth?.selectedType || s?.selectedType
    const hasModel = s?.model?.name || s?.modelProviders
    return !!(hasAuth && hasModel)
  } catch {
    return false
  }
}

/**
 * Get the default base URL for a provider
 * @param {string} provider - Provider name
 * @returns {string} Default base URL
 */
function getDefaultBaseUrl(provider) {
  const defaults = {
    'openai': 'https://api.openai.com/v1',
    'modelscope': 'https://api-inference.modelscope.cn/v1',
    'openrouter': 'https://openrouter.ai/api/v1',
    'alibaba': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'alibaba-coding': 'https://coding.dashscope.aliyuncs.com/v1', // Alibaba Bailian Coding Plan
    'qwen': 'https://portal.qwen.ai/v1', // Qwen Portal
    'azure': 'https://api.openai.com/v1', // Azure uses custom URL per region
  }
  return defaults[provider] || 'https://api.openai.com/v1'
}

/**
 * Configure Qwen authentication by writing to ~/.qwen/settings.json
 * @param {Object} config - Auth configuration
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function configureQwenAuth(config) {
  try {
    const qwenDir = path.join(os.homedir(), '.qwen')
    const settingsPath = path.join(qwenDir, 'settings.json')
    
    // Ensure ~/.qwen directory exists
    await fs.mkdir(qwenDir, { recursive: true })
    
    // Read existing settings or start fresh
    let settings
    try {
      const raw = await fs.readFile(settingsPath, 'utf8')
      settings = JSON.parse(raw)
    } catch {
      settings = {}
    }
    
    // Update auth configuration
    settings.security = settings.security || {}
    settings.security.auth = {
      selectedType: config.provider || 'api-key',
    }
    
    settings.model = settings.model || {}
    if (config.modelName) {
      settings.model.name = config.modelName
    }
    
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    
    // Write API key to ~/.qwen/.env
    const envPath = path.join(qwenDir, '.env')
    let envContent = ''
    try {
      envContent = await fs.readFile(envPath, 'utf8')
    } catch {
      // File doesn't exist, start fresh
    }
    
    // Update or add OPENAI_API_KEY
    const apiKeyLine = `OPENAI_API_KEY=${config.apiKey}`
    const baseUrl = config.baseUrl || getDefaultBaseUrl(config.provider)
    const baseUrlLine = `OPENAI_BASE_URL=${baseUrl}`
    
    // Remove existing OPENAI_API_KEY and OPENAI_BASE_URL lines
    const lines = envContent.split('\n').filter(line => {
      return !line.startsWith('OPENAI_API_KEY=') && !line.startsWith('OPENAI_BASE_URL=')
    })
    
    // Add new lines
    lines.push(apiKeyLine)
    lines.push(baseUrlLine)
    
    await fs.writeFile(envPath, lines.join('\n'), 'utf8')
    
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * Test the authentication by calling the /models endpoint (free, no token usage)
 * For providers that don't support /models, falls back to a minimal chat completion
 * @param {Object} config - Auth configuration (provider, apiKey, baseUrl, modelName)
 * @returns {Promise<{ok: boolean, error?: string, message?: string}>}
 */
async function testQwenAuth(config) {
  const baseUrl = config.baseUrl || getDefaultBaseUrl(config.provider)
  const apiKey = config.apiKey
  const modelName = config.modelName
  const provider = config.provider

  // Require API key
  if (!apiKey) {
    return { ok: false, error: 'API key is required' }
  }

  // Providers that don't support /models endpoint - need chat completion test
  const requiresChatTest = ['azure']

  // Try /models endpoint first (free, no cost)
  if (!requiresChatTest.includes(provider)) {
    const modelsResult = await testModelsEndpoint(baseUrl, apiKey, provider)
    if (modelsResult.ok) {
      // Check if the specified model exists in the list
      if (modelName && modelsResult.models && modelsResult.models.length > 0) {
        const modelFound = modelsResult.models.some(m => {
          const apiModelId = m.id.toLowerCase()
          const inputModelId = modelName.toLowerCase()

          // Exact match
          if (apiModelId === inputModelId) return true

          // Match without :free, :plus, :extended suffixes
          const apiModelIdBase = apiModelId.split(':')[0]
          const inputModelIdBase = inputModelId.split(':')[0]
          if (apiModelIdBase === inputModelIdBase) return true

          // Match if API model ends with input model (handles provider prefix differences)
          if (apiModelId.endsWith('/' + inputModelId)) return true
          if (apiModelId.endsWith(inputModelId)) return true

          // Match if input model ends with API model (handles user adding extra suffix)
          if (inputModelId.endsWith(apiModelId)) return true

          // Match ignoring version numbers and special chars
          const normalize = (id) => id.replace(/[:/\-.]/g, '').toLowerCase()
          if (normalize(apiModelId) === normalize(inputModelId)) return true

          return false
        })
        // If model found in list, success
        if (modelFound) {
          return { ok: true, message: `Connection successful - ${modelsResult.message}` }
        }
        // Model not found in list - fall through to chat completion test
        // The /models list may be incomplete or use different ID format
      }
      // Empty models list - fall through to chat completion test to verify model
    }
    // /models failed - fall through to chat completion test for non-Azure providers
    if (provider === 'azure') {
      return modelsResult // Azure doesn't support /models, return the error
    }
  }

  // Fall back to minimal chat completion (may incur minimal cost)
  if (!modelName) {
    return { ok: false, error: 'Model name is required for connection test' }
  }

  return testChatCompletion(baseUrl, apiKey, modelName)
}

/**
 * Test the /models endpoint (free, no token usage)
 * @param {string} baseUrl - API base URL
 * @param {string} apiKey - API key
 * @param {string} provider - Provider name for header customization
 * @returns {Promise<{ok: boolean, error?: string, message?: string, models?: Array}>}
 */
async function testModelsEndpoint(baseUrl, apiKey, provider) {
  return new Promise((resolve) => {
    let url
    try {
      // Normalize baseUrl to end with '/' for correct URL resolution
      const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
      url = new URL('models', normalizedBase)
    } catch (e) {
      resolve({ ok: false, error: 'Invalid base URL format' })
      return
    }

    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    }
    
    // OpenRouter requires/recommends these headers
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/jarvix'
      headers['X-OpenRouter-Title'] = 'JARVIX'
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: headers,
      timeout: 10000,
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        // Check if response is HTML (indicates wrong URL or error page)
        const contentType = res.headers['content-type'] || ''
        if (contentType.includes('text/html') || data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
          resolve({ ok: false, error: 'API returned HTML instead of JSON - check base URL' })
          return
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const response = JSON.parse(data)
            const models = response.data || response.models || []
            resolve({
              ok: true,
              message: `Connection successful - ${models.length} models available`,
              models: models
            })
          } catch (e) {
            resolve({ ok: false, error: 'Failed to parse API response' })
          }
        } else {
          try {
            const error = JSON.parse(data)
            resolve({ ok: false, error: `API returned error: ${error.error?.message || data}` })
          } catch {
            resolve({ ok: false, error: `API returned HTTP ${res.statusCode}` })
          }
        }
      })
    })

    req.on('error', (e) => {
      resolve({ ok: false, error: `Connection failed: ${e.message}` })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'Connection timed out after 10 seconds' })
    })

    req.end()
  })
}

/**
 * Test chat completion endpoint (may incur minimal cost)
 * @param {string} baseUrl - API base URL
 * @param {string} apiKey - API key
 * @param {string} modelName - Model name to test
 * @returns {Promise<{ok: boolean, error?: string, message?: string}>}
 */
async function testChatCompletion(baseUrl, apiKey, modelName) {
  return new Promise((resolve) => {
    let url
    try {
      // Normalize baseUrl to end with '/' for correct URL resolution
      const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
      url = new URL('chat/completions', normalizedBase)
    } catch (e) {
      resolve({ ok: false, error: 'Invalid base URL format' })
      return
    }

    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const requestBody = JSON.stringify({
      model: modelName,
      messages: [
        { role: 'user', content: 'OK' }
      ],
      max_tokens: 1
    })

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      timeout: 15000,
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        // Check if response is HTML (indicates wrong URL or error page)
        const contentType = res.headers['content-type'] || ''
        if (contentType.includes('text/html') || data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
          resolve({ ok: false, error: 'API returned HTML instead of JSON - check base URL' })
          return
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const response = JSON.parse(data)
            if (response.choices && response.choices.length > 0) {
              resolve({ ok: true, message: `Connection successful - ${modelName} responded` })
            } else {
              resolve({ ok: false, error: 'API returned empty response' })
            }
          } catch (e) {
            resolve({ ok: false, error: 'Failed to parse response' })
          }
        } else {
          try {
            const error = JSON.parse(data)
            resolve({ ok: false, error: `API returned error: ${error.error?.message || data}` })
          } catch {
            resolve({ ok: false, error: `API returned HTTP ${res.statusCode}` })
          }
        }
      })
    })

    req.on('error', (e) => {
      resolve({ ok: false, error: `Connection failed: ${e.message}` })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'Connection timed out after 15 seconds' })
    })

    req.write(requestBody)
    req.end()
  })
}

/**
 * Get current authentication settings from ~/.qwen/settings.json and ~/.qwen/.env
 * @returns {Promise<{provider?: string, apiKeyMasked?: string, baseUrl?: string, modelName?: string, configured: boolean}>}
 */
async function getAuthSettings() {
  try {
    const settingsPath = path.join(os.homedir(), '.qwen', 'settings.json')
    const envPath = path.join(os.homedir(), '.qwen', '.env')

    // Read settings.json
    let settings = {}
    try {
      const raw = await fs.readFile(settingsPath, 'utf8')
      settings = JSON.parse(raw)
    } catch {
      return { configured: false }
    }

    // Read .env file for API key and base URL
    let apiKey = ''
    let baseUrl = ''
    try {
      const envRaw = await fs.readFile(envPath, 'utf8')
      const lines = envRaw.split('\n')
      for (const line of lines) {
        if (line.startsWith('OPENAI_API_KEY=')) {
          apiKey = line.substring('OPENAI_API_KEY='.length).trim()
        } else if (line.startsWith('OPENAI_BASE_URL=')) {
          baseUrl = line.substring('OPENAI_BASE_URL='.length).trim()
        }
      }
    } catch {
      // .env file doesn't exist
    }

    // Get provider from settings
    const provider = settings?.security?.auth?.selectedType || 'openai'
    const modelName = settings?.model?.name || ''

    // If baseUrl not in .env, use default for provider
    if (!baseUrl) {
      baseUrl = getDefaultBaseUrl(provider)
    }

    // Mask API key: show first 5 and last 5 characters
    let apiKeyMasked = ''
    if (apiKey && apiKey.length > 10) {
      apiKeyMasked = apiKey.substring(0, 5) + '...' + apiKey.substring(apiKey.length - 5)
    } else if (apiKey) {
      apiKeyMasked = '...'
    }

    return {
      configured: !!apiKey,
      provider,
      apiKeyMasked,
      apiKeyFull: apiKey, // Include full key for pre-filling (will be masked in UI)
      baseUrl,
      modelName,
    }
  } catch (e) {
    console.error('[getAuthSettings] Error:', e.message)
    return { configured: false }
  }
}

module.exports = { validateQwenAuth, configureQwenAuth, testQwenAuth, getDefaultBaseUrl, getAuthSettings, isOAuthEnabled, setOAuthEnabled, restoreQwenSettingsToOAuthDefaults }

/**
 * Check if OAuth is enabled in app settings
 * @returns {Promise<boolean>}
 */
async function isOAuthEnabled() {
  try {
    const Settings = require('./settings')
    const settings = await Settings.load()
    return !!settings.oauthEnabled
  } catch (e) {
    console.error('[isOAuthEnabled] Error:', e.message)
    return false
  }
}

/**
 * Enable or disable OAuth mode in app settings
 * @param {boolean} enabled - Whether OAuth should be enabled
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function setOAuthEnabled(enabled) {
  try {
    const Settings = require('./settings')
    const settings = await Settings.load()
    settings.oauthEnabled = enabled
    return await Settings.save(settings)
  } catch (e) {
    console.error('[setOAuthEnabled] Error:', e.message)
    return { error: e.message }
  }
}

/**
 * Restore ~/.qwen/settings.json to OAuth defaults
 * This writes the default Qwen OAuth configuration
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function restoreQwenSettingsToOAuthDefaults() {
  try {
    const fs = require('fs/promises')
    const path = require('path')
    const os = require('os')
    
    const qwenDir = path.join(os.homedir(), '.qwen')
    const settingsPath = path.join(qwenDir, 'settings.json')
    
    // Ensure ~/.qwen directory exists
    await fs.mkdir(qwenDir, { recursive: true })
    
    // Write default OAuth settings
    const oauthDefaults = {
      model: {
        name: 'coder-model'
      },
      '$version': 3,
      security: {
        auth: {
          selectedType: 'qwen-oauth'
        }
      }
    }
    
    await fs.writeFile(settingsPath, JSON.stringify(oauthDefaults, null, 2), 'utf8')
    
    return { ok: true }
  } catch (e) {
    console.error('[restoreQwenSettingsToOAuthDefaults] Error:', e.message)
    return { error: e.message }
  }
}
