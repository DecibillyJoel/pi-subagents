# Subagent model confirmation gate — design

Date: 2026-11-08
Status: awaiting approval

## Intent

The runtime agent can name a model for a subagent. Today `pi-subagents`
resolves that model and spawns the child without a word to the human
partner. The partner pays for the choice and never sees it.

An omitted model inherits the caller's own model. So naming one is always
a deliberate act: either an escalation to a stronger tier, or a drop to a
cheaper one. That act deserves a look from the person holding the account.

This change makes pi ask the human partner before any subagent starts with
a model the calling agent named. A denial stops the spawn and tells the
caller why, so the caller can correct itself.

## Goals

- Prompt the human partner before a subagent spawns with a caller-named model.
- Cover all four declaring paths:
  1. the `Agent` tool,
  2. the nested delegation tools,
  3. `agent({ model })` inside a workflow script,
  4. the inbound `subagents:rpc:spawn` handler.
- Block the spawn when no UI can answer, and say why in the tool result.
- Fail closed. Any error on the confirmation route is a denial.
- Ship a failing test first for each path.

## Non-goals

- Do not gate a model that comes from an agent file's frontmatter `model:`.
  That is user-authored config, written once by the human partner.
- Do not gate `thinking`, `effort`, `isolation`, or `maxTurns`.
- Do not change the `scopeModels` allowlist or its policy.
- Do not remember an approval and reuse it for a later spawn in the same turn.

## Anti-goals

- Do not add a second settings mechanism. Use `SubagentsSettings`.
- Do not prompt from a child session that has no UI of its own. Route the
  prompt to the top-level session, or block.
- Do not touch a spawn that names no model.
- Do not prompt after a scope error. An out-of-range model already fails.

## Constraints

- The gate must run **after** the existing `checkModelScope` call at each
  site. A caller-named model outside the allowlist must keep its current
  hard error, with no prompt.
- The decision signal already exists. `resolveAgentInvocationConfig(...)`
  returns `modelFromParams`, defined as
  `agentConfig?.model == null && params.model != null`. `true` means the
  caller named the model and the agent file did not, and it implies the
  model string is present. The workflow path has the same signal inline as
  `request.model !== undefined`. The RPC handler has it as a null check on
  the payload's `model`: `null` means inherit, a string means the caller
  named it.
- Blocking must happen before any side effect: no child session, no
  worktree, no gate command, no journal entry, no scheduler job.
- pi loads `src/index.ts` directly (`package.json` `pi.extensions`), so the
  running code is the TypeScript source.
- Prompt API: `ctx.ui.confirm(title, message)` returns a promise of boolean.
  `ctx.hasUI` is `false` in print mode (`-p`) and JSON mode (`--mode json`),
  and `true` in the interactive TUI and RPC.
- `test/documented-defaults.test.ts` hardcodes the published defaults and
  asserts the code matches. It does not read the README. The README entry
  is a convention, and the real guard is an assertion added to that test.

## Approaches

Three ways to build it. The human partner picked A.

**A. Fork the repository and gate inside the extension.** *Picked.*
The repo carries the test suite, so each path gets a failing test first.
The fork keeps the upstream project's structure, lint, and typecheck.
Cost: the fork must be rebased or merged when upstream moves.

**B. A standalone extension that intercepts `tool_call`.** Cheapest to
keep. No fork, and it survives pi updates. It covers the `Agent` tool and
the nested tools, because nested calls through `ctx.executeTool()` also
fire `tool_call` handlers. It **cannot** cover the workflow path, because
`agent({ model })` inside a script is not a tool call — it is an in-process
`callHost("agent", …)`. The partner asked for all four paths.

**C. Patch the installed npm package in place.** Fast to try, and the next
`pi update` erases it. Rejected.

### Mechanism inside A

The coverage decision forces one mechanism: a shared helper called at the
four spawn sites. A `tool_call` hook would cover two paths and leave the
rest to a different mechanism, which duplicates policy and doubles the
places a future change can miss. One helper, four call sites.

## The How (decided)

### 1. New module `src/model-confirmation.ts`

Mirrors `src/model-scope.ts`: one module-level setting plus accessors, and
now one module-level context, so the nested path cannot escape the
top-level policy.

