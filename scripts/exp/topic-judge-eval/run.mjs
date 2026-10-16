#!/usr/bin/env -S npx tsx
/**
 * topic-switch judge eval · step 2 — labelled harness (scripts/exp/topic-judge-eval/).
 *
 * Reads a LABELLED JSONL (extract.mjs output where the main session filled
 * `label: true | false` — true = the judge SHOULD answer related), runs every case
 * through `buildJudgePrompt(input, variant)` × {v1, v2} against a list of models,
 * exactly like the live judge (`ModelRuntime` built from `~/.pi/agent`
 * auth.json/models.json — the same registry pi itself uses; by default `completeSimple(model,
 * {systemPrompt, messages}, {maxTokens: JUDGE_MAX_TOKENS, reasoning: JUDGE_REASONING, signal})`,
 * the same provider-neutral options as the live streamSimple call), parses with the
 * real `parseJudgeReply`, bounded concurrency (default 3) + per-call timeout.
 *
 * Prints a per model × variant accuracy table (false-related = missed suggestion,
 * false-unrelated = wrong suggestion) plus per-case rows, and writes
 * `docs/dev/topic-switch/judge-eval/results-<date>.json`. A single failed call is
 * recorded as {error}, never thrown.
 *
 * Usage:
 *   npx tsx scripts/exp/topic-judge-eval/run.mjs <labelled.jsonl> \
 *     [--models zai-coding-cn/glm-5.3-flash,deepseek/deepseek-flash] [--variants v1,v2] \
 *     [--concurrency 3] [--timeout-ms 30000]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  JUDGE_CRITERION_VARIANTS,
  JUDGE_MAX_TOKENS,
  JUDGE_REASONING,
  buildJudgePrompt,
  parseJudgeReply,
} from "../../../src/topic-switch/judge.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(SCRIPT_DIR, "../../../docs/dev/topic-switch/judge-eval");
const DEFAULT_MODELS = "zai-coding-cn/glm-5.3-flash,deepseek/deepseek-flash";

function parseArgs(argv) {
  const out = {
    input: "",
    models: DEFAULT_MODELS,
    variants: "v1,v2",
    concurrency: 3,
    timeoutMs: 30_000,
    reasoning: JUDGE_REASONING,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--models") out.models = argv[++i] ?? out.models;
    else if (a === "--variants") out.variants = argv[++i] ?? out.variants;
    else if (a === "--concurrency") out.concurrency = Number.parseInt(argv[++i] ?? "", 10) || out.concurrency;
    else if (a === "--reasoning") out.reasoning = argv[++i];
    else if (a === "--max-tokens") out.maxTokens = Number.parseInt(argv[++i] ?? "", 10) || out.maxTokens;
    else if (a === "--timeout-ms") out.timeoutMs = Number.parseInt(argv[++i] ?? "", 10) || out.timeoutMs;
    else if (!out.input) out.input = a;
  }
  if (!out.input) {
    console.error(
      "usage: run.mjs <labelled.jsonl> [--models a/b,c/d] [--variants v1,v2] [--concurrency N] [--timeout-ms Ms] [--max-tokens N] [--reasoning minimal|low|off|default]",
    );
    process.exit(2);
  }
  return out;
}

/** Same extraction as wire.ts's assistantMessageText (error message surfaces as the call's error). */
function assistantText(message) {
  if (message.errorMessage) throw new Error(message.errorMessage);
  const text = (message.content ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join(" ");
  if (!text.trim()) throw new Error("empty reply");
  return text;
}

async function callJudge(runtime, model, variant, input, timeoutMs) {
  const started = Date.now();
  const { systemPrompt, userPrompt } = buildJudgePrompt(input, variant);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const ctx = { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] };
    const base = { signal: ac.signal, maxTokens: args.maxTokens ?? JUDGE_MAX_TOKENS };
    // --reasoning <level|off|default>: provider-neutral thinking level via completeSimple, like the
    // live judge (default JUDGE_REASONING); "default" = plain complete() without a level.
    const message =
      args.reasoning === "default"
        ? await runtime.complete(model, ctx, base)
        : await runtime.completeSimple(model, ctx, {
            ...base,
            ...(args.reasoning === "off" ? {} : { reasoning: args.reasoning }),
          });
    const text = assistantText(message);
    const parsed = parseJudgeReply(text);
    if (parsed === undefined) return { ms: Date.now() - started, error: `parse-error: ${text.slice(0, 120)}` };
    return { ms: Date.now() - started, related: parsed.related, confidence: parsed.confidence };
  } catch (err) {
    return {
      ms: Date.now() - started,
      error: ac.signal.aborted ? "timeout" : String(err?.message ?? err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded-concurrency worker pool over a task list; single failures become {error} results. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

const args = parseArgs(process.argv.slice(2));
const variants = args.variants
  .split(",")
  .map((s) => s.trim())
  .filter((v) => JUDGE_CRITERION_VARIANTS.includes(v));
const modelRefs = args.models
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const cases = readFileSync(args.input, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l, idx) => {
    try {
      return { ...JSON.parse(l), line: idx + 1 };
    } catch (err) {
      return { id: `line-${idx + 1}`, label: null, input: undefined, parseError: String(err?.message ?? err) };
    }
  });
const labelled = cases.filter((c) => c.label === true || c.label === false);
const skipped = cases.length - labelled.length;
if (skipped > 0) console.error(`skipped ${skipped} case(s) without a boolean label (label:null/unparsable)`);
if (labelled.length === 0) {
  console.error("no labelled cases — fill `label: true|false` (should the judge say related?) first");
  process.exit(2);
}

const runtime = await ModelRuntime.create({
  authPath: join(getAgentDir(), "auth.json"),
  modelsPath: join(getAgentDir(), "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const models = [];
for (const ref of modelRefs) {
  const [provider, id] = ref.split("/");
  const model = provider && id ? runtime.getModel(provider, id) : undefined;
  if (model === undefined) console.error(`model not found in registry (skipped): ${ref}`);
  else models.push({ ref, model });
}

const tasks = [];
for (const c of labelled) {
  for (const m of models) {
    for (const variant of variants) {
      tasks.push(async () => {
        const r = await callJudge(runtime, m.model, variant, c.input, args.timeoutMs);
        return { caseId: c.id, label: c.label, model: m.ref, variant, ...r };
      });
    }
  }
}
console.error(
  `running ${tasks.length} call(s): ${labelled.length} case(s) × ${models.length} model(s) × ${variants.length} variant(s), concurrency ${args.concurrency}`,
);
const results = await pool(tasks, args.concurrency);

// aggregate per model × variant
const agg = new Map();
for (const r of results) {
  const key = `${r.model}|${r.variant}`;
  const a = agg.get(key) ?? {
    model: r.model,
    variant: r.variant,
    total: 0,
    answered: 0,
    correct: 0,
    falseRelated: 0,
    falseUnrelated: 0,
    errors: 0,
  };
  a.total += 1;
  if (r.error !== undefined) a.errors += 1;
  else {
    a.answered += 1;
    if (r.related === r.label) a.correct += 1;
    if (r.related === true && r.label === false) a.falseRelated += 1;
    if (r.related === false && r.label === true) a.falseUnrelated += 1;
  }
  agg.set(key, a);
}
const date = new Date().toISOString().slice(0, 10);
const out = {
  date,
  input: resolve(args.input),
  cases: labelled.length,
  models: models.map((m) => m.ref),
  variants,
  aggregates: [...agg.values()],
  results,
};
mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `results-${date}.json`);
writeFileSync(outFile, JSON.stringify(out, null, 2));

// print table + per-case rows
const pct = (a, b) => (b === 0 ? "-" : `${Math.round((a / b) * 100)}%`);
console.log(`\n=== accuracy (label = ground truth; ${labelled.length} cases) ===`);
console.log("model                          variant  acc        correct  false-rel  false-unrel  err");
for (const a of [...agg.values()].sort(
  (x, y) => x.model.localeCompare(y.model) || x.variant.localeCompare(y.variant),
)) {
  console.log(
    `${a.model.padEnd(30)} ${a.variant.padEnd(8)} ${pct(a.correct, a.answered).padEnd(9)} ${String(a.correct).padStart(4)}/${String(a.answered).padStart(4)}  ${String(a.falseRelated).padStart(8)}  ${String(a.falseUnrelated).padStart(11)}  ${a.errors}`,
  );
}
console.log("\n=== per-case ===");
for (const r of results) {
  const verdict =
    r.error !== undefined
      ? `ERR ${r.error.slice(0, 60)}`
      : `${r.related ? "related" : "unrelated"} conf=${r.confidence.toFixed(2)}`;
  console.log(
    `${r.model.padEnd(30)} ${r.variant} label=${String(r.label).padEnd(5)} ${verdict}  ${r.ms}ms  ${r.caseId}`,
  );
}
console.log(`\nwrote ${outFile}`);
