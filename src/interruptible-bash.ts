// A subagent runs precisely one bash command at a time, but pi's own bash tool
// has no way for the parent to stop that one command. The only cancellation pi
// exposes is the signal of the whole run, which tears the subagent down. This
// module rebuilds pi's bash tool around a wrapped `BashOperations` that opens a
// registry handle for the duration of `exec`. An interrupt on the handle
// aborts just the running command, and the base operations kill the process
// group as usual.
//
// Two behaviours matter and are easy to get wrong:
//
//   1. pi's own run signal must keep working. The wrapper hands the base
//      operations a combined signal, so aborting either the registry handle or
//      the caller signal stops the command.
//   2. The interrupt reason is only appended when one was given. A reasonless
//      interrupt leaves pi's own error path ("Command aborted") untouched,
//      because the wrapper rethrows the base error unchanged.

import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CommandInterruptRegistry } from "./command-interrupt.js";

/** The shape pi's own bash tool uses to append a status line to command output. */
function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

/** The rejection message of a base operations failure, for the reason append. */
function rejectionText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface InterruptibleBashOptions {
	/** The working directory the command runs in. */
	cwd: string;
	/** The agent id used to key the registry handle. */
	agentId: string;
	/** The registry that receives the handle for this command. */
	registry: CommandInterruptRegistry;
	/** A command prepended to every command, exactly like pi's own bash tool. */
	commandPrefix?: string;
	/** The shell binary, exactly like pi's own bash tool. */
	shellPath?: string;
	/**
	 * Test seam. When set, the wrapped operations call this backend instead of
	 * the local shell. Production code must leave this unset.
	 */
	baseOperations?: BashOperations;
}

/**
 * Build a `bash` tool that behaves exactly like pi's own bash tool, except that
 * an interrupt on the registry handle stops the running command and appends the
 * interrupt reason to the failure message.
 */
export function createInterruptibleBashTool(options: InterruptibleBashOptions): ToolDefinition {
	const base = options.baseOperations ?? createLocalBashOperations({ shellPath: options.shellPath });

	const wrapped: BashOperations = {
		exec: async (command, cwd, execOptions) => {
			const handle = options.registry.begin(options.agentId);
			const signal = execOptions.signal
				? AbortSignal.any([execOptions.signal, handle.signal])
				: handle.signal;
			try {
				return await base.exec(command, cwd, { ...execOptions, signal });
			} catch (error) {
				if (handle.reason !== undefined) {
					throw new Error(appendStatus(rejectionText(error), handle.reason));
				}
				throw error;
			} finally {
				handle.done();
			}
		},
	};

	const tool = createBashToolDefinition(options.cwd, {
		operations: wrapped,
		commandPrefix: options.commandPrefix,
		shellPath: options.shellPath,
	});
	// A definition placed in `AgentSessionConfig.customTools` is used as-is, so
	// copy the prompt fields the way `createBashTool` does. Without the copy the
	// child session would see a bash tool with no prompt hint.
	// The cast is the same one `createStructuredOutputTool` uses: pi types a
	// definition's parameters as the open `TSchema`, and the concrete bash schema
	// is not assignable back to it through `renderCall`.
	return Object.assign(tool, {
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
	}) as ToolDefinition;
}
