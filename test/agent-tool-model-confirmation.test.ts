/**
 * agent-tool-model-confirmation.test.ts — proves the Agent tool refuses a spawn
 * whose model the CALLING agent named, until the human partner approves it.
 *
 * The context is registered through the real `session_start` lifecycle, never by
 * calling `setConfirmationCtx` from the test. That is what proves `src/index.ts`
 * wires the context up, which is what makes the gate work in a live session. A
 * test that registered the context itself would stay green with no wiring at all.
 *
 * The load-bearing assertion in every refusal case is that `runAgent` was NEVER
 * called: a refusal that still starts the child session is not a gate.
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
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/** One model, so `model: "haiku"` resolves through `resolveModel`'s fuzzy match. */
const MODELS = [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" }];
const REGISTRY = {
  find: (provider: string, modelId: string) => MODELS.find((m) => m.provider === provider && m.id === modelId),
  getAvailable: () => MODELS,
  getAll: () => MODELS,
};

/** The human partner's answer. The only knob a case turns. */
const confirm = vi.fn(async () => true);

/** An agent file that pins its own model, so `modelFromParams` is false. */
const PINNED = "---\ndescription: Pinned\ntools: read\nmodel: haiku\n---\nPinned.\n";

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

/** The ctx a tool call receives — never the one the extension registered. */
const toolCtx = () => ctx({ hasUI: true, ui: ui(), modelRegistry: REGISTRY });

/** Boot the real extension and let its own `session_start` register the context. */
async function boot(hasUI = true) {
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  await lifecycle.get("session_start")?.({}, ctx({ hasUI, ui: ui(), modelRegistry: REGISTRY }));
  return { pi, tools, lifecycle };
}

const params = (extra: Record<string, unknown> = {}) => ({
  subagent_type: "general-purpose",
  prompt: "go",
  description: "model gate",
  run_in_background: false,
  ...extra,
});

describe("the Agent tool gates a caller-named model on confirmation", () => {
  beforeEach(() => {
    hermetic = hermeticDir({ agentFiles: { pinned: PINNED } });
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
    const { tools } = await boot();
    confirm.mockResolvedValueOnce(false);

    const result = await tools.get("Agent").execute("call-1", params({ model: "haiku" }), undefined, undefined, toolCtx());

    expect(textOf(result)).toContain('The human partner denied the model "anthropic/claude-haiku-4-5"');
    // The prompt must name the model the caller asked for, not the label it typed.
    expect(confirm.mock.calls[0][0]).toBe("Allow this model?");
    expect(confirm.mock.calls[0][1]).toContain("Model: haiku 4.5 (anthropic/claude-haiku-4-5)");
    expect(confirm.mock.calls[0][1]).toContain("Named by: the calling agent (agent-tool).");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("spawns once the partner confirms", async () => {
    const { tools } = await boot();

    await tools.get("Agent").execute("call-2", params({ model: "haiku" }), undefined, undefined, toolCtx());

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the caller named no model", async () => {
    const { tools } = await boot();

    await tools.get("Agent").execute("call-3", params(), undefined, undefined, toolCtx());

    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not ask on a resume, which carries a stored model rather than naming one", async () => {
    const { tools } = await boot();

    // The harness holds no real session for "agent-1", so the call itself is
    // expected to fail. Only the absence of a prompt is under test.
    await tools.get("Agent").execute("call-4", params({ model: "haiku", resume: "agent-1" }), undefined, undefined, toolCtx());

    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not ask when the agent file pins the model in its own frontmatter", async () => {
    const { tools } = await boot();

    await tools.get("Agent").execute("call-5", params({ subagent_type: "pinned" }), undefined, undefined, toolCtx());

    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses without a UI instead of asking, and never spawns", async () => {
    const { tools } = await boot(false);

    const result = await tools.get("Agent").execute("call-6", params({ model: "haiku" }), undefined, undefined, toolCtx());

    expect(textOf(result)).toContain("no UI is available to confirm it");
    expect(confirm).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
