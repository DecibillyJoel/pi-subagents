/**
 * model-confirmation.ts — `confirmCallerModel` policy: ask the human partner
 * before a subagent spawns with a model that the calling agent named.
 *
 * An omitted `model` inherits the calling session's own model, so it costs
 * exactly what the caller's own turns cost. Naming one is therefore a
 * deliberate act, and the person who pays for it should see it before the child
 * starts. This module holds the ask; the five spawn paths hold the call.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `scopeModels` lives in model-scope.ts: the top-level Agent tool and the nested
 * delegation tools both need it, and the nested tools run without a session
 * context of their own. The registered context is the session's own.
 */

/**
 * The part of a pi extension context this gate needs. Typed structurally, like
 * the `EventBus` interface in cross-extension-rpc.ts, so no caller has to pass a
 * whole `ExtensionContext`.
 */
export interface ConfirmableCtx {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

export interface ModelConfirmationRequest {
  /** The resolved model, as the partner should see it. */
  model: { modelName: string; modelId: string };
  /** The caller's raw `model` text. Carried for callers and diagnostics only. */
  modelInput: string;
  /** Display name of the subagent about to spawn. */
  agentLabel: string;
  /** Which spawn path asked. */
  source: "agent-tool" | "nested" | "workflow" | "rpc" | "registry";
}

export type ModelConfirmationVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * When enabled, a caller-supplied model is confirmed by the human partner before
 * the spawn proceeds. On by default in this fork; off restores the old silent
 * behaviour. Opt out via `/agents → Settings`. See the
 * SubagentsSettings.confirmCallerModel docstring for the fail-closed policy.
 */
let confirmCallerModelEnabled = true;
let confirmationCtx: ConfirmableCtx | undefined;

export function isConfirmCallerModelEnabled(): boolean { return confirmCallerModelEnabled; }
export function setConfirmCallerModel(value: boolean): void { confirmCallerModelEnabled = value; }

export function setConfirmationCtx(ctx: ConfirmableCtx | undefined): void { confirmationCtx = ctx; }

function deniedReason(agentLabel: string, modelId: string): string {
  return `Subagent "${agentLabel}" was not started. The human partner denied the model "${modelId}". Dispatch again with no \`model\` field to inherit your own model, or ask your partner to approve that model first.`;
}

function noUiReason(agentLabel: string, modelId: string): string {
  return `Subagent "${agentLabel}" was not started. It named the model "${modelId}", and no UI is available to confirm it. Dispatch again with no \`model\` field to inherit your own model, or run interactively.`;
}

/**
 * Confirm a caller-supplied model, or refuse the spawn.
 *
 * Fails closed. A missing context, a context with no UI, and a confirm route
 * that throws all refuse the spawn: an unanswered ask is not a yes.
 */
export async function confirmCallerSuppliedModel(
  request: ModelConfirmationRequest,
): Promise<ModelConfirmationVerdict> {
  const { model, agentLabel, source } = request;
  if (!confirmCallerModelEnabled) return { allowed: true };

  const ctx = confirmationCtx;
  if (!ctx?.hasUI) return { allowed: false, reason: noUiReason(agentLabel, model.modelId) };

  const message = [
    `Subagent: ${agentLabel}`,
    `Model: ${model.modelName} (${model.modelId})`,
    `Named by: the calling agent (${source}). Your agent file did not set it.`,
  ].join("\n");

  try {
    const confirmed = await ctx.ui.confirm("Allow this model?", message);
    if (confirmed) return { allowed: true };
    return { allowed: false, reason: deniedReason(agentLabel, model.modelId) };
  } catch {
    return { allowed: false, reason: noUiReason(agentLabel, model.modelId) };
  }
}