```
/** The least a context must offer to raise a prompt. */
export interface ConfirmableCtx {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

export interface ModelConfirmationRequest {
  /** The model the caller named, as resolved. */
  model: { modelName: string; modelId: string };
  /** The raw text the caller wrote, for the message. */
  modelInput: string;
  /** Display label of the agent type. */
  agentLabel: string;
  /** Which path asked. Used in the message and in tests. */
  source: "agent-tool" | "nested" | "workflow" | "rpc";
}

export type ModelConfirmationVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Register the top-level session context that can raise a prompt. */
export function setConfirmationCtx(ctx: ConfirmableCtx | undefined): void;

export async function confirmCallerSuppliedModel(
  request: ModelConfirmationRequest,
): Promise<ModelConfirmationVerdict>;

export function isConfirmCallerModelEnabled(): boolean;
export function setConfirmCallerModel(value: boolean): void;
```

`model` is required, not optional. `modelFromParams` is true only when the
caller supplied a string, so the helper never runs without one. The
context is module-level because a child session has none of its own. No
`NestedToolContext` field and no `AgentManager` change is needed. The
structural `ConfirmableCtx` follows the minimal `EventBus` interface in
`src/cross-extension-rpc.ts`, so a test can pass a plain object.

`src/index.ts` calls `setConfirmationCtx(ctx)` beside `currentCtx` in the
`session_start` handler, and clears it beside `currentCtx = undefined` in
`session_shutdown`.

Behaviour, in order:

1. Setting off → `{ allowed: true }`. The caller skips the prompt only by
   configuration, never by accident.
2. No registered context, or one with `hasUI === false` → `{ allowed:
   false }` with the no-UI reason.
3. Otherwise `await registered.ui.confirm(title, message)`.
   - `true` → `{ allowed: true }`.
   - `false` → `{ allowed: false }` with the denied reason.
   - A throw or a rejected promise → `{ allowed: false }` with the
     no-UI reason. Fail closed.

Message text (the builder may polish it, not soften it):

- Title: `Allow this model?`
- Body, three short lines:
  - `Subagent: <agentLabel>`
  - `Model: <modelName> (<modelId>)`
  - `Named by: the calling agent (<source>). Your agent file did not set it.`

Denied reason, returned as the tool result or the spawn error:

```
Subagent "<agentLabel>" was not started. The human partner denied the
model "<modelId>". Dispatch again with no `model` field to inherit your
own model, or ask your partner to approve that model first.
```

No-UI reason:

```
Subagent "<agentLabel>" was not started. It named the model "<modelId>",
and no UI is available to confirm it. Dispatch again with no `model`
field to inherit your own model, or run interactively.
```

Both reasons name the fix. The caller reads them, so they must not shame
the caller and must not be vague.

### 2. Setting

`SubagentsSettings` in `src/settings.ts` gains:

```
/** Ask the human partner before a subagent spawns with a caller-named
 *  model. Off restores the old silent behaviour. */
confirmCallerModel?: boolean;
```

Global file `<agentDir>/subagents.json`, project file
`<cwd>/.pi/subagents.json`, project overrides global. Expose it in
`/agents → Settings` next to `scopeModels`. Add it to the README settings
list, and add the matching assertion to
`test/documented-defaults.test.ts`.

Default in this fork: **`true`**. This matches the partner's standing rule,
"never name a subagent model without asking the human partner first". It is
the designer's call, because the partner did not state a default. Upstream
would almost certainly want `false`; this fork is the partner's own use.

### 3. Call sites (four paths)

**Path 1 — the `Agent` tool, `src/index.ts`.** The block runs a little
after `const resolvedConfig = resolveAgentInvocationConfig(customConfig,
params, {…})`. Place the gate between the scope verdict and
`const thinking = resolvedConfig.thinking;`:

```
if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

if (resolvedConfig.modelFromParams && params.resume === undefined) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: resolvedConfig.modelInput ?? "",
    agentLabel: customConfig?.displayName ?? subagentType,
    source: "agent-tool",
  });
  if (!verdict.allowed) return textResult(verdict.reason);
}
```

**Path 1 resume rule.** The `Agent` tool resumes an existing child at
`params.resume`. A resume starts no new model choice, and a stray `model`
on a resume is ignored today. The guard above leaves it alone. Gating a
resume is a non-goal.

**Path 2 — the nested delegation tools, `src/nested-tools.ts`.** The same
block, after its `checkModelScope` call and before the
`const rootSessionId = …` line. The nested code has no UI of its own — the
comment above its scope check says "child sessions have no UI surface to
toast to". The helper reads the registered top-level context, so this path
prompts with no change to `NestedToolContext` and no change to the nested
runtime wiring. A child of a print-mode run finds no context with a UI, so
the spawn blocks. No resume guard is needed here: `if (params.resume)`
returns before the gate.

