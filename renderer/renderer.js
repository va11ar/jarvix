// ═══════════════════════════════════════════════════════════════════════════
// JARVIX Renderer — All UI logic, state object, IPC event handlers
// ═══════════════════════════════════════════════════════════════════════════

'use strict'

// ─── State Object — Single Source of Truth ──────────────────────────────────
const state = {
  // App state
  currentProject: null,
  pipelineState: 'idle',
  agents: [],
  projects: [],

  // Agent load errors (permission issues, etc.)
  agentLoadErrors: [],

  // Pipeline state
  pipelineSteps: [],
  currentStepIndex: -1,
  selectedAgentId: null,
  selectedNodeIndex: -1,
  selectedLibraryAgentId: null, // Track library agent selection separately

  // Agent output
  agentOutputs: new Map(), // agentId -> content

  // Activity log
  logEntries: [],

  // Auth state
  qwenAuthConfigured: true, // Assume true until proven otherwise

  // New Project Dialog state
  npStep: 1,
  npAllowedCommands: new Set(),
  npSelectedAgents: [],
  npDragSrc: null,
  npTotalAgents: 0,

  // Edit warning dialog state
  editingAgentId: null,

  // Discovery pre-flight state per §10
  preflightPhase: null, // null | 'loading' | 'choice' | 'sandbox-warning' | 'approve-list' | 'decline-warning'
  preflightDelta: [],   // Discovered commands not in baseline
  preflightDockerError: false,
}

const NP_STEP_SUBTITLES = [
  'Step 1 of 4 — Name & Location',
  'Step 2 of 4 — Project Stack',
  'Step 3 of 4 — Command Whitelist',
  'Step 4 of 4 — Select Agents',
]

// ─── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  wireEventListeners()
  wireNewProjectDialog()
  await loadInitialData()
  setupIPCListeners()
})

async function loadInitialData() {
  try {
    const [agentResult, projects, firstLaunchResult] = await Promise.all([
      window.api.listAgents(),
      window.api.listProjects(),
      window.api.checkFirstLaunch(),
    ])
    state.agents = agentResult?.agents || []
    state.agentLoadErrors = agentResult?.errors || []
    state.projects = projects || []
    updateStatusBar()

    // Show first-launch dialog if this is the first launch
    if (firstLaunchResult?.isFirst) {
      showDialog('dialog-first-launch')
    } else if (!state.currentProject) {
      // Show welcome dialog if no project is open (not first launch)
      showDialog('dialog-welcome')
    }
  } catch (e) {
    appendLogLine('Failed to load initial data: ' + e.message, 'error')
  }
}

function setupIPCListeners() {
  window.api.onPipelineStatus((data) => {
    handlePipelineStatus(data)
  })

  window.api.onLogUpdated((data) => {
    appendLogLine(data.message, data.type, data.time)
  })

  window.api.onAgentDefinitionChanged((data) => {
    handleAgentDefinitionChanged(data)
  })

  window.api.onIncompleteRunDetected((data) => {
    handleIncompleteRunDetected(data)
  })

  window.api.onWindowFocus(() => {
    handleWindowFocus()
  })

  // Discovery pre-flight listeners
  window.api.onDiscoveryStarted(() => {
    handleDiscoveryStarted()
  })

  window.api.onDiscoveryComplete((data) => {
    handleDiscoveryComplete(data)
  })

  window.api.onDiscoveryError((data) => {
    handleDiscoveryError(data)
  })

  // Qwen installation listener
  window.api.onQwenNotFound((data) => {
    handleQwenNotFound(data)
  })
}

// ─── Event Listeners ────────────────────────────────────────────────────────

function wireEventListeners() {
  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimizeWindow())
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximizeWindow())
  document.getElementById('btn-close').addEventListener('click', () => window.api.closeWindow())

  // Pipeline controls
  document.getElementById('btn-start').addEventListener('click', handleStart)
  document.getElementById('btn-pause').addEventListener('click', togglePause)
  document.getElementById('btn-abort').addEventListener('click', handleAbort)

  // Agent controls
  document.getElementById('btn-continue').addEventListener('click', handleContinue)
  document.getElementById('btn-edit-output').addEventListener('click', handleEditOutput)
  document.getElementById('btn-kill-agent').addEventListener('click', handleKillAgent)

  // Activity log
  document.getElementById('btn-clear-log').addEventListener('click', clearLog)

  // Pipeline structure buttons
  document.getElementById('btn-add-agent').addEventListener('click', openAddAgentDialog)
  document.getElementById('btn-remove-agent').addEventListener('click', handleRemoveAgent)
  document.getElementById('btn-skip-agent').addEventListener('click', handleSkipAgent)

  // Add Agent dialog cancel button
  document.getElementById('btn-add-agent-cancel').addEventListener('click', () => {
    hideDialog('dialog-add-agent')
  })

  // Create Agent button (sidebar)
  document.getElementById('btn-create-agent').addEventListener('click', async () => {
    try {
      const result = await window.api.createBoilerplateAgent()
      if (result.error) {
        appendLogLine('Failed to create agent: ' + result.error, 'error')
        return
      }
      appendLogLine('Agent created and opened in editor', 'ok')
      // Reload agents list
      const result2 = await window.api.listAgents()
      state.agents = result2?.agents || []
      renderLibraryAgents()
    } catch (e) {
      appendLogLine('Failed to create agent: ' + e.message, 'error')
    }
  })

  // Refresh agents button
  document.getElementById('btn-refresh-agents').addEventListener('click', async () => {
    try {
      const result = await window.api.listAgents()
      state.agents = result?.agents || []
      renderLibraryAgents()
      appendLogLine('Agents list refreshed', 'info')
    } catch (e) {
      appendLogLine('Failed to refresh agents: ' + e.message, 'error')
    }
  })

  // Welcome dialog
  document.getElementById('btn-welcome-new').addEventListener('click', () => {
    hideDialog('dialog-welcome')
    openNewProjectDialog()
  })
  document.getElementById('btn-welcome-open').addEventListener('click', async () => {
    hideDialog('dialog-welcome')
    await openProjectDialog()
  })

  // First-launch dialog
  document.getElementById('btn-first-launch-create').addEventListener('click', async () => {
    try {
      const result = await window.api.createBoilerplateAgent()
      if (result.error) {
        appendLogLine('Failed to create boilerplate agent: ' + result.error, 'error')
        return
      }
      // Mark first launch as done
      await window.api.markFirstLaunchDone()
      hideDialog('dialog-first-launch')
      appendLogLine('Boilerplate agent created and opened in editor', 'ok')
      // After creating agent, show new project dialog
      openNewProjectDialog()
    } catch (e) {
      appendLogLine('Failed to create boilerplate agent: ' + e.message, 'error')
    }
  })

  document.getElementById('btn-first-launch-cancel').addEventListener('click', async () => {
    // Mark first launch as done even if user cancels
    await window.api.markFirstLaunchDone()
    hideDialog('dialog-first-launch')
    // Show new project dialog anyway - user can create project without agents
    openNewProjectDialog()
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', async (e) => {
    const isCtrl = e.ctrlKey || e.metaKey
    if (!isCtrl) return

    // Don't trigger shortcuts when typing in an input field
    const tag = e.target.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return

    if (e.key === 'n') {
      e.preventDefault()
      // Check if pipeline is active
      if (state.pipelineState === 'running' || state.pipelineState === 'paused') {
        appendLogLine('Cannot create new project while pipeline is active. Stop the pipeline first.', 'warn')
        return
      }
      openNewProjectDialog()
    } else if (e.key === 'o') {
      e.preventDefault()
      // Check if pipeline is active
      if (state.pipelineState === 'running' || state.pipelineState === 'paused') {
        appendLogLine('Cannot open another project while pipeline is active. Stop the pipeline first.', 'warn')
        return
      }
      await openProjectDialog()
    }
  })
}

// ─── Pipeline Status Handler ────────────────────────────────────────────────

function handlePipelineStatus(data) {
  // Only update pipeline state for actual pipeline states, not transient events
  const validPipelineStates = ['idle', 'running', 'paused', 'complete', 'error', 'aborted']
  if (validPipelineStates.includes(data.state)) {
    state.pipelineState = data.state
  }
  state.pipelineSteps = data.steps || []
  state.currentStepIndex = data.currentStepIndex

  // Handle review-loop state
  if (data.state === 'review-loop' && data.loopType) {
    updateReviewPips(data.agentId, data.loopCount, data.maxLoops, data.loopType)
  }

  // Handle max-loops-reached state
  if (data.state === 'max-loops-reached') {
    const agent = state.agents.find(a => a.id === data.agentId)
    appendLogLine(`Max review loops reached for ${agent?.name || 'Unknown'}`, 'warn')
  }

  updateTitlebarStatus()
  renderPipelineAgents()
  renderPipelineCanvas()
  updateDetailPanel()
  updateAgentControls()
  setPipelineControlsDisabled(state.pipelineSteps.length === 0)
}

// ─── Discovery Pre-flight Handlers ──────────────────────────────────────────

function handleDiscoveryStarted() {
  // State A — Loading screen
  state.preflightPhase = 'loading'
  state.preflightDockerError = false
  showOverlay('overlay-discovery')
}

function handleDiscoveryComplete(data) {
  // State B — Pre-flight modal
  hideOverlay('overlay-discovery')
  state.preflightPhase = 'choice'
  state.preflightDelta = data.delta || []
  renderPreflightModal()
  showDialog('dialog-preflight')
}

function handleDiscoveryError(data) {
  hideOverlay('overlay-discovery')
  state.preflightDockerError = !!data.dockerRequired
  state.preflightPhase = data.dockerRequired ? 'sandbox-warning' : 'decline-warning'
  renderPreflightModal()
  showDialog('dialog-preflight')
}

