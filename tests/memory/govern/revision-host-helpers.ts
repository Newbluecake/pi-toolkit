/** Only own temp data, synthetic bounded byte-token protocol; NOT LIVE binding. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect } from "vitest";
import { createJevClient, createRegistryRevisionTransport } from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { readIncrementalCorpus } from "../../../src/memory/govern/incremental-corpus.js";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { createRevisionHost, REVISION_HOST_POLICY_VERSION } from "../../../src/memory/govern/revision-host.js";
import type { IncrementalBatch, IncrementalAttemptContext } from "../../../src/memory/govern/incremental.js";
import type {
  ControlledClassifyTransport,
  ClassifierRegistryLike,
  RevisionRegistryLike,
  RevisionTransportResult,
  ClassifyContext,
  JevAnswer,
} from "../../../src/memory/jev/contracts.js";
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  clearHealthTable();
});
export async function hostFixture(
  count = 2,
  options: {
    relation?: (dto: ClassifyContext) => JevAnswer;
    maxCalls?: number;
    unknown?: boolean;
    noQuote?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(join(tmpdir(), "p50-host-")),
    blocks = join(dir, "blocks");
  fs.mkdirSync(blocks, { mode: 0o700 });
  fs.writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}', { mode: 0o600 });
  const write = (id: string, body = "Keep the budget and directory lock.", authority = "agent", version = 1) =>
    fs.writeFileSync(
      join(blocks, `${id}.md`),
      `---\nkind: block\nauthority: ${authority}\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nversion: ${version}\n---\n\n${body}\n`,
      { mode: 0o600 },
    );
  for (let i = 0; i < count; i++)
    write(`rules.${String(i + 1).padStart(3, "0")}`, `Keep the budget and directory lock ${i}.`);
  const calls: { kind: string; dto: unknown; jobId?: string }[] = [],
    events: string[] = [];
  let answer =
    options.relation ??
    (() => ({
      type: "choice" as const,
      choice: "conflict",
      probabilities: { conflict: 0.99, supersedes: 0.005, unrelated: 0.005 },
      confidence: 0.99,
    }));
  const registry: ClassifierRegistryLike &
    RevisionRegistryLike & {
      classify: NonNullable<ClassifierRegistryLike["classify"]>;
      complete: NonNullable<RevisionRegistryLike["complete"]>;
    } = {
    getAvailableOfType: async () => [{ provider: "rel", id: "main" }],
    getModelOfType: () => ({}),
    classify: async (_model, dto) => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(false);
      calls.push({ kind: "relation", dto });
      events.push("relation");
      return {
        provider: "offline",
        model: "relation",
        stopReason: "stop",
        answers: { revisionRelation: answer(dto) },
        usage: { input: 1, cost: { total: 0.0001 } },
      };
    },
    complete: async (model, context, opts): Promise<RevisionTransportResult> => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(false);
      const kind = (model as { kind: string }).kind;
      expect(opts.onPayload({ max_tokens: 999 })).toEqual({ max_tokens: opts.maxTokens });
      expect(opts.maxRetries).toBe(0);
      calls.push({ kind, dto: context });
      events.push(kind);
      return {
        provider: "offline",
        model: kind,
        stopReason: "stop",
        content: [
          {
            type: "text",
            text:
              kind === "coverage"
                ? '{"verdict":"complete"}'
                : "Keep the budget and directory lock; preserve the current safety rules.",
          },
        ],
        usage: { cost: { total: 0.0001 } },
      };
    },
  };
  const classify: ControlledClassifyTransport = {
    prepare: (input) =>
      options.noQuote
        ? undefined
        : {
            adapterId: "host-offline",
            chainVersion: "v1",
            bounds: { maxInputTokens: 8192, maxOutputTokens: 128, priceUsdPerMillion: { input: 1, output: 1 } },
            dispatch: (opts) => registry.classify!(input.model, input.context, opts),
            resolveRoute: () => ({
              provider: "offline",
              model: "relation",
              routeIdentity: sha("relation"),
              routeAliases: ["rel/main", "offline/relation"],
            }),
          },
  };
  const client = createJevClient({
    config: {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      classifiers: ["rel/main"],
      proxy: "",
      maxCalls: options.maxCalls ?? 10000,
      maxCostUsd: 100,
    },
    isChild: false,
    now: Date.now,
    p50: {
      enabled: true,
      transport: classify,
      revision: {
        models: ["gen/main"],
        coverageModels: ["judge/main"],
        transport: createRegistryRevisionTransport(
          ["generation", "coverage"].map((kind) => ({
            registry,
            requestChainId: kind === "generation" ? "gen/main" : "judge/main",
            model: { kind },
            adapterId: "host-byte-token",
            chainVersion: "v1",
            maxTokensEnforced: true as const,
            outputLimitField: "max_tokens" as const,
            maxOutputTokens: 2048,
            resultEvidence: (r: RevisionTransportResult) => ({
              ...(!options.unknown ? { actual: { provider: r.provider, model: r.model } } : {}),
              costUsd: 0.0001,
            }),
            quoteInput: (c) => ({
              maxInputTokens: Buffer.byteLength(JSON.stringify(c)) + 32,
              priceUsdPerMillion: { input: 1, output: 1 },
            }),
            resolveRoute: () => ({
              provider: "offline",
              model: kind,
              routeIdentity: sha(kind),
              routeAliases: [kind === "generation" ? "gen/main" : "judge/main", `offline/${kind}`],
            }),
          })),
        ),
      },
    },
  });
  const state = { current: true, lease: true, admit: true, auto: false, cap: 0, writes: 0 };
  const binding = { registry, budgetMs: 3000, maxOutputTokens: 2048 };
  let liveBinding: typeof binding | undefined = binding;
  const host = createRevisionHost({
    client,
    binding: () => liveBinding,
    isCurrent: () => state.current,
    canAttempt: () => state.admit,
    autoEnabled: () => state.auto,
    now: () => new Date("2026-11-10T00:00:00Z"),
    onAfterWrite: () => {
      events.push("effect");
      state.writes++;
      state.lease = false;
    },
  });
  const attempt: IncrementalAttemptContext = {
    signal: new AbortController().signal,
    isCurrent: () => state.current,
    leaseValid: () => state.lease,
    tryStartGenerate: () => state.lease,
    capReached: () => {
      state.cap++;
    },
  };
  const batch = (cap = 10, epoch = 1): IncrementalBatch => {
    const { dev, ino } = inspectDirNoFollow(dir),
      directory = { realpath: dir, dev, ino, sessionEpoch: epoch },
      corpus = readIncrementalCorpus(directory);
    if (!corpus) throw Error("fixture corpus");
    return {
      v: 1,
      batchId: "selection",
      policyVersion: "p50-selection-v1",
      directory,
      corpus,
      changeCount: 5,
      taskDoneEligible: false,
      lastExternalWriteAt: 0,
      activityLease: { generation: 0, lastActivityAt: 0 },
      limits: { autoActions: 2, generateRequests: 2, jobCostCapUsd: cap },
    };
  };
  cleanup.push(() => {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    blocks,
    client,
    registry,
    host,
    state,
    binding,
    attempt,
    batch,
    write,
    calls,
    events,
    setAnswer: (f: typeof answer) => {
      answer = f;
    },
    setBinding: (b: typeof binding | undefined) => {
      liveBinding = b;
    },
    policyVersion: REVISION_HOST_POLICY_VERSION,
  };
}
