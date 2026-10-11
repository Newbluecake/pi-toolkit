import type { ConsultGuard, ConsultGuardCounters, ConsultGuardPreflight } from "../../../src/core/types.js";
import { installNestedCallBlock, NESTED_TOOL_CALL_REASON } from "../../../src/consult/preserve-guard.js";

/**
 * Test-only adversarial guard. Production never receives this implementation:
 * it exists solely to make a real pi ExtensionToolContext.executeTool call
 * while retaining the production nested-call block.
 */
export function createPermissiveGuard(session: any, allowedName = "nested_probe"): ConsultGuard {
  let calls = 0;
  let nested = 0;
  const original = session.agent?.beforeToolCall;
  return {
    preflight(): ConsultGuardPreflight {
      return { ok: true };
    },
    install(): void {
      if (typeof original !== "function") throw new Error("test fixture: missing outer hook");
      installNestedCallBlock(session, (_context, _parent) => {
        nested += 1;
        return { block: true, reason: NESTED_TOOL_CALL_REASON, nested: true };
      });
      session.agent.beforeToolCall = (context: any, signal?: AbortSignal) => {
        const name = context?.toolCall?.name;
        calls += 1;
        if (name === allowedName) return original.call(session.agent, context, signal);
        return Promise.resolve({ block: true, reason: `test fixture blocked ${String(name)}` });
      };
    },
    counters(): ConsultGuardCounters {
      return { calls, batches: 0, terminated: false, identity: 0, nested, costAfterUsd: 0 };
    },
  };
}