function renderPreflightModal() {
  const body = document.getElementById('preflight-body')
  const footer = document.getElementById('preflight-footer')
  const title = document.getElementById('preflight-title')

  // Clear existing content
  body.innerHTML = ''
  footer.innerHTML = ''

  switch (state.preflightPhase) {
    case 'choice':
      renderPreflightChoice(body, footer, title)
      break
    case 'sandbox-warning':
      renderPreflightSandboxWarning(body, footer, title)
      break
    case 'approve-list':
      renderPreflightApproveList(body, footer, title)
      break
    case 'decline-warning':
      renderPreflightDeclineWarning(body, footer, title)
      break
  }
}

function renderPreflightChoice(body, footer, title) {
  title.textContent = 'The next step will write code and execute commands'

  body.innerHTML = `
    <p style="color:var(--text-dim);line-height:1.6;margin-bottom:16px;">
      The next pipeline step is a programmer agent. It will write code and run shell commands
      on your file system.
    </p>
    <p style="color:var(--text-dim);line-height:1.6;margin-bottom:16px;">
      Jarvix can scan your project documents and infer which commands this agent will likely need.
      You can then review and approve them.
    </p>
    <p style="color:var(--text-dim);line-height:1.6;">
      Alternatively, if you trust the AI provider you are using, you can allow the agent to run
      any command inside a sandboxed environment. Sandbox mode uses Docker to isolate the agent
      from your system. Note: sandbox mode requires Docker to be running, and while it provides
      meaningful protection, it is not a complete safety net.
    </p>
  `

  const sandboxBtn = document.createElement('button')
  sandboxBtn.className = 'footer-btn'
  sandboxBtn.textContent = 'Use Sandbox Mode'
  sandboxBtn.addEventListener('click', () => {
    window.api.discoveryUserSandbox()
  })

  const inferBtn = document.createElement('button')
  inferBtn.className = 'footer-btn primary'
  inferBtn.textContent = 'Infer Commands'
  inferBtn.addEventListener('click', () => {
    state.preflightPhase = 'approve-list'
    renderPreflightModal()
  })

  footer.appendChild(sandboxBtn)
  footer.appendChild(inferBtn)
}

function renderPreflightSandboxWarning(body, footer, title) {
  title.textContent = 'Sandbox mode: important limitations'

  if (state.preflightDockerError) {
    body.innerHTML = `
      <p style="color:var(--text-dim);line-height:1.6;margin-bottom:16px;">
        Sandbox mode requires Docker. Docker was not detected on this system.
        Please install and start Docker, then try again.
      </p>
    `

    const retryBtn = document.createElement('button')
    retryBtn.className = 'footer-btn'
    retryBtn.textContent = 'Retry'
    retryBtn.addEventListener('click', () => {
      window.api.discoveryUserSandbox()
    })

    const backBtn = document.createElement('button')
    backBtn.className = 'footer-btn primary'
    backBtn.textContent = 'Choose Differently'
    backBtn.addEventListener('click', () => {
      state.preflightPhase = 'choice'
      state.preflightDockerError = false
      renderPreflightModal()
    })

    footer.appendChild(retryBtn)
    footer.appendChild(backBtn)
  } else {
    body.innerHTML = `
      <p style="color:var(--text-dim);line-height:1.6;margin-bottom:16px;">
        In sandbox mode, the programmer agent can execute any shell command. Docker provides
        isolation from your file system, but sandbox mode is not a complete safety net.
      </p>
      <p style="color:var(--text-dim);line-height:1.6;">
        Are you sure you want to continue without command restrictions?
      </p>
    `

    const continueBtn = document.createElement('button')
    continueBtn.className = 'footer-btn'
    continueBtn.textContent = 'Continue with Sandbox'
    continueBtn.addEventListener('click', () => {
      window.api.discoveryUserSandbox()
    })

    const backBtn = document.createElement('button')
    backBtn.className = 'footer-btn primary'
    backBtn.textContent = 'Go Back'
    backBtn.addEventListener('click', () => {
      state.preflightPhase = 'choice'
      renderPreflightModal()
    })

    footer.appendChild(continueBtn)
    footer.appendChild(backBtn)
  }
}

function renderPreflightApproveList(body, footer, title) {
  title.textContent = 'Approve commands for the programmer agent'

  if (state.preflightDelta.length === 0) {
    // All commands already approved — close modal and continue
    hideDialog('dialog-preflight')
    window.api.discoveryUserApprove()
    return
  }

  const commandListHtml = state.preflightDelta.map(cmd =>
    `<div class="command-row-readonly">${escapeHtml(cmd)}</div>`
  ).join('')

  body.innerHTML = `
    <div style="margin-bottom:16px;">
      ${commandListHtml}
    </div>
    <p style="color:var(--text-dim);line-height:1.6;font-size:10px;">
      These commands were not found in your current project whitelist. The programmer agent will
      need them to complete its work. If you decline, the agent will not be able to run these
      commands and the pipeline will fail.
    </p>
  `

  const declineBtn = document.createElement('button')
  declineBtn.className = 'footer-btn'
  declineBtn.textContent = 'Decline'
  declineBtn.addEventListener('click', () => {
    state.preflightPhase = 'decline-warning'
    renderPreflightModal()
  })

  const allowBtn = document.createElement('button')
  allowBtn.className = 'footer-btn primary'
  allowBtn.textContent = 'Allow All'
  allowBtn.addEventListener('click', () => {
    window.api.discoveryUserApprove()
    hideDialog('dialog-preflight')
  })

  footer.appendChild(declineBtn)
  footer.appendChild(allowBtn)
}

function renderPreflightDeclineWarning(body, footer, title) {
  title.textContent = 'Pipeline cannot continue without these commands'

  body.innerHTML = `
    <p style="color:var(--text-dim);line-height:1.6;margin-bottom:16px;">
      The programmer agent requires these commands to do its work. Without them, the pipeline
      will fail when the agent attempts to run them.
    </p>
  `

  const approveBtn = document.createElement('button')
  approveBtn.className = 'footer-btn'
  approveBtn.textContent = 'Approve Commands'
  approveBtn.addEventListener('click', () => {
    state.preflightPhase = 'approve-list'
    renderPreflightModal()
  })

  const abortBtn = document.createElement('button')
  abortBtn.className = 'footer-btn primary'
  abortBtn.textContent = 'Decline and Abort'
  abortBtn.addEventListener('click', () => {
    window.api.discoveryUserAbort()
    hideDialog('dialog-preflight')
  })

  footer.appendChild(approveBtn)
  footer.appendChild(abortBtn)
}

// ─── Qwen Installation Not Found Handler ────────────────────────────────────

let qwenResponseCallback = null

function handleQwenNotFound(data) {
  // Show the Qwen not found dialog
  const commandDisplay = document.getElementById('qwen-command-display')
  if (commandDisplay) {
    commandDisplay.textContent = data.command || 'qwen'
  }
  
  // Log to Activity Log
  appendLogLine('Could not find Qwen CLI installation', 'error')
  
  // Show dialog
  showDialog('dialog-qwen-not-found')
  
  // Setup button handlers
  const okBtn = document.getElementById('btn-qwen-ok')
  const browseBtn = document.getElementById('btn-qwen-browse')
  
  // Remove old listeners by cloning
  const newOkBtn = okBtn.cloneNode(true)
  const newBrowseBtn = browseBtn.cloneNode(true)
  okBtn.parentNode.replaceChild(newOkBtn, okBtn)
  browseBtn.parentNode.replaceChild(newBrowseBtn, browseBtn)
  
  // OK button - dismiss dialog and abort
  newOkBtn.addEventListener('click', () => {
    hideDialog('dialog-qwen-not-found')
    if (qwenResponseCallback) {
      qwenResponseCallback({ action: 'cancel' })
      qwenResponseCallback = null
    }
  })
  
  // Browse button - open file explorer
  newBrowseBtn.addEventListener('click', async () => {
    try {
      const selectedPath = await window.api.browseQwenInstallation()
      if (selectedPath) {
        // User selected a path - save it and continue
        const saveResult = await window.api.setQwenPath(selectedPath)
        if (saveResult.error) {
          appendLogLine('Failed to save Qwen path: ' + saveResult.error, 'error')
          hideDialog('dialog-qwen-not-found')
          if (qwenResponseCallback) {
            qwenResponseCallback({ action: 'cancel' })
            qwenResponseCallback = null
          }
          return
        }
        
        // Path saved - notify main process to continue
        hideDialog('dialog-qwen-not-found')
        if (qwenResponseCallback) {
          qwenResponseCallback({ action: 'browse', path: selectedPath })
          qwenResponseCallback = null
        }
      } else {
        // User canceled the folder picker - stay on dialog
        appendLogLine('Folder selection canceled', 'info')
      }
    } catch (e) {
      appendLogLine('Failed to browse for Qwen installation: ' + e.message, 'error')
      hideDialog('dialog-qwen-not-found')
      if (qwenResponseCallback) {
        qwenResponseCallback({ action: 'cancel' })
        qwenResponseCallback = null
      }
    }
  })
  
  // Setup the callback that will be called when user responds
  qwenResponseCallback = (response) => {
    window.api.qwenUserResponse(response)
  }
}

// ─── Agent Definition Changed Handler ───────────────────────────────────────

