import type { ConsultCacheProbe } from "../../src/core/consult-summary.js";
import type {
  AnchorIdentity,
  ConsultCacheDiagnostics,
  ConsultCacheResult,
  RunDisplayMeta,
} from "../../src/core/types.js";

export function anchorIdentity(): AnchorIdentity {
  return {
    k: 12,
    block: 1,
    blockType: "text",
    blockHash: "b".repeat(64),
    prefixHash: "p".repeat(64),
    systemHash: "s".repeat(64),
    toolsHash: "t".repeat(64),
    route: { provider: "cr-anthropic", model: "claude-sonnet-5", api: "anthropic-messages" },
    ttl: "",
  };
}

export function cacheResult(): ConsultCacheResult {
  return { v: 1, readShare: 0.96, label: "hit", anchor: "added" };
}

export function consultMeta(): RunDisplayMeta {
  return {
    consultOf: { askerRunId: "r_asker" },
    consultCache: {
      v: 1,
      predicted: {
        state: "warm",
        reason: "proven-touch",
        evidence: { source: "anchor-ledger", ttlMs: 300_000, lastProvenTouchAt: 100 },
      },
    },
    consultThread: { threadId: "ct_thread", seq: 2 },
  };
}

export function cacheDiagnostics(): ConsultCacheDiagnostics {
  return { ...consultMeta().consultCache!, first: { ...cacheResult(), at: 200 } };
}

export function cacheProbe(seq = 2): ConsultCacheProbe {
  return {
    expertRunId: "r_expert",
    outcome: "completed",
    identity: { preflight: "pass", expertTools: 4 },
    provider: "cr-anthropic",
    model: "claude-sonnet-5",
    api: "anthropic-messages",
    anchor: { state: "added", ttl: "1h" },
    thread: { id: "ct_thread", seq, mode: "continued" },
    cacheResult: cacheResult(),
    warm: { ...consultMeta().consultCache!.predicted, pingsSince: 0, pingUsdSince: 0 },
    requests: [{ input: 0, cacheRead: 96, cacheWrite: 4, output: 1, costUsd: 0.01 }],
    hitRatio: 0.99,
  };
}
