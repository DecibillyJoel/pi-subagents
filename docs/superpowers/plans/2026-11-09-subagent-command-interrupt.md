# Subagent Command Interrupt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill one running command inside a subagent without stopping the subagent, and make the stop/interrupt controls reachable from the pi UI.

**Architecture:** The child session gets a session-scoped `bash` shadow built on pi's own `createBashToolDefinition` and `createLocalBashOperations`. The shadow registers each live command with a registry owned by `AgentManager`. A caller aborts only the command's controller, so pi's bash tool throws and the agent loop turns the throw into an error tool result and continues.

**Tech Stack:** TypeScript (ESM, `tsc` to `dist`), vitest, biome, pi 1.5.1 extension API.

**Spec:** `docs/superpowers/specs/2026-11-09-subagent-command-interrupt-design.md`

## Global Constraints

- The SDD worktree already ran `npm install`, and `npm run check` is green at the base commit (126 files, 2573 passed, 7 skipped). Do not install again.
- The acceptance gate is `npm run check` = `biome check src/ test/` + `tsc --noEmit` + `vitest run`.
- Every relative import carries an explicit `.js` specifier.
- `package.json` `pi.extensions` is `./src/index.ts`. pi loads the TypeScript source, not `dist/`.
- `test/` is outside the `tsconfig.json` `include` (src only). A test type error does not fail `tsc --noEmit`.
- pi symbols used: `createBashToolDefinition`, `createLocalBashOperations`, `BashOperations`, `ToolDefinition`. `createLocalShellOperations` is declared in the `.d.ts` but is NOT exported at runtime. Do not import it.
- The interrupt must never call `session.abort()`. `session.abort()` ends the whole run.
- The interrupt owner is a top-level agent record. `interrupt_subagent` is excluded from subagent sessions.
- One command interrupt never changes the agent record's status.
- Every commit message is imperative and names the unit of behavior, as in the existing history.

## Deviations From The Spec

- The spec threads `commandPrefix` and `shellPath` from `AgentManager`. This plan reads them inside `agent-runner.ts` from `sessionSettingsManager` instead. That manager is already built there, and it applies the trusted-project rule that the parent manager does not. Fewer moving parts, same values.
- The spec names the tool parameter `agentId`. This plan uses `agent_id`, to match the existing `get_subagent_result` and `steer_subagent` tools.
- The spec names `RunAgentOptions`. The real interface is `RunOptions`.

## Review Focus

Five failure modes, most likely first. Each names the task that adds its test.

1. **The interrupt kills the whole agent run instead of one command.** The wrapper must abort only its own controller, and the base `exec` must keep pi's run signal. Owning task: Task 2.
2. **The interrupt is unreachable because the `x` or `i` action is clipped from the footer.** The footer must never drop an action label, and a test must render at a narrow width. Owning task: Task 7.
3. **A reasonless interrupt stops producing pi's "Command aborted" text.** The wrapper must leave pi's own error path alone when no reason is set. Owning task: Task 2.
4. **The registry reports a command as live after it has exited.** `done()` must run in a `finally`, and a late `done()` must not clear a newer command. Owning task: Task 1.
5. **The shadow `bash` drops `commandPrefix`, `shellPath`, `promptSnippet`, or `promptGuidelines`.** The shadow must forward all four. Owning task: Task 2.

---

### Task 1: CommandInterruptRegistry

**Files:**
- Create: `src/command-interrupt.ts`
- Test: `test/command-interrupt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CommandHandle { readonly signal: AbortSignal; readonly done: () => void; readonly reason?: string }`
  - `class CommandInterruptRegistry` with `begin(agentId: string): CommandHandle`, `interrupt(agentId: string, reason?: string): number`, `isRunning(agentId: string): boolean`, `clear(agentId: string): void`.