async function handleAgentDefinitionChanged(data) {
  const { agentId } = data
  // Reload agents list
  try {
    const result = await window.api.listAgents()
    state.agents = result?.agents || []
    renderLibraryAgents()

    // Show edit warning dialog
    const projects = state.projects.filter(p =>
      p.steps && p.steps.some(s => s.agent_id === agentId)
    )
    document.getElementById('edit-warning-projects').textContent = projects.map(p => p.name).join(', ')
    state.editingAgentId = agentId
    showDialog('dialog-edit-warning')
  } catch (e) {
    appendLogLine('Failed to reload agents: ' + e.message, 'error')
  }
}

// ─── Incomplete Run Detected Handler ────────────────────────────────────────

function handleIncompleteRunDetected(data) {
  const { projectPath, projectName, incompleteStep } = data
  appendLogLine(`Incomplete run detected in ${projectName}: ${incompleteStep.agent_name || 'Unknown agent'}`, 'warn')
  // Could show a resume dialog here
}

// ─── Window Focus Handler ───────────────────────────────────────────────────

async function handleWindowFocus() {
  // Check for agent file changes when window regains focus
  if (state.editingAgentId) {
    try {
      const result = await window.api.checkAgentChanges(state.editingAgentId)
      if (result.changed) {
        // Trigger the edit warning flow
        await handleAgentDefinitionChanged({ agentId: state.editingAgentId })
      }
    } catch (e) {
      // Ignore errors
    }
  }
}

// ─── Titlebar & Status Updates ──────────────────────────────────────────────

function updateTitlebarStatus() {
  const pill = document.getElementById('status-pill')
  const startBtn = document.getElementById('btn-start')
  const pauseBtn = document.getElementById('btn-pause')
  const pauseIcon = document.getElementById('pause-icon')

  pill.className = 'tb-pill ' + state.pipelineState

  const statusText = state.pipelineState.charAt(0).toUpperCase() + state.pipelineState.slice(1)
  pill.textContent = statusText

  // Show/hide buttons based on pipeline state
  // Start: visible when idle or complete, hidden when running or paused
  // Pause: visible when running or paused, hidden when idle or complete
  // Pause icon: ⏸ when running (to pause), ▶ when paused (to resume)
  if (state.pipelineState === 'running') {
    startBtn.style.display = 'none'
    pauseBtn.style.display = 'flex'
    pauseIcon.textContent = '⏸'
    pauseBtn.classList.remove('paused')
    pauseBtn.setAttribute('data-tip', 'Pause')
    pauseBtn.setAttribute('aria-label', 'Pause')
  } else if (state.pipelineState === 'paused') {
    startBtn.style.display = 'none'
    pauseBtn.style.display = 'flex'
    pauseIcon.textContent = '▶'
    pauseBtn.classList.add('paused')
    pauseBtn.setAttribute('data-tip', 'Resume')
    pauseBtn.setAttribute('aria-label', 'Resume')
  } else if (state.pipelineState === 'complete') {
    // Pipeline complete - show Start button to re-run, hide pause
    startBtn.style.display = 'flex'
    pauseBtn.style.display = 'none'
  } else {
    // idle
    startBtn.style.display = 'flex'
    pauseBtn.style.display = 'flex'
    pauseIcon.textContent = '⏸'
    pauseBtn.classList.remove('paused')
    pauseBtn.setAttribute('data-tip', 'Pause')
    pauseBtn.setAttribute('aria-label', 'Pause')
  }
}

function updateStatusBar() {
  document.getElementById('sb-agents-count').textContent = state.agents.length
  document.getElementById('sb-projects-count').textContent = state.projects.length
}

// ─── Pipeline Rendering ─────────────────────────────────────────────────────

function renderPipelineAgents() {
  const list = document.getElementById('pipeline-agents-list')
  list.innerHTML = ''

  // Show empty state if no agents in pipeline
  if (state.pipelineSteps.length === 0) {
    list.innerHTML = `
      <div class="pipeline-agents-empty">
        <div class="pipeline-agents-empty-text">No agents in pipeline</div>
      </div>
    `
    // Disable pipeline controls
    setPipelineControlsDisabled(true)
    return
  }

  state.pipelineSteps.forEach((step, index) => {
    const agentName = step.agent_name || 'Unknown'
    const item = document.createElement('div')
    item.className = 'agent-item'
    item.dataset.agentId = step.agent_id
    item.dataset.index = index
    item.setAttribute('draggable', 'true')

    // Check for skipped status first
    const isSkipped = step.status === 'skipped'

    // Determine state class
    // When pipeline is complete, all steps are complete
    if (isSkipped) {
      item.classList.add('skipped')
      item.setAttribute('title', 'This agent will be skipped during the pipeline run')
    } else if (state.pipelineState === 'complete' || index < state.currentStepIndex) {
      item.classList.add('complete')
    } else if (index === state.currentStepIndex) {
      if (state.pipelineState === 'running') {
        item.classList.add('running')
      } else if (state.pipelineState === 'error') {
        item.classList.add('error')
      }
    }

    if (item.dataset.agentId === state.selectedAgentId) {
      item.classList.add('selected')
    }

    // State tag: all done when complete, otherwise based on currentStepIndex
    const stateTag = isSkipped ? 'skip' :
                     (state.pipelineState === 'complete' || index < state.currentStepIndex) ? 'done' :
                     index === state.currentStepIndex ? 'run' : 'idle'

    // Selection indicator: triangle for selected, nothing for others
    const selectionIndicator = item.dataset.agentId === state.selectedAgentId
      ? '<div class="agent-triangle">▶</div>'
      : '<div class="agent-triangle-placeholder"></div>'

    // Running indicator: bold "Running" text for currently running agent
    const runningIndicator = (index === state.currentStepIndex && state.pipelineState === 'running')
      ? '<span class="agent-running-label">Running</span>'
      : ''

    item.innerHTML = `
      ${selectionIndicator}
      <div class="agent-name-wrapper">
        <div class="agent-name">${agentName}</div>
        ${runningIndicator}
      </div>
      <div class="agent-state-tag">${stateTag}</div>
    `

    item.addEventListener('click', () => selectAgent(index))
    attachDragEvents(item)
    list.appendChild(item)
  })

  // Enable pipeline controls when there are agents
  setPipelineControlsDisabled(false)
}

function setPipelineControlsDisabled(disabled) {
  // Add Agent and Create Agent are always enabled
  const alwaysEnabled = ['btn-add-agent', 'btn-create-agent']
  // These are disabled when pipeline is empty
  const disableWhenEmpty = ['btn-remove-agent']
  // These require pipeline to be paused AND have a selected agent
  const disableWhenNotPaused = ['btn-skip-agent']

  // Always enable these buttons
  alwaysEnabled.forEach(id => {
    const btn = document.getElementById(id)
    if (btn) btn.disabled = false
  })

  // Disable/enable based on whether pipeline has agents
  disableWhenEmpty.forEach(id => {
    const btn = document.getElementById(id)
    if (btn) btn.disabled = disabled
  })

  // Disable/enable based on pipeline state
  disableWhenNotPaused.forEach(id => {
    const btn = document.getElementById(id)
    if (btn) {
      const wrapper = btn.parentElement
      // Skip Agent requires: pipeline NOT running AND a selected agent
      if (state.pipelineState === 'running') {
        btn.disabled = true
        wrapper.setAttribute('data-tip', 'Pipeline must not be running to skip an agent')
      } else if (state.selectedNodeIndex === -1) {
        btn.disabled = true
        wrapper.setAttribute('data-tip', 'You need to select an agent first before you can skip or unskip')
      } else {
        // Check the selected agent's status
        const selectedStep = state.pipelineSteps[state.selectedNodeIndex]
        // Defensive: handle missing step or status
        const status = selectedStep?.status || 'idle'
        const isSkipped = status === 'skipped'
        const isComplete = status === 'complete' || status === 'error'

        if (isComplete) {
          btn.disabled = true
          wrapper.setAttribute('data-tip', 'Cannot skip a completed agent')
        } else {
          btn.disabled = false
          wrapper.setAttribute('data-tip', isSkipped ? 'Unskip this agent' : 'Skip the selected agent')
        }
      }
      // Update button text to match state
      updateSkipAgentButtonText()
    }
  })
}

function renderLibraryAgents() {
  const list = document.getElementById('library-agents-list')
  list.innerHTML = ''

  const pipelineAgentIds = new Set(state.pipelineSteps.map(s => s.agent_id))

  state.agents.forEach(agent => {
    if (pipelineAgentIds.has(agent.id)) return

    const item = document.createElement('div')
    item.className = 'library-agent'
    if (agent.id === state.selectedLibraryAgentId) {
      item.classList.add('selected')
    }
    item.innerHTML = `
      <div class="library-agent-dot"></div>
      <div class="library-agent-name">${agent.name}</div>
      <div class="library-agent-usage">—</div>
    `
    item.addEventListener('click', () => selectLibraryAgent(agent))
    list.appendChild(item)
  })
}

