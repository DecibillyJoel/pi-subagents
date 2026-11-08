# Subagent Model Confirmation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a subagent spawn whose caller named a model until the human partner confirms that model in a UI prompt.

**Architecture:** One new module, `src/model-confirmation.ts`, holds the `confirmCallerModel` flag and the top-level session context at module level, and exposes `confirmCallerSuppliedModel()`. Four spawn sites call it in the order resolve, scope-validate, confirm, spawn, and turn a denial into their own refusal shape.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), pi extension API, `typebox`, `vitest`, `@biomejs/biome`.

**Spec:** `docs/superpowers/specs/2026-11-08-subagent-model-confirmation-gate-design.md`

## Global Constraints

- The gate runs after the existing `checkModelScope` call at every site. An out-of-scope caller-named model keeps its hard error and raises no prompt.
- The decision signal is existing code. Top-level and nested: `resolveAgentInvocationConfig(...)` gives `modelFromParams`, defined as `agentConfig?.model == null && params.model != null`. Workflow: `request.model !== undefined`. RPC: `normalizedOptions.model != null`.
- Block before any side effect. No child session, worktree, gate command, journal entry, or scheduler job starts for a refused spawn.
- pi loads `src/index.ts` directly (`package.json` gives `pi.extensions`). The running code is the TypeScript source, not `dist/`.
- `ctx.ui.confirm(title, message)` returns `Promise<boolean>`. `ctx.hasUI` is `false` in print mode (`-p`) and in JSON mode (`--mode json`).
- Fail closed. Any throw or rejection on the confirmation route is a denial.
- `confirmCallerModel` defaults to `true` in this fork.
- Every relative import carries an explicit `.js` specifier, for example `from "./model-confirmation.js"`.
- `test/` is outside the tsconfig `include`, so tests are checked by biome and vitest only.
- This clone has no `node_modules`. Run `npm install` once before the first `npm run check`.
- `npm run check` must pass after every task. It runs `biome check src/ test/`, then `tsc --noEmit`, then `vitest run`.
- Copy the prompt title, the three prompt lines, and both refusal reasons from the spec verbatim.

## Review Focus

Five failure modes the spec implies, and no task's happy path exercises. Each line names the task that owns the code and adds the test.

- **A resume that carries a stray `model`.** The Agent tool's resume branch is at `src/index.ts:2188`. Without the `params.resume === undefined` guard, a resume raises a prompt for a model no child session will use. Test added by Task 3.
- **A spawn after `session_shutdown` cleared the context.** `currentCtx = undefined` runs at `src/index.ts:1150`. A nested or RPC spawn that outlives its session must be refused, not thrown. Test added by Task 1, exercised again by Task 4.
- **One spawn, two prompts.** A nested `Agent` call runs inside the child session, so only the nested site may gate it. Task 4 asserts exactly one `confirm` call.
- **A project file that turns the gate off while the global file leaves it unset.** Precedence must hold for `confirmCallerModel` as it does for `scopeModels`. Test added by Task 2.
- **An empty `modelInput` with a resolved model.** The prompt must still name the model. Test added by Task 1.

---

### Task 1: The confirmation module

The module the other four tasks call. Nothing calls it yet, so this task changes no behavior.