- [ ] Write `test/command-interrupt.test.ts` with the failing cases:
  - `begin` returns a signal that is not aborted.
  - `interrupt(id)` aborts that signal and returns `1`.
  - `interrupt(id, "reason text")` makes `handle.reason` read `"reason text"`.
  - two `begin` calls for one id both abort on one `interrupt(id)`, which returns `2`.
  - `interrupt` on an unknown id returns `0` and does not throw.
  - after `done()`, `isRunning` is false and `interrupt` returns `0`.
  - `done()` on an old handle does not clear a newer handle for the same id.
  - the registry keys by id: `interrupt("a")` does not abort a command of `"b"`.
- [ ] Run `npx vitest run test/command-interrupt.test.ts` and see it fail with a missing module error.
- [ ] Implement `src/command-interrupt.ts` with the exact interfaces above. Add a JSDoc header that explains why the class holds a `Map<string, Set<AbortController>>` (pi runs tool calls in parallel, so one agent can have several live commands). Keep `done` bound to its own controller.
- [ ] Run `npx vitest run test/command-interrupt.test.ts` and see it pass.
- [ ] Run `npx biome check src/command-interrupt.ts test/command-interrupt.test.ts` and fix any finding.
- [ ] Commit: `Add a command interrupt registry keyed by agent`.

### Task 2: createInterruptibleBashTool

**Files:**
- Create: `src/interruptible-bash.ts`
- Test: `test/interruptible-bash.test.ts`

**Interfaces:**
- Consumes: `CommandInterruptRegistry` from `./command-interrupt.js`, `createBashToolDefinition`/`createLocalBashOperations`/`BashOperations` from `@earendil-works/pi-coding-agent`.
- Produces:
  - `interface InterruptibleBashOptions { cwd: string; agentId: string; registry: CommandInterruptRegistry; commandPrefix?: string; shellPath?: string }`
  - `function createInterruptibleBashTool(options: InterruptibleBashOptions): ToolDefinition` — returns a definition whose `name` is `"bash"`.

- [ ] Write `test/interruptible-bash.test.ts` with a fake `BashOperations` that records its `exec` options and never resolves until its signal aborts. Failing cases:
  - the returned definition has `name === "bash"`.
  - a `registry.interrupt(agentId)` makes `exec` resolve/reject with an aborted signal.
  - with a reason, the thrown error message ends with the reason and keeps the output text.
  - without a reason, the thrown error message is exactly `aborted`, so pi's own path produces `Command aborted`.
  - the wrapper passes pi's own run signal through: aborting the caller signal also aborts `exec`.
  - `registry.isRunning(agentId)` is true during `exec` and false after it settles.
  - `commandPrefix` and `shellPath` reach the returned definition (assert `promptSnippet` and `promptGuidelines` are present, and that the resolved command carries the prefix).
- [ ] Run `npx vitest run test/interruptible-bash.test.ts` and see it fail with a missing module error.
- [ ] Implement `src/interruptible-bash.ts`:
  1. `const base = createLocalBashOperations({ shellPath: options.shellPath })`.
  2. Build a wrapped `BashOperations` whose `exec(command, cwd, execOptions)` calls `const handle = options.registry.begin(options.agentId)`.
  3. `const signal = execOptions.signal ? AbortSignal.any([execOptions.signal, handle.signal]) : handle.signal`.
  4. Call `base.exec(command, cwd, { ...execOptions, signal })`.
  5. In a `finally`, call `handle.done()`.
  6. On a rejection where `handle.signal.aborted` is true and `handle.reason` is set, throw `new Error(appendStatus(text, handle.reason))`. Use the same `appendStatus` shape pi uses: `text ? \`${text}\n\n${status}\` : status`. When `handle.reason` is unset, rethrow the original error unchanged.
  7. Return `createBashToolDefinition(options.cwd, { operations: wrapped, commandPrefix: options.commandPrefix, shellPath: options.shellPath })` as `ToolDefinition`, and copy `promptSnippet` and `promptGuidelines` onto the result the way `createBashTool` does.