function renderPipelineCanvas() {
  const canvas = document.getElementById('pipeline-canvas')
  const canvasInner = document.getElementById('canvas-inner')
  canvas.innerHTML = ''

  // Show empty state if no agents in pipeline
  if (state.pipelineSteps.length === 0) {
    canvas.innerHTML = `
      <div class="pipeline-empty-state">
        <div class="pipeline-empty-icon">⊘</div>
        <div class="pipeline-empty-title">No agents in pipeline</div>
        <div class="pipeline-empty-text">
          This project has no agents configured.<br>
          Edit the pipeline to add agents and start the workflow.
        </div>
      </div>
    `
    return
  }

  state.pipelineSteps.forEach((step, index) => {
    const agentName = step.agent_name || 'Unknown'

    // Create node
    const node = document.createElement('div')
    node.className = 'pipeline-node idle'
    node.dataset.index = index
    node.dataset.agentId = step.agent_id

    // Check for skipped status first
    const isSkipped = step.status === 'skipped'

    // When pipeline is complete, all nodes are complete
    if (isSkipped) {
      node.classList.add('skipped')
      node.setAttribute('title', 'This agent will be skipped during the pipeline run')
    } else if (state.pipelineState === 'complete' || index < state.currentStepIndex) {
      node.classList.add('complete')
    } else if (index === state.currentStepIndex) {
      if (state.pipelineState === 'running') {
        node.classList.add('running')
      } else if (state.pipelineState === 'error') {
        node.classList.add('error')
      }
    }

    if (index === state.selectedNodeIndex) {
      node.classList.add('selected')
    }

    // Status text: all Complete when pipeline is complete
    const statusText = isSkipped ? 'Skipped' :
                       (state.pipelineState === 'complete' || index < state.currentStepIndex) ? 'Complete' :
                       index === state.currentStepIndex ? (state.pipelineState === 'running' ? 'Running…' : state.pipelineState) :
                       'Idle'

    node.innerHTML = `
      <div class="node-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="node-name">${agentName}</div>
      <div class="node-status">${statusText}</div>
      <div class="node-state-bar"></div>
    `

    node.addEventListener('click', (e) => {
      e.stopPropagation() // Prevent canvas click from firing
      selectAgent(index)
    })
    canvas.appendChild(node)

    // Add connector if not last
    if (index < state.pipelineSteps.length - 1) {
      const connector = document.createElement('div')
      connector.className = 'connector'
      // All connectors are done when pipeline is complete
      if (state.pipelineState === 'complete' || index < state.currentStepIndex) {
        connector.classList.add('done')
      } else if (index === state.currentStepIndex && state.pipelineState === 'running') {
        connector.classList.add('active')
      }
      connector.innerHTML = `
        <div class="connector-line"></div>
        <div class="connector-arrow">›</div>
      `
      canvas.appendChild(connector)
    }
  })

  // Add click handler to canvas for deselection
  canvas.addEventListener('click', (e) => {
    // Only deselect if clicking on the canvas itself, not a node or connector
    if (e.target === canvas) {
      deselectAgent()
    }
  })

  // Add click handler to canvas-inner for deselection
  canvasInner.addEventListener('click', (e) => {
    // Only deselect if clicking on canvas-inner directly (background area)
    if (e.target === canvasInner) {
      deselectAgent()
    }
  })
}

// ─── Agent Selection ────────────────────────────────────────────────────────

function selectAgent(index) {
  state.selectedNodeIndex = index
  state.selectedAgentId = state.pipelineSteps[index]?.agent_id

  // Update sidebar selection - use dataset.index for accurate matching
  document.querySelectorAll('#pipeline-agents-list .agent-item').forEach((item) => {
    const itemIndex = parseInt(item.dataset.index, 10)
    item.classList.toggle('selected', itemIndex === index)
  })

  // Update canvas selection - use dataset.index for accurate matching
  document.querySelectorAll('.pipeline-node').forEach((node) => {
    const nodeIndex = parseInt(node.dataset.index, 10)
    node.classList.toggle('selected', nodeIndex === index)
  })

  updateDetailPanel()
  updateAgentControls()
  setPipelineControlsDisabled(state.pipelineSteps.length === 0)
}

function deselectAgent() {
  state.selectedNodeIndex = -1
  state.selectedAgentId = null
  state.selectedLibraryAgentId = null

  // Clear sidebar selection
  document.querySelectorAll('#pipeline-agents-list .agent-item').forEach((item) => {
    item.classList.remove('selected')
  })

  // Clear canvas selection
  document.querySelectorAll('.pipeline-node').forEach((node) => {
    node.classList.remove('selected')
  })

  // Clear library selection
  document.querySelectorAll('#library-agents-list .library-agent').forEach((item) => {
    item.classList.remove('selected')
  })

  updateDetailPanel()
  updateAgentControls()
  setPipelineControlsDisabled(state.pipelineSteps.length === 0)
}

function selectLibraryAgent(agent) {
  // Clear pipeline selection
  state.selectedNodeIndex = -1
  state.selectedAgentId = null

  // Set library selection
  state.selectedLibraryAgentId = agent.id

  // Update sidebar selection for pipeline agents
  document.querySelectorAll('#pipeline-agents-list .agent-item').forEach((item) => {
    item.classList.remove('selected')
  })

  // Update library selection
  document.querySelectorAll('#library-agents-list .library-agent').forEach((item) => {
    item.classList.remove('selected')
  })
  // Re-render library to show selection
  renderLibraryAgents()

  updateDetailPanel(agent)
}

async function updateDetailPanel(libraryAgent = null) {
  // Check if a library agent is selected
  if (libraryAgent || state.selectedLibraryAgentId) {
    const agent = libraryAgent || state.agents.find(a => a.id === state.selectedLibraryAgentId)
    if (agent) {
      document.getElementById('detail-agent-name').textContent = agent.name
      document.getElementById('detail-status').textContent = 'Not in pipeline'
      document.getElementById('detail-elapsed').textContent = '—'
      document.getElementById('detail-timeout').textContent = agent ? `${agent.timeout_seconds}s` : '—'
      document.getElementById('detail-reads').textContent = agent?.reads?.length ? `${agent.reads.length} files` : 'None'
      document.getElementById('detail-output').textContent = '—'
      document.getElementById('agent-output').innerHTML = '<div class="output-placeholder">Library agents have no output until added to a pipeline</div>'

      // Hide progress bar for library agents
      document.getElementById('progress-fill').style.width = '0%'
      document.getElementById('progress-text').textContent = 'Step 0 of 0'
      document.getElementById('review-section').classList.add('hidden')
      return
    }
  }

  const index = state.selectedNodeIndex
  if (index === -1 || !state.pipelineSteps[index]) {
    document.getElementById('detail-agent-name').textContent = 'No agent selected'
    document.getElementById('detail-status').textContent = '—'
    document.getElementById('detail-elapsed').textContent = '—'
    document.getElementById('detail-timeout').textContent = '—'
    document.getElementById('detail-reads').textContent = '—'
    document.getElementById('detail-output').textContent = '—'
    document.getElementById('agent-output').innerHTML = '<div class="output-placeholder">Select an agent to view output</div>'
    return
  }

  const step = state.pipelineSteps[index]
  const agent = state.agents.find(a => a.id === step.agent_id)

  document.getElementById('detail-agent-name').textContent = agent?.name || step.agent_name || 'Unknown'
  
  // Check for skipped status
  const isSkipped = step.status === 'skipped'
  document.getElementById('detail-status').textContent = isSkipped ? 'Skipped' :
                                                         index < state.currentStepIndex ? 'Complete' :
                                                         index === state.currentStepIndex ? state.pipelineState : 'Idle'
  document.getElementById('detail-timeout').textContent = agent ? `${agent.timeout_seconds}s` : '—'
  document.getElementById('detail-reads').textContent = agent?.reads?.length ? `${agent.reads.length} files` : 'None'

  // Load output file
  if (state.currentProject && agent) {
    try {
      const outputPath = await window.api.getAgentOutputPath(state.currentProject.projectPath, agent.filePath)
      const content = await window.api.readContextFile(outputPath)
      // Store true if file exists (even if empty), false if file doesn't exist
      state.agentOutputs.set(step.agent_id, content !== undefined && content !== null)
      document.getElementById('agent-output').textContent = content || '(No output yet)'
      document.getElementById('detail-output').textContent = content ? `${(content.length / 1024).toFixed(1)} KB` : '—'
      updateAgentControls()
    } catch (e) {
      // File doesn't exist
      state.agentOutputs.set(step.agent_id, false)
      document.getElementById('agent-output').textContent = '(File not found)'
      document.getElementById('detail-output').textContent = '—'
      updateAgentControls()
    }
  }

  // Update progress bar
  const total = state.pipelineSteps.length
  const completed = state.currentStepIndex >= 0 ? state.currentStepIndex : 0
  const pct = total > 0 ? (completed / total) * 100 : 0
  document.getElementById('progress-fill').style.width = `${pct}%`
  document.getElementById('progress-text').textContent = `Step ${Math.min(completed + 1, total)} of ${total}`

  // Review section (hidden by default for now)
  document.getElementById('review-section').classList.add('hidden')

  // Update Skip Agent button text based on selected agent status
  updateSkipAgentButtonText()
}

function updateSkipAgentButtonText() {
  const btn = document.getElementById('btn-skip-agent')
  if (!btn) return

  if (state.selectedNodeIndex === -1 || !state.pipelineSteps[state.selectedNodeIndex]) {
    btn.textContent = 'Skip Agent'
    return
  }

  const selectedStep = state.pipelineSteps[state.selectedNodeIndex]
  const isSkipped = selectedStep.status === 'skipped'
  btn.textContent = isSkipped ? 'Unskip Agent' : 'Skip Agent'
}

/**
 * Update review loop pips/spinner based on loop type
 * @param {string} agentId - Agent ID
 * @param {number} loopCount - Current loop iteration
 * @param {number} maxLoops - Max loops (for revision type)
 * @param {string} loopType - 'revision' or 'iteration'
 */
function updateReviewPips(agentId, loopCount, maxLoops, loopType) {
  const section = document.getElementById('review-section')
  const label = section.querySelector('.progress-label')
  const pipsContainer = document.getElementById('review-pips')
  const textEl = document.getElementById('review-text')

  section.classList.remove('hidden')
  label.textContent = 'REVIEW LOOP'

  if (loopType === 'iteration') {
    // Indeterminate mode: show spinner, no pips
    pipsContainer.innerHTML = '<div class="pip-spinner"></div>'
    textEl.textContent = ''
  } else {
    // Revision mode: show pips
    pipsContainer.innerHTML = ''
    for (let i = 1; i <= maxLoops; i++) {
      const pip = document.createElement('div')
      pip.className = 'pip'
      if (i < loopCount) pip.classList.add('done')
      else if (i === loopCount) pip.classList.add('active')
      pipsContainer.appendChild(pip)
    }
    textEl.textContent = `${loopCount} / ${maxLoops}`
  }
}

