/**
 * command-interrupt.ts — let the user stop ONE running command inside a
 * subagent, without stopping the subagent itself.
 *
 * The registry is keyed by agent id and holds a Set of controllers per agent,
 * not a single controller, because pi runs tool calls in parallel: one agent
 * can have several live commands at the same time. A single-controller map
 * would silently drop every command after the first, and the user's interrupt
 * would look like it did nothing.
 *
 * Each `begin` returns a handle bound to its own controller. `done` removes
 * that controller alone, so a command that finishes on its own never clears a
 * newer command that started later for the same agent. `interrupt` aborts
 * every live controller for one agent and reports how many it aborted, so the
 * caller can tell "stopped four commands" from "nothing was running". It also
 * records the reason on the handle it interrupted, so the wrapper that awaited
 * the command can read why it stopped. Both `interrupt` and the unknown-id
 * path are total: pressing the interrupt key at any moment, including on an
 * agent record that is already gone, is safe.
 */

/** A handle to one live command. `signal` is the caller's abort surface; `reason` is set by `interrupt`. */
export interface CommandHandle {
  readonly signal: AbortSignal;
  readonly done: () => void;
  readonly reason?: string;
}

/** The handle as the registry sees it: `reason` is filled in when `interrupt` fires. */
interface LiveCommand extends CommandHandle {
  reason?: string;
}

/** Track the live commands of every agent so one agent's commands can be interrupted together. */
export class CommandInterruptRegistry {
  private readonly byAgent = new Map<string, Set<AbortController>>();
  /** Index back from a controller to the handle it produced, so `interrupt` can stamp the reason. */
  private readonly handles = new WeakMap<AbortController, LiveCommand>();

  /**
   * Start tracking one command for an agent and return its handle. The handle
   * carries the abort signal the caller races against, and a `done` bound to
   * this controller only.
   */
  begin(agentId: string): CommandHandle {
    const controller = new AbortController();
    let controllers = this.byAgent.get(agentId);
    if (!controllers) {
      controllers = new Set();
      this.byAgent.set(agentId, controllers);
    }
    controllers.add(controller);

    const handle: LiveCommand = {
      signal: controller.signal,
      done: () => {
        const live = this.byAgent.get(agentId);
        if (!live) return;
        live.delete(controller);
        if (live.size === 0) this.byAgent.delete(agentId);
      },
    };
    this.handles.set(controller, handle);
    return handle;
  }

  /**
   * Abort every live command of one agent. Return the number aborted, or 0
   * when nothing is live. An unknown id is not an error.
   *
   * The loop iterates a snapshot: an abort listener may call back into the
   * registry (a listener that calls `done`, or `clear`), and mutating the Set
   * during iteration would skip commands and lie about the count.
   */
  interrupt(agentId: string, reason?: string): number {
    const controllers = this.byAgent.get(agentId);
    if (!controllers || controllers.size === 0) return 0;

    let aborted = 0;
    for (const controller of [...controllers]) {
      if (controller.signal.aborted) continue;
      const handle = this.handles.get(controller);
      if (handle) handle.reason = reason;
      controller.abort(reason);
      aborted++;
    }
    return aborted;
  }

  /** True while at least one command for this agent is running. */
  isRunning(agentId: string): boolean {
    const controllers = this.byAgent.get(agentId);
    return controllers !== undefined && controllers.size > 0;
  }

  /** Drop the whole record for an agent. Used when its record is removed; does not abort. */
  clear(agentId: string): void {
    this.byAgent.delete(agentId);
  }
}

/**
 * The one wording for an interrupt result, shared by every surface that offers
 * the key (the `/interrupt` tool, the fleet list, the conversation viewer), so
 * a count reported from one place reads the same as from another.
 */
export function describeInterrupt(description: string, count: number): string {
  if (count === 0) return `No commands were running for "${description}".`;
  if (count === 1) return `Interrupted 1 running command for "${description}".`;
  return `Interrupted ${count} running commands for "${description}".`;
}