- [ ] Run `npx vitest run test/interruptible-bash.test.ts` and see it pass.
- [ ] Run `npx biome check src/interruptible-bash.ts test/interruptible-bash.test.ts` and fix any finding.
- [ ] Commit: `Add an interruptible bash tool built on pi's own bash tool`.

### Task 3: Wire the registry into the child session

**Files:**
- Modify: `src/agent-runner.ts`
- Test: `test/agent-runner.test.ts`

**Interfaces:**
- Consumes: `CommandInterruptRegistry` from `./command-interrupt.js`, `createInterruptibleBashTool` from `./interruptible-bash.js`.
- Produces: `RunOptions.commandInterrupt?: CommandInterruptRegistry`.

- [ ] Add a failing test to `test/agent-runner.test.ts`. This file mocks `createAgentSession` entirely, so assert on the mocked call's `customTools` array, not on a live session: with a config that allows `bash` and a `commandInterrupt` registry, `createAgentSession.mock.calls[0][0].customTools` contains a definition named `bash`. Add a second case: when `bash` is denied for the session, no `bash`-named definition is in `customTools`. The file's module mock must gain `createBashToolDefinition` and `createLocalBashOperations` stubs, or the import of `interruptible-bash.js` resolves them as `undefined`.
- [ ] Run the new test and see it fail.
- [ ] In `src/agent-runner.ts`:
  1. Add `commandInterrupt?: CommandInterruptRegistry` to `RunOptions` near `onSessionCreated`.
  2. In the tool-scope branch, compute `const bashAllowed = noExtensions ? Boolean(sessionTools?.includes("bash")) : !sessionExcludeTools?.includes("bash")`.
  3. When `bashAllowed` and `options.commandInterrupt` is set for a top-level agent, build `const interruptibleBash = createInterruptibleBashTool({ cwd: effectiveCwd, agentId, registry: options.commandInterrupt, commandPrefix: sessionSettingsManager.getShellCommandPrefix(), shellPath: sessionSettingsManager.getShellPath() })`. Reading the shell settings here, and not in the manager, is the deliberate deviation recorded above.
  4. Push it onto `customTools` next to `...nestedTools, ...structuredTools`.
  5. Add `INTERRUPT: "interrupt_subagent"` to `SUBAGENT_TOOL_NAMES` so `EXCLUDED_TOOL_NAMES` derives it.
- [ ] Run `npx vitest run test/agent-runner.test.ts` and see it pass.
- [ ] Run `npm run typecheck` and fix any error.
- [ ] Commit: `Shadow bash in a child session with the interruptible tool`.

### Task 4: AgentManager owns the registry

**Files:**
- Modify: `src/agent-manager.ts`
- Test: `test/agent-manager.test.ts`

**Interfaces:**
- Consumes: `CommandInterruptRegistry` from `./command-interrupt.js`.
- Produces:
  - `AgentManager.interruptCommand(id: string, reason?: string): number`
  - `AgentManager.isCommandRunning(id: string): boolean`

- [ ] Add failing tests to `test/agent-manager.test.ts`:
  - `interruptCommand` on a running agent returns `1` and does not change `record.status`.
  - `interruptCommand` on an unknown id returns `0` and does not throw.
  - `isCommandRunning` is false for an idle agent.
  - the registry instance is passed to `runAgent` as `commandInterrupt` (assert the option reaches the runner).
- [ ] Run the new tests and see them fail.
- [ ] In `src/agent-manager.ts`:
  1. Add `private readonly commandInterrupt = new CommandInterruptRegistry()` next to the other private fields on `AgentManager`.
  2. Add `commandInterrupt: this.commandInterrupt` to the `runAgent` options object.
  3. Add `interruptCommand(id, reason?)` and `isCommandRunning(id)` directly after `abort(id)`. `interruptCommand` delegates to the registry. Do not touch `record.status`, `record.abortController`, or `completedAt`.
  4. Call `this.commandInterrupt.clear(id)` from `removeRecord(id, record)` (`src/agent-manager.ts:1582`), next to `this.agents.delete(id)`. `removeRecord` is the single removal path (60s cleanup timer, `clearCompleted()` session boundaries, and the quit path), so a reused id cannot inherit stale handles.
