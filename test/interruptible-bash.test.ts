// The interruptible bash tool is the seam that lets a user stop ONE running
// command inside a subagent while pi's own bash tool does everything else. The
// interesting behaviour is not the happy path — it is what happens when the
// registry's handle aborts, so a fake BashOperations stands in for the real
// shell. The fake records the exec options and stays pending until its signal
// aborts, which pins three separate invariants:
//
//   1. The wrapper passes BOTH signals down. An interrupt aborts the command
//      through the registry handle, and pi's own run signal still reaches the
//      base operations. Dropping either one silently breaks a different
//      cancellation path.
//   2. The reason is only appended when the registry was interrupted with one.
//      A reasonless interrupt must leave pi's error text ("Command aborted")
//      reachable, so the wrapper rethrows the base error unchanged.
//   3. The registry tracks the command only for the duration of `exec`. A
//      factory call must not look like a live command, and the handle must be
//      released on every settle path, including the throw path.

import { describe, expect, it } from "vitest";
import { CommandInterruptRegistry } from "../src/command-interrupt.js";
import { createInterruptibleBashTool, type InterruptibleBashOptions } from "../src/interruptible-bash.js";

/** One recorded call to the base operations. */
interface ExecCall {
  command: string;
  cwd: string;
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  };
}

/**
 * A BashOperations that never resolves until its signal aborts. It rejects the
 * way pi's local backend does: `new Error("aborted")`, which is the message
 * pi's own bash tool checks for. `rejection` lets a case set the base text so
 * the test can prove that text survives the reason append.
 */
function fakeOperations(calls: ExecCall[], rejection: () => Error = () => new Error("aborted")) {
  return {
    exec: (
      command: string,
      cwd: string,
      options: ExecCall["options"],
    ): Promise<{ exitCode: number | null }> => {
      calls.push({ command, cwd, options });
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(rejection());
          return;
        }
        signal.addEventListener("abort", () => reject(rejection()));
      });
    },
  };
}

function options(calls: ExecCall[], overrides: Partial<InterruptibleBashOptions> = {}) {
  return {
    cwd: "/repo",
    agentId: "agent-a",
    registry: new CommandInterruptRegistry(),
    baseOperations: fakeOperations(calls),
    ...overrides,
  };
}

describe("createInterruptibleBashTool", () => {
  it("returns a definition named bash", () => {
    const calls: ExecCall[] = [];

    const tool = createInterruptibleBashTool(options(calls));

    expect(tool.name).toBe("bash");
  });

  it("aborts the running exec when the registry interrupts the agent", async () => {
    const calls: ExecCall[] = [];
    const registry = new CommandInterruptRegistry();
    const tool = createInterruptibleBashTool(options(calls, { registry }));
    const running = tool.execute("call-1", { command: "sleep 10" }, undefined, undefined, undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal?.aborted).toBe(false);
    expect(registry.isRunning("agent-a")).toBe(true);

    registry.interrupt("agent-a", "stopped by user");

    await expect(running).rejects.toThrow("stopped by user");
    expect(calls[0].options.signal?.aborted).toBe(true);
  });

  it("appends the reason to the base error message and keeps the base text", async () => {
    const calls: ExecCall[] = [];
    const registry = new CommandInterruptRegistry();
    const tool = createInterruptibleBashTool(
      options(calls, {
        registry,
        baseOperations: fakeOperations(calls, () => new Error("partial output\n\nmore output")),
      }),
    );
    const running = tool.execute("call-1", { command: "sleep 10" }, undefined, undefined, undefined);

    registry.interrupt("agent-a", "Command interrupted by user");

    await expect(running).rejects.toThrow("partial output\n\nmore output\n\nCommand interrupted by user");
  });

  it("leaves pi's own aborted text untouched when the interrupt carries no reason", async () => {
    const calls: ExecCall[] = [];
    const registry = new CommandInterruptRegistry();
    const tool = createInterruptibleBashTool(options(calls, { registry }));
    const running = tool.execute("call-1", { command: "sleep 10" }, undefined, undefined, undefined);

    registry.interrupt("agent-a");

    const error = await running.then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    // The wrapper rethrows the base error unchanged, so pi's own bash tool
    // turns "aborted" into its fixed text with no reason appended.
    expect(error?.message).toBe("Command aborted");
  });

  it("passes pi's own run signal through and aborts exec when it fires", async () => {
    const calls: ExecCall[] = [];
    const controller = new AbortController();
    const tool = createInterruptibleBashTool(options(calls));
    const running = tool.execute("call-1", { command: "sleep 10" }, controller.signal, undefined, undefined);

    expect(calls[0].options.signal).not.toBe(controller.signal);
    expect(calls[0].options.signal?.aborted).toBe(false);

    controller.abort();

    const error = await running.then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toBe("Command aborted");
    expect(calls[0].options.signal?.aborted).toBe(true);
  });

  it("reports isRunning true only while exec runs", async () => {
    const calls: ExecCall[] = [];
    const registry = new CommandInterruptRegistry();
    const tool = createInterruptibleBashTool(options(calls, { registry }));

    expect(registry.isRunning("agent-a")).toBe(false);
    const running = tool.execute("call-1", { command: "sleep 10" }, undefined, undefined, undefined);
    expect(registry.isRunning("agent-a")).toBe(true);

    registry.interrupt("agent-a");
    await expect(running).rejects.toThrow("aborted");

    expect(registry.isRunning("agent-a")).toBe(false);
  });

  it("keeps promptSnippet and promptGuidelines on the definition", () => {
    const calls: ExecCall[] = [];

    const tool = createInterruptibleBashTool(options(calls));

    expect(typeof tool.promptSnippet).toBe("string");
    expect(tool.promptSnippet?.length ?? 0).toBeGreaterThan(0);
    expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    expect(tool.promptGuidelines?.length ?? 0).toBeGreaterThan(0);
  });

  it("resolves the prefixed command through the base operations", async () => {
    const calls: ExecCall[] = [];
    const registry = new CommandInterruptRegistry();
    const tool = createInterruptibleBashTool(
      options(calls, { registry, commandPrefix: "source ./env.sh", shellPath: "/bin/bash" }),
    );
    const running = tool.execute("call-1", { command: "echo hi" }, undefined, undefined, undefined);

    expect(calls[0].command).toBe("source ./env.sh\necho hi");
    expect(calls[0].cwd).toBe("/repo");

    registry.interrupt("agent-a");
    await running.catch(() => {});
  });
});
