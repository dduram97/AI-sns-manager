/**
 * Node scripts preload: neutralize Next.js `server-only` guard.
 * Usage: node --import ./scripts/stub-server-only.mjs --import tsx scripts/...
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export {};",
      };
    }
    return nextResolve(specifier, context);
  },
});