**Files:**
- Create: `src/model-confirmation.ts`
- Test: `test/model-confirmation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all from `src/model-confirmation.js`:
  - `interface ConfirmableCtx { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }`
  - `interface ModelConfirmationRequest { model: { modelName: string; modelId: string }; modelInput: string; agentLabel: string; source: "agent-tool" | "nested" | "workflow" | "rpc" }`
  - `type ModelConfirmationVerdict = { allowed: true } | { allowed: false; reason: string }`
  - `setConfirmationCtx(ctx: ConfirmableCtx | undefined): void`
  - `confirmCallerSuppliedModel(request: ModelConfirmationRequest): Promise<ModelConfirmationVerdict>`
  - `isConfirmCallerModelEnabled(): boolean`
  - `setConfirmCallerModel(value: boolean): void`

- [ ] **Step 1: Write the failing test**

Create `test/model-confirmation.test.ts`. The `beforeEach` saves the flag and the `afterEach` restores both globals, because both live at module scope and other suites share this module.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmCallerSuppliedModel,
  isConfirmCallerModelEnabled,
  setConfirmationCtx,
  setConfirmCallerModel,
} from "../src/model-confirmation.js";

const MODEL = { modelName: "Claude Haiku 4.5", modelId: "anthropic/claude-haiku-4-5" };

const request = (over: Record<string, unknown> = {}) => ({
  model: MODEL,
  modelInput: "haiku",
  agentLabel: "general-purpose",
  source: "agent-tool" as const,
  ...over,
});

const withConfirm = (answer: boolean | (() => Promise<boolean>)) => {
  const confirm = vi.fn(typeof answer === "function" ? answer : async () => answer);
  setConfirmationCtx({ hasUI: true, ui: { confirm } });
  return confirm;
};

describe("confirmCallerSuppliedModel", () => {
  let prevEnabled: boolean;

  beforeEach(() => {
    // module-global — restore for other suites
    prevEnabled = isConfirmCallerModelEnabled();
    setConfirmCallerModel(true);
  });

  afterEach(() => {
    setConfirmCallerModel(prevEnabled);
    setConfirmationCtx(undefined);
  });

  it("allows the spawn when confirmCallerModel is off, even with no UI", async () => {
    setConfirmCallerModel(false);
    expect(await confirmCallerSuppliedModel(request())).toEqual({ allowed: true });
  });

  it("denies the spawn when no context is registered", async () => {
    const verdict = await confirmCallerSuppliedModel(request());
    expect(verdict.allowed).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("no UI is available to confirm it");
  });

  it("denies the spawn when the registered context has no UI", async () => {
    setConfirmationCtx({ hasUI: false, ui: { confirm: vi.fn(async () => true) } });
    expect((await confirmCallerSuppliedModel(request())).allowed).toBe(false);
  });

  it("allows the spawn when the partner confirms, and asks once", async () => {
    const confirm = withConfirm(true);
    expect(await confirmCallerSuppliedModel(request())).toEqual({ allowed: true });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("names the agent, the model, and the source in the prompt", async () => {
    const confirm = withConfirm(true);
    await confirmCallerSuppliedModel(request({ source: "workflow" }));
    const [title, message] = confirm.mock.calls[0]!;
    expect(title).toBe("Allow this model?");
    expect(message).toContain("Subagent: general-purpose");
    expect(message).toContain("Model: Claude Haiku 4.5 (anthropic/claude-haiku-4-5)");
    expect(message).toContain("Named by: the calling agent (workflow).");
  });

  it("denies the spawn when the partner refuses, and names the fix", async () => {
    withConfirm(false);
    const verdict = await confirmCallerSuppliedModel(request());
    expect(verdict.allowed).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toBe(
      'Subagent "general-purpose" was not started. The human partner denied the model ' +
        '"anthropic/claude-haiku-4-5". Dispatch again with no `model` field to inherit your ' +
        "own model, or ask your partner to approve that model first.",
    );
  });

  it("denies the spawn when the confirm route throws", async () => {
    withConfirm(async () => {
      throw new Error("no prompt available");
    });
    expect((await confirmCallerSuppliedModel(request())).allowed).toBe(false);
  });

  it("still names the model when the caller's input text is empty", async () => {
    const confirm = withConfirm(true);
    await confirmCallerSuppliedModel(request({ modelInput: "" }));
    expect(confirm.mock.calls[0]?.[1]).toContain("anthropic/claude-haiku-4-5");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/model-confirmation.test.ts`

Expected: the suite fails to load with `Failed to resolve import "../src/model-confirmation.js" from "test/model-confirmation.test.ts". Does the file exist?`

- [ ] **Step 3: Implement the module**

Create `src/model-confirmation.ts`. Give it a header docstring that says the state lives here rather than in an `index.ts` closure because the top-level Agent tool and the nested delegation tools both need it, and the nested ones have no session context. State plainly that an omitted `model` inherits the calling session's own model, so naming one is a deliberate act the payer should see.

Module state: `let confirmCallerModelEnabled = true;` and `let confirmationCtx: ConfirmableCtx | undefined;`

Then, in this order:

1. `if (!confirmCallerModelEnabled) return { allowed: true };`
2. `const ctx = confirmationCtx;` then `if (!ctx || !ctx.hasUI) return { allowed: false, reason: noUiReason(agentLabel, model.modelId) };`
3. `const confirmed = await ctx.ui.confirm("Allow this model?", message);` inside a `try`. Return `{ allowed: true }` when true, `{ allowed: false, reason: deniedReason(...) }` when false, and `{ allowed: false, reason: noUiReason(...) }` from the `catch`.

Build `message` by joining these three lines with `"\n"`:

```ts
`Subagent: ${agentLabel}`
`Model: ${model.modelName} (${model.modelId})`
`Named by: the calling agent (${source}). Your agent file did not set it.`
```

The two reason helpers take `(agentLabel: string, modelId: string)` and return exactly:

```ts
// deniedReason
`Subagent "${agentLabel}" was not started. The human partner denied the model "${modelId}". Dispatch again with no \`model\` field to inherit your own model, or ask your partner to approve that model first.`

// noUiReason
`Subagent "${agentLabel}" was not started. It named the model "${modelId}", and no UI is available to confirm it. Dispatch again with no \`model\` field to inherit your own model, or run interactively.`
```

Keep `modelInput` in the request interface and do not read it. The resolved `modelName (modelId)` is what the partner needs, and the raw text is carried for callers and diagnostics.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/model-confirmation.test.ts`

Expected: eight passing tests, no failures.

- [ ] **Step 5: Run the full check**

Run `npm install` once, because this clone has no `node_modules`. Then run: `npm run check`

Expected: biome clean, `tsc --noEmit` clean, the whole vitest suite green. The module is unreferenced, so no existing test changes behavior.

- [ ] **Step 6: Commit**

```bash
git add src/model-confirmation.ts test/model-confirmation.test.ts
git commit -m "Add the caller-named model confirmation helper"
```

---

### Task 2: The `confirmCallerModel` setting

Mirrors `scopeModels` at all eight touch points, so the gate can be turned off from `/agents → Settings`, the global file, or the project file.

**Files:**
- Modify: `src/settings.ts` (the field after `scopeModels` at line 90, `SettingsAppliers` at 354, the project parse at 462, `applySettings` at 586)
- Modify: `src/index.ts` (import at 35, the appliers map at 1575, the current-values getter at 3766, the settings row at 3943, the row handler at 4135)
- Modify: `test/settings.test.ts` (after the `scopeModels` cases at 429 and 450)
- Modify: `test/documented-defaults.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `isConfirmCallerModelEnabled` and `setConfirmCallerModel` from `src/model-confirmation.js` (Task 1).
- Produces: `SubagentsSettings.confirmCallerModel?: boolean`; `SettingsAppliers.setConfirmCallerModel: (enabled: boolean) => void`.

- [ ] **Step 1: Write the failing tests**

In `test/settings.test.ts`, beside the `scopeModels` cases, add:

```ts
it("accepts confirmCallerModel boolean (true and false)", () => {
  writeProject({ confirmCallerModel: true });
  expect(loadSettings(projectDir)).toEqual({ confirmCallerModel: true });
  writeProject({ confirmCallerModel: false });
  expect(loadSettings(projectDir)).toEqual({ confirmCallerModel: false });
});

