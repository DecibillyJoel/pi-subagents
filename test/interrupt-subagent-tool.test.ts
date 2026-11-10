/**
 * interrupt-subagent-tool.test.ts — the parent-facing surface for stopping one
 * wedged command without killing the subagent.
 *
 * The registry, the interruptible bash tool, and `AgentManager.interruptCommand`
 * are covered by their own suites. What had no coverage is the wiring a caller
 * actually reaches: the tool a parent model calls and the `/interrupt` command a
 * person types. Both have to resolve a handle, refuse another agent's child, and
 * report a COUNT, because "nothing was running" is an ordinary answer and not an
 * error — a caller that sees a throw here would escalate to aborting the agent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/**
 * The manager facade this activation published, which is the only handle a test
 * has on the records the extension created.
 */
function registryEntry(): any {
  return (globalThis as any)[MANAGER_KEY];
}

let lifecycle: Map<string, any> | undefined;

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  lifecycle = undefined;
  // Only the first activation may claim the slot, so a leftover entry would
  // point every later case at this case's manager.
  delete (globalThis as any)[MANAGER_KEY];
  vi.mocked(runAgent).mockReset();
});

interface Booted {
  tools: Map<string, any>;
  commands: Map<string, any>;
  id: string;
  record: any;
  /** The interrupt registry the extension handed the child run. */
  interruptRegistry: any;
}

/**
 * Boot the extension, spawn one background agent whose run never settles, and
 * hand back what the assertions need.
 */
async function bootWithHangingAgent(description = "interrupt target agent"): Promise<Booted> {
  const booted = makePi();
  subagentsExtension(booted.pi);
  lifecycle = booted.lifecycle;
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

  const spawned = await booted.tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
  await flush();

  // The registry arrives as a run option (4th argument) — the same object
  // `interruptCommand` delegates to, so a handle begun here is what the tool
  // and the command must abort.
  const interruptRegistry = vi.mocked(runAgent).mock.lastCall![3].commandInterrupt;
  return { ...booted, id, record: registryEntry().getRecord(id), interruptRegistry };
}

/** Call the interrupt tool the way a parent model does. */
const interruptTool = (tools: Map<string, any>, params: Record<string, unknown>) =>
  tools.get(SUBAGENT_TOOL_NAMES.INTERRUPT).execute("tc-interrupt", params, undefined, undefined, ctx());

describe("the interrupt_subagent tool", () => {
  it("is registered under the name a parent agent calls", async () => {
    const { pi, tools, lifecycle: life } = makePi();
    lifecycle = life;
    subagentsExtension(pi);

    expect(SUBAGENT_TOOL_NAMES.INTERRUPT).toBe("interrupt_subagent");
    expect(tools.has("interrupt_subagent")).toBe(true);
  });

  it("names the count and leaves the agent running", async () => {
    const booted = await bootWithHangingAgent();
    const before = booted.record.status;
    booted.interruptRegistry.begin(booted.id);

    const result = await interruptTool(booted.tools, {
      agent_id: booted.id,
      reason: "build is stuck",
    });

    expect(textOf(result)).toBe('Interrupted 1 running command for "interrupt target agent".');
    expect(result.isError).toBeFalsy();
    // The whole point: the command stops, the agent does not. `abort()` would
    // take the record out of `running` and lose the rest of the agent's work.
    expect(booted.record.status).toBe(before);
  });

  it("counts every live command rather than the first one", async () => {
    const booted = await bootWithHangingAgent();
    booted.interruptRegistry.begin(booted.id);
    booted.interruptRegistry.begin(booted.id);

    const result = await interruptTool(booted.tools, { agent_id: booted.id });

    expect(textOf(result)).toBe('Interrupted 2 running commands for "interrupt target agent".');
  });

  it("reports that nothing was running without failing the call", async () => {
    const booted = await bootWithHangingAgent();

    const result = await interruptTool(booted.tools, { agent_id: booted.id });

    expect(textOf(result)).toBe('No commands were running for "interrupt target agent".');
    expect(result.isError).toBeFalsy();
    expect(booted.record.status).toBe("running");
  });

  it("refuses a child owned by another agent and aborts nothing", async () => {
    const booted = await bootWithHangingAgent();
    // A nested child reports through its owner, so a top-level caller must not
    // reach in. Marking the record is the cheapest faithful stand-in for a real
    // nested spawn: `isTopLevelAgent` reads exactly these two fields.
    booted.record.parentAgentId = "parent-agent";
    const handle = booted.interruptRegistry.begin(booted.id);

    const result = await interruptTool(booted.tools, { agent_id: booted.id });

    expect(textOf(result)).toContain("Agent is owned by another agent or workflow");
    expect(handle.signal.aborted).toBe(false);
  });

  it("reports an unknown id as not found", async () => {
    const booted = await bootWithHangingAgent();

    const result = await interruptTool(booted.tools, { agent_id: "agent-that-never-existed" });

    expect(textOf(result)).toContain("Agent not found");
  });

  it("stays out of a plain subagent's toolset", () => {
    // `agent-runner.ts` builds its denylist from `Object.values(SUBAGENT_TOOL_NAMES)`
    // and this file must not be edited here, so assert the fact the denylist
    // depends on: the registered name is one of those values. The deny itself is
    // exercised behaviourally in agent-runner.test.ts ("EXCLUDED_TOOL_NAMES never
    // reach the allowlist").
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("interrupt_subagent");
  });
});

describe("the /interrupt command", () => {
  it("passes the id and the reason through and reports the count", async () => {
    const booted = await bootWithHangingAgent();
    const handle = booted.interruptRegistry.begin(booted.id);
    const commandCtx = ctx();

    await booted.commands.get("interrupt").handler(`${booted.id} build is stuck`, commandCtx);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason).toBe("build is stuck");
    expect(commandCtx.ui.notify).toHaveBeenCalledWith(
      'Interrupted 1 running command for "interrupt target agent".',
      undefined,
    );
  });

  it("takes the whole rest of the line as the reason", async () => {
    const booted = await bootWithHangingAgent();
    const handle = booted.interruptRegistry.begin(booted.id);

    await booted.commands.get("interrupt").handler(`  ${booted.id}   stop  the  build  `, ctx());

    expect(handle.reason).toBe("stop  the  build");
  });

  it("shows usage instead of throwing when the id is missing", async () => {
    const booted = await bootWithHangingAgent();
    const commandCtx = ctx();

    await expect(booted.commands.get("interrupt").handler("", commandCtx)).resolves.toBeUndefined();

    expect(commandCtx.ui.notify).toHaveBeenCalled();
    expect(String(commandCtx.ui.notify.mock.calls[0][0])).toContain("/interrupt");
  });
});
