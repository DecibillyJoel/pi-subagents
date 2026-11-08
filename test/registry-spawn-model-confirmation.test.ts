/**
 * registry-spawn-model-confirmation.test.ts — proves the
 * `Symbol.for("pi-subagents:manager")` registry entry refuses a spawn whose
 * model the CALLER named, until the human partner approves it.
 *
 * The registry is the fifth way to name a model, and the docs claim every path
 * that can name one is gated. It reaches `spawnTopLevel` directly, so the gate
 * has to sit on the registry's own `spawn` — not on `spawnTopLevel`, which the
 * RPC handler shares and which already asks its own question.
 *
 * The context is registered through the real `session_start` lifecycle, never by
 * calling `setConfirmationCtx` from the test. That is what proves `src/index.ts`
 * wires the context up. The load-bearing assertion in every refusal case is that
 * `runAgent` was NEVER called: a refusal that still starts the child session is
 * not a gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { setConfirmationCtx, setConfirmCallerModel } from "../src/model-confirmation.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** One model, so `model: "haiku"` resolves through `resolveModel`'s fuzzy match. */
const MODELS = [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" }];
const REGISTRY = {
  find: (provider: string, modelId: string) => MODELS.find((m) => m.provider === provider && m.id === modelId),
  getAvailable: () => MODELS,
  getAll: () => MODELS,
};

/** The human partner's answer. The only knob a case turns. */
const confirm = vi.fn(async () => true);

let hermetic: Hermetic | undefined;

const ui = () => ({
  setStatus: vi.fn(),
  setWidget: vi.fn(),
  notify: vi.fn(),
  addAutocompleteProvider: vi.fn(),
  // `session_start` hands this context to the widget, the fleet list and the
  // ctrl+b handoff watcher, and each subscribes to terminal input.
  onTerminalInput: vi.fn(() => vi.fn()),
  confirm,
});

type Registry = {
  spawn: (pi: any, ctx: any, type: string, prompt: string, options: any) => Promise<string>;
};

/** Boot the real extension, let `session_start` register the ctx, take the registry. */
async function boot(hasUI = true): Promise<Registry> {
  const { pi, lifecycle } = makePi();
  subagentsExtension(pi);
  await lifecycle.get("session_start")?.({}, ctx({ hasUI, ui: ui(), modelRegistry: REGISTRY }));
  return (globalThis as any)[Symbol.for("pi-subagents:manager")] as Registry;
}

const options = (extra: Record<string, unknown> = {}) => ({ description: "registry spawn", ...extra });

describe("the manager registry gates a caller-named model on confirmation", () => {
  beforeEach(() => {
    hermetic = hermeticDir();
    setConfirmCallerModel(true);
    confirm.mockReset();
    confirm.mockResolvedValue(true);
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
  });

  afterEach(() => {
    setConfirmationCtx(undefined);
    setConfirmCallerModel(true);
    registerAgents(new Map());
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic?.restore();
    hermetic = undefined;
  });

  it("asks, and refuses the spawn, when the partner denies the model", async () => {
    const registry = await boot();
    confirm.mockResolvedValueOnce(false);

    await expect(
      registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options({ model: "haiku" })),
    ).rejects.toThrow('The human partner denied the model "anthropic/claude-haiku-4-5"');

    // The prompt must name the model the caller asked for, not the label it typed.
    expect(confirm.mock.calls[0][0]).toBe("Allow this model?");
    expect(confirm.mock.calls[0][1]).toContain("Model: haiku 4.5 (anthropic/claude-haiku-4-5)");
    expect(confirm.mock.calls[0][1]).toContain("Named by: the calling agent (registry).");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("spawns once the partner confirms", async () => {
    const registry = await boot();

    const id = await registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options({ model: "haiku" }));

    expect(typeof id).toBe("string");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the caller named no model", async () => {
    const registry = await boot();

    const id = await registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options());

    expect(typeof id).toBe("string");
    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses without a UI instead of asking, and never spawns", async () => {
    const registry = await boot(false);

    await expect(
      registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options({ model: "haiku" })),
    ).rejects.toThrow("no UI is available to confirm it");

    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("returns a promise on the no-model path too, so one caller shape covers both", async () => {
    const registry = await boot();

    const pending = registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options());

    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("describes a model object without a registry, and still asks", async () => {
    const registry = await boot();

    await registry.spawn({}, ctx(), "general-purpose", "go", options({ model: MODELS[0] }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toContain("Model: haiku 4.5 (anthropic/claude-haiku-4-5)");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("leaves an unresolvable model name alone, which the registry never validated", async () => {
    const registry = await boot();

    // Unchanged from before the gate: no prompt, and the name passes through.
    // Closing this would be a new refusal on a path the review scoped to
    // confirmation only. Recorded as a residual gap in the ledger.
    const id = await registry.spawn({}, ctx({ modelRegistry: REGISTRY }), "general-purpose", "go", options({ model: "no-such-model" }));

    expect(typeof id).toBe("string");
    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