function updateAgentControls() {
  const continueBtn = document.getElementById('btn-continue')
  const killBtn = document.getElementById('btn-kill-agent')
  const editOutputBtn = document.getElementById('btn-edit-output')

  // Continue only when paused at transition
  continueBtn.classList.toggle('hidden', state.pipelineState !== 'paused')

  // Kill button visible only when pipeline is running AND an agent is selected
  const isRunning = state.pipelineState === 'running'
  const hasSelection = state.selectedNodeIndex !== -1
  killBtn.classList.toggle('hidden', !isRunning || !hasSelection)

  // Edit output: hidden when no agent selected, disabled when pipeline running
  const selectedAgentId = state.pipelineSteps[state.selectedNodeIndex]?.agent_id
  const hasOutput = state.agentOutputs.get(selectedAgentId)
  if (!hasSelection) {
    // No agent selected: hide the button
    editOutputBtn.classList.add('hidden')
  } else if (isRunning) {
    // Agent selected but pipeline running: show but disable
    editOutputBtn.classList.remove('hidden')
    editOutputBtn.disabled = true
  } else {
    // Agent selected and pipeline not running: show and enable if there's output
    editOutputBtn.classList.remove('hidden')
    editOutputBtn.disabled = !hasOutput
  }
}

// ─── Pipeline Control Actions ───────────────────────────────────────────────

async function togglePause() {
  try {
    appendLogLine(`Toggle pause: current state = ${state.pipelineState}`, 'info')
    if (state.pipelineState === 'running') {
      appendLogLine('Pausing pipeline...', 'info')
      await window.api.pausePipeline()
    } else if (state.pipelineState === 'paused') {
      appendLogLine('Resuming pipeline...', 'info')
      await window.api.resumePipeline()
    } else {
      appendLogLine(`Cannot toggle pause: state is ${state.pipelineState}`, 'warn')
    }
  } catch (e) {
    appendLogLine('Failed to toggle pause: ' + e.message, 'error')
  }
}

async function handleStart() {
  if (!state.currentProject) {
    appendLogLine('No project open', 'warn')
    return
  }
  if (state.pipelineSteps.length === 0) {
    appendLogLine('No agents in pipeline. Add agents before starting.', 'warn')
    return
  }

  // Check auth before starting pipeline
  try {
    const authResult = await window.api.checkAuth()
    if (!authResult.configured) {
      showDialog('dialog-auth-warning')
      return
    }
  } catch (e) {
    appendLogLine('Failed to check auth: ' + e.message, 'error')
    return
  }

  await startPipeline()
}

async function handleAbort() {
  if (!confirm('Are you sure you want to abort the pipeline?')) return
  try {
    await window.api.abortPipeline()
    state.pipelineState = 'idle'
    updateTitlebarStatus()
  } catch (e) {
    appendLogLine('Failed to abort: ' + e.message, 'error')
  }
}

async function handleContinue() {
  try {
    await window.api.resumePipeline()
  } catch (e) {
    appendLogLine('Failed to continue: ' + e.message, 'error')
  }
}

async function handleKillAgent() {
  try {
    await window.api.killAgent()
  } catch (e) {
    appendLogLine('Failed to kill agent: ' + e.message, 'error')
  }
}

async function handleEditOutput() {
  try {
    if (!state.currentProject || state.selectedNodeIndex === -1) {
      appendLogLine('No agent selected', 'warn')
      return
    }

    const step = state.pipelineSteps[state.selectedNodeIndex]
    const agent = state.agents.find(a => a.id === step.agent_id)

    if (!agent || !agent.filePath) {
      appendLogLine('Selected agent does not have an output file. This is likely because the agent did not output anything or did not complete a run yet.', 'warn')
      return
    }

    const result = await window.api.openAgentOutput(state.currentProject.projectPath, agent.filePath)
    if (result.exists === false) {
      appendLogLine('Selected agent does not have an output file. This is likely because the agent did not output anything or did not complete a run yet.', 'warn')
    }
  } catch (e) {
    appendLogLine('Failed to open output file: ' + e.message, 'error')
  }
}

// ─── Activity Log ───────────────────────────────────────────────────────────