- [ ] Run `npx vitest run test/agent-manager.test.ts` and see it pass.
- [ ] Run `npm run typecheck` and fix any error.
- [ ] Commit: `Let the agent manager interrupt one live command`.

### Task 5: interrupt_subagent tool and /interrupt command

**Files:**
- Modify: `src/index.ts`
- Test: `test/interrupt-subagent-tool.test.ts`

**Interfaces:**
- Consumes: `SUBAGENT_TOOL_NAMES.INTERRUPT`, `AgentManager.interruptCommand`, `resolveAgentRef`, `isTopLevelAgent`, `textResult`, `defineTool`, `registerToolReportingUsage`.
- Produces:
  - tool `interrupt_subagent` with parameters `Type.Object({ agent_id: Type.String(...), reason: Type.Optional(Type.String(...)) })`.
  - slash command `/interrupt <agentId> [reason]`.

- [ ] Write `test/interrupt-subagent-tool.test.ts` using `test/helpers/boot-extension.ts` `makePi`:
  - the tool is registered under the name `interrupt_subagent`.
  - `execute` with a running agent returns text that names the count and does not change agent status.
  - `execute` with no live command returns a result that says nothing was running, not an error.
  - `execute` on an id owned by another agent returns the ownership error.
  - `interrupt_subagent` is not offered to a plain subagent session.
- [ ] Run the new test and see it fail.
- [ ] In `src/index.ts`:
  1. Register the tool with `registerToolReportingUsage(defineTool({ name: SUBAGENT_TOOL_NAMES.INTERRUPT, label: "Interrupt Subagent Command", ... }))` next to the `get_subagent_result` tool. Resolve the id with `resolveAgentRef`, check `isTopLevelAgent`, then call `manager.interruptCommand(record.id, params.reason)` and return a `textResult`.
  2. Register `pi.registerCommand("interrupt", ...)` next to the `agents` command. Parse the first token as the agent id and the rest as the reason.
- [ ] Run `npx vitest run test/interrupt-subagent-tool.test.ts` and see it pass.
- [ ] Run `npm run typecheck` and fix any error.
- [ ] Commit: `Add interrupt_subagent and the /interrupt command`.

### Task 6: Cross-extension RPC channel

**Files:**
- Modify: `src/cross-extension-rpc.ts`
- Test: `test/cross-extension-rpc.test.ts`

**Interfaces:**
- Consumes: the `SpawnCapable` manager view, `assertOwned`, `handleRpc`.
- Produces: channel `subagents:rpc:interrupt` with `{ requestId, agentId, reason? }` and reply `subagents:rpc:interrupt:reply:${requestId}`.

- [ ] Add failing tests to `test/cross-extension-rpc.test.ts`:
  - an `interrupt` request for an owned agent replies `{ success: true, data: { interrupted: <count> } }`.
  - an `interrupt` request for an agent owned by another agent replies `{ success: false, error: "Agent is owned by another agent or workflow" }`.
  - an `interrupt` request with no live command succeeds with `interrupted: 0`.
- [ ] Run the tests and see them fail.
- [ ] In `src/cross-extension-rpc.ts`:
  1. Widen `SpawnCapable` with `interruptCommand(agentId: string, reason?: string): number`.
  2. Register the handler mirroring `:stop`: `assertOwned(agentId)` first, then `manager.interruptCommand(agentId, reason)`.
  3. Add `unsubInterrupt` to the returned handle object.
  4. Keep `PROTOCOL_VERSION` unchanged. The channel is additive.
