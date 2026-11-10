/**
 * interruptible-bash-shadow-e2e.test.ts — the shadow really becomes the child's `bash`.
 *
 * `test/agent-runner.test.ts` mocks `createAgentSession` and
 * `createBashToolDefinition`, so no test there can show that the `customTools`
 * entry named `bash` beats pi's builtin `bash` inside a REAL child session.
 * Every other link in the chain is tested; this one is the assumption the whole
 * feature rests on. A pi bump that changed custom-tool precedence would kill
 * the feature silently with the rest of the suite green.
 *
 * This test closes the loop with no pi mock. pi registers the builtin
 * definitions first and then applies `customTools` over them by name, so
 * `getToolDefinition("bash")` must return the interruptible definition itself,
 * and `getAllTools()` must report it from the sdk source.
 *
 * No network and no model call: a faux Model object satisfies
 * `createAgentSession`'s `model` param, and the assertion reads the registry
 * that construction fixes. This test never prompts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandInterruptRegistry } from "../src/command-interrupt.js";
import { createInterruptibleBashTool } from "../src/interruptible-bash.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Session construction imports and initialises the real runtime, so allow more
// than vitest's 5s default under full-suite CPU contention.
vi.setConfig({ testTimeout: 30_000 });

describe("interruptible bash shadow (real pi session)", () => {
  let cwd: string;
  let home: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-shadow-"));
    home = mkdtempSync(join(tmpdir(), "subagents-shadow-home-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Build a real session whose only allowed tool is `bash`, then report what pi resolved it to. */
  async function resolvedBash(customTools?: ToolDefinition[]) {
    const loader = new DefaultResourceLoader({ cwd, agentDir: home, noExtensions: true });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: home,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      model: faux.getModel(),
      tools: ["bash"],
      ...(customTools ? { customTools } : {}),
    });
    const definition = session.getToolDefinition("bash");
    const info = session.getAllTools().find((tool) => tool.name === "bash");
    const active = session.getActiveToolNames();
    session.dispose();
    return { definition, info, active };
  }

  it("resolves bash to the interruptible custom definition, not pi's builtin", async () => {
    // Control: without customTools, `bash` is pi's own builtin.
    const builtin = await resolvedBash();
    expect(builtin.info?.sourceInfo.source).toBe("builtin");
    expect(builtin.active).toContain("bash");

    const registry = new CommandInterruptRegistry();
    const shadow = createInterruptibleBashTool({ cwd, agentId: "agent-a", registry });
    const shadowed = await resolvedBash([shadow]);

    // Same name, so pi keeps exactly one `bash`, and it is OUR definition object.
    expect(shadowed.definition).toBe(shadow);
    expect(shadowed.info?.sourceInfo.source).toBe("sdk");
    expect(shadowed.info?.description).toBe(shadow.description);
    expect(shadowed.active).toContain("bash");
    expect(shadowed.active.filter((name) => name === "bash")).toHaveLength(1);
  });
});
