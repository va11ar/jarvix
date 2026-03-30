# WAZEAR — Bug-Fix Protocol

> This file is imported by QWEN.md via the @BUG-FIX-PROTOCOL.md reference and is
> part of your active context for any bug-fix task. Read it completely before
> writing any code.

---

## Before Any Code

You must produce two things before touching any file:

**1. An Investigation Report**
**2. A Success Commitment**

Both must be specific. Vague answers mean you have not investigated yet. Do not write
code with vague answers.

---

## Investigation Report

Produce this block filled in completely:

```
INVESTIGATION REPORT
====================
Bug: [one sentence restatement]
File: [exact path]
Function / selector: [exact name]
Line: [number or range]
Actual behaviour: [what happens]
Expected behaviour: [what should happen]
Root cause: [one sentence — exact mechanism, no speculation. Must name a specific
            file, function, browser behaviour, or language rule. No "might", "think",
            "try", or "probably".]
Files read: [every file you loaded to reach this conclusion]
Callers affected: [every file and line that calls the function you are changing,
                  or "none — no function boundary crossed"]
Spec section: [which section, or "not applicable — [reason]"]
```

If any field contains speculation or a placeholder, you have not finished the
investigation. Do not proceed.

---

## Success Commitment

Immediately after the Investigation Report, state:

```
SUCCESS COMMITMENT
==================
When this fix is working, the user will see: [specific, observable, testable outcome]
```

This is a commitment, not a hope. It must describe something the user can directly
observe when they run the app. "The code will be correct" is not a success commitment.
"The tooltip will appear when hovering over the disabled button" is.

The success commitment is how the user knows whether to trust your claim that the fix
is done. You will be held to it.

---

## Root Cause Standard

Root cause names the exact mechanism. One sentence. No hedging.

Valid:
- "Disabled HTML buttons do not fire pointer or hover events in any browser — the tooltip trigger on the button itself never activates."
- "The `ipcMain.handle` body in `ipc.js` line 42 is not wrapped in `try/catch`, so unhandled errors silently reject the renderer's invoke promise."

Invalid — stop and keep investigating:
- "The tooltip might be positioned incorrectly."
- "I think the CSS is the issue."
- "Let me try moving the element."

If you cannot write the root cause without hedging words, you have not found it yet.

---

## Fix Summary

After writing the fix, before saying it is done:

```
FIX SUMMARY
===========
Files changed: [list]
What changed: [for each file — what the code was, what it is now]
Callers verified: [confirm each caller from the Investigation Report is unaffected]
IPC contract checked: [if ipc.js was touched — handler, preload, renderer all agree
                      on channel name, argument shape, return shape. Or "not applicable".]
DOM contract checked: [if renderer.js DOM IDs were touched — IDs verified in index.html.
                      Or "not applicable".]
State shape checked: [if state object changed — all usages of changed field audited.
                     Or "not applicable".]
```

Do not write "done" or "fixed" without this block. Do not write this block until the
changes are actually made.

---

## If the Fix Does Not Work

Do not patch on top of broken code.

Revert the change. Then produce a new Investigation Report. The new report must contain
one additional field:

```
Why the first root cause was wrong: [what you now understand that you did not before]
```

If you cannot fill that field, you do not yet understand the bug. Read more before
writing a new report.

---

## One Bug Per Report

If the fix exposes a second bug, stop. Report the second bug separately after the
first is confirmed working. Do not fix two bugs in one pass.