- [ ] Run `npx vitest run test/cross-extension-rpc.test.ts` and see it pass.
- [ ] Run `npm run typecheck` and fix any error.
- [ ] Commit: `Add the subagents:rpc:interrupt channel`.

### Task 7: Reachable stop and interrupt controls

**Files:**
- Modify: `src/ui/fleet-list.ts`, `src/ui/conversation-viewer.ts`, `src/index.ts`
- Test: `test/fleet-list.test.ts`, `test/conversation-viewer.test.ts`

**Interfaces:**
- Consumes: `AgentManager.abort`, `AgentManager.interruptCommand`, `AgentActivity.activeTools`.
- Produces:
  - a trailing optional constructor parameter `onInterrupt?: () => void` on `ConversationViewer`.
  - `x` and `i` keys in the fleet list's active block.
  - `i` key in the conversation viewer.
  - a footer that never clips an action label.

- [ ] Add failing tests:
  - `test/fleet-list.test.ts` (extend `fakeManager` with `interruptCommand` and `isCommandRunning`): `x` twice on the selected running agent calls `abort` once. `i` calls `interruptCommand` once. `x` on a completed agent does nothing.
  - `test/conversation-viewer.test.ts`: the viewer renders `i interrupt` only while a bash tool is live, and the composed footer fits `width` for a narrow width (assert with `assertAllLinesFit` and `visibleWidth`).
- [ ] Run the new tests and see them fail.
- [ ] In `src/ui/fleet-list.ts`, add `x` (two-press stop) and `i` (interrupt) inside the active block of `handleKey`. Any other key still deactivates. The keys apply to the selected row: `x` calls `this.manager.abort(record.id)` when `record.status` is `running` or `queued` (the same condition as the viewer's `isStoppable()`), and `i` calls `this.manager.interruptCommand(record.id)` when `record.status === "running"`.
- [ ] In `src/ui/conversation-viewer.ts`:
  1. Add a trailing optional `onInterrupt` parameter to the constructor.
  2. Bind `i` next to `x` and reset its arm state on the same keys that reset `stopArmed`.
  3. Add the `i interrupt` footer action only while a `bash` tool is live in the `AgentActivity.activeTools` map.
  4. Fix the footer so it composes the action labels before the navigation hint and never lets `footerGap` clamp to a row wider than `innerW`. Truncate the navigation hint instead of the actions.
- [ ] In `src/index.ts`, pass `onInterrupt` at both `ConversationViewer` call sites (`viewAgentConversation` and, via the fleet list, `openSelected`).
- [ ] Run `npx vitest run test/fleet-list.test.ts test/conversation-viewer.test.ts` and see them pass.
- [ ] Run `npm run check` and fix any finding.
- [ ] Commit: `Show reachable stop and interrupt controls in the agent UI`.

### Task 8: Document and verify

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Test: `test/documented-defaults.test.ts` (only if a documented value changes)

**Interfaces:**
- Consumes: nothing new.
- Produces: README coverage for the `interrupt_subagent` tool, the `/interrupt` command, the `x` and `i` keys, and the `subagents:rpc:interrupt` channel.

- [ ] Add the README entries: the tool and its parameters, the slash command, the two keys in the fleet list and the viewer, and the RPC channel with its reply channel name.
- [ ] Add a `CHANGELOG.md` entry under `## [Unreleased] / ### Added`.
- [ ] Run `npm run check` and confirm biome, `tsc --noEmit`, and vitest all pass.
- [ ] Confirm spec coverage against `docs/superpowers/specs/2026-11-09-subagent-command-interrupt-design.md` section by section. Record the known limitation in the spec: a resume's `bash` shadow is not re-installed.
- [ ] Leave the live TUI test to the human partner after the branch is merged. pi loads this package from the clone at `git/github.com/DecibillyJoel/pi-subagents`, not from this worktree, so a worktree cannot be exercised in a live session without repointing pi's package config. Do not change that config.
- [ ] Commit: `Document the subagent command interrupt`.