**Path 3 — the workflow host, `src/workflow/host.ts`.** Inside
`spawnAgent(request)`, after its `checkModelScope` call and before the gate
block. Guard on `request.model !== undefined` — that is the script's own
model, and it mirrors `modelFromParams`. The helper reads the registered
context:

```
if (request.model !== undefined) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: request.model,
    agentLabel: config?.displayName ?? dispatch.type,
    source: "workflow",
  });
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
}
```

Returning `{ ok: false, error }` is the existing shape for a refused model
on this path. The script sees `null` for that one agent and its siblings
carry on, which the code already documents as the intended behaviour.

A workflow always runs from a top-level session, so the registered context
is the right one. `pi.registerTool(workflowTool)` is top-level only, and
the nested tools are `Agent`, `get_subagent_result`, and `steer_subagent`.

**Path 4 — the inbound RPC handler, `src/cross-extension-rpc.ts`.** The
`subagents:rpc:spawn` handler resolves `normalizedOptions.model`, then
calls `checkModelScope(… callerSupplied: true …)`. Place the gate after
that verdict, before `manager.spawn`:

```
if (override != null) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: label,
    agentLabel: type,
    source: "rpc",
  });
  if (!verdict.allowed) throw new Error(verdict.reason);
}
```

A refusal here throws, which becomes `{ success: false, error }` for the
remote caller. This path matters because `pi-tasks` `TaskExecute` reaches
subagents through it and carries its own `model` parameter. The handler's
own comment already treats a payload model as "an orchestrator-level
choice, exactly like `Agent({ model })`". Leaving it open would leave a
hole in the gate.

### 4. Ordering rule, stated once

At every site the order is: resolve → scope-validate → confirm → spawn.
All four sites call the one helper, in that order. Resolve and scope both
reject with no prompt. A prompt therefore only ever asks about a model
that would really run.

### 5. Risks

- A prompt raised from the nested, workflow, or RPC path may not be
  answerable while the top-level session waits on a tool result. If
  `ctx.ui.confirm` cannot open, it rejects or returns `false`, and the
  gate blocks. The risk is a refused spawn, never a silent escalation.
  The builder should confirm this by hand in the TUI, and say in the
  finish report what the prompt looked like from each path.
- A workflow that fans out N agents with named models raises N prompts.
  Accepted for now. A "approve this model for the rest of the run"
  affordance is a later request, and it needs its own design.
- A scheduled workflow runs with no UI, so it blocks. A schedule that
  names a model stops working until the human removes the model name.
  This follows from the partner's "block when no UI" decision. Call it
  out in the CHANGELOG entry.

## What the human partner decided

- Approach A: fork the repository and gate inside the extension.
- Coverage: all four paths, including workflow scripts and the RPC handler.
- No UI: block the spawn.
- Frontmatter `model:` in an agent file: not gated. Caller-named models only.

## Calls made by the designer

The partner should check these while reading. Each is reversible.

1. The helper lives in `src/model-confirmation.ts`, modelled on
   `src/model-scope.ts`.
2. The setting is `confirmCallerModel`, default `true` in this fork.
3. Any error on the confirmation route denies the spawn.
4. The nested path prompts through the top-level session's context when
   that context has a UI, instead of blocking outright.
5. Both refusal reasons name the fix, and suggest dropping `model`.
6. One prompt per spawn. No "remember this choice" for the run.
7. The helper holds the top-level session context at module level, set in
   `session_start` and cleared in `session_shutdown`. This replaces the
   `getUiCtx` threading the first draft proposed, which had no wiring point
   to attach to. It leaves `NestedToolContext` and `AgentManager` untouched.
8. The RPC path is gated too. `pi-tasks` `TaskExecute` reaches subagents
   through it and carries its own `model`, so an ungated RPC path would
   leave a hole.
9. A resume that carries a stray `model` is not gated. A resume makes no
   new model choice.

## What is left to the builder

- Create the fork `DecibillyJoel/pi-subagents`, keep this doc and commit it.
- Write the failing test first for each of the four paths, then the helper.
  `test/invocation-config.test.ts` shows the config-level shape.
  `test/schedule-menu.test.ts` shows a `ctx.ui.confirm` fake.
  `test/documented-defaults.test.ts` shows how a default is asserted.
- Add the settings row to `/agents → Settings` and the README entry.
- Add a CHANGELOG entry, including the scheduled-workflow consequence.
- Run `npm run check` (`biome check`, `tsc --noEmit`, `vitest run`).
- Install the fork over the npm package (`pi install <fork>` then
  `pi remove npm:@tintinweb/pi-subagents`), and verify the prompt in a
  live TUI session.
