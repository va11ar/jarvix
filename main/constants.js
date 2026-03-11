// Shared constants for the entire application
// All pipeline state values, step status strings, and IPC channel names come from here.

// Pipeline execution states
const PIPELINE_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  ERROR: 'error',
  COMPLETE: 'complete',
  WAITING_FOR_USER: 'waiting-for-user',
}

// Individual step status values
const STEP_STATUSES = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETE: 'complete',
  ERROR: 'error',
  SKIPPED: 'skipped',
}

// Agent roles — used to trigger pre-flight behaviours and Output folder injection
// Regular: no role field (null) — standard agent behavior
// Producer: role: 'producer' — produces artifacts to Output/, triggers pre-flight discovery
// Producer Reviewer: role: 'producer-reviewer' — reviews artifacts from Output/
// Fixer: role: 'fixer' — fixes issues found by QA agent
const AGENT_ROLES = {
  PRODUCER: 'producer',
  PRODUCER_REVIEWER: 'producer-reviewer',
  FIXER: 'fixer',
}

// IPC channel names — never hardcode these inline
const IPC = {
  // Project
  PROJECT_CREATE: 'project:create',
  PROJECT_OPEN: 'project:open',
  PROJECT_VALIDATE: 'project:validate',
  PROJECT_LIST: 'project:list',
  PROJECT_STACK_DEFAULTS: 'project:stack-defaults',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',

  // Agents
  AGENTS_LIST: 'agents:list',
  AGENTS_GET: 'agents:get',
  AGENTS_CREATE: 'agents:create',
  AGENTS_USAGE_COUNT: 'agents:usageCount',
  AGENTS_UPDATE_REVIEW_TARGET:   'agents:update-review-target',
  AGENTS_UPDATE_LOOP_CONFIG:     'agents:update-loop-config',
  AGENTS_UPDATE_ROLE:            'agents:update-role',

  // Pipeline
  PIPELINE_START: 'pipeline:start',
  PIPELINE_PAUSE: 'pipeline:pause',
  PIPELINE_RESUME: 'pipeline:resume',
  PIPELINE_ABORT: 'pipeline:abort',
  PIPELINE_UPDATE_STEPS: 'pipeline:update-steps',
  PIPELINE_SKIP_AGENT: 'pipeline:skip-agent',
  PIPELINE_UNSKIP_AGENT: 'pipeline:unskip-agent',
  AGENT_KILL: 'agent:kill',
  PIPELINE_HAS_RUN_BEFORE: 'pipeline:has-run-before',
  PIPELINE_RESET: 'pipeline:reset',

  // Editor
  EDITOR_OPEN: 'editor:open',
  EDITOR_CHECK_CHANGES: 'editor:check-changes',
  EDITOR_CONFIRM_CHANGES: 'editor:confirm-changes',
  EDITOR_CANCEL_CHANGES: 'editor:cancel-changes',

  // Context file I/O
  CONTEXT_READ: 'context:read',
  CONTEXT_LIST: 'context:list',
  CONTEXT_WRITE: 'context:write',
  CONTEXT_AGENT_OUTPUT_PATH: 'context:agent-output-path',
  CONTEXT_OPEN_OUTPUT: 'context:open-output',
  CONTEXT_OPEN_AGENT_FILE:       'context:open-agent-file',
  CONTEXT_OPEN_BRIEF:            'context:open-brief',
  CONTEXT_OPEN_AGENTS_FOLDER:    'context:open-agents-folder',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Window
  SHOW_PREFERENCES_COMING_SOON: 'show-preferences-coming-soon',

  // Authentication
  AUTH_CHECK: 'auth:check',
  AUTH_CONFIGURE: 'auth:configure',
  AUTH_TEST: 'auth:test',
  AUTH_GET_SETTINGS: 'auth:get-settings',
  AUTH_OAUTH_ENABLED: 'auth:oauth-enabled',
  AUTH_SET_OAUTH_ENABLED:        'auth:set-oauth-enabled',
  AUTH_RESTORE_OAUTH_DEFAULTS:   'auth:restore-oauth-defaults',

  // Onboarding
  ONBOARDING_CHECK:              'onboarding:check',
  ONBOARDING_MARK_DONE:          'onboarding:mark-done',
  GET_AGENTS_DIR_PATH:           'agents:get-dir-path',

  // Qwen installation
  QWEN_CHECK_INSTALLED: 'qwen:check-installed',
  QWEN_BROWSE_INSTALLATION: 'qwen:browse-installation',
  QWEN_SET_PATH: 'qwen:set-path',
  QWEN_NOT_FOUND: 'qwen:not-found',
  QWEN_USER_RESPONSE: 'qwen:user-response',

  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // External
  EXTERNAL_OPEN: 'external:open',

  // Main → Renderer events
  PIPELINE_STATUS: 'pipeline:status',
  AGENT_OUTPUT_UPDATED: 'agent:output-updated',
  LOG_UPDATED: 'log:updated',
  AGENT_DEFINITION_CHANGED: 'agent:definition-changed',
  INCOMPLETE_RUN_DETECTED: 'pipeline:incomplete-run-detected',
  STARTUP_AUTH_INVALID: 'startup:auth-invalid',
  WINDOW_FOCUS: 'window:focus',

  // Discovery pre-flight
  DISCOVERY_STARTED: 'discovery:started',
  DISCOVERY_SHOW_CHOICE: 'discovery:show-choice',
  DISCOVERY_SHOW_CHOICE_ACK: 'discovery:show-choice-ack',
  DISCOVERY_COMPLETE: 'discovery:complete',
  DISCOVERY_ERROR: 'discovery:error',
  DISCOVERY_USER_APPROVE: 'discovery:user-approve',
  DISCOVERY_USER_SANDBOX: 'discovery:user-sandbox',
  DISCOVERY_USER_ABORT: 'discovery:user-abort',

  // QA MCP
  QA_USER_DONE: 'qa:user-done',
  QA_USER_ALL_GOOD: 'qa:user-all-good',
  QA_HOTKEY_REREGISTER: 'qa:hotkey-reregister',
  QA_SCREENSHOT_TAKEN: 'qa:screenshot-taken',
  QA_REQUEST_NOTE: 'qa:request-note',
  QA_SUBMIT_NOTE: 'qa:submit-note',
  QA_CANCEL_NOTE: 'qa:cancel-note',

  // QA Pre-flight dialogs
  QA_PREFLIGHT_SHOW:      'qa:preflight-show',
  QA_PREFLIGHT_READY:     'qa:preflight-ready',
  QA_PREFLIGHT_ABORT:     'qa:preflight-abort',
  QA_INSTRUCTIONS_SHOW:   'qa:instructions-show',
  QA_INSTRUCTIONS_CONFIRM:'qa:instructions-confirm',
  QA_ROUTING_CONFIRM_SHOW:   'qa:routing-confirm-show',
  QA_ROUTING_CONFIRM_YES:    'qa:routing-confirm-yes',
  QA_ROUTING_CONFIRM_NO:     'qa:routing-confirm-no',
  QA_NO_FIXER_WARN:          'qa:no-fixer-warn',
  QA_NO_FIXER_WARN_ACK:      'qa:no-fixer-warn-ack',
}