function appendLogLine(message, type = 'info', time = null) {
  const logLines = document.getElementById('log-lines')
  if (!time) {
    const now = new Date()
    time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  }

  const line = document.createElement('div')
  line.className = `log-line ${type}`
  line.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `

  logLines.appendChild(line)
  logLines.scrollTop = logLines.scrollHeight

  state.logEntries.push({ time, message, type })
}

function clearLog() {
  document.getElementById('log-lines').innerHTML = ''
  state.logEntries = []
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// ─── Project Management ─────────────────────────────────────────────────────

async function openProjectDialog() {
  try {
    const folderPath = await window.api.openFolderDialog()
    if (!folderPath) {
      // User cancelled — if no project is open, show welcome dialog again
      if (!state.currentProject) {
        showDialog('dialog-welcome')
      }
      return
    }

    const result = await window.api.openProject(folderPath)
    if (result.error) {
      appendLogLine('Failed to open project: ' + result.error, 'error')
      return
    }

    await loadProject(result.projectPath)
  } catch (e) {
    appendLogLine('Failed to open project: ' + e.message, 'error')
  }
}

async function loadProject(projectPath) {
  try {
    // Refresh agents list first to ensure we have latest data
    const agentResult = await window.api.listAgents()
    state.agents = agentResult?.agents || []
    state.agentLoadErrors = agentResult?.errors || []

    const result = await window.api.openProject(projectPath)
    if (result.error) {
      appendLogLine('Failed to load project: ' + result.error, 'error')
      return
    }

    state.currentProject = result
    document.getElementById('tb-project-name').textContent = result.projectJson.name

    // Load brief
    try {
      const brief = await window.api.readContextFile(pathJoin(projectPath, 'Context', 'brief.md'))
      document.getElementById('brief-text').textContent = brief ? brief.split('\n')[0] : 'No brief loaded'
    } catch {
      document.getElementById('brief-text').textContent = 'No brief loaded'
    }

    // Load pipeline steps with agent names
    state.pipelineSteps = (result.pipelineJson.steps || []).map(step => ({
      ...step,
      agent_name: state.agents.find(a => a.id === step.agent_id)?.name || 'Unknown',
    }))

    state.currentStepIndex = -1
    state.pipelineState = 'idle'
    state.selectedNodeIndex = -1
    state.selectedAgentId = null

    renderPipelineAgents()
    renderLibraryAgents()
    renderPipelineCanvas()
    updateDetailPanel()
    updateAgentControls()
    updateTitlebarStatus()
    updateStatusBar()

    hideDialog('dialog-welcome')
  } catch (e) {
    appendLogLine('Failed to load project: ' + e.message, 'error')
  }
}

// Simple path join for renderer (avoid path module dependency)
function pathJoin(...parts) {
  return parts.join('/').replace(/\/+/g, '/')
}

// ─══════════════════════════════════════════════════════════════════════════
// NEW PROJECT DIALOG SCAFFOLDING
// ═══════════════════════════════════════════════════════════════════════════

async function openNewProjectDialog() {
  // Reset all local state
  state.npStep = 1
  state.npAllowedCommands = new Set()
  state.npSelectedAgents = []
  state.npDragSrc = null
  state.npTotalAgents = 0

  // Clear dynamic content from previous opens
  document.getElementById('stack-picker-list').innerHTML = ''
  document.getElementById('allowed-commands-list').innerHTML = ''
  document.getElementById('denied-commands-list').innerHTML = ''
  document.getElementById('agent-picker-list').innerHTML = ''
  document.getElementById('agent-order-list').innerHTML = ''
  document.getElementById('new-project-name').value = ''
  document.getElementById('new-project-path').value = ''
  document.getElementById('new-project-brief').value = ''
  document.getElementById('new-project-path-preview').textContent = ''
  document.getElementById('new-project-footer-status').textContent = ''

  // Pre-load stack defaults and agent list
  let stackDefaults, agentResult
  try {
    [stackDefaults, agentResult] = await Promise.all([
      window.api.getStackDefaults(),
      window.api.listAgents(),
    ])
    state.agents = agentResult?.agents || []
    state.agentLoadErrors = agentResult?.errors || []
    state.npTotalAgents = agentResult?.agents ? agentResult.agents.length : 0
  } catch (e) {
    appendLogLine('Failed to load dialog data: ' + e.message, 'error')
    return
  }

  npRenderStackPicker(stackDefaults)
  npRenderDeniedList(stackDefaults.hardcodedExclude)
  npRenderAgentPicker(state.agents, state.agentLoadErrors)

  showDialog('dialog-new-project')
  npUpdateUI()
}

function npUpdateUI() {
  // Show only the active step body
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`dialog-step-${i}`)
    el.classList.toggle('hidden', i !== state.npStep)
  }

  // Step progress pips: done | active | pending
  for (let i = 1; i <= 4; i++) {
    const pip = document.getElementById(`new-project-pip-${i}`)
    pip.className = 'step-pip' +
      (i < state.npStep ? ' done' : i === state.npStep ? ' active' : ' pending')
  }

  document.getElementById('new-project-subtitle').textContent = NP_STEP_SUBTITLES[state.npStep - 1]

  // Back disabled on step 1
  document.getElementById('btn-new-project-back').disabled = state.npStep === 1

  // Next vs Create
  const isLast = state.npStep === 4
  document.getElementById('btn-new-project-next').classList.toggle('hidden', isLast)
  document.getElementById('btn-new-project-create').classList.toggle('hidden', !isLast)

  npUpdateFooterStatus()
}

function npAdvance() {
  if (state.npStep === 1) {
    const name = document.getElementById('new-project-name').value.trim()
    const path = document.getElementById('new-project-path').value.trim()
    if (!name || !path) {
      npSetStatus('Project name and location are required.', 'error')
      return
    }
  }
  if (state.npStep === 3) {
    npSyncAllowedCommands()
  }
  if (state.npStep < 4) {
    state.npStep++
    npUpdateUI()
    if (state.npStep === 3) npRenderAllowedList()
  }
}

function npRetreat() {
  if (state.npStep > 1) {
    state.npStep--
    npUpdateUI()
  }
}

function npUpdateFooterStatus() {
  if (state.npStep === 3) {
    const count = document.querySelectorAll('#allowed-commands-list .command-row').length
    npSetStatus(`${count} command${count !== 1 ? 's' : ''} will be allowed`, '')
  } else if (state.npStep === 4) {
    const count = state.npSelectedAgents.length
    if (count > 0) {
      npSetStatus(`${count} agent${count !== 1 ? 's' : ''} in pipeline`, '')
    } else if (state.npTotalAgents === 0) {
      npSetStatus('No available agents found. You\'ll need to create at least one agent if you proceed with creating this project.', 'warn')
    } else {
      npSetStatus('Select at least one agent.', 'error')
    }
  } else {
    npSetStatus('', '')
  }
}

function npSetStatus(msg, type) {
  const el = document.getElementById('new-project-footer-status')
  el.textContent = msg
  if (type === 'error') {
    el.className = 'dialog-footer-status error'
  } else if (type === 'warn') {
    el.className = 'dialog-footer-status warn'
  } else {
    el.className = 'dialog-footer-status'
  }
}

function npUpdatePathPreview() {
  const name = document.getElementById('new-project-name').value.trim() || '…'
  const base = document.getElementById('new-project-path').value.trim() || '…'
  document.getElementById('new-project-path-preview').textContent = base + '/' + name
}

function npRenderStackPicker(stackDefaults) {
  const list = document.getElementById('stack-picker-list')
  list.innerHTML = ''

  // 'common' (git) commands are always included
  if (stackDefaults.stacks.common) {
    for (const cmd of stackDefaults.stacks.common) state.npAllowedCommands.add(cmd)
  }

  const stackNames = Object.keys(stackDefaults.stacks).filter(k => k !== 'common')

  for (const stackName of stackNames) {
    const commands = stackDefaults.stacks[stackName]
    const item = document.createElement('div')
    item.className = 'stack-option'
    item.dataset.stack = stackName
    item.innerHTML = `
      <div class="stack-check">✓</div>
      <div class="stack-name">${stackName.charAt(0).toUpperCase() + stackName.slice(1)}</div>
    `
    item.addEventListener('click', () => {
      const selected = item.classList.toggle('selected')
      if (selected) {
        for (const cmd of commands) state.npAllowedCommands.add(cmd)
      } else {
        for (const cmd of commands) {
          const stillNeeded = [...list.querySelectorAll('.stack-option.selected')]
            .some(el => el !== item &&
              (stackDefaults.stacks[el.dataset.stack] || []).includes(cmd))
          if (!stillNeeded) state.npAllowedCommands.delete(cmd)
        }
      }
    })
    list.appendChild(item)
  }
}

function npRenderAllowedList() {
  const list = document.getElementById('allowed-commands-list')
  list.innerHTML = ''
  for (const cmd of state.npAllowedCommands) {
    npAppendCommandRow(list, cmd)
  }
  npUpdateFooterStatus()
}

function npAppendCommandRow(list, value) {
  const row = document.createElement('div')
  row.className = 'command-row'
  row.innerHTML = `
    <input type="text" class="dialog-input" value="${escapeHtml(value)}">
    <button class="command-remove" title="Remove">×</button>
  `
  row.querySelector('.command-remove').addEventListener('click', () => {
    row.remove()
    npUpdateFooterStatus()
  })
  list.appendChild(row)
}

function npAddBlankCommandRow() {
  const list = document.getElementById('allowed-commands-list')
  npAppendCommandRow(list, '')
  list.lastElementChild.querySelector('input').focus()
  npUpdateFooterStatus()
}

function npSyncAllowedCommands() {
  state.npAllowedCommands = new Set(
    [...document.querySelectorAll('#allowed-commands-list .command-row input')]
      .map(i => i.value.trim())
      .filter(Boolean)
  )
}

function npRenderDeniedList(hardcodedExclude) {
  const list = document.getElementById('denied-commands-list')
  list.innerHTML = ''
  const TIP = 'These values are locked -- hardcoded to prevent the agent from executing ' +
    'any destructive behaviour, we plan to allow unlocking them in the future with ' +
    'v2 of our safety and mitigation system'
  for (const pattern of hardcodedExclude) {
    const cmd = pattern.replace(/^run_shell_command\(/, '').replace(/\)$/, '')
    const row = document.createElement('div')
    row.className = 'command-row denied'
    row.innerHTML = `
      <input type="text" class="dialog-input" value="${escapeHtml(cmd)}" readonly>
      <div class="lock-icon" data-tip="${TIP}">🔒</div>
    `
    list.appendChild(row)
  }
}

function npRenderAgentPicker(agents, errors = []) {
  const list = document.getElementById('agent-picker-list')
  list.innerHTML = ''

  // Show warning if there are permission errors
  if (errors && errors.length > 0) {
    const warningDiv = document.createElement('div')
    warningDiv.className = 'agent-load-warning'
    warningDiv.innerHTML = `
      <div class="warning-icon">⚠</div>
      <div class="warning-text">Could not display some agent files due to permission issues, Jarvix lacks the correct permissions to access them</div>
    `
    list.appendChild(warningDiv)
  }

  for (const agent of agents) {
    const item = document.createElement('div')
    item.className = 'agent-pick-item'
    item.dataset.agentId = agent.id
    item.dataset.agentName = agent.name
    item.innerHTML = `
      <div class="agent-pick-check">✓</div>
      <div class="agent-pick-name">${escapeHtml(agent.name)}</div>
    `
    item.addEventListener('click', () => npToggleAgent(item, agent))
    list.appendChild(item)
  }
}

function npToggleAgent(item, agent) {
  const selected = item.classList.toggle('selected')
  if (selected) {
    state.npSelectedAgents.push({ id: agent.id, name: agent.name })
    npAppendOrderItem(agent)
  } else {
    state.npSelectedAgents = state.npSelectedAgents.filter(a => a.id !== agent.id)
    const orderItem = document.querySelector(`#agent-order-list [data-agent-id="${agent.id}"]`)
    if (orderItem) orderItem.remove()
    npSyncOrderFromDOM()
  }
  npUpdateFooterStatus()
}

function npAppendOrderItem(agent) {
  const list = document.getElementById('agent-order-list')
  const item = document.createElement('div')
  item.className = 'order-item'
  item.dataset.agentId = agent.id
  item.draggable = true
  item.innerHTML = `
    <div class="drag-handle"><span></span><span></span><span></span></div>
    <div class="order-index">—</div>
    <div class="order-name">${escapeHtml(agent.name)}</div>
  `
  npAttachDragEvents(item)
  list.appendChild(item)
  npRenumberOrderList()
}

function npRenumberOrderList() {
  document.querySelectorAll('#agent-order-list .order-item').forEach((item, i) => {
    item.querySelector('.order-index').textContent = String(i + 1).padStart(2, '0')
  })
}

function npSyncOrderFromDOM() {
  state.npSelectedAgents = [...document.querySelectorAll('#agent-order-list .order-item')]
    .map(item => ({
      id: item.dataset.agentId,
      name: item.querySelector('.order-name').textContent,
    }))
}

function npAttachDragEvents(item) {
  item.addEventListener('dragstart', (e) => {
    state.npDragSrc = item
    e.dataTransfer.effectAllowed = 'move'
    requestAnimationFrame(() => item.classList.add('dragging'))
  })

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging')
    document.querySelectorAll('#agent-order-list .drag-over')
      .forEach(el => el.classList.remove('drag-over'))
    state.npDragSrc = null
    npRenumberOrderList()
    npSyncOrderFromDOM()
    npUpdateFooterStatus()
  })

  item.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (item !== state.npDragSrc) {
      document.querySelectorAll('#agent-order-list .drag-over')
        .forEach(el => el.classList.remove('drag-over'))
      item.classList.add('drag-over')
    }
  })

  item.addEventListener('dragleave', () => item.classList.remove('drag-over'))

  item.addEventListener('drop', (e) => {
    e.preventDefault()
    item.classList.remove('drag-over')
    if (!state.npDragSrc || state.npDragSrc === item) return
    const list = item.parentNode
    const items = [...list.querySelectorAll('.order-item')]
    const srcIdx = items.indexOf(state.npDragSrc)
    const destIdx = items.indexOf(item)
    if (srcIdx < destIdx) {
      list.insertBefore(state.npDragSrc, item.nextSibling)
    } else {
      list.insertBefore(state.npDragSrc, item)
    }
  })
}

