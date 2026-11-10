# Interrupt One Running Command In A Subagent

Status: Design, approved by the human partner on 2026-11-09.
Three open questions were answered by the human partner on 2026-11-09:
track every live command, allow top-level callers only, and deliver the
reason to the child.

## Intent

A subagent can wedge on a command that never returns. The user asked the
main agent to stop the subagent. Neither the agent nor the user could do
it without finding the shell PID and killing it by hand. Stopping the
parent agent left the subagent running. The `/agents` surface showed no
working stop affordance.

Today the only lever is `manager.abort(id)`. It calls `session.abort()`,
which aborts the whole agent run. There is no per-command handle in pi's
public API. `AgentSession.abortBash()` serves only `!`-prefixed user
shell, never the model's bash tool.

This change adds a second lever: kill the command that is running, and
let the subagent keep going. The subagent receives an error tool result
and can choose another step.

## Goals

- Kill one subagent's currently running command, as a whole process
  group.
- Let the subagent continue with an error tool result.
- Offer the interrupt to three callers: a user in the UI, the parent
  agent through a tool, and another extension through RPC.
- Fix the missing stop affordance in the `/agents` surfaces.

## Non-Goals

- No automatic idle watchdog. The user chose manual interrupts only.
- No change to `manager.abort(id)`. Whole-agent stop keeps its meaning.
- No change to the parent session.

## Anti-Goals

- Killing a command the user did not name.
- Leaving the child wedged after an interrupt.
- Breaking pi's bash rendering, truncation, or full-output file.
- Shadowing `bash` for an agent that was not allowed bash.

## Constraints

- pi's bash tool takes an `operations` seam:
  `createBashToolDefinition(cwd, options)` uses
  `options.operations ?? createLocalBashOperations(...)`, and the tool
  calls `ops.exec(command, cwd, { onData, signal, timeout, env })`.
- `createLocalBashOperations` kills the whole process group on abort.
  It sends `SIGKILL` to `-pid`, with a fallback to `pid`.
- Aborting with reason `"aborted"` makes pi's bash tool throw
  `Command aborted`. The agent loop turns a thrown tool into an error
  tool result and continues. This is the wanted semantics.
- A custom tool named `bash` shadows the builtin in one child session
  only. `customTools` is session-scoped. The builtin registry is built
  first, then custom tools overwrite by name.
- `bash` must pass the session allowlist for the shadow to work.
- `AbortSignal.any` exists in Node 26.

## Approaches

### 1. Wrap `operations` and shadow `bash` in the child session (chosen)

