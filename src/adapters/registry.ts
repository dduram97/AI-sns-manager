import type { ChannelType } from "../workers/types";
import { NaverBlogAdapter } from "./naver/NaverBlogAdapter";
import type { ChannelAdapter } from "./types";

/**
 * Channel → Adapter registry (no switch on channel).
 * blog → NaverBlogAdapter (Playwright). Future: Threads / Instagram.
 */
export class ChannelAdapterRegistry {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.channel, adapter);
    return this;
  }

  resolve(channel: ChannelType): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new Error(
        `ChannelAdapterRegistry: no adapter registered for channel=${channel}`,
      );
    }
    return adapter;
  }

  has(channel: ChannelType): boolean {
    return this.adapters.has(channel);
  }

  list(): ChannelType[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultAdapterRegistry(): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  registry.register(new NaverBlogAdapter());
  return registry;
}
