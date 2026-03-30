# Wazear — Security Audit Task Prompt
**Hand this entire file to Qwen CLI as a one-shot task prompt.**

---

## Your role and objective

You are performing a structured security audit of the Wazear Electron/TypeScript application. Your job is to find real, confirmed issues — not theoretical ones. Do not report something as a finding unless you have located the specific file and line where it exists.

You will work through four distinct audit passes, in the order listed below. Complete each pass fully before starting the next. After all four passes, produce a single consolidated report as described at the end of this prompt.

Do not modify any source files during this audit. Read only.

---

## Before you start: orient yourself

Before running any pass, do the following exactly once:

1. List the top-level directory structure of the project.
2. Locate and read `package.json` (and `package-lock.json` or `yarn.lock` if present) to understand dependencies, scripts, and the Electron version in use.
3. Locate the Electron main process entry point (commonly `main.ts`, `main/index.ts`, or the value of the `main` field in `package.json`).
4. Locate the renderer process entry point(s).
5. Identify whether a `preload` script exists and where it is.
6. Identify whether there is a database in use (SQLite, LowDB, better-sqlite3, etc.).
7. Identify all locations where child processes, shell commands, or `exec`/`spawn` are invoked.
8. Identify all locations where AI model calls are made (any LLM SDK, `fetch` to an AI API, etc.).

Record these facts. Reference them throughout the passes. Do not assume any structure — discover it.

---

## Pass 1 — Static analysis: secrets and hardcoded credentials

**Goal:** Find credentials, keys, tokens, or secrets that are hardcoded in source files and would be committed to version control.

**What to look for:**

- API keys for any external service (OpenAI, Anthropic, AWS, Stripe, etc.) assigned directly to a variable or string literal.
- Hardcoded passwords, database connection strings, private keys, or bearer tokens.
- `.env` values that are duplicated inline in source files rather than read from `process.env`.
- Any secret-looking string matching the pattern of a key (long alphanumeric, starts with `sk-`, `pk_`, `AIza`, `AKIA`, etc.).
- `console.log` or logging calls that print secrets or tokens at runtime.
- Any credential or token stored in `localStorage`, `sessionStorage`, or `electron-store` without encryption.

**How to search:**

Use grep or file reads. Suggested patterns (adapt to what you find in the codebase):

```
grep -rn "sk-" src/
grep -rn "api_key\|apiKey\|API_KEY" src/ --include="*.ts" --include="*.js"
grep -rn "password\s*=\|password:" src/
grep -rn "Bearer " src/
grep -rn "private_key\|privateKey" src/
```

Do not report environment variable reads (`process.env.SOME_KEY`) as findings — those are correct. Only report actual string literal values.

**Output format for this pass:**

For each finding:
```
[SECRETS-N] Severity: Critical|High|Medium
File: <relative path>
Line: <line number>
Description: <one sentence — what was found>
Evidence: <the exact line or the relevant portion, redacted if it's a real key>
Recommendation: <one sentence fix>
```

---

## Pass 2 — Destructive command detection

**Goal:** Find code that could irreversibly destroy data, files, system state, or the database — especially code that could be triggered accidentally or by untrusted input.

**Electron-specific context:** Electron gives the main process full Node.js access. A single unsanitized input reaching `exec`, `spawn`, `rm`, or a raw SQL statement can have system-level consequences.

**What to look for:**

**File system destruction:**
- `fs.rm`, `fs.rmdir`, `fs.unlink` called with a path that is user-supplied or constructed from user input without validation.
- Shell commands containing `rm -rf`, `del /f /q`, `rimraf`, or equivalent.
- Any `exec`/`execSync`/`spawn`/`spawnSync` call where any part of the command string is derived from user input, IPC messages, or AI model output without sanitization.

**Database destruction:**
- Raw SQL strings containing `DROP TABLE`, `DELETE FROM` without a `WHERE` clause, `TRUNCATE`, `DROP DATABASE`.
- ORM calls like `.destroy()`, `.deleteMany()`, `.truncate()` with no `where` argument.
- Database file deletion (`unlink` on a `.db` or `.sqlite` file).

