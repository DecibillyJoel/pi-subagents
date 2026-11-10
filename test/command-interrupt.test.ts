// The interrupt registry is the piece that lets a user stop ONE running
// command inside a subagent without touching the subagent itself. Its real
// invariants are not visible from a happy-path call, so they are asserted
// directly here:
//
//   1. One agent can have SEVERAL live commands. Pi runs tool calls in
//      parallel, so `begin` must accumulate controllers per agent id and one
//      `interrupt` must abort all of them (returns the count aborted). A
//      registry keyed by a single controller would silently lose the second
//      command, and the user's interrupt would look like it did nothing.
//   2. `done` is bound to its OWN controller. When a command finishes on its
//      own it must not clear a newer command that started for the same agent
//      under the same id. Clearing the whole Set on any `done` reintroduces
//      the same lost-command bug from the other side.
//   3. `interrupt` must not throw on an unknown id or on an agent whose
//      commands already finished — a user can press the interrupt key at any
//      time, including on a stale agent id.
//   4. Iteration over the controllers must be snapshot-safe. An abort listener
//      that removes itself (a very normal cleanup) must not corrupt the loop.

import { describe, expect, it, vi } from "vitest";
import { CommandInterruptRegistry } from "../src/command-interrupt.js";

describe("CommandInterruptRegistry", () => {
  it("begin returns a signal that is not aborted", () => {
    const registry = new CommandInterruptRegistry();

    const handle = registry.begin("agent-a");

    expect(handle.signal.aborted).toBe(false);
    expect(handle.reason).toBeUndefined();
  });

  it("interrupt aborts the signal and returns 1", () => {
    const registry = new CommandInterruptRegistry();
    const handle = registry.begin("agent-a");

    expect(registry.interrupt("agent-a")).toBe(1);
    expect(handle.signal.aborted).toBe(true);
  });

  it("interrupt stores the reason on the handle", () => {
    const registry = new CommandInterruptRegistry();
    const handle = registry.begin("agent-a");

    registry.interrupt("agent-a", "reason text");

    expect(handle.reason).toBe("reason text");
  });

  it("aborts every live command for one agent and counts them", () => {
    const registry = new CommandInterruptRegistry();
    const first = registry.begin("agent-a");
    const second = registry.begin("agent-a");

    expect(registry.interrupt("agent-a")).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("returns 0 and does not throw for an unknown agent", () => {
    const registry = new CommandInterruptRegistry();

    expect(() => registry.interrupt("nobody")).not.toThrow();
    expect(registry.interrupt("nobody")).toBe(0);
  });

  it("reports isRunning false and returns 0 after done", () => {
    const registry = new CommandInterruptRegistry();
    const handle = registry.begin("agent-a");

    expect(registry.isRunning("agent-a")).toBe(true);
    handle.done();

    expect(registry.isRunning("agent-a")).toBe(false);
    expect(registry.interrupt("agent-a")).toBe(0);
  });

  it("done on an old handle does not clear a newer handle for the same id", () => {
    const registry = new CommandInterruptRegistry();
    const old = registry.begin("agent-a");
    const newer = registry.begin("agent-a");

    old.done();

    expect(registry.interrupt("agent-a")).toBe(1);
    expect(newer.signal.aborted).toBe(true);
  });

  it("keys by id: interrupt on one agent does not touch another", () => {
    const registry = new CommandInterruptRegistry();
    const a = registry.begin("agent-a");
    const b = registry.begin("agent-b");

    registry.interrupt("agent-a");

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("clear drops the record without aborting the live command", () => {
    const registry = new CommandInterruptRegistry();
    const handle = registry.begin("agent-a");

    registry.clear("agent-a");

    expect(registry.isRunning("agent-a")).toBe(false);
    expect(handle.signal.aborted).toBe(false);
  });

  it("survives an abort listener that removes itself during interrupt", () => {
    const registry = new CommandInterruptRegistry();
    const first = registry.begin("agent-a");
    const second = registry.begin("agent-a");
    const removed = vi.fn();
    first.signal.addEventListener("abort", () => {
      registry.clear("agent-a");
      removed();
    });

    expect(registry.interrupt("agent-a")).toBe(2);
    expect(removed).toHaveBeenCalled();
    expect(second.signal.aborted).toBe(true);
  });
});
