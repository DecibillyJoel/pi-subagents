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
//      because the wrapper rethrows the base error unchanged. A reasoned
//      interrupt cannot use that path: attaching a reason changes the message,
//      and pi only re-attaches the accumulated output for the bare `aborted`
//      sentinel. The wrapper therefore keeps its own bounded tail of the
//      command's output and sends it with the reason.

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

/**
 * The most output bytes the wrapper keeps to report after an interrupt. A
 * killed command's tail is what matters, so the buffer keeps the last
 * `INTERRUPT_OUTPUT_LIMIT_BYTES` bytes and drops earlier output. The bound
 * stops a command that spews gigabytes from exhausting memory.
 */
const INTERRUPT_OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Keep the tail of one command's streamed output, up to
 * `INTERRUPT_OUTPUT_LIMIT_BYTES` bytes. A reasoned interrupt needs the text the
 * command already produced: pi attaches its accumulated output only for the
 * bare `aborted` sentinel, so the wrapper must carry the text itself.
 */
class TailBuffer {
	private readonly chunks: Buffer[] = [];
	private bytes = 0;

	append(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > INTERRUPT_OUTPUT_LIMIT_BYTES && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			if (dropped) this.bytes -= dropped.length;
		}
		const only = this.chunks[0];
		if (this.bytes > INTERRUPT_OUTPUT_LIMIT_BYTES && only) {
			const tail = only.subarray(only.length - INTERRUPT_OUTPUT_LIMIT_BYTES);
			this.chunks[0] = tail;
			this.bytes = tail.length;
		}
	}

	text(): string {
		return Buffer.concat(this.chunks, this.bytes).toString("utf8");
	}
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
 * Build the wrapped operations the interruptible bash tool runs on. The
 * wrapper is exported so a test can assert its own rejection, which pi's
 * `execute` otherwise masks. Production code reaches it through
 * `createInterruptibleBashTool`.
 */
export function createInterruptibleBashOperations(options: InterruptibleBashOptions): BashOperations {
	const base = options.baseOperations ?? createLocalBashOperations({ shellPath: options.shellPath });

	return {
		exec: async (command, cwd, execOptions) => {
			const handle = options.registry.begin(options.agentId);
			const signal = execOptions.signal
				? AbortSignal.any([execOptions.signal, handle.signal])
				: handle.signal;
			const output = new TailBuffer();
			// pi's own output handling must see the original chunk, so forward the
			// chunk untouched and keep a separate bounded copy for the reason.
			const onData = (chunk: Buffer) => {
				if (Buffer.isBuffer(chunk)) output.append(chunk);
				execOptions.onData(chunk);
			};
			try {
				return await base.exec(command, cwd, { ...execOptions, signal, onData });
			} catch (error) {
				if (handle.reason !== undefined) {
					throw new Error(appendStatus(output.text(), handle.reason));
				}
				throw error;
			} finally {
				handle.done();
			}
		},
	};
}

/**
 * Build a `bash` tool that behaves like pi's own bash tool, except that an
 * interrupt on the registry handle stops the running command and appends the
 * interrupt reason to the failure message, together with the bounded tail of
 * the output the command already produced.
 */
export function createInterruptibleBashTool(options: InterruptibleBashOptions): ToolDefinition {
	const tool = createBashToolDefinition(options.cwd, {
		operations: createInterruptibleBashOperations(options),
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