Build the child's `bash` from `createBashToolDefinition(cwd, {
operations })`. The wrapper merges pi's run signal with a private
interrupt signal through `AbortSignal.any`. A registry keyed by agent id
holds the private controller.

- Good: uses pi's own kill path and pi's own bash rendering.
- Good: the interrupt is scoped to one command, and the child session
  isolation protects the parent.
- Cost: one new custom tool per child session, only when bash is
  allowed.

### 2. Reuse `session.abort()`

Already exists. It ends the whole run, which is the wrong scope. Not
chosen.

### 3. Kill the process group from outside by PID

Walk `/proc`, find descendants, `kill -9`. This is the manual
workaround. It is fragile and unaware of pi. Not chosen.

## The Design

### Interrupt registry

New module `src/command-interrupt.ts`.

`CommandInterruptRegistry` holds a `Map<string, Set<AbortController>>`
keyed by agent id. An agent can have more than one live command. pi's
agent loop defaults to `toolExecution: "parallel"`, and one assistant
turn with two bash calls runs both `exec` calls at once.

- `begin(agentId)` creates a controller, adds it to the agent's set,
  and returns the signal plus a `done()` cleanup.
- `interrupt(agentId, reason?)` aborts every live controller for that
  agent and returns how many it aborted. Zero means no command was live.
- `isRunning(agentId)` reports whether the agent has any live command.
  It stays true until the last command exits.

`done()` removes only its own controller from the set, and drops the set
when it is empty. A late cleanup therefore cannot clear a newer command.

### Interruptible bash tool

New module `src/interruptible-bash.ts`.

`createInterruptibleBashTool({ cwd, agentId, registry, commandPrefix?,
shellPath? })`:

0. Forward `commandPrefix` and `shellPath` to the definition, the way
   pi's own builtin does. pi builds the child's builtin as
   `createAllToolDefinitions(cwd, { bash: { commandPrefix:
   shellCommandPrefix, shellPath } })`. The factory must match that, or
   every subagent command silently stops running the user's shell
   setup.
1. Wraps `createLocalBashOperations({ shellPath })`.
2. In `exec`, calls `registry.begin(agentId)`.
3. Builds the signal: `opts.signal ? AbortSignal.any([opts.signal,
   handle.signal]) : handle.signal`.
4. Calls the base `exec` with that signal.
5. Calls `handle.done()` in a `finally`.
6. Returns `createBashToolDefinition(cwd, { operations, commandPrefix,
   shellPath })`, and copies `promptSnippet` and `promptGuidelines`
   from the definition, the way `createBashTool` does.

The reason reaches the child. `interrupt(agentId, reason)` stores the
reason on the handle. When the base `exec` rejects and the interrupt
signal fired, the wrapper throws `new Error(appendStatus(text, reason))`
so the child's tool result carries why the command died. A reason-free
interrupt leaves pi's own text: the base `exec` rejection already
reaches pi's catch, which writes `Command aborted`.

The reason path is sound because pi's bash tool re-throws any error that
is neither `"aborted"` nor `"timeout:"`. The agent loop then turns the
thrown tool error into an error tool result and the subagent continues.

The wrapper keeps pi's schema, renderer, truncation, and full-output
file.

### Child session wiring

`src/agent-runner.ts` builds `sessionOpts` near line 1258. Two changes:

- Add the interrupt tool to `customTools` at line 1276, but only when
  `bash` passes the session tool scope. With an allowlist, bash is in
  `sessionTools`. With the deny path, bash is absent from
  `sessionExcludeTools`.
- Thread a `commandInterrupt` registry and the `agentId` through
  `RunAgentOptions`.

### Manager

`src/agent-manager.ts` owns one `CommandInterruptRegistry`. It passes
the registry into `runAgent` at line 825. It gains
`interruptCommand(id, reason?): number`, which delegates to the
registry and returns the count. It also exposes `isCommandRunning(id)`
for the UI.

The registry must also receive the child's `commandPrefix` and
`shellPath`, so the shadow tool keeps the user's shell setup. The
manager reads them from the settings manager and threads them through
`RunAgentOptions` beside the registry.

### Parent agent tool

`src/index.ts` gains `interrupt_subagent`, built with the existing
`defineTool` pattern near line 3073. Parameters: `agentId` (string,
required) and `reason` (string, optional). The result reports how many
commands were killed, or that no command was running.

Ownership is top-level only, matching the existing RPC `stop` handler's
`assertOwned` rule (`src/cross-extension-rpc.ts:200`). Add `INTERRUPT:
"interrupt_subagent"` to `SUBAGENT_TOOL_NAMES`
(`src/agent-runner.ts:44-49`). `EXCLUDED_TOOL_NAMES` derives from
`Object.values(SUBAGENT_TOOL_NAMES)`, so a plain subagent does not
inherit the tool. A subagent therefore cannot interrupt a sibling's or
its parent's command.

### Cross-extension RPC

`src/cross-extension-rpc.ts` gains a channel, matching the existing
`stop` shape at line 201:

- Request `subagents:rpc:interrupt` with `{ requestId, agentId }`.
- Reply `subagents:rpc:interrupt:reply:${requestId}`.

### UI

Two surfaces, one new key.

- Fleet list (`src/ui/fleet-list.ts`): bind `x` (two-press) to stop the
  agent, and `i` to interrupt the running command. The list binds no
  stop key today.
- Conversation viewer (`src/ui/conversation-viewer.ts`): keep `x` for
  stop, and add `i` for interrupt, shown only while a command is live.
- Footer visibility: the stop and interrupt actions must render before
  the right-side navigation hint is allowed to crowd them. The current
  row can exceed `innerW` and clip the middle actions, which is the
  likely cause of the missing `x`. The fix keeps the action labels
  intact and shortens or drops the navigation hint first.
- Both openers pass `onInterrupt`: `src/index.ts` around line 3418 and
  `src/ui/fleet-list.ts` around line 433.
- Liveness source: `ConversationViewer` already receives the agent's
  `AgentActivity` object. That object re-renders on `tool_execution_*`
  events through the session subscription. The viewer reads the live
  command state from it. No new injected predicate is needed.

### Slash command

`src/index.ts` gains `/interrupt <agentId>`, next to
`registerCommand("agents", ...)` at line 4423. It reports the same
result as the tool.

## Known Limitations

- **A resumed agent does not get the `bash` shadow installed again.**
  `resumeAgent` (`src/agent-runner.ts:1428`) takes the session that the
  original run created (`record.session`, passed at
  `src/agent-manager.ts:1287` and `:1409`) and only calls `observeRun` and
  `session.prompt`. It never builds `customTools`, so the shadow is not
  installed a second time. The shadow is installed once, in `runAgent`
  (`src/agent-runner.ts:1272-1295`), and reaches the session through
  `customTools` (`src/agent-runner.ts:1309`).
- **The missing re-install does not lose tracking today.** A pi session
  keeps its injected custom tools for the life of the object
  (`this._customTools` at
  `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:182`,
  re-applied by `_refreshToolRegistry` at `:2817`). The resumed session is
  the same object, with the same registry and the same agent id, so an
  interrupt during a resumed run finds the live command and reports it as
  usual. A resumed agent does not show the reported gap.
- **A rebuilt session would lose it.** If a future change builds a session
  outside `runAgent`, the shadow is gone and `interrupt_subagent` reports
  `No commands were running for "<agent>".` while a command is live. No
  such path exists today: `createAgentSession` has one call site,
  `src/agent-runner.ts:1319`.
- **A reasonless interrupt is not distinguishable from a real abort.**
  The child keeps pi's `Command aborted` text, as the human partner chose.
  A caller that must tell the two apart has to pass a `reason`.

## What Is Left To The Builder

- Pin the exact cause of the missing `x` in a live session. The footer
  overflow is the leading theory, not a confirmed one. Two verified
  facts narrow it. The viewer footer renders `x stop` only while
  `isStoppable()`, which is `status === "running" || status ===
  "queued"` (`src/ui/conversation-viewer.ts:642-644`). A live command
  shows activity `running command` (`src/ui/agent-widget.ts:29`), so the
  agent was running and the stop action should have been pushed. The
  remaining suspect is the overflow computation.
- Verify that a `ToolDefinition` passed through `customTools` keeps
  `promptSnippet` and `promptGuidelines`, or copy them as
  `createBashTool` does.
- Confirm the shadowed `bash` is still allowed when the agent has
  extensions enabled, where `sessionExcludeTools` is the mechanism.
- Keep the registry's liveness in step with the viewer. The viewer shows
  `i` only while a command is live, and reads that from the agent's
  `AgentActivity` object, which re-renders on `tool_execution_*` events.
  The registry and the activity map must agree, so test a command that
  exits normally as well as an interrupted one.
- Settle the exact status text. The human partner chose to deliver the
  reason to the child, so the reasonless case must keep pi's
  `Command aborted` text and the reason case must use the caller's
  reason. Pick the separator and test both.
- Write the README entries: the new tool, the RPC channel, the keys, and
  the slash command.
- Add the CHANGELOG entry.
- Run `npm run check` (`biome check`, `tsc --noEmit`, `vitest run`).
  The repo needs one `npm install` first: `node_modules` is incomplete.
- Install the fork over the npm package, and verify both keys in a live
  TUI session.