// Hardcoded exclude list — always written into .qwen/settings.json tools.exclude
// Cannot be removed by user configuration or agent YAML
const HARDCODED_EXCLUDE = [
  'run_shell_command(rm -rf)',
  'run_shell_command(sudo)',
  'run_shell_command(curl)',
  'run_shell_command(wget)',
  'run_shell_command(chmod +x)',
  'run_shell_command(dd)',
  'run_shell_command(mkfs)',
  'run_shell_command(:(){ :|:& };:)',
]

// Stack defaults for command whitelist generation
const STACK_DEFAULTS = {
  // Common commands included for all projects
  common: [
    'git add',
    'git commit',
    'git status',
    'git diff',
    'git log',
    'git push',
    'git pull',
  ],
  // Node.js stack
  'nodejs': [
    'npm install',
    'npm run build',
    'npm run test',
    'npm run dev',
    'npm run lint',
    'npx tsc',
    'node',
  ],
  // Python stack
  'python': [
    'pip install',
    'pip install -r requirements.txt',
    'python -m pytest',
    'python -m unittest',
    'python',
    'pylint',
    'black',
  ],
  // Rust stack
  'rust': [
    'cargo build',
    'cargo test',
    'cargo clippy',
    'cargo fmt',
    'cargo run',
  ],
  // Go stack
  'go': [
    'go build',
    'go test',
    'go mod tidy',
    'go run',
    'go fmt',
    'go vet',
  ],
  // Java stack
  'java': [
    'mvn compile',
    'mvn test',
    'mvn package',
    'mvn clean',
    'gradle build',
    'gradle test',
  ],
  // .NET stack
  'dotnet': [
    'dotnet build',
    'dotnet test',
    'dotnet run',
    'dotnet publish',
    'dotnet restore',
  ],
  // Ruby stack
  'ruby': [
    'bundle install',
    'bundle exec rake',
    'bundle exec rspec',
    'ruby',
    'rails',
  ],
  // PHP stack
  'php': [
    'composer install',
    'composer update',
    'phpunit',
    'php',
    'php -l',
  ],
  // Other / generic
  'other': [],
}

module.exports = {
  PIPELINE_STATES,
  STEP_STATUSES,
  AGENT_ROLES,
  IPC,
  HARDCODED_EXCLUDE,
  STACK_DEFAULTS,
}