**Electron IPC risk:**
- `ipcMain.on` or `ipcMain.handle` handlers that execute a shell command, file deletion, or database write using data directly from the renderer without validation.
- `contextBridge` exposing dangerous Node.js APIs directly to the renderer (e.g., exposing `fs` or `child_process` wholesale).
- `nodeIntegration: true` set in `BrowserWindow` options — this is a critical misconfiguration.
- `contextIsolation: false` set in `BrowserWindow` options — also critical.
- `webSecurity: false` — disables same-origin policy.

**AI output execution:**
- Any code path where text or code returned by an LLM is passed to `eval()`, `new Function()`, `exec()`, or written to a file and then executed.
- Any code path where LLM output influences a file path used for deletion or overwrite.

**How to search:**

```
grep -rn "exec\|execSync\|spawn\|spawnSync" src/
grep -rn "fs\.rm\|fs\.unlink\|fs\.rmdir\|rimraf" src/
grep -rn "DROP TABLE\|DELETE FROM\|TRUNCATE" src/
grep -rn "nodeIntegration\|contextIsolation\|webSecurity" src/
grep -rn "ipcMain\.on\|ipcMain\.handle" src/
grep -rn "eval(" src/
grep -rn "new Function(" src/
```

For every `exec`/`spawn` call found, trace back whether any argument could originate from user input, IPC, or AI output.

**Output format for this pass:**

```
[DESTRUCT-N] Severity: Critical|High|Medium|Low
File: <relative path>
Line: <line number>
Description: <one sentence>
Attack vector: <how an attacker or bad input could trigger this>
Evidence: <the relevant code snippet>
Recommendation: <concrete fix — e.g., "validate path against allowlist before passing to fs.unlink">
```

---

## Pass 3 — Dependency vulnerability scanning

**Goal:** Identify known CVEs or high-severity advisories in the project's npm dependencies.

**Steps:**