async function npCreate() {
  const name = document.getElementById('new-project-name').value.trim()
  const folderPath = document.getElementById('new-project-path').value.trim()
  const brief = document.getElementById('new-project-brief').value.trim()

  if (!name || !folderPath) {
    npSetStatus('Project name and location are required.', 'error')
    return
  }

  // Warn if no agents selected, but allow creation
  if (state.npSelectedAgents.length === 0) {
    npSetStatus('Warning: Creating project without agents. Pipeline will be empty.', 'warn')
  }

  try {
    const result = await window.api.createProject({
      name,
      folderPath,
      steps: state.npSelectedAgents.map(a => ({ agent_id: a.id, type: 'standard' })),
      allowedCommands: [...state.npAllowedCommands],
      brief,
    })

    if (result.error) {
      npSetStatus(result.error, 'error')
      appendLogLine('Failed to create project: ' + result.error, 'error')
      return
    }

    hideDialog('dialog-new-project')
    await loadProject(result.projectPath)
  } catch (e) {
    npSetStatus(e.message, 'error')
    appendLogLine('Failed to create project: ' + e.message, 'error')
  }
}

// ─── Add Agent Dialog ───────────────────────────────────────────────────────

async function openAddAgentDialog() {
  if (!state.currentProject) {
    appendLogLine('No project open', 'warn')
    return
  }

  try {
    // Load agents from library
    const result = await window.api.listAgents()
    const agents = result?.agents || []
    const errors = result?.errors || []

    // Store errors in state for potential display
    state.agentLoadErrors = errors

    const list = document.getElementById('add-agent-list')
    list.innerHTML = ''

    // Show warning if there are permission errors
    if (errors && errors.length > 0) {
      const warningDiv = document.createElement('div')
      warningDiv.className = 'agent-load-warning'
      warningDiv.innerHTML = `
        <div class="warning-icon">⚠</div>
        <div class="warning-text">Could not display some agent files due to permission issues, Jarvix lacks the correct permissions to access them</div>
      `
      list.appendChild(warningDiv)
    }

    if (!agents || agents.length === 0) {
      list.innerHTML = '<div class="pipeline-agents-empty"><div class="pipeline-agents-empty-text">No agents available. Create an agent first.</div></div>'
    } else {
      // Get current pipeline agent IDs to exclude them
      const currentAgentIds = new Set(state.pipelineSteps.map(s => s.agent_id))

      for (const agent of agents) {
        const alreadyInPipeline = currentAgentIds.has(agent.id)
        const item = document.createElement('div')
        item.className = 'add-agent-item' + (alreadyInPipeline ? ' disabled' : '')
        item.innerHTML = `
          <div class="add-agent-name">${escapeHtml(agent.name)}</div>
          ${alreadyInPipeline ? '<span class="add-agent-in-pipeline">✓ Already in pipeline</span>' : ''}
        `
        item.addEventListener('click', () => {
          if (alreadyInPipeline) return
          addAgentToPipeline(agent)
        })
        list.appendChild(item)
      }
    }

    showDialog('dialog-add-agent')
  } catch (e) {
    appendLogLine('Failed to load agents: ' + e.message, 'error')
  }
}

async function addAgentToPipeline(agent) {
  try {
    // Add agent to pipeline steps
    const newStep = { agent_id: agent.id, type: 'standard', agent_name: agent.name }
    state.pipelineSteps.push(newStep)

    // Save updated pipeline
    await window.api.updatePipelineSteps(state.pipelineSteps)

    hideDialog('dialog-add-agent')
    appendLogLine(`Added "${agent.name}" to pipeline`, 'ok')

    // Refresh agents list from library
    const result = await window.api.listAgents()
    state.agents = result?.agents || []

    // Re-render UI
    renderPipelineAgents()
    renderLibraryAgents()
    renderPipelineCanvas()
  } catch (e) {
    appendLogLine('Failed to add agent: ' + e.message, 'error')
  }
}

async function handleRemoveAgent() {
  // Check if an agent is selected
  if (state.selectedNodeIndex === -1 || !state.pipelineSteps[state.selectedNodeIndex]) {
    appendLogLine('There are no agents selected, please select an agent first', 'warn')
    return
  }

  const indexToRemove = state.selectedNodeIndex
  const agentName = state.pipelineSteps[indexToRemove].agent_name || 'Unknown'

  try {
    // Remove agent from pipeline steps
    state.pipelineSteps.splice(indexToRemove, 1)

    // Save updated pipeline
    await window.api.updatePipelineSteps(state.pipelineSteps)

    appendLogLine(`Removed "${agentName}" from pipeline`, 'ok')

    // Refresh agents list from library
    const result = await window.api.listAgents()
    state.agents = result?.agents || []

    // Clear selection
    state.selectedNodeIndex = -1
    state.selectedAgentId = null
    state.selectedLibraryAgentId = null

    // Re-render UI
    renderPipelineAgents()
    renderLibraryAgents()
    renderPipelineCanvas()
    updateDetailPanel()
  } catch (e) {
    appendLogLine('Failed to remove agent: ' + e.message, 'error')
  }
}

async function handleSkipAgent() {
  // Can only skip/unskip when pipeline is NOT running
  if (state.pipelineState === 'running') {
    appendLogLine('Pipeline must not be running to skip an agent', 'warn')
    return
  }

  // Check if an agent is selected
  if (state.selectedNodeIndex === -1 || !state.pipelineSteps[state.selectedNodeIndex]) {
    appendLogLine('Please select an agent to skip or unskip', 'warn')
    return
  }

  const selectedStep = state.pipelineSteps[state.selectedNodeIndex]
  const agentName = selectedStep.agent_name || 'Unknown'
  const isSkipped = selectedStep.status === 'skipped'

  try {
    let result
    if (isSkipped) {
      // Unskip the selected agent
      result = await window.api.unskipAgent(state.selectedNodeIndex, state.currentProject?.projectPath)
      if (result.error) {
        appendLogLine('Failed to unskip agent: ' + result.error, 'error')
        return
      }
      appendLogLine(`Unskipped "${agentName}"`, 'ok')
      // Update local state immediately for responsive UI
      state.pipelineSteps[state.selectedNodeIndex].status = 'idle'
    } else {
      // Skip the selected agent
      result = await window.api.skipAgent(state.selectedNodeIndex, state.currentProject?.projectPath)
      if (result.error) {
        appendLogLine('Failed to skip agent: ' + result.error, 'error')
        return
      }
      appendLogLine(`Skipped "${agentName}"`, 'warn')
      // Update local state immediately for responsive UI
      state.pipelineSteps[state.selectedNodeIndex].status = 'skipped'
    }

    // Re-render UI to reflect the skipped state
    renderPipelineAgents()
    renderPipelineCanvas()
    updateDetailPanel()
  } catch (e) {
    appendLogLine('Failed to skip/unskip agent: ' + e.message, 'error')
  }
}

// Shared drag state
let dragSrcEl = null

function attachDragEvents(item) {
  function handleDragStart(e) {
    // Block drag if pipeline is running
    if (state.pipelineState === 'running') {
      e.preventDefault()
      showDialog('dialog-reorder-warning')
      return false
    }

    dragSrcEl = this
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/html', this.innerHTML)
    this.classList.add('dragging')
  }

  function handleDragOver(e) {
    if (e.preventDefault) {
      e.preventDefault()
    }
    e.dataTransfer.dropEffect = 'move'
    return false
  }

  function handleDragEnter(e) {
    this.classList.add('drag-over')
  }

  function handleDragLeave(e) {
    // Only remove drag-over if we're leaving the item entirely,
    // not when moving to a child element
    const relatedTarget = e.relatedTarget
    if (!this.contains(relatedTarget)) {
      this.classList.remove('drag-over')
    }
  }

  function handleDrop(e) {
    if (e.stopPropagation) {
      e.stopPropagation()
    }

    if (dragSrcEl && dragSrcEl !== this) {
      // Get indices
      const srcIndex = parseInt(dragSrcEl.dataset.index, 10)
      const destIndex = parseInt(this.dataset.index, 10)

      // Check for incomplete agents and archive their output files
      const movedStep = state.pipelineSteps[srcIndex]
      const isAgentIncomplete = srcIndex <= state.currentStepIndex && state.pipelineState !== 'idle'

      if (isAgentIncomplete && state.currentProject) {
        // Archive the incomplete agent's output file with timestamp
        archiveIncompleteAgentOutput(movedStep)
      }

      // Reorder in state
      state.pipelineSteps.splice(srcIndex, 1)
      state.pipelineSteps.splice(destIndex, 0, movedStep)

      // Re-render UI
      renderPipelineAgents()
      renderPipelineCanvas()

      // Save updated pipeline
      window.api.updatePipelineSteps(state.pipelineSteps).catch((e) => {
        appendLogLine('Failed to save pipeline order: ' + e.message, 'error')
      })

      appendLogLine(`Reordered pipeline: "${movedStep.agent_name}" moved to position ${destIndex + 1}`, 'info')
    }

    dragSrcEl = null
    return false
  }

  function handleDragEnd(e) {
    this.classList.remove('dragging')
    // Clear drag-over classes from all items
    document.querySelectorAll('#pipeline-agents-list .agent-item').forEach((i) => {
      i.classList.remove('drag-over')
    })
    dragSrcEl = null
  }

  item.addEventListener('dragstart', handleDragStart, false)
  item.addEventListener('dragenter', handleDragEnter, false)
  item.addEventListener('dragover', handleDragOver, false)
  item.addEventListener('dragleave', handleDragLeave, false)
  item.addEventListener('drop', handleDrop, false)
  item.addEventListener('dragend', handleDragEnd, false)
}

