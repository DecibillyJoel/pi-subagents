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
