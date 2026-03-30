# WAZEAR — Project Instructions for Qwen Code

## Ground Truth

These files are authoritative. They override this file on product behaviour:
- `@implementation-spec.md` — implementation spec
- `@project-spec.md` — product specification

This file governs how you work, not what you build.

---

## Stack Constraints

Do not add, suggest, or introduce anything outside this:
- Electron + vanilla JS + plain HTML + plain CSS. No frameworks, no TypeScript, no bundler.
- `js-yaml` is the only permitted runtime dependency. No others without a spec-documented reason.
- Node.js built-ins only for file I/O, crypto, path. No third-party equivalents.

---

## Landmines

Things that look normal but will break this project. You cannot discover these from
the code alone.

| What | Rule |
|---|---|
| `--yolo` spawn flag | Never. Always `--approval-mode auto-edit`. |
| `ipcRenderer.sendSync` | Never. |
| `nodeIntegration: true` or `contextIsolation: false` | Never. |
| `element.style.*` in JS | Never, except `display`. All styling goes in `styles.css`. |
| Inline styles in HTML | Never. |
| Path string concatenation | Never. Always `path.join()` or `path.resolve()`. |
| Hardcoded IPC channel names | Never. Always `IPC.*` keys from `main/constants.js`. |
| Writing `.qwen/settings.json` | Only `AgentProcess._writeAgentSettings()` may write this. |
| Writing `~/.qwen/settings.json` | Never. Read only. |
| Logic in `index.html` | Never. Markup skeleton only. |
| Reading DOM to determine state | Never. Read `state.*` in `renderer.js` only. |
| `PipelineRunner` as class export | Never. It is a singleton: `module.exports = new PipelineRunner()`. |
| `ipc.js` handlers over 3 lines | Never. Route only. Logic belongs in the target module. |
| `AgentLibrary` top-level require | Never. Lazy `require()` inside `usageCount()` only — prevents circular dependency. |
| npm package install | Only with a spec-documented reason. |
| Refactor + feature in same edit | Never. Pick one. |

---

## Coding Rules

`const` by default. `let` only when reassignment is required. Never `var`.

Every `async` function: wrapped in `try/catch` or its caller wraps it. Every
`ipcMain.handle` body: `try/catch`, return `{ error: e.message }` on error, never
throw. Every `await window.api.*`: `try/catch`, surface via `appendLogLine`. Every
`JSON.parse`: `try/catch`.

One responsibility per module. Exports explicit: `module.exports = { ... }`.

---

## How to Work

**Every task, before writing any code:**

State your understanding of the task in one or two sentences. If anything is ambiguous,
ask one question and wait. Do not guess past uncertainty.

**If the task is a bug fix:** The full protocol is defined in @BUG-FIX-PROTOCOL.md.
Read it now. You must produce the Investigation Report and Success Commitment defined
there before touching any file.

If you detect a conflict between the user's request and the spec, stop. State the
conflict explicitly. Wait for direction. Do not write code in the same turn.

Before modifying any file, read its current contents. Do not assume what a file
contains.

If you are about to use an API, flag, or library whose current behaviour you are not
certain of, search online first. Do not rely on training memory for Qwen CLI flags,
Electron APIs, or Node.js built-ins.