it("drops non-boolean confirmCallerModel", () => {
  writeProject({ confirmCallerModel: "yes" });
  expect(loadSettings(projectDir).confirmCallerModel).toBeUndefined();
  writeProject({ confirmCallerModel: 1 });
  expect(loadSettings(projectDir).confirmCallerModel).toBeUndefined();
  writeProject({ confirmCallerModel: null });
  expect(loadSettings(projectDir).confirmCallerModel).toBeUndefined();
});
```

Then add the project-over-global case. The file already has both writers, `writeGlobal` at line 44 and `writeProject` at line 48, and the merge cases at line 65 show the shape:

```ts
it("project confirmCallerModel overrides the global value", () => {
  writeGlobal({ confirmCallerModel: true });
  writeProject({ confirmCallerModel: false });
  expect(loadSettings(projectDir).confirmCallerModel).toBe(false);
});
```

In `test/documented-defaults.test.ts`, add a case to the existing describe block:

```ts
it("caller-named model confirmation is on by default", async () => {
  // On is the point of the fork: an omitted model inherits the caller's own
  // model, so naming one is a deliberate act. README documents the default.
  const { isConfirmCallerModelEnabled } = await import("../src/model-confirmation.js");
  expect(isConfirmCallerModelEnabled()).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/settings.test.ts test/documented-defaults.test.ts`

Expected: the settings cases fail with `expected {} to deeply equal { confirmCallerModel: true }`. The documented-defaults case fails with `Failed to resolve import "../src/model-confirmation.js"` only in Task 1's absence, and otherwise passes at this point, which is correct.

- [ ] **Step 3: Add the four settings plumbing edits**

In `src/settings.ts`:

1. After the `scopeModels?: boolean;` field, add the field with this docstring:

```ts
/** Ask the human partner before a subagent spawns with a caller-named
 *  model. Off restores the old silent behaviour. */
confirmCallerModel?: boolean;
```

2. In `SettingsAppliers`, beside `setScopeModels`, add `setConfirmCallerModel: (enabled: boolean) => void;`
3. In the project parse, add `if (typeof r.confirmCallerModel === "boolean") { out.confirmCallerModel = r.confirmCallerModel; }`
4. In `applySettings`, add `if (typeof s.confirmCallerModel === "boolean") appliers.setConfirmCallerModel(s.confirmCallerModel);`

- [ ] **Step 4: Run the settings and defaults tests**

Run: `npx vitest run test/settings.test.ts test/documented-defaults.test.ts`

Expected: green.

- [ ] **Step 5: Wire the four `src/index.ts` sites**

1. Import `isConfirmCallerModelEnabled` and `setConfirmCallerModel` from `./model-confirmation.js`, next to the existing `./model-scope.js` import.
2. In the appliers map, add `setConfirmCallerModel,` next to `setScopeModels: setScopeModelsEnabled,`.
3. In the current-values getter, add `confirmCallerModel: isConfirmCallerModelEnabled(),` next to `scopeModels: isScopeModelsEnabled(),`.
4. In the settings row array, add next to the `scopeModels` row:

```ts
{
  id: "confirmCallerModel",
  label: "Confirm caller model",
  description: "Ask before a subagent spawns with a model the calling agent named",
  currentValue: isConfirmCallerModelEnabled() ? "on" : "off",
  values: ["on", "off"],
},
```

5. In the row handler, add beside the `scopeModels` branch:

```ts
} else if (id === "confirmCallerModel") {
  const enabled = value === "on";
  setConfirmCallerModel(enabled);
  notifyApplied(ctx, `Confirm caller model ${enabled ? "enabled" : "disabled"}`);
}
```

- [ ] **Step 6: Document the setting in the README**

Add `confirm caller models on/off` to the toggle list in the "## Persistent Settings" intro paragraph. Add a paragraph beside the `**Strict agent files**` entry, in the same shape, that covers both files, the default `true`, the `/agents → Settings → Confirm caller model` row, and the two consequences: `confirmCallerModel: false` restores the old silent behavior, and a spawn with no UI is refused rather than silently allowed.

- [ ] **Step 7: Run the full check**

Run: `npm run check`

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts src/index.ts test/settings.test.ts test/documented-defaults.test.ts README.md
git commit -m "Add the confirmCallerModel setting"
```

---

### Task 3: Gate path 1, the Agent tool

The first site that actually refuses a spawn, so this task also adds the `confirm` fake to the shared boot helper.

**Files:**
- Modify: `src/index.ts` (the Agent-tool block at 2010-2050, between the `scopeVerdict` warn line at 2041 and `const thinking = resolvedConfig.thinking;`)
- Modify: `test/helpers/boot-extension.ts` (the `ui` object in `ctx()`)
- Test: `test/agent-tool-model-confirmation.test.ts`

**Interfaces:**
- Consumes: `confirmCallerSuppliedModel` from `src/model-confirmation.js`; `describeModel` from `src/model-resolver.js`.
- Produces: nothing new. The refusal is the existing `textResult(verdict.reason)` shape.

- [ ] **Step 1: Add the `confirm` fake to the shared boot helper**

In `test/helpers/boot-extension.ts`, add `confirm: vi.fn(async () => true),` to the `ui` object inside `ctx()`. The default still has `hasUI: false`, so a suite must ask for a UI explicitly with `ctx({ hasUI: true })`. Note the reason in the surrounding comment: the real extension registers this context at `session_start`, and a fake without `confirm` makes every caller-named model a refusal.

- [ ] **Step 2: Write the failing test**

Create `test/agent-tool-model-confirmation.test.ts`. Mock `runAgent` as `test/fallback-subagent-wiring.test.ts` does, so a permitted spawn records a call instead of starting a session.

```ts
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { setConfirmationCtx, setConfirmCallerModel } from "../src/model-confirmation.js";
```

Reuse the boot harness from `test/fallback-subagent-wiring.test.ts`: its `makePi()`, its `writeAgents()`, and its `beforeEach` / `afterEach` temp-dir dance. Take the model registry shape from `test/nested-tools.test.ts`'s `ctx()`, which carries `find`, `getAvailable`, and `getAll`, and give it `[{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" }]` so `model: "haiku"` resolves through `resolveModel`'s fuzzy match.

One `const confirm = vi.fn(async () => true);` at module scope is the only knob. Register the context once per test through the real lifecycle, so the test proves the wiring works: build the pi mock, call `subagentsExtension(pi)`, then `await lifecycle.get("session_start")?.({}, ctx({ hasUI: true, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), confirm } }))`. Read the Agent tool from `tools.get("Agent")` and call it as `tool.execute("call-1", params, undefined, undefined, ctx({ hasUI: true }))`.

Per case, change the answer with `confirm.mockResolvedValueOnce(false)` or read the calls with `confirm.mock.calls`. Do not re-register the context to change one answer. `beforeEach`: `setConfirmCallerModel(true)`, `confirm.mockReset()`, `confirm.mockResolvedValue(true)`, `vi.mocked(runAgent).mockReset()`. `afterEach`: `setConfirmationCtx(undefined)`.

Cases:

1. **Denied.** `confirm.mockResolvedValueOnce(false)`. Call with `{ subagent_type: "general-purpose", prompt: "go", model: "haiku" }`. Assert the result text contains the spec's denied reason for `anthropic/claude-haiku-4-5`, and `runAgent` was not called.
2. **Confirmed.** The default `confirm` answer. Assert `runAgent` was called once.
3. **No caller model.** Call with no `model`. Assert `confirm` was not called and `runAgent` was called.
4. **Resume with a model.** `{ subagent_type: "general-purpose", prompt: "go", model: "haiku", resume: "agent-1" }`. Assert `confirm` was not called. This is the Review Focus case. The call may fail for unrelated reasons, because the harness holds no real session for `agent-1` to resume. Assert only on `confirm`, and do not require the call to succeed.
5. **Frontmatter-pinned model.** Write an agent file whose frontmatter has `model: haiku`, call it with no `model` param. Assert `confirm` was not called.
6. **No UI.** Register the context with `ctx({ hasUI: false })`. Assert the refusal text contains `no UI is available to confirm it`, and `runAgent` was not called.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/agent-tool-model-confirmation.test.ts`

Expected: cases 1, 6 fail because the spawn proceeds and `runAgent` was called. Cases 2, 3, 4, 5 fail on `confirm` never having been called, or pass for the wrong reason. Record what fails.

- [ ] **Step 4: Implement the gate**

In `src/index.ts`, immediately after `if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");` and before `const thinking = resolvedConfig.thinking;`, insert:

```ts
if (resolvedConfig.modelFromParams && params.resume === undefined && model) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: resolvedConfig.modelInput ?? "",
    agentLabel: customConfig?.displayName ?? subagentType,
    source: "agent-tool",
  });
  if (!verdict.allowed) return textResult(verdict.reason);
}
```

The trailing `model` guard is for `tsc`, not for runtime. `ctx.model` is optional, so `describeModel(model)` needs the narrowing. It can never be false when `modelFromParams` is true: that flag means the caller passed a model, and an unresolvable one returned earlier at the `resolveModel` string branch. Say so in a comment.

Import `confirmCallerSuppliedModel` from `./model-confirmation.js` and `describeModel` from `./model-resolver.js`. Confirm the enclosing function is `async`, so `await` is legal.

Update the Agent tool's `model` parameter description so it states the consequence: a caller-named model asks the human partner first, and omitting `model` inherits the caller's own model.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/agent-tool-model-confirmation.test.ts`

Expected: all six cases pass.

- [ ] **Step 6: Make the whole suite green**

Run: `npx vitest run`

Expected: failures only in suites that boot the extension and call the `Agent` tool with a caller-named `model`. For each one, change its `ctx()` call to pass `hasUI: true`, which the shared helper already supplies a confirming `confirm` for. Do not weaken an assertion to get green. If a suite needs the refusal, keep `hasUI: false` and assert it.

Then run `npm run check` and expect green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/model-resolver.ts test/helpers/boot-extension.ts test/agent-tool-model-confirmation.test.ts
git commit -m "Gate the Agent tool on a caller-named model"
```

---

### Task 4: Gate path 2, the nested delegation tools

The nested path has no session context of its own, so it reads the one the top-level session registered.

**Files:**
- Modify: `src/nested-tools.ts` (after the scope error at line 255, before the `rootSessionId` line at 258)
- Test: `test/nested-tools.test.ts`

**Interfaces:**
- Consumes: `confirmCallerSuppliedModel` from `src/model-confirmation.js`; `describeModel` from `src/model-resolver.js`.
- Produces: nothing new. The refusal is the existing `textResult(verdict.reason, true)` shape, which sets `isError`.

- [ ] **Step 1: Write the failing tests**

In `test/nested-tools.test.ts`, import `setConfirmationCtx` and `setConfirmCallerModel` from `../src/model-confirmation.js`. Add a `confirm` spy and register it in `beforeEach` with `setConfirmationCtx({ hasUI: true, ui: { confirm } })`, and clear it in `afterEach` with `setConfirmationCtx(undefined)`. Restore the flag the way the file already restores `setScopeModelsEnabled`.

Cases:

1. **Denied.** `confirm` returns false. Execute the nested `Agent` tool with `{ subagent_type: "scout", prompt: "go", model: "anthropic/allowed" }` against a registry that resolves it. Assert `spawn` was not called and the result's `isError` is true with the spec's denied reason.
2. **Confirmed.** Assert `spawn` was called once.
3. **No UI.** `setConfirmationCtx(undefined)`. Assert `spawn` was not called and the reason names the missing UI. This is the Review Focus case.
4. **Exactly one prompt.** Register a `confirm` spy, run one confirmed call, and assert `confirm` was called exactly once. No other site may gate the same spawn.
5. **Frontmatter model.** Write an agent file with `model: haiku` in frontmatter and call it with no `model` param. Assert `confirm` was not called.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/nested-tools.test.ts`

Expected: cases 1 and 3 fail because `spawn` was called, and case 4 reports zero `confirm` calls.

- [ ] **Step 3: Implement the gate**

In `src/nested-tools.ts`, immediately after `if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);` and before the `// The whole branch shares the root session's transcript directory;` comment, insert:

```ts
if (invocation.modelFromParams && model) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: invocation.modelInput ?? "",
    agentLabel: config?.displayName ?? resolvedType, // the same label the scope check above uses
    source: "nested",
  });
  if (!verdict.allowed) return textResult(verdict.reason, true);
}
```

The `&& model` guard is for `tsc` and cannot be false here, for the same reason as Task 3's. Import `confirmCallerSuppliedModel` from `./model-confirmation.js` and `describeModel` from `./model-resolver.js`.

No resume guard is needed here. The `if (params.resume)` early return at line 184 runs first and never reaches this block. Add a comment that says so, so the asymmetry with the Agent tool reads as deliberate.

Do not change `NestedToolContext` and do not change `AgentManager`. The helper reads the registered context.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/nested-tools.test.ts`

Expected: all cases pass.

- [ ] **Step 5: Run the full check**

Run: `npm run check`

Expected: green. Fix any suite that now blocks on a caller-named model by registering a confirming context.

- [ ] **Step 6: Commit**

```bash
git add src/nested-tools.ts test/nested-tools.test.ts
git commit -m "Gate the nested delegation tools on a caller-named model"
```

---

### Task 5: Gate path 3, the workflow spawn

Workflows always run from a top-level session, because `pi.registerTool(workflowTool)` at `src/index.ts:2862` is top-level only and `NESTED_TOOL_NAMES` at `src/nested-tools.ts:50` excludes the workflow tool. The host's own `ctx` is therefore the right one.

**Files:**
- Modify: `src/workflow/host.ts` (`spawnAgent` at 256, after the scope error at 295, before `let gate: WorkflowGateResult | undefined;`)
- Test: `test/workflow-tool.test.ts`

**Interfaces:**
- Consumes: `confirmCallerSuppliedModel` from `src/model-confirmation.js`; `describeModel` from `src/model-resolver.js`.
- Produces: nothing new. The refusal is the existing `{ ok: false, error: string }` shape, which the script sees as `null` for that one agent.

- [ ] **Step 1: Keep the existing model cases green**

`test/workflow-tool.test.ts` already spawns with caller-named models at lines 172, 193, 364, 384, 394, and 452. Register a confirming context in that file's `beforeEach`:

```ts
confirm = vi.fn(async () => true);
setConfirmationCtx({ hasUI: true, ui: { confirm } });
```

and clear it in `afterEach` with `setConfirmationCtx(undefined)`. Add the same to `test/workflow-effective-config.test.ts` and `test/workflow-runtime.test.ts`, whose reported lines are 105, 164, 552, and 626.

- [ ] **Step 2: Write the failing tests**

Add to `test/workflow-tool.test.ts`, beside the existing model cases:

1. **Denied.** Make `confirm` return false, then `await host.spawnAgent(request({ model: "anthropic/allowed-model" }))`. Assert the result is `{ ok: false, error: <the spec's denied reason> }`. Assert the manager's `spawnAndWait` was not called.
2. **Confirmed.** `confirm` returns true. Assert the spawn proceeded.
3. **Frontmatter model, no request model.** Spawn with `{ agentType: "pinned" }` where `pinned` has a frontmatter model. Assert `confirm` was not called.
4. **One prompt per named model.** Spawn two agents that each name a model. Assert `confirm` was called twice, not four times.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/workflow-tool.test.ts`

Expected: case 1 fails because the spawn proceeded, and case 4 reports zero calls.

- [ ] **Step 4: Implement the gate**

In `src/workflow/host.ts`, after the `if (scopeVerdict.kind === "error") return { ok: false, error: scopeVerdict.message };` block and before `let gate: WorkflowGateResult | undefined;`, insert:

```ts
if (request.model !== undefined) {
  const verdict = await confirmCallerSuppliedModel({
    model: describeModel(model),
    modelInput: request.model,
    agentLabel: config?.displayName ?? dispatch.type, // the same label the scope check above uses
    source: "workflow",
  });
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
}
```

Use the resolved model variable the surrounding code already has, so the prompt names the model that will actually run. If `tsc` reports that the variable may be `undefined`, add `&& model` to the condition with the same comment as Task 3. Import `confirmCallerSuppliedModel` from `./model-confirmation.js` and `describeModel` from `./model-resolver.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/workflow-tool.test.ts test/workflow-effective-config.test.ts test/workflow-runtime.test.ts`

Expected: green.

- [ ] **Step 6: Run the full check**

Run: `npm run check`

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/host.ts test/workflow-tool.test.ts test/workflow-effective-config.test.ts test/workflow-runtime.test.ts
git commit -m "Gate the workflow spawn on a caller-named model"
```

---

### Task 6: Gate path 4, the cross-extension RPC handler

The hole that matters most: `pi-tasks` `TaskExecute` reaches subagents through `subagents:rpc:spawn` and carries its own `model` parameter. Leaving this open would let another extension name a model without asking.

**Files:**
- Modify: `src/cross-extension-rpc.ts` (the `subagents:rpc:spawn` handler at 110, inside `if (override != null)`, after the scope error throw)
- Test: `test/cross-extension-rpc.test.ts`

**Interfaces:**
- Consumes: `confirmCallerSuppliedModel` from `src/model-confirmation.js`; `describeModel` from `src/model-resolver.js`. Add `describeModel` to the existing `./model-resolver.js` import.
- Produces: nothing new. The refusal is `throw new Error(verdict.reason)`, which the envelope turns into `{ success: false, error }`.

- [ ] **Step 1: Write the failing tests**

In `test/cross-extension-rpc.test.ts`, register a confirming context the way `test/schedule-menu.test.ts:25` builds its `confirm` fake, and clear it in `afterEach`.

Cases:

1. **Denied.** Send a `subagents:rpc:spawn` request with `options.model` set to a resolvable model, and make `confirm` return false. Assert the reply is `success: false` with the spec's denied reason, and the spawned record count is unchanged.
2. **Confirmed.** Assert the spawn happened.
3. **No caller model.** Send a request with no `options.model`. Assert `confirm` was not called.
4. **No UI.** Clear the registered context. Assert the refusal names the missing UI, and nothing spawned.
5. **The existing scope error still wins.** With `scopeModels` on and an out-of-scope model, assert the error is the scope message and `confirm` was never called. The gate sits after the scope check, so no prompt may appear for a spawn that is already refused.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cross-extension-rpc.test.ts`

Expected: cases 1 and 4 fail because the spawn succeeded.

- [ ] **Step 3: Implement the gate**

In `src/cross-extension-rpc.ts`, inside the `if (override != null)` block, after `if (verdict.kind === "error") throw new Error(verdict.message);`, insert:

```ts
const confirmation = await confirmCallerSuppliedModel({
  model: describeModel(model),
  modelInput: label,
  agentLabel: type,
  source: "rpc",
});
if (!confirmation.allowed) throw new Error(confirmation.reason);
```

The handler is already `async`, so `await` is legal. If `tsc` reports that `model` may still be a `string`, narrow it first rather than casting: `const confirmed = typeof model === "string" ? undefined : model;` then throw when it is undefined. That branch is unreachable, because the string case threw at the `resolveModel` check above, and an explicit throw beats a silent skip.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cross-extension-rpc.test.ts`

Expected: green.

- [ ] **Step 5: Run the full check**

Run: `npm run check`

Expected: green. `pi-tasks` suites and the other RPC suites may now refuse a model-bearing spawn. For each one, register a confirming context rather than dropping the model from the request — the request is the thing under test.

- [ ] **Step 6: Commit**

```bash
git add src/cross-extension-rpc.ts test/cross-extension-rpc.test.ts
git commit -m "Gate the RPC spawn handler on a caller-named model"
```

---

### Task 7: Docs, changelog, and the live check

**Files:**
- Modify: `README.md` (a "## Model Confirmation" section after "## Model Scope" at 733, the src file listing at 1101)
- Modify: `docs/rpc.md` (the `model` row at 19, the error table at 77-79)
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-08-subagent-model-confirmation-gate-design.md` (the `Status:` line at the top)
- Test: the full suite, plus one manual pass in a live TUI

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-visible. The `CHANGELOG.md` entry is the only artifact users read before the behavior surprises them.

- [ ] **Step 1: Write the README section**

Add "## Model Confirmation" after the "## Model Scope" section. Cover, in this order:

1. What it does, in one paragraph. Named by default, so `confirmCallerModel: false` in `subagents.json` turns it off.
2. The four paths, as a table, mirroring the Model Scope table: the `Agent` tool, the nested delegation tools, a workflow's `agent(prompt, { model })`, and `subagents:rpc:spawn`. Name the refusal shape for each: a tool error, an `isError` tool result, `{ ok: false, error }` and a `null` for that one agent in the script, and a `throw` that becomes `{ success: false, error }`.
3. What is not gated: a `model:` in an agent file's frontmatter, a parent-inherited model, and a caller-named model on a resume.
4. The no-UI rule. Print mode, JSON mode, and a scheduled workflow have no prompt, so those spawns are refused rather than silently allowed.
5. Why it exists. An omitted `model` inherits the calling session's own model, so it costs what the caller's own turns cost. Naming one is a deliberate act the payer never otherwise sees.

Add `model-confirmation.ts` to the src file listing, next to the `model-scope.ts` line.

- [ ] **Step 2: Write the RPC doc changes**

In `docs/rpc.md`, extend the `model` row at line 19 with the confirmation consequence. Add a row to the error table at 77-79, beside the scope row, naming the two new refusals and `src/model-confirmation.ts`.

- [ ] **Step 3: Write the changelog entry**

Add an entry to `CHANGELOG.md` under the unreleased heading, in the file's existing style. State the four gated paths, the default `true`, the off switch, and the one consequence users will hit without warning: **a scheduled workflow that names a model now refuses to spawn, because a scheduled run has no UI to answer the prompt.** Say that plainly rather than leaving it to be discovered.

- [ ] **Step 4: Update the spec status line**

Change `Status: awaiting approval` to the approved status with the date, so the doc does not read as pending.

- [ ] **Step 5: Run the full check**

Run: `npm run check`

Expected: green. Then confirm the counts are real: `npx vitest run` should report no skipped or todo cases added by this work.

- [ ] **Step 6: Check the prompt by hand in a live TUI**

This step needs the human partner, because a prompt is the deliverable. Install the fork over the npm package, start pi interactively, and confirm the prompt appears and reads correctly for each of the four paths. Record the exact prompt text as it rendered, and report anything that reads wrong. Do not mark this plan complete on an automated test alone.

```bash
pi install /home/joe/Projects/GitHub/pi-subagents
pi remove npm:@tintinweb/pi-subagents
pi list
```

Then, in the session: dispatch an `Agent` call with an explicit `model` and answer both ways, run a workflow whose script names a model, and run a `TaskExecute` from `pi-tasks` with `model` set. Confirm that a refusal names the fix.

- [ ] **Step 7: Commit and push**

```bash
git add README.md docs/rpc.md CHANGELOG.md docs/superpowers/specs/2026-11-08-subagent-model-confirmation-gate-design.md
git commit -m "Document the caller-named model confirmation gate"
```

Push to the fork's `master` with the credential helper already used for this repo:

```bash
git -c credential.helper='!f(){ echo username=x-access-token; echo password=$GITHUB_PERSONAL_ACCESS_TOKEN; };f' push origin master
```

---

## Task Dependencies

Task 1 has no dependencies. Task 2 consumes Task 1. Tasks 3, 4, 5, and 6 each consume Task 1 and are independent of one another, so they can run in any order or in parallel. Task 7 consumes all six.