1. Run `npm audit --json` from the project root. This is a read-only operation — do not pass `--fix` or any flag that modifies files. Parse the output.
2. If `npm audit` is not available or fails, install `audit-ci` outside the project folder (`npm install --prefix /tmp/audit-tools audit-ci`) and run it pointing at the project root. Do not install anything inside the project folder.
3. Filter results to `high` and `critical` severity only. Do not report `low` or `moderate` unless they have a known exploit path relevant to an Electron desktop app.
4. For each high/critical finding, check whether the vulnerable package is in `dependencies` (ships to users) or `devDependencies` (build-time only). Flag the former as higher priority.
5. Check the Electron version itself. Cross-reference it with the [Electron security releases page](https://releases.electronjs.org/releases/stable) pattern — specifically note if the version is end-of-life or more than two major versions behind current stable.

**Do not hallucinate CVEs.** Only report what `npm audit` actually returns. If `npm audit` returns zero findings, say so explicitly.

**Output format for this pass:**

```
[DEP-N] Severity: Critical|High
Package: <name@version>
CVE / Advisory: <ID>
In: dependencies | devDependencies
Description: <one sentence — what the vulnerability is>
Fix: <npm audit fix command or manual upgrade path>
```

End with a one-line summary: total critical, total high, and whether any are in `dependencies`.

---

## Pass 4 — Runtime sandbox escapes and prompt injection

**Goal:** Find code paths where the Electron sandbox could be escaped, or where AI prompt injection could cause unintended execution.

**Electron sandbox checks:**

- Confirm `sandbox: true` is set (or not explicitly disabled) in `BrowserWindow` `webPreferences`.
- Confirm `allowRunningInsecureContent` is `false` or absent.
- Check whether any renderer-facing preload script exposes APIs that allow arbitrary file reads, writes, shell execution, or IPC to privileged channels without input validation.
- Check for use of `shell.openExternal()` with a URL derived from user input or page content — this can be used to execute arbitrary protocol handlers.
- Check for `protocol.registerFileProtocol` or `protocol.interceptFileProtocol` — misuse can allow renderer-to-filesystem access bypassing the sandbox.

**Prompt injection checks:**

Prompt injection occurs when untrusted content (user data, web content, file content) is interpolated directly into an AI prompt without sanitization, and the resulting output is then used in a sensitive operation.

- Locate all places where LLM prompts are constructed. Check whether any part of the prompt is:
  - Raw user input
  - Content read from a file the user opened
  - Content fetched from an external URL
  - AI-generated content from a prior turn (chained without a trust boundary)
- For each such prompt, check what the AI output is then used for:
  - If it is displayed only → low risk
  - If it is written to a file → medium risk
  - If it is passed to `exec`, `eval`, or used to construct a file path → critical risk
- Check whether system prompts contain instructions that an attacker could override with user-supplied content (e.g., `You are a helpful assistant. User says: ${userInput}` where `userInput` could contain `"Ignore all previous instructions"`).

**Output format for this pass:**

```
[SANDBOX-N] Severity: Critical|High|Medium
File: <relative path>
Line: <line number>
Type: Sandbox escape | Prompt injection | Insecure IPC | Protocol misuse
Description: <one sentence>
Attack scenario: <how this could be exploited>
Evidence: <the relevant code>
Recommendation: <concrete fix>
```

---

## Final consolidated report

After all four passes, output a single report with the following structure. Do not repeat all the evidence again — summarize and reference finding IDs.

```
# Wazear Security Audit Report

## Summary table

| ID         | Severity | Pass    | Short description                        |
|------------|----------|---------|------------------------------------------|
| SECRETS-1  | Critical | Pass 1  | ...                                      |
| DESTRUCT-1 | High     | Pass 2  | ...                                      |
| ...        |          |         |                                          |

## Critical findings (fix before next release)
List all Critical findings with their IDs and one-sentence descriptions.

## High findings (fix within current sprint)
List all High findings.

## Medium / Low findings (schedule for backlog)
List all Medium and Low findings.

## Electron security configuration status
Confirm or deny each of the following. State the file and line for each:
- [ ] nodeIntegration: false
- [ ] contextIsolation: true
- [ ] sandbox: true
- [ ] webSecurity: true
- [ ] allowRunningInsecureContent: false
- [ ] Electron version is not end-of-life

## Dependency audit summary
Total critical: N | Total high: N | In production dependencies: N

## What was not found
Explicitly state any category where no issues were found. This confirms coverage.
```

---

## Constraints and rules you must follow

### Project folder is read-only — no exceptions

- **Do not create, modify, or delete any file inside the project folder.** This includes source files, config files, lock files, `node_modules`, and any generated output.
- **Do not run `npm install`, `npm audit fix`, `npx`, or any package manager command inside the project folder.** These can silently modify `package-lock.json`, `node_modules`, or other files.
- **Do not run the application.**
- If any tool or command you need is not installed on the system, install it to a temporary directory **outside** the project folder (e.g., `/tmp/`). Example: `npm install --prefix /tmp/audit-tools some-tool` rather than installing inside the project.
- `npm audit` is the one exception — run it from the project root because it needs to read `package-lock.json`, but it is a read-only operation and does not modify files. Do not pass `--fix`.

### Analysis rules

- **Do not invent findings.** If you cannot find evidence for something, say so explicitly.
- **Do not report false positives from environment variable reads.** `process.env.X` is correct usage, not a finding.
- **Be specific.** Every finding must have a file path and line number. Findings without a location are invalid and must not be included.
- **If you cannot access a file or directory, say so explicitly** rather than skipping it silently.
- **If the codebase structure differs significantly from what this prompt assumes** (e.g., no Electron main process found, no AI calls found), note the discrepancy and adapt the relevant pass accordingly rather than inventing findings to fill the template.
