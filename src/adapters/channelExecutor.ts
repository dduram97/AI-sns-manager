/**
 * ChannelExecutor — ActionJob → Registry → Adapter method.
 * Channel selection is Registry-only (no switch on channel).
 */

import type { ActionJob } from "../workers/types";
import {
  createDefaultAdapterRegistry,
  type ChannelAdapterRegistry,
} from "./registry";
import {
  ACTION_METHOD_REGISTRY,
  toChannelActionInput,
  type ChannelActionResult,
} from "./types";
import { traceEnter, traceReturn } from "./naver/traceSummary";

export class ChannelExecutor {
  constructor(private readonly registry: ChannelAdapterRegistry) {}

  async execute(job: ActionJob): Promise<ChannelActionResult> {
    traceEnter(
      "ChannelExecutor.execute",
      `action=${job.action_type} channel=${job.channel}`,
    );
    let adapter;
    try {
      adapter = this.registry.resolve(job.channel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      traceReturn("ChannelExecutor.execute", "adapter_resolve_failed", msg);
      return {
        ok: false,
        errorMessage: msg,
      };
    }

    const method = ACTION_METHOD_REGISTRY[job.action_type];
    if (!method) {
      traceReturn(
        "ChannelExecutor.execute",
        "unsupported_action",
        String(job.action_type),
      );
      return {
        ok: false,
        errorMessage: `ChannelExecutor: unsupported action_type=${job.action_type}`,
      };
    }

    const input = toChannelActionInput(job);
    try {
      console.log(`[TRACE] ChannelExecutor calling adapter.${method}`);
      const result = await adapter[method](input);
      traceReturn(
        "ChannelExecutor.execute",
        "channel_executor_done",
        `ok=${result.ok} err=${!result.ok ? result.errorMessage.slice(0, 120) : ""}`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      traceReturn("ChannelExecutor.execute", "channel_executor_throw", msg);
      return {
        ok: false,
        errorMessage: msg,
      };
    }
  }

  async sync(channel: ActionJob["channel"]): Promise<ChannelActionResult> {
    try {
      const adapter = this.registry.resolve(channel);
      return await adapter.sync();
    } catch (err) {
      return {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

let defaultExecutor: ChannelExecutor | null = null;

export function createChannelExecutor(
  registry?: ChannelAdapterRegistry,
): ChannelExecutor {
  return new ChannelExecutor(registry ?? createDefaultAdapterRegistry());
}

export function getChannelExecutor(): ChannelExecutor {
  if (!defaultExecutor) {
    defaultExecutor = createChannelExecutor();
  }
  return defaultExecutor;
}