async function archiveIncompleteAgentOutput(step) {
  if (!state.currentProject) return

  // Find the agent to get its file path
  const agent = state.agents.find(a => a.id === step.agent_id)
  if (!agent) return

  try {
    const outputPath = await window.api.getAgentOutputPath(state.currentProject.projectPath, agent.filePath)
    const content = await window.api.readContextFile(outputPath)

    // Only archive if there's content
    if (content && content.trim().length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) // YYYY-MM-DDTHH-MM-SS
      const archivedPath = outputPath.replace(/\.md$/, `.${timestamp}.archived.md`)

      await window.api.writeContextFile(archivedPath, content)
      appendLogLine(`Archived incomplete output for "${step.agent_name}" to ${archivedPath.split('/').pop()}`, 'warn')
    }
  } catch (e) {
    // File might not exist yet, that's ok
    appendLogLine(`No output file to archive for "${step.agent_name}"`, 'info')
  }
}

function wireNewProjectDialog() {
  document.getElementById('btn-new-project-cancel').addEventListener('click', () => {
    hideDialog('dialog-new-project')
    // If no project is open, show welcome dialog again
    if (!state.currentProject) {
      showDialog('dialog-welcome')
    }
  })

  document.getElementById('btn-new-project-back').addEventListener('click', npRetreat)

  document.getElementById('btn-new-project-next').addEventListener('click', () => {
    if (state.npStep === 3) npSyncAllowedCommands()
    npAdvance()
  })

  document.getElementById('btn-new-project-create').addEventListener('click', npCreate)

  document.getElementById('btn-pick-folder').addEventListener('click', async () => {
    const picked = await window.api.openFolderDialog()
    if (picked) {
      document.getElementById('new-project-path').value = picked
      npUpdatePathPreview()
    }
  })

  document.getElementById('new-project-name').addEventListener('input', npUpdatePathPreview)
  document.getElementById('new-project-path').addEventListener('input', npUpdatePathPreview)

  document.getElementById('btn-add-command').addEventListener('click', npAddBlankCommandRow)

  // Create Agent button in dialog (step 4)
  document.getElementById('btn-dialog-create-agent').addEventListener('click', async () => {
    try {
      const result = await window.api.createBoilerplateAgent()
      if (result.error) {
        appendLogLine('Failed to create agent: ' + result.error, 'error')
        return
      }
      appendLogLine('Agent created and opened in editor', 'ok')
      // Reload agents list and re-render picker
      const agentResult = await window.api.listAgents()
      state.agents = agentResult?.agents || []
      state.npTotalAgents = state.agents.length
      // Re-render the agent picker with updated list
      npRenderAgentPicker(state.agents)
      npUpdateFooterStatus()
    } catch (e) {
      appendLogLine('Failed to create agent: ' + e.message, 'error')
    }
  })

  // Edit warning dialog buttons
  document.getElementById('btn-edit-confirm-changes').addEventListener('click', async () => {
    try {
      await window.api.confirmAgentChanges(state.editingAgentId)
      hideDialog('dialog-edit-warning')
      state.editingAgentId = null
    } catch (e) {
      appendLogLine('Failed to confirm changes: ' + e.message, 'error')
    }
  })

  document.getElementById('btn-edit-cancel-changes').addEventListener('click', async () => {
    try {
      await window.api.cancelAgentChanges(state.editingAgentId)
      hideDialog('dialog-edit-warning')
      state.editingAgentId = null
    } catch (e) {
      appendLogLine('Failed to cancel changes: ' + e.message, 'error')
    }
  })

  // Auth warning dialog
  document.getElementById('btn-auth-warning-cancel').addEventListener('click', () => {
    hideDialog('dialog-auth-warning')
  })

  document.getElementById('btn-auth-warning-setup').addEventListener('click', () => {
    hideDialog('dialog-auth-warning')
    showAuthSetupDialog()
  })

  // Auth setup dialog
  document.getElementById('btn-auth-setup-cancel').addEventListener('click', () => {
    hideDialog('dialog-auth-setup')
  })

  document.getElementById('btn-auth-setup-save').addEventListener('click', handleAuthSave)

  document.getElementById('btn-auth-test').addEventListener('click', handleAuthTest)

  // Provider dropdown - update base URL when provider changes
  document.getElementById('auth-provider').addEventListener('change', handleProviderChange)

  // Disable Save button when any input field changes (require re-test)
  document.getElementById('auth-api-key').addEventListener('input', () => setAuthSaveEnabled(false))
  document.getElementById('auth-base-url').addEventListener('input', () => setAuthSaveEnabled(false))
  document.getElementById('auth-model-name').addEventListener('input', () => setAuthSaveEnabled(false))
}

// ─── Dialog Utilities ───────────────────────────────────────────────────────

function showDialog(id) {
  document.getElementById(id).classList.remove('hidden')
}

function hideDialog(id) {
  document.getElementById(id).classList.add('hidden')
}

// Overlay utilities (same as dialogs, different semantic name)
function showOverlay(id) {
  document.getElementById(id).classList.remove('hidden')
}

function hideOverlay(id) {
  document.getElementById(id).classList.add('hidden')
}

// ─── Edit Warning Dialog ────────────────────────────────────────────────────

async function handleConfirmChanges() {
  try {
    await window.api.confirmAgentChanges(state.editingAgentId)
    hideDialog('dialog-edit-warning')
    state.editingAgentId = null
  } catch (e) {
    appendLogLine('Failed to confirm changes: ' + e.message, 'error')
  }
}

async function handleCancelChanges() {
  try {
    await window.api.cancelAgentChanges(state.editingAgentId)
    hideDialog('dialog-edit-warning')
    state.editingAgentId = null
  } catch (e) {
    appendLogLine('Failed to cancel changes: ' + e.message, 'error')
  }
}

// ─── Start Pipeline ─────────────────────────────────────────────────────────

// Default base URLs for each provider
const PROVIDER_BASE_URLS = {
  'openai': 'https://api.openai.com/v1',
  'modelscope': 'https://api-inference.modelscope.cn/v1',
  'openrouter': 'https://openrouter.ai/api/v1',
  'alibaba': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'azure': 'https://api.openai.com/v1',
  'custom': '',
}

function showAuthSetupDialog() {
  showDialog('dialog-auth-setup')
  // Reset form
  document.getElementById('auth-provider').value = 'openai'
  document.getElementById('auth-api-key').value = ''
  document.getElementById('auth-base-url').value = PROVIDER_BASE_URLS.openai
  document.getElementById('auth-model-name').value = ''
  document.getElementById('auth-test-result').textContent = ''
  document.getElementById('auth-test-result').className = ''
  // Disable Save button until test passes
  document.getElementById('btn-auth-setup-save').disabled = true
}

function setAuthSaveEnabled(enabled) {
  document.getElementById('btn-auth-setup-save').disabled = !enabled
}

function handleProviderChange() {
  const provider = document.getElementById('auth-provider').value
  const baseUrlInput = document.getElementById('auth-base-url')
  // Always set the default base URL for the selected provider
  // This ensures correct endpoint even if user had edited the field
  if (PROVIDER_BASE_URLS[provider]) {
    baseUrlInput.value = PROVIDER_BASE_URLS[provider]
  }
  // Show note for Azure (requires chat completion test)
  const noteEl = document.getElementById('auth-test-note')
  noteEl.style.display = (provider === 'azure') ? 'block' : 'none'
  // Disable Save button when provider changes (require re-test)
  setAuthSaveEnabled(false)
}

async function handleAuthTest() {
  const provider = document.getElementById('auth-provider').value
  const apiKey = document.getElementById('auth-api-key').value
  const baseUrl = document.getElementById('auth-base-url').value
  const modelName = document.getElementById('auth-model-name').value

  const resultEl = document.getElementById('auth-test-result')

  if (!apiKey) {
    resultEl.textContent = 'Please enter an API key'
    resultEl.className = 'error'
    setAuthSaveEnabled(false)
    return
  }

  if (!modelName || modelName.trim() === '') {
    resultEl.textContent = 'Model name is empty'
    resultEl.className = 'error'
    setAuthSaveEnabled(false)
    return
  }

  resultEl.textContent = 'Testing connection...'
  resultEl.className = ''
  setAuthSaveEnabled(false)

  try {
    const result = await window.api.testAuth({ provider, apiKey, baseUrl, modelName })
    if (result.ok) {
      resultEl.textContent = result.message || 'Connection successful'
      resultEl.className = 'ok'
      setAuthSaveEnabled(true)
    } else {
      resultEl.textContent = result.error || 'Connection failed'
      resultEl.className = 'error'
      setAuthSaveEnabled(false)
    }
  } catch (e) {
    resultEl.textContent = 'Test failed: ' + e.message
    resultEl.className = 'error'
    setAuthSaveEnabled(false)
  }
}

async function handleAuthSave() {
  const provider = document.getElementById('auth-provider').value
  const apiKey = document.getElementById('auth-api-key').value
  const baseUrl = document.getElementById('auth-base-url').value
  const modelName = document.getElementById('auth-model-name').value

  if (!apiKey) {
    appendLogLine('API key is required', 'error')
    return
  }

  try {
    const result = await window.api.configureAuth({ provider, apiKey, baseUrl, modelName })
    if (result.ok) {
      state.qwenAuthConfigured = true
      appendLogLine('Authentication configured successfully', 'ok')
      hideDialog('dialog-auth-setup')
    } else {
      appendLogLine('Failed to configure auth: ' + result.error, 'error')
    }
  } catch (e) {
    appendLogLine('Failed to configure auth: ' + e.message, 'error')
  }
}

async function startPipeline(resumeFrom = null) {
  if (!state.currentProject) return

  try {
    const result = await window.api.startPipeline(state.currentProject.projectPath, resumeFrom)
    if (result.error) {
      appendLogLine('Failed to start pipeline: ' + result.error, 'error')
    }
  } catch (e) {
    appendLogLine('Failed to start pipeline: ' + e.message, 'error')
  }
}
