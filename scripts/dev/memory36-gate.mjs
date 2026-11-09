#!/usr/bin/env node
/** #36 PG, Tier 3. No data generation, no labels/predictions inferred from gold.
 * Build current dist first; export/build 122de638 separately (see pg-report).
 * Importing this module performs no I/O and cannot enable the live transport.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { candidateAudit } from "./memory36-candidate-audit.mjs";

export const BASELINE = "122de638";
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_DATA = join(homedir(), ".pi/agent/memory-reports/eval36");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
function check(ok, code) {
  if (!ok) throw new Error(code);
}
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}
export function parseJsonl(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSONL line ${i + 1}`);
      }
    });
}
function unique(rows, key) {
  check(new Set(rows.map((r) => r[key])).size === rows.length, `duplicate ${key}`);
}
/** Minimal label contract. Additional metadata is preserved, never edited. */
export function validateLabels(mode, rows, corpusIds) {
  check(Array.isArray(rows) && rows.length > 0, "missing labels");
  const ids = new Set(corpusIds);
  unique(rows, mode === "g1" ? "id" : "turnId");
  for (const r of rows) {
    check(
      (text(r.rationale) || (mode === "g1" && r.expected === "excluded" && text(r.excludeReason))) &&
        r.source &&
        typeof r.source === "object",
      "missing label provenance",
    );
    if (mode === "g1") {
      check(text(r.id) && ids.has(r.a) && ids.has(r.b) && r.a !== r.b, "invalid pair reference");
      check(["negative", "positive", "excluded"].includes(r.expected), "invalid pair label");
      check(["agent-agent", "user-user", "user-agent"].includes(r.pairClass), "invalid pair class");
    } else {
      check(text(r.turnId) && text(r.prompt), "invalid turn");
      check(text(r.source.sessionFile) && Number.isInteger(r.source.line) && r.source.line > 0, "invalid turn source");
      check(
        Array.isArray(r.relevantIds) &&
          r.relevantIds.length > 0 &&
          new Set(r.relevantIds).size === r.relevantIds.length &&
          r.relevantIds.every((id) => ids.has(id)),
        "invalid relevantIds",
      );
    }
  }
  return rows;
}
export function g1Support(labels) {
  const negative = labels.filter((r) => r.expected === "negative");
  const positive = labels.filter((r) => r.expected === "positive");
  const count = (cls) => negative.filter((r) => r.pairClass === cls).length;
  const strata = { AA: count("agent-agent"), UU: count("user-user"), UA: count("user-agent") };
  return {
    negative: negative.length,
    positive: positive.length,
    excluded: labels.filter((r) => r.expected === "excluded").length,
    strata,
    sufficient: negative.length >= 60 && positive.length >= 20 && strata.AA >= 30 && strata.UU >= 15 && strata.UA >= 15,
  };
}
export function metricsG1(labels, runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const negative = labels.filter((r) => r.expected === "negative");
  const positive = labels.filter((r) => r.expected === "positive");
  const count = (cls) => negative.filter((r) => r.pairClass === cls).length;
  const complete = runs.length === labels.length && labels.every((r) => typeof byId.get(r.id)?.wouldAuto === "boolean");
  const falseAuto = negative.filter((r) => byId.get(r.id)?.wouldAuto === true).length;
  const falseAA = negative.filter((r) => r.pairClass === "agent-agent" && byId.get(r.id)?.wouldAuto === true).length;
  const trueAuto = positive.filter((r) => byId.get(r.id)?.wouldAuto === true).length;
  const enough =
    negative.length >= 60 &&
    positive.length >= 20 &&
    count("agent-agent") >= 30 &&
    count("user-user") >= 15 &&
    count("user-agent") >= 15;
  const pass = falseAuto / negative.length <= 1 / 60 && falseAA === 0 && trueAuto / positive.length >= 0.5;
  return {
    status: !complete || !enough ? "NOT-EVALUATED" : pass ? "PASS" : "FAIL",
    negative: negative.length,
    positive: positive.length,
    strata: { AA: count("agent-agent"), UU: count("user-user"), UA: count("user-agent") },
    falseAuto,
    falseAA,
    trueAuto,
    falseAutoRate: negative.length ? falseAuto / negative.length : null,
    positiveRecall: positive.length ? trueAuto / positive.length : null,
  };
}
export function metricsG2(labels, runs) {
  const byId = new Map(runs.map((r) => [r.turnId, r]));
  let denominator = 0,
    oldHits = 0,
    newHits = 0;
  const complete =
    runs.length === labels.length &&
    labels.every((r) => Array.isArray(byId.get(r.turnId)?.oldIds) && Array.isArray(byId.get(r.turnId)?.newIds));
  for (const row of labels) {
    denominator += row.relevantIds.length;
    const run = byId.get(row.turnId);
    for (const id of row.relevantIds) {
      if (run?.oldIds?.includes(id)) oldHits++;
      if (run?.newIds?.includes(id)) newHits++;
    }
  }
  const oldRecall = denominator ? oldHits / denominator : null;
  const newRecall = denominator ? newHits / denominator : null;
  return {
    status:
      !complete || labels.length < 30 || !denominator
        ? "NOT-EVALUATED"
        : newHits >= oldHits && newRecall >= 0.6
          ? "PASS"
          : "FAIL",
    turns: labels.length,
    denominator,
    oldHits: complete ? oldHits : null,
    newHits: complete ? newHits : null,
    oldRecall: complete ? oldRecall : null,
    newRecall: complete ? newRecall : null,
  };
}

/** Strict exact-request replay: model + complete outbound DTO + version namespace.
 * Missing/invalid/failed responses are NOT a negative prediction. Network only
 * via an explicitly supplied callback AND the environment switch. No SDK import
 * or credential access happens on replay. Cache stores answers, not credentials.
 */
export function createReplyCache({ dir, namespace, live = false, transport, maxCalls = 400, signal, observeLookup }) {
  let calls = 0,
    hits = 0;
  const missing = new Set();
  const failures = new Set();
  return {
    stats: () => ({ calls, hits, missing: missing.size, failures: failures.size }),
    async classify(model, context, options = {}) {
      const request = { model, context };
      const key = digest({ namespace, request });
      const path = join(dir, `${key}.json`);
      if (existsSync(path)) {
        const cached = JSON.parse(readFileSync(path, "utf8"));
        check(cached.key === key && cached.requestHash === digest(request), "cache fingerprint mismatch");
        validateAnswers(context.questions, cached.result);
        observeLookup?.({ contextHash: digest(context), key, elapsedMs: cached.elapsedMs, found: true });
        await replayDelay(cached.elapsedMs, options.signal, signal);
        hits++;
        return cached.result;
      }
      observeLookup?.({ contextHash: digest(context), key, found: false });
      if (!live || process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE !== "1") {
        missing.add(key);
        throw new Error("NOT-EVALUATED: uncached classifier request");
      }
      if (!transport || calls >= maxCalls || signal?.aborted || options.signal?.aborted) {
        failures.add(key);
        throw new Error("NOT-EVALUATED: classifier call budget/abort");
      }
      calls++;
      try {
        const started = performance.now();
        const result = await transport(model, context, {
          ...options,
          signal: AbortSignal.any([signal, options.signal].filter(Boolean)),
        });
        validateAnswers(context.questions, result);
        // Persist only the closed answer schema. Provider diagnostics may contain secrets.
        const usageEstimate = result.usage?.cost?.total;
        const clean = {
          stopReason: "stop",
          ...(Number.isFinite(usageEstimate) && usageEstimate >= 0
            ? { usage: { cost: { total: usageEstimate } } }
            : {}),
          answers: Object.fromEntries(
            Object.entries(context.questions).map(([id]) => [id, cleanAnswer(result.answers[id])]),
          ),
        };
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(
          path,
          JSON.stringify({ key, requestHash: digest(request), elapsedMs: performance.now() - started, result: clean }),
          { mode: 0o600, flag: "wx" },
        );
        return clean;
      } catch (err) {
        failures.add(key);
        // Controlled harness errors (budget caps, deadline/abort, pre-transport
        // audit failures) keep their stable code for category mapping; raw
        // provider errors are suppressed to a fixed string.
        if (err instanceof Error && err.message.startsWith("NOT-EVALUATED: ")) throw err;
        throw new Error("NOT-EVALUATED: classifier failed (details suppressed)");
      }
    },
  };
}
/** Replay measured latency, not instant canned probabilities: P2's real
 * wait/late path must see the same response timing on cached reruns. */
async function replayDelay(ms, ...signals) {
  check(Number.isFinite(ms) && ms >= 0, "cache lacks measured latency");
  if (ms === 0) return;
  await bounded(
    (signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        t.unref();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("replay aborted"));
          },
          { once: true },
        );
      }),
    ms + 1000,
    AbortSignal.any(signals.filter(Boolean)),
  );
}
export async function createChatCache({
  dir,
  models,
  namespace,
  live,
  runtime,
  maxCalls,
  maxUsd,
  signal,
  budgetMs,
  estimate,
  audit,
}) {
  check(Number.isInteger(maxCalls) && maxCalls > 0 && Number.isFinite(maxUsd) && maxUsd > 0, "invalid chat budget");
  const catalogPath = join(dir, `chat-models-${digest(models)}.json`);
  let catalog;
  if (existsSync(catalogPath)) catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  else {
    check(live && process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE === "1" && runtime, "NOT-EVALUATED: chat catalog absent");
    catalog = models.map((spec) => {
      const slash = spec.indexOf("/");
      const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
      check(model, "NOT-EVALUATED: chat model not in local catalog");
      return {
        provider: model.provider,
        id: model.id,
        semanticHash: digest(model),
        cost: { input: model.cost.input, cacheRead: model.cost.cacheRead, output: model.cost.output },
      };
    });
    writePrivate(catalogPath, catalog);
  }
  check(
    Array.isArray(catalog) &&
      catalog.length === models.length &&
      catalog.every(
        (m, i) =>
          `${m.provider}/${m.id}` === models[i] &&
          [m.cost?.input, m.cost?.cacheRead, m.cost?.output].every((v) => Number.isFinite(v) && v >= 0),
      ),
    "invalid chat model catalog",
  );
  if (live && process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE === "1" && runtime)
    for (const m of catalog) {
      check(
        m.semanticHash && digest(runtime.getModel(m.provider, m.id)) === m.semanticHash,
        "NOT-EVALUATED: chat catalog changed",
      );
    }
  let calls = 0,
    hits = 0,
    reservedUsd = 0,
    missing = 0,
    failures = 0;
  const keys = new Set();
  return {
    find: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id),
    stats: () => ({ calls, hits, missing, failures, reservedUsd, models: models, keys: [...keys] }),
    streamSimple(model, context, options) {
      return {
        result: async () => {
          // Timestamp is wall-clock metadata, not model input. All textual DTO
          // fields/system/roles/options/model prices are part of the key.
          const dto = {
            systemPrompt: context.systemPrompt,
            messages: context.messages.map(({ role, content }) => ({ role, content })),
          };
          const request = { model, context: dto, maxTokens: options.maxTokens, reasoning: options.reasoning };
          const key = digest({ namespace, chat: request });
          keys.add(key);
          const path = join(dir, `chat-${key}.json`);
          if (existsSync(path)) {
            const c = JSON.parse(readFileSync(path, "utf8"));
            check(c.key === key && c.requestHash === digest(request), "chat cache fingerprint mismatch");
            check(
              c.result?.content?.every((b) => b.type === "text" && typeof b.text === "string"),
              "invalid chat cache",
            );
            await replayDelay(c.elapsedMs, options.signal, signal);
            hits++;
            return c.result;
          }
          if (!live || process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE !== "1") {
            missing++;
            throw new Error("NOT-EVALUATED: uncached chat DTO");
          }
          const price = {
            inputPerM: model.cost.input,
            cacheReadPerM: model.cost.cacheRead,
            outputPerM: model.cost.output,
          };
          const reserve = estimate(dto.systemPrompt, dto.messages[0].content, price);
          if (calls >= maxCalls || !Number.isFinite(reserve) || reservedUsd + reserve > maxUsd || signal.aborted) {
            failures++;
            throw new Error("NOT-EVALUATED: chat budget");
          }
          reservedUsd += reserve;
          // Pre-transport audit write fails closed: the conservative reserve
          // is kept, but an attempted call is counted only once the audit
          // record is durable — a request that never left the process can
          // never inflate the P2 evidence — and failures/NOT-EVALUATED reflect
          // the incomplete attempt explicitly.
          const attemptedCalls = calls + 1;
          try {
            audit?.noteTransport("chat", attemptedCalls, reservedUsd);
          } catch {
            failures++;
            throw new Error("NOT-EVALUATED: pre-transport audit write failed");
          }
          calls = attemptedCalls;
          const started = performance.now();
          try {
            const actual = runtime.getModel(model.provider, model.id);
            const result = await bounded(
              (s) => runtime.streamSimple(actual, context, { ...options, maxRetries: 0, signal: s }).result(),
              budgetMs,
              AbortSignal.any([signal, options.signal].filter(Boolean)),
            );
            check(
              result.stopReason !== "error" && result.stopReason !== "aborted" && !result.errorMessage,
              "chat failed",
            );
            const content = result.content
              .filter((b) => b.type === "text")
              .map((b) => ({ type: "text", text: b.text }));
            check(content.length > 0, "empty chat reply");
            const u = result.usage;
            const usage =
              u && [u.input, u.cacheRead, u.output].every((v) => Number.isFinite(v) && v >= 0)
                ? { input: u.input, cacheRead: u.cacheRead, output: u.output }
                : undefined;
            // No thinking/provider response headers/error strings persisted.
            const clean = { content, ...(usage ? { usage } : {}) };
            writePrivate(path, {
              key,
              requestHash: digest(request),
              elapsedMs: performance.now() - started,
              result: clean,
            });
            return clean;
          } catch {
            failures++;
            throw new Error("NOT-EVALUATED: chat failed (details suppressed)");
          }
        },
      };
    },
  };
}
function cleanAnswer(a) {
  if (a.type === "bool") return { type: "bool", probability: a.probability };
  if (a.type === "score") return { type: "score", score: a.score, confidence: a.confidence };
  return { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
}
export function validateAnswers(questions, result) {
  check(result?.stopReason === "stop" && result.answers, "incomplete classifier result");
  const probability = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  for (const [id, q] of Object.entries(questions)) {
    const a = result.answers[id];
    check(a?.type === q.type, "missing/wrong answer type");
    if (a.type === "bool") check(probability(a.probability), "invalid bool probability");
    if (a.type === "score")
      check(
        Number.isFinite(a.score) && a.score >= 0 && a.score < q.criteria.length && probability(a.confidence),
        "invalid score",
      );
    if (a.type === "choice")
      check(
        Object.hasOwn(q.criteria, a.choice) &&
          probability(a.confidence) &&
          a.probabilities &&
          Object.entries(a.probabilities).every(([k, p]) => Object.hasOwn(q.criteria, k) && probability(p)),
        "invalid choice",
      );
  }
}
async function production(dist) {
  const load = (p) => import(pathToFileURL(join(dist, `memory/${p}.js`)).href);
  const [
    settings,
    config,
    entries,
    wire,
    client,
    health,
    taxonomy,
    store,
    tagging,
    writePort,
    redact,
    secrets,
    inject,
    render,
    paths,
    predictLlm,
    predictOutbound,
    predictFlight,
  ] = await Promise.all([
    load("settings"),
    load("jev/config"),
    load("jev/entries"),
    load("jev/wire"),
    load("jev/client"),
    load("jev/health"),
    load("jev/taxonomy"),
    load("jev/index-store"),
    load("jev/tagging"),
    load("jev/write-port"),
    load("jev/redact"),
    load("secret-patterns"),
    load("inject"),
    load("render"),
    load("paths"),
    load("jev/predict/llm"),
    load("jev/predict/outbound"),
    load("jev/predict/flight"),
  ]);
  const clock = await import(pathToFileURL(join(dist, "core/clock.js")).href);
  return {
    ...settings,
    ...config,
    ...entries,
    ...wire,
    ...client,
    ...health,
    ...taxonomy,
    ...store,
    ...tagging,
    ...writePort,
    ...redact,
    ...secrets,
    ...inject,
    ...render,
    ...paths,
    ...predictLlm,
    ...predictOutbound,
    ...predictFlight,
    ...clock,
  };
}
function safeName(name) {
  check(
    text(name) && basename(name) === name && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name),
    "unsafe snapshot filename",
  );
  return name;
}
/** Corpus adapter contract is intentionally lossless: raw old files, raw new
 * blocks and a stable id mapping. Never reconstruct an old file from block text.
 * A labeler may use `items` instead of `entries`; no gold field is changed.
 */
export function corpusAdapter(raw) {
  const entries = raw.entries ?? raw.items;
  check(
    Array.isArray(entries) && entries.length > 0 && Array.isArray(raw.files),
    "corpus needs entries and old files snapshots",
  );
  unique(entries, "id");
  for (const e of entries) {
    check(
      text(e.id) &&
        text(e.project) &&
        (text(e.old?.hash) || e.whole === true) &&
        text(e.old?.file) &&
        text(e.block?.id) &&
        text(e.block?.raw),
      "incomplete corpus mapping",
    );
    safeName(e.old.file);
    safeName(`${e.block.id}.md`);
    check(!e.private && !e.secret, "private/secret corpus entry excluded");
  }
  for (const f of raw.files) {
    check(text(f.project) && typeof f.raw === "string", "invalid old snapshot");
    safeName(f.name);
  }
  return { ...raw, entries };
}
/** Adapt the independent labeler's native export with the actual migration
 * planner, not a second handwritten migration/authority implementation. */
export function adaptProductionCorpus(raw, planner, blockApi, includeHistory = false) {
  if (raw.entries?.[0]?.block) return corpusAdapter(raw);
  check(Array.isArray(raw.entries) && Array.isArray(raw.files), "missing native corpus");
  const entries = [],
    sidecars = {};
  const files = raw.files.map((f) => {
    check(digest(f.raw) === f.sha256, "old file sha mismatch");
    return { ...f, project: f.slug };
  });
  for (const project of new Set(files.map((f) => f.project))) {
    const items = raw.entries.filter((e) => e.source.slug === project && (!e.origin || e.origin === "live"));
    const oldIndex = {
      v: 1,
      entries: Object.fromEntries(
        items.filter((e) => e.oldEntryHash && e.oldTags).map((e) => [e.oldEntryHash, e.oldTags]),
      ),
    };
    const plan = planner.planMigration(
      files
        .filter((f) => f.project === project)
        .map((f) => ({ name: f.name, raw: f.raw, sha256: f.sha256, size: f.bytes, mtimeMs: f.mtimeMs })),
      oldIndex,
      raw.generatedAt.slice(0, 10),
    );
    const byId = new Map(plan.blocks.map((b) => [b.name.replace(/\.md$/, ""), b.content]));
    check(plan.blocks.length === items.length, "migration snapshot block count differs");
    for (const e of items) {
      const blockRaw = byId.get(e.newBlockId);
      check(typeof blockRaw === "string", "migration snapshot id differs");
      const parsed = blockApi.parseBlockFile(`${e.newBlockId}.md`, blockRaw);
      check(
        !("stray" in parsed) &&
          parsed.body === e.text &&
          parsed.meta.authority === e.authority &&
          (parsed.meta.scope ?? null) === e.scope,
        "migration snapshot content/authority differs",
      );
      entries.push({
        ...e,
        project,
        old: { file: e.source.file, hash: e.oldEntryHash },
        block: { id: e.newBlockId, raw: blockRaw },
      });
    }
    // Reuse only exported real tags. The production read/sanitize/prepare path
    // validates them; absent tags trigger real tagOne, never synthetic tags.
    sidecars[project] = { files: { index: oldIndex }, blocks: { index: plan.sidecar } };
  }
  const history = [];
  for (const e of raw.entries.filter((entry) => includeHistory && entry.origin === "backup")) {
    const source = raw.historyFiles?.find(
      (f) =>
        f.slug === e.source.slug &&
        f.snapshot === e.snapshot &&
        f.file === e.source.file &&
        f.sha256 === e.source.fileSha256,
    );
    check(source && digest(source.raw) === source.sha256, "history raw/source hash unavailable");
    const index = { v: 1, entries: e.oldTags && e.oldEntryHash ? { [e.oldEntryHash]: e.oldTags } : {} };
    const plan = planner.planMigration(
      [
        {
          name: source.file,
          raw: source.raw,
          sha256: source.sha256,
          size: source.bytes,
          mtimeMs: Date.parse(e.updatedAt),
        },
      ],
      index,
      raw.generatedAt.slice(0, 10),
    );
    const candidates = plan.blocks
      .map((b) => ({ raw: b.content, parsed: blockApi.parseBlockFile(b.name, b.content) }))
      .filter(
        (b) =>
          !("stray" in b.parsed) &&
          b.parsed.body === e.text &&
          b.parsed.meta.authority === e.authority &&
          (b.parsed.meta.scope ?? null) === e.scope,
      );
    check(candidates.length === 1, "history production block not uniquely recoverable");
    const found = candidates[0];
    check(
      found.parsed.meta.created === e.createdAt &&
        found.parsed.meta.updated === e.updatedAt &&
        !!found.parsed.meta.residue === !!e.residue &&
        !found.parsed.meta.private,
      "history metadata differs from source evidence",
    );
    history.push({
      ...e,
      project: e.source.slug,
      old: { file: e.source.file, hash: e.oldEntryHash },
      block: { id: e.newBlockId, raw: found.raw },
    });
  }
  return { ...corpusAdapter({ ...raw, at: raw.generatedAt, entries, files, sidecars }), history };
}
/** Source attribution is checked locally, never sent to any model. */
export function verifyTurnSources(
  labels,
  sessionsRoot = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"),
    "sessions",
    `--${ROOT.replace(/^\//, "").replace(/\//g, "-")}--`,
  ),
  redact,
) {
  const files = new Map();
  const sources = new Set();
  const prompts = new Map();
  for (const row of labels) {
    const path = resolve(sessionsRoot, row.source.sessionFile.replace(/^~(?=\/)/, homedir()));
    check(path.startsWith(resolve(sessionsRoot) + "/"), "turn outside real sessions root");
    const sourceKey = `${path}:${row.source.line}`;
    check(!sources.has(sourceKey), "duplicate real user turn");
    sources.add(sourceKey);
    let lines = files.get(path);
    if (!lines) {
      lines = readFileSync(path, "utf8").split(/\r?\n/);
      files.set(path, lines);
    }
    const event = JSON.parse(lines[row.source.line - 1]);
    check(event.type === "message" && event.message?.role === "user", "source is not a real user message");
    const content = event.message.content;
    const prompt =
      typeof content === "string"
        ? content
        : content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    check(
      prompt.trim() === row.prompt.trim() || (redact && redact(prompt, "user") === row.prompt),
      "label prompt differs from real user turn",
    );
    prompts.set(row.turnId, prompt);
  }
  return prompts;
}
function writePrivate(path, data) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
async function snapshots(p, raw, dir, project, blocks, blockApi) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const items = raw.entries.filter((e) => e.project === project);
  if (blocks) {
    mkdirSync(join(dir, "blocks"), { mode: 0o700 });
    writePrivate(join(dir, "blocks/.layout.json"), { v: 1 });
    for (const e of items) {
      const parsed = blockApi.parseBlockFile(`${e.block.id}.md`, e.block.raw);
      check(
        !("stray" in parsed) &&
          !parsed.meta.private &&
          !p.looksSecret(parsed.body) &&
          (!parsed.meta.heading || p.redactForJev(parsed.meta.heading, "entry") === parsed.meta.heading),
        "unsafe/malformed block snapshot",
      );
      writeFileSync(join(dir, "blocks", `${e.block.id}.md`), e.block.raw, { mode: 0o600 });
    }
  } else {
    const files = raw.files.filter((f) => f.project === project);
    check(files.length > 0, "missing old files");
    for (const f of files) writeFileSync(join(dir, safeName(f.name)), f.raw, { mode: 0o600 });
  }
  const indexed = new p.EntryIndex().get(dir);
  check(
    indexed.length > 0 && indexed.every((e) => !e.secret && !e.inline.isPrivate),
    "private/secret in snapshot or empty snapshot",
  );
  const map = new Map();
  for (const item of items) {
    if (!blocks && !item.old.hash && item.whole) continue;
    const entry = indexed.find((e) =>
      blocks ? e.block?.id === item.block.id : e.file === item.old.file && e.hash === item.old.hash,
    );
    check(entry !== undefined, "corpus hash/id not found in production snapshot");
    map.set(item.id, entry);
  }
  const sidecar = blocks ? raw.sidecars?.[project]?.blocks : raw.sidecars?.[project]?.files;
  if (sidecar) {
    const base = blocks ? join(dir, "blocks") : dir;
    if (sidecar.taxonomy) writePrivate(join(base, ".jev/taxonomy.json"), sidecar.taxonomy);
    if (sidecar.index) writePrivate(join(base, ".jev/index.json"), sidecar.index);
  }
  return { items, map, indexed };
}
function classifierCatalog(dir, classifiers, runtime, live) {
  const path = join(dir, `classifier-models-${digest(classifiers)}.json`);
  if (existsSync(path)) {
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    check(
      Array.isArray(catalog) &&
        catalog.length === classifiers.length &&
        catalog.every((m, i) => `${m.provider}/${m.id}` === classifiers[i] && text(m.semanticHash)),
      "invalid classifier catalog",
    );
    if (live && runtime)
      for (const m of catalog) {
        const actual = runtime.getModelOfType("classifier", m.provider, m.id);
        check(actual && digest(actual) === m.semanticHash, "NOT-EVALUATED: classifier catalog changed");
      }
    return catalog;
  }
  check(
    live && process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE === "1" && runtime,
    "NOT-EVALUATED: classifier catalog absent",
  );
  const catalog = classifiers.map((spec) => {
    const slash = spec.indexOf("/");
    const m = runtime.getModelOfType("classifier", spec.slice(0, slash), spec.slice(slash + 1));
    check(m, "classifier not in local catalog");
    return { provider: m.provider, id: m.id, semanticHash: digest(m), contextWindow: m.contextWindow, cost: m.cost };
  });
  writePrivate(path, catalog);
  return catalog;
}
export function registryFor(cache, models, chat) {
  const hardFailures = [];
  const guarded = async (work) => {
    try {
      return await work();
    } catch (err) {
      const category = classifyErrorCategory(err);
      if (
        [
          "classifier-budget",
          "chat-budget",
          "deadline-abort",
          "audit-write",
          "cache-missing",
          "cache-corrupt",
        ].includes(category)
      )
        hardFailures.push(category);
      throw err;
    }
  };
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  return {
    hardFailures: () => [...hardFailures],
    getAvailableOfType: async () => models,
    getModelOfType: (_type, provider, id) => models.find((m) => m.provider === provider && m.id === id),
    classify: (...args) => track(guarded(() => cache.classify(...args))),
    ...(chat
      ? {
          find: chat.find,
          streamSimple: (...args) => ({ result: () => track(guarded(() => chat.streamSimple(...args).result())) }),
        }
      : {}),
    async drain() {
      // Classifier settle queues production askAll/commit continuations. Drain
      // those microtasks too; no new predictions are manufactured here.
      do {
        await Promise.allSettled([...pending]);
        await new Promise((done) => setImmediate(done));
      } while (pending.size);
    },
  };
}
export function clientFor(p, config) {
  return p.createJevClient({
    config,
    isChild: false,
    now: Date.now,
    health: new Map(),
    bucket: p.createTokenBucket(),
    log: () => {},
  });
}
/** Thin turn-local view: retain the production client's lastModel and sticky
 * budget, but own every wire subscription and every FINAL ask outcome. Registry
 * always comes from this call's request, never a cached session context. */
export function turnClient(client, identity, observations) {
  const outcomes = [],
    subscriptions = new Set();
  let callseq = 0;
  const initialUsage = client.usage();
  const proxy = {
    ...client,
    onStatusChange(cb) {
      const off = client.onStatusChange(cb);
      subscriptions.add(off);
      return () => {
        subscriptions.delete(off);
        off();
      };
    },
    async ask(req) {
      const record = {
        ...identity,
        duty: req.duty,
        callseq: ++callseq,
        requestedIds: Object.keys(req.questions),
        answeredIds: [],
        ok: false,
        reason: "pending",
        resolved: false,
      };
      outcomes.push(record);
      const observation = observations ? { callseq: record.callseq, req, outcome: undefined } : undefined;
      if (observation) observations.push(observation);
      try {
        const outcome = await client.ask(req);
        if (observation) observation.outcome = outcome;
        record.ok = outcome.ok;
        record.answeredIds = Object.keys(outcome.answers ?? {});
        let valid = false;
        if (outcome.ok && outcome.missing?.length === 0) {
          try {
            validateAnswers(req.questions, { stopReason: "stop", answers: outcome.answers });
            valid = true;
          } catch {
            /* unresolved, never negative */
          }
        }
        record.resolved = valid;
        record.reason = valid ? "resolved" : outcome.ok ? "missing-or-invalid" : outcome.reason;
        return outcome;
      } finally {
        if (record.reason === "pending") record.reason = "exception";
      }
    },
  };
  return {
    client: proxy,
    outcomes,
    subscriptions: () => subscriptions.size,
    close() {
      for (const off of subscriptions) off();
      subscriptions.clear();
    },
    usage() {
      const u = client.usage();
      return {
        calls: u.calls - initialUsage.calls,
        costUsd: u.costUsd - initialUsage.costUsd,
        cumulative: u,
        usageEstimated: true,
        provenance: "production-client SDK usage.cost.total; actual unknown",
      };
    },
  };
}
/** Exclusive per-attempt, per-sample files: no old run or summary is replaced. */
export function persistTurnSummary(dir, identity, summary) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${digest(identity)}.json`);
  try {
    writeFileSync(path, JSON.stringify({ ...identity, ...summary }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("NOT-EVALUATED: pre-transport audit write failed");
  }
  return path;
}
export function logicalComplete(outcomes) {
  return outcomes.every((o) => o.resolved === true);
}
/** P2 terminal errors/timeouts are production's completed rule fallback. An
 * aborted/nonterminal flight or a budget/audit/cache denial is NOT evaluated.
 * With runTurn's model-binding/upper-bound budget precheck and a fresh flight,
 * no dispatch can be an ordinary certain-rule/prompt gate, not a fake hit. */
export function p2Completion(calls, dispatched, hardFailures = []) {
  return (
    hardFailures.length === 0 &&
    (dispatched === 0 ? calls.length === 0 : calls.length > 0) &&
    calls.every((c) => c.ok === true || ["failed", "timeout"].includes(c.reason))
  );
}
async function prepareTags(p, dir, client, registry, signal) {
  const index = p.readIndex(dir).index;
  const merged = p.mergeTaxonomy(p.readTaxonomyFile(dir));
  check(merged.ok, "invalid taxonomy");
  for (const e of new p.EntryIndex().get(dir)) {
    if (index.entries[e.hash]) continue;
    const result = await p.tagOne({
      client,
      registry,
      entry: e,
      taxonomy: merged.taxonomy,
      compare: [],
      mode: "sync",
      signal,
    });
    check(result.tags, "NOT-EVALUATED: missing production entry tags");
    await p.writeIndexPatch(dir, { upsert: { [e.hash]: result.tags } });
  }
}
/** Historical b is added alone to its own project's CURRENT context. ID
 * reassignment is harness identity, not evidence of real-world coexistence. */
export function relationContext(corpus, next, old, blockApi) {
  check(next.project === old.project && next.origin !== "backup", "invalid historical relation direction");
  const current = corpus.entries.filter((e) => e.project === next.project);
  if (old.origin !== "backup") return { corpus: { ...corpus, entries: current }, mapping: [] };
  const parsed = blockApi.parseBlockFile(`${old.block.id}.md`, old.block.raw);
  check(!("stray" in parsed), "invalid history block");
  const used = current.map((e) => `${e.block.id}.md`);
  let evalId = old.block.id;
  if (used.includes(`${evalId}.md`)) {
    const seq = blockApi.nextSeq(parsed.topic, used);
    evalId = `${parsed.topic}.${String(seq).padStart(3, "0")}`;
    check(blockApi.parseBlockName(`${evalId}.md`), "historical seq exhausted");
  }
  const mapped = { ...old, block: { ...old.block, id: evalId } };
  // Filename identity changes only; the serialized production metadata/body
  // is byte-identical and still parsed by the production reader.
  const mapping = [
    {
      labelId: old.id,
      sourceBlockId: old.block.id,
      evalBlockId: evalId,
      sourceHash: old.source.fileSha256,
      snapshot: old.snapshot,
      snapshotAt: old.snapshotAt,
    },
  ];
  const sidecars = structuredClone(corpus.sidecars);
  if (old.newTags) {
    const hash = old.old.hash;
    check(text(hash), "missing history hash");
    sidecars[old.project].blocks.index.entries[hash] = { ...old.newTags, file: `${evalId}.md` };
  }
  return { corpus: { ...corpus, entries: [...current, mapped], sidecars }, mapping };
}
async function runG1({
  p,
  corpus,
  labels,
  scratch,
  registry,
  config,
  signal,
  blockApi,
  governance,
  summaryDir,
  evalId,
}) {
  const runs = [];
  const sharedClient = clientFor(p, config);
  await sharedClient.probe(registry, signal);
  for (const row of labels) {
    check(!signal.aborted, "NOT-EVALUATED: run deadline");
    const next = corpus.entries.find((e) => e.id === row.a),
      old = [...corpus.entries, ...(corpus.history ?? [])].find((e) => e.id === row.b);
    check(next && old && next.project === old.project, "cross-project relation pair");
    const context = relationContext(corpus, next, old, blockApi);
    const dir = mkdtempSync(join(scratch, "g1-"));
    const snap = await snapshots(p, context.corpus, dir, next.project, true, blockApi);
    const a = snap.map.get(row.a),
      b = snap.map.get(row.b);
    const cls = a.authority === b.authority ? `${a.authority}-${b.authority}` : "user-agent";
    check(row.pairClass === cls, "pairClass does not match production authority");
    const identity = { evalId, sampleId: row.id, turn: runs.length + 1, variant: "new" };
    const scoped = turnClient(sharedClient, identity);
    const client = scoped.client;
    let completed = false;
    try {
      const taxonomy = p.mergeTaxonomy(p.readTaxonomyFile(dir));
      check(taxonomy.ok, "invalid taxonomy");
      const port = p.createJevWritePort({
        client,
        entryIndex: new p.EntryIndex(),
        dirFor: () => dir,
        taxonomyFor: () => taxonomy.taxonomy,
        now: Date.now,
      });
      const parsed = blockApi.parseBlockFile(`${next.block.id}.md`, next.block.raw);
      const result = await port.afterWrite({
        cwd: dir,
        wholeRelation: true,
        file: `${next.block.id}.md`,
        before: undefined,
        after: next.block.raw,
        registry,
        signal,
        block: { id: parsed.id, rev: parsed.rev, authority: parsed.meta.authority, scopeExplicit: true },
      });
      check(
        scoped.outcomes.length > 0 && logicalComplete(scoped.outcomes) && registry.hardFailures().length === 0,
        "NOT-EVALUATED: relation classification unavailable",
      );
      // Includes the real pool, matrix, per-write cap, rev/CAS/active/residue
      // checks. Writes ONLY to the disposable evaluation snapshot.
      const executed = await governance.supersede(dir, result.relations ?? [], { signal });
      runs.push({
        id: row.id,
        wouldAuto: executed.some((r) => r.oldId === b.block.id && r.outcome === "superseded"),
        verdicts: result.relations ?? [],
        executed,
        identityMapping: context.mapping,
      });
      completed = true;
    } finally {
      client.abortBackground();
      scoped.close();
      try {
        persistTurnSummary(summaryDir, identity, {
          complete: completed,
          closedReason: completed ? "resolved" : "not-evaluated",
          logicalOutcomes: scoped.outcomes,
          usage: scoped.usage(),
          result: runs.find((r) => r.id === row.id) ?? null,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return runs;
}
/** runTurn's clock port. BOTH pinned production versions require the full
 * Clock contract (`now`/`setTimer`/`clearTimer` — each dist's own
 * `core/clock.js`); the raw timer shape is only `createSegmentedClock`'s
 * INPUT. The 2026-11-06 G2 live run passed `{now,set,clear}` straight through
 * and baseline `predict/flight.js:242` threw
 * `TypeError: clock.setTimer is not a function` before any turn completed.
 * Conversion therefore goes through EACH VERSION'S OWN production
 * `createSegmentedClock` (imported from its dist), never a hand-rolled
 * rename; raw timers stay unref'd (I5). Real wall time — a frozen `now` base
 * would re-arm segmented timers forever without ever firing, neutering P2
 * deadlines. The pinned evaluation instant stays on `deps.now`.
 * Static audit of every clock/timer injection into production entry points:
 * wireJev `clock` (here), createJevClient `now` + createJevWritePort `now`
 * (plain `() => number` functions — no Clock contract), PredictCache and the
 * P2 flight clock are built inside production wire from these deps. */
export function productionClockPort(clockModule) {
  check(typeof clockModule?.createSegmentedClock === "function", "production createSegmentedClock missing");
  return clockModule.createSegmentedClock({
    now: () => Date.now(),
    set: (ms, fn) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clear: (t) => clearTimeout(t),
  });
}
export async function runTurn({
  p,
  dir,
  prompt,
  previousPrompt,
  registry,
  client: sharedClient,
  config,
  settings,
  now,
  signal,
  ledger,
  identity,
  summaryDir,
  entryIds = [],
  relevantIds = [],
  auditEntries,
  cacheLookups,
}) {
  const lookupStart = cacheLookups?.length ?? 0;
  const observedCalls = auditEntries ? [] : undefined;
  const observedChat = auditEntries ? [] : undefined;
  const scoped = turnClient(sharedClient, identity, observedCalls);
  const client = scoped.client;
  let complete = false,
    closedReason = "not-evaluated",
    hashes = new Set();
  let p2Dispatched = 0;
  const turnRegistry = {
    ...registry,
    streamSimple: (...args) => {
      p2Dispatched++;
      if (observedChat) observedChat.push(args[1]);
      return registry.streamSimple(...args);
    },
  };
  const ledgerKey = Symbol.for("pi-subagent:memory-predict-ledger");
  const savedLedger = globalThis[ledgerKey];
  globalThis[ledgerKey] = ledger;
  const handlers = new Map(),
    branch = [],
    messages = [],
    logs = [];
  const pi = {
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerMessageRenderer() {},
    sendMessage(message) {
      messages.push(message);
      branch.push({ type: "custom_message", id: `m${branch.length}`, ...message });
    },
    appendEntry(customType, data) {
      branch.push({ type: "custom", id: `c${branch.length}`, customType, data });
    },
  };
  if (previousPrompt) branch.push({ type: "message", id: "prev", message: { role: "user", content: previousPrompt } });
  branch.push({ type: "message", id: "user", message: { role: "user", content: prompt } });
  // The shared client was probed once. Do NOT run session_start's async auto-tag/review:
  // snapshot tags were prepared above, and only real before_agent_start is
  // under evaluation. Fresh activation/segment per independently labelled turn.
  let renderInfo;
  let observedBudgetStats;
  let rendered;
  let renderRoot;
  const oldMemoryRoot = process.env.ARMORY_MEMORY_ROOT;
  let ctx;
  try {
    const status = client.status();
    check(!(status.kind === "partial" && status.reason === "budget"), "NOT-EVALUATED: classifier call budget/abort");
    const modelBudget = config.predict?.model;
    if (modelBudget) {
      // Exclude budget-related silent admit(false), WITHOUT replaying the
      // production uncertain/rules decision. Public producer/estimator only:
      // serialized DTO <= byte cap, ASCII cap bytes upper-bounds its estimate.
      const taxonomy = p.mergeTaxonomy(p.readTaxonomyFile(dir));
      check(taxonomy.ok, "NOT-EVALUATED: invalid taxonomy");
      const system = p.buildPredictSystemPrompt(taxonomy.taxonomy.tags);
      const userBound = "x".repeat(p.OUTBOUND_MAX_TOTAL_BYTES);
      check(modelBudget.models.length > 0, "NOT-EVALUATED: chat model unavailable");
      const reserves = modelBudget.models.map((spec) => {
        const slash = spec.indexOf("/");
        const model = slash > 0 ? registry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
        check(model, "NOT-EVALUATED: chat model unavailable");
        const cost = model.cost;
        check(
          cost && [cost.input, cost.cacheRead, cost.output].every((v) => Number.isFinite(v) && v >= 0),
          "NOT-EVALUATED: chat model price unavailable",
        );
        const reserve = p.estimatePredictUsd(system, userBound, {
          inputPerM: cost.input,
          cacheReadPerM: cost.cacheRead,
          outputPerM: cost.output,
        });
        check(Number.isFinite(reserve) && reserve >= 0, "NOT-EVALUATED: chat model price unavailable");
        return reserve;
      });
      const bound = Math.max(...reserves);
      // Same wall-clock local calendar day as productionClockPort/flight.
      const today = new Date();
      const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const used = ledger.get(day) ?? { calls: 0, spent: 0, reserved: 0 };
      check(
        modelBudget.maxCallsPerDay > 0 &&
          modelBudget.maxUsdPerDay > 0 &&
          used.calls < modelBudget.maxCallsPerDay &&
          modelBudget.maxUsdPerDay - used.spent - used.reserved >= bound,
        "NOT-EVALUATED: chat budget",
      );
    }
    p.wireJev(pi, {
      config,
      settings,
      client,
      isChildSession: false,
      dirFor: () => dir,
      getRenderInfo: () => renderInfo,
      getSectionSnapshot: () => ({ snapshot: rendered, stale: false }),
      onAfterWriteHook() {},
      now: () => now,
      clock: productionClockPort(p),
      log: () => logs.push("wire error"),
    });
    ctx = {
      cwd: dir,
      hasUI: false,
      modelRegistry: turnRegistry,
      sessionManager: { getBranch: () => branch, getSessionId: () => "pg-eval" },
    };
    renderRoot = mkdtempSync(join(tmpdir(), "memory36-render-"));
    symlinkSync(dir, join(renderRoot, p.toSlug(dir)), "dir");
    process.env.ARMORY_MEMORY_ROOT = renderRoot;
    const section = p.memorySection({
      settings,
      isChildSession: false,
      cache: new p.RenderCache(),
      frozenBlocks: new Map(),
      getActiveTools: () => ["memory", "read"],
      stripInlineMeta: true,
      onRender: (_cwd, _block, info, _resident, budgetStats) => {
        renderInfo = info;
        if (auditEntries) observedBudgetStats = budgetStats;
      },
    });
    rendered = section.provider({ ctx, promptText: "", optionsCwd: dir });
    check(typeof rendered === "string", "NOT-EVALUATED: memory renderer skipped");
    for (const fn of handlers.get("before_agent_start") ?? []) {
      const r = await fn({ type: "before_agent_start", messageType: "user", prompt }, ctx);
      if (r?.message) messages.push(r.message);
    }
    await registry.drain();
    check(!logs.length && !signal.aborted, "NOT-EVALUATED: wire error/abort");
    hashes = new Set();
    for (const m of messages) {
      const d = m.details;
      const parts = d?.parts ?? [d];
      for (const part of parts)
        if (["U", "P"].includes(part?.layer)) for (const item of part.items ?? []) hashes.add(item.hash);
    }
    const p2 = branch.filter((e) => e.type === "custom" && e.data?.kind === "call").map((e) => e.data);
    check(
      logicalComplete(scoped.outcomes) && p2Completion(p2, p2Dispatched, registry.hardFailures()),
      "NOT-EVALUATED: unresolved logical outcome",
    );
    complete = true;
    closedReason = "resolved";
    return hashes;
  } catch (err) {
    closedReason = classifyErrorCategory(err);
    throw err;
  } finally {
    // Drain BEFORE shutdown, including late 1.5–3s replies; never shorten the
    // production validity window to the initial UI wait. Shutdown is retained.
    try {
      for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
    } catch (err) {
      complete = false;
      closedReason = classifyErrorCategory(err);
      throw err;
    } finally {
      client.abortBackground();
      scoped.close();
      globalThis[ledgerKey] = savedLedger;
      if (oldMemoryRoot === undefined) delete process.env.ARMORY_MEMORY_ROOT;
      else process.env.ARMORY_MEMORY_ROOT = oldMemoryRoot;
      if (renderRoot) rmSync(renderRoot, { recursive: true, force: true });
      persistTurnSummary(summaryDir, identity, {
        complete,
        closedReason,
        hashes: [...hashes],
        deliveredIds: complete ? entryIds.filter(([hash]) => hashes.has(hash)).map(([, id]) => id) : null,
        hits: complete
          ? entryIds.filter(([hash, id]) => hashes.has(hash) && relevantIds.includes(id)).map(([, id]) => id)
          : null,
        logicalOutcomes: scoped.outcomes,
        usage: scoped.usage(),
        p2: { dispatched: p2Dispatched, calls: branch.filter((e) => e.data?.kind === "call").map((e) => e.data) },
        hardFailures: registry.hardFailures(),
        subscriptions: scoped.subscriptions(),
      });
      if (auditEntries) {
        try {
          persistTurnSummary(`${summaryDir}-candidate-audit`, identity, {
            diagnostic: candidateAudit({
              entries: auditEntries,
              calls: observedCalls,
              redact: p.redactForJev,
              renderInfo,
              budgetStats: observedBudgetStats,
              settings,
              config,
              outboundLimit: p.OUTBOUND_MAX_TOTAL_BYTES,
              chat: observedChat,
              messages,
              cacheLookups: cacheLookups?.slice(lookupStart) ?? [],
              contextHash: digest,
              rendered,
              prompt,
            }),
          });
        } catch {
          // Observability must not change the gate's result or disclose data.
          console.error("candidate audit unavailable");
        }
      }
    }
  }
}
async function runG2({
  p,
  oldP,
  corpus,
  labels,
  prompts,
  scratch,
  registry,
  config,
  settings,
  signal,
  blockApi,
  now,
  summaryDir,
  evalId,
  candidateAuditEnabled,
  cacheLookups,
  recallTopK,
  recallThreshold,
}) {
  const runs = [];
  const newConfig = withRecallThreshold(withRecallTopK(config, recallTopK), recallThreshold);
  const clients = { old: clientFor(oldP, config), new: clientFor(p, newConfig) };
  await clients.old.probe(registry, signal);
  await clients.new.probe(registry, signal);
  const ledgers = { old: new Map(), new: new Map() };
  const prepared = new Map();
  for (const row of labels) {
    const relevant = row.relevantIds.map((id) => corpus.entries.find((e) => e.id === id));
    const project = relevant[0].project;
    check(
      relevant.every((e) => e.project === project),
      "mixed-project G2 turn",
    );
    const pair = {};
    for (const [name, api, blocks] of [
      ["old", oldP, false],
      ["new", p, true],
    ]) {
      const key = `${project}-${name}`;
      let prep = prepared.get(key);
      if (!prep) {
        const dir = mkdtempSync(join(scratch, `prepared-${key}-`));
        const snap = await snapshots(api, corpus, dir, project, blocks, blockApi);
        const scoped = turnClient(clients[name], { evalId, sampleId: `prepare-${key}`, turn: 0, variant: name });
        try {
          await prepareTags(api, dir, scoped.client, registry, signal);
          check(logicalComplete(scoped.outcomes), "NOT-EVALUATED: missing production entry tags");
        } finally {
          scoped.close();
          clients[name].abortBackground();
          persistTurnSummary(
            summaryDir,
            { evalId, sampleId: `prepare-${key}`, variant: name },
            { logicalOutcomes: scoped.outcomes, usage: scoped.usage() },
          );
        }
        prep = { dir, snap };
        prepared.set(key, prep);
      }
      if (blocks)
        for (const item of relevant) {
          const entry = prep.snap.map.get(item.id);
          check(entry?.authority === "user" && entry.block.scope === "topic", "G2 gold is not a topic user rule");
        }
      const dir = mkdtempSync(join(scratch, `g2-${name}-`));
      cpSync(prep.dir, dir, { recursive: true });
      try {
        const hashes = await runTurn({
          p: api,
          client: clients[name],
          identity: { evalId, sampleId: row.turnId, turn: runs.length + 1, variant: name },
          summaryDir,
          entryIds: [...prep.snap.map].map(([id, e]) => [e.hash, id]),
          relevantIds: row.relevantIds,
          ...(candidateAuditEnabled
            ? {
                auditEntries: [...prep.snap.map].map(([id, entry]) => {
                  const item = prep.snap.items.find((value) => value.id === id);
                  const parsed =
                    blocks && item ? blockApi.parseBlockFile(`${item.block.id}.md`, item.block.raw) : undefined;
                  return { id, entry, rev: parsed && !("stray" in parsed) ? parsed.rev : undefined };
                }),
              }
            : {}),
          dir,
          prompt: prompts.get(row.turnId) ?? row.prompt,
          previousPrompt: row.previousPrompt,
          registry,
          config: blocks ? newConfig : config,
          cacheLookups,
          settings: { ...settings, layout: blocks ? "blocks" : "tiered" },
          now,
          signal,
          ledger: ledgers[name],
        });
        pair[`${name}Ids`] = [...prep.snap.map].filter(([, e]) => hashes.has(e.hash)).map(([id]) => id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    runs.push({ turnId: row.turnId, ...pair });
  }
  return runs;
}
function treeHash(dir) {
  const files = [];
  const walk = (base, prefix = "") => {
    for (const ent of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) walk(join(base, ent.name), `${prefix}${ent.name}/`);
      else if (ent.isFile() && ent.name.endsWith(".js"))
        files.push([`${prefix}${ent.name}`, digest(readFileSync(join(base, ent.name), "utf8"))]);
    }
  };
  walk(dir);
  return digest(files);
}
async function liveRuntime(signal) {
  // Only reached AFTER the env gate; read-only credentials, no refresh/login,
  // no catalog network, existing pi configuration and installed dependencies.
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
  const { ReadOnlyAuthStorage } = await import(
    pathToFileURL(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href
  );
  const runtime = await ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(join(agentDir, "auth.json")),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
  return runtime;
}
export function classifierTransport(runtime, deadlineMs, maxUsd, audit) {
  let reserved = 0;
  let invocations = 0;
  check(Number.isFinite(maxUsd) && maxUsd > 0, "invalid classifier USD budget");
  return async (model, context, options) => {
    const actual = runtime.getModelOfType("classifier", model.provider, model.id);
    check(actual, "configured classifier unavailable");
    check(
      actual.cost &&
        [actual.cost.input, actual.cost.output].every((v) => Number.isFinite(v) && v >= 0) &&
        Number.isFinite(actual.contextWindow) &&
        actual.contextWindow > 0,
      "NOT-EVALUATED: classifier price/context absent",
    );
    // System One does not expose an output-token setting. Reserve a FULL
    // catalog context window on BOTH sides, never guess zero for no usage.
    const reserve = (actual.contextWindow * (actual.cost.input + actual.cost.output)) / 1e6;
    check(reserved + reserve <= maxUsd, "NOT-EVALUATED: classifier USD cap");
    reserved += reserve;
    // The reserve is kept conservative even when the pre-transport audit
    // write fails; the attempted-call counter only advances past a durable
    // audit record, and the failure propagates BEFORE the transport fires.
    const attempted = invocations + 1;
    try {
      audit?.noteTransport("classifier", attempted, reserved);
    } catch {
      throw new Error("NOT-EVALUATED: pre-transport audit write failed");
    }
    invocations = attempted;
    return bounded(
      (s) => runtime.classify(actual, context, { ...options, maxRetries: 0, signal: s }),
      deadlineMs,
      options.signal,
    );
  };
}
/** Abort plus race: an ignoring provider cannot extend the script lifetime. */
export async function bounded(work, ms, outer) {
  const controller = new AbortController();
  let timer;
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  try {
    return await Promise.race([
      (() => {
        check(!signal.aborted, "NOT-EVALUATED: aborted");
        return work(signal);
      })(),
      new Promise((_, reject) => {
        const abort = () => reject(new Error("NOT-EVALUATED: deadline/abort"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(() => {
          controller.abort();
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
/** CLOSED audit error categories — the ONLY strings the audit ever records.
 * Known failures map from THIS FILE's own controlled `NOT-EVALUATED:` codes
 * (and the clock-port TypeError signature) to constant names; everything
 * else — arbitrary Error.name/message/code, stack traces, provider bodies,
 * echoed secrets — maps to a fixed "unclassified". Because no free text is
 * ever concatenated into the audit, no scrubbing/truncation heuristic is
 * needed or claimed. */
export const AUDIT_ERROR_CATEGORIES = Object.freeze([
  "unclassified",
  "unhandled-rejection",
  "clock-port",
  "dataset",
  "dist-provenance",
  "invalid-input",
  "cache-missing",
  "cache-corrupt",
  "classifier-unavailable",
  "classifier-budget",
  "classifier-failed",
  "chat-catalog",
  "chat-budget",
  "chat-failed",
  "deadline-abort",
  "audit-write",
]);
export function classifyErrorCategory(err) {
  const message = err && typeof err.message === "string" ? err.message : "";
  if (message.startsWith("NOT-EVALUATED: ")) {
    const tail = message.slice("NOT-EVALUATED: ".length);
    if (tail.startsWith("uncached classifier request") || tail.startsWith("uncached chat DTO")) return "cache-missing";
    if (tail.startsWith("classifier call budget") || tail.startsWith("classifier USD cap")) return "classifier-budget";
    if (tail.startsWith("classifier failed")) return "classifier-failed";
    if (tail.startsWith("classifier price/context absent") || tail.startsWith("configured classifier unavailable"))
      return "classifier-unavailable";
    if (tail.startsWith("chat catalog")) return "chat-catalog";
    if (tail.startsWith("chat budget")) return "chat-budget";
    if (tail.startsWith("chat failed")) return "chat-failed";
    if (tail.startsWith("deadline/abort") || tail.startsWith("aborted") || tail.startsWith("run deadline"))
      return "deadline-abort";
    if (tail.startsWith("pre-transport audit write failed")) return "audit-write";
    if (tail.startsWith("dataset freeze hash mismatch")) return "dataset";
    if (tail.startsWith("baseline provenance mismatch") || tail.startsWith("current snapshot provenance mismatch"))
      return "dist-provenance";
    if (tail.startsWith("invalid arguments") || tail.startsWith("invalid run budgets")) return "invalid-input";
    return "unclassified";
  }
  // Constant-only output: matching the message can never leak it.
  if (err instanceof TypeError && /clock|setTimer|clearTimer/i.test(message)) return "clock-port";
  if (
    message.startsWith("cache fingerprint mismatch") ||
    message.startsWith("chat cache fingerprint mismatch") ||
    message.startsWith("invalid chat cache") ||
    message.startsWith("cache lacks measured latency")
  )
    return "cache-corrupt";
  return "unclassified";
}
/** Private per-attempt run audit state under `<data>/audit/` (0700 dirs,
 * 0600 files). ONE UNIQUE FILE PER ATTEMPT: a retry or an offline replay in
 * the same data dir gets its own file and can never overwrite a previous
 * (e.g. live) attempt's evidence — creation uses "wx" so even a colliding
 * attempt id fails closed instead of clobbering. The same attempt updates
 * its own file atomically (tmp + rename), written synchronously at run start
 * and BEFORE any transport initiation, so even a SIGKILL mid-request leaves
 * conservative reserve/call counts on disk; every exit path finalizes with
 * status, finishedAt, budget and cache summaries. Only closed error
 * categories are stored — never prompts, keys or provider error bodies. */
export function createAuditState({ dir, mode, budgets, cacheProvenance, attemptId }) {
  check(text(dir) && text(mode), "invalid audit state target");
  check(budgets && typeof budgets === "object", "audit budgets required");
  const id =
    attemptId ??
    `${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}-${process.pid}-${randomBytes(4).toString("hex")}`;
  check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id), "unsafe audit attempt id");
  const auditDir = join(dir, "audit");
  const path = join(auditDir, `attempt-${id}.json`);
  const state = {
    v: 1,
    attempt: id,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    budgets,
    ...(cacheProvenance ? { cacheProvenance } : {}),
    cost: { classifier: { calls: 0, reservedUsd: 0 }, chat: { calls: 0, reservedUsd: 0 } },
    error: null,
  };
  const persist = (next, initial) => {
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(next, null, 2)}\n`;
    if (initial) writeFileSync(path, body, { mode: 0o600, flag: "wx" });
    else {
      // Atomic same-attempt update: readers never see a torn file; a crash
      // mid-write leaves the previous complete record plus an inert .tmp.
      const tmp = join(auditDir, `.attempt-${id}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, path);
    }
    // Commit in memory only AFTER the write succeeded: a failed write leaves
    // the last durable record as the truth (no in-memory inflation can leak
    // into a later transient-success finalize).
    Object.assign(state, next);
  };
  persist(state, true);
  return {
    attemptId: id,
    file: `audit/attempt-${id}.json`,
    path,
    noteTransport(scope, calls, reservedUsd) {
      check(scope === "classifier" || scope === "chat", "unknown transport scope");
      persist({
        ...state,
        cost: { ...state.cost, [scope]: { calls, reservedUsd } },
      });
    },
    finish({ status, errorCategory, cache, chat } = {}) {
      check(text(status), "audit status required");
      check(!errorCategory || AUDIT_ERROR_CATEGORIES.includes(errorCategory), "unknown audit error category");
      persist({
        ...state,
        status,
        finishedAt: new Date().toISOString(),
        ...(cache ? { cache } : {}),
        ...(chat ? { chat } : {}),
        ...(errorCategory ? { error: errorCategory } : {}),
      });
    },
  };
}
/** Formal G2 needs REAL P2 evidence, not a rule-path stand-in: actual chat
 * calls or cache hits must exceed zero AND no cache entry may be missing or
 * failed. Otherwise the run is NOT-EVALUATED — never a fake PASS. */
export function g2P2Evidence(chatStats, cacheStats, completion) {
  const calls = chatStats?.calls ?? 0;
  const hits = chatStats?.hits ?? 0;
  const missing = (cacheStats?.missing ?? 0) + (chatStats?.missing ?? 0);
  const failures = (cacheStats?.failures ?? 0) + (chatStats?.failures ?? 0);
  return {
    calls,
    hits,
    missing,
    failures,
    satisfied:
      calls + hits > 0 &&
      (completion === undefined
        ? missing === 0 && failures === 0
        : completion.complete && completion.hardFailures.length === 0),
    requirement:
      "P2 actual calls+hits > 0; complete logical outcomes and terminal P2, no sticky controlled denial (raw failures are telemetry)",
  };
}
/** Sticky fatal-rejection latch, local to ONE main() activation (no module
 * state). Once tripped by an unhandled rejection the attempt can never report
 * PASS: the final gate status is forced to NOT-EVALUATED, later finalize
 * calls keep the closed `unhandled-rejection` category, and the exit code is
 * forced to 2 — even when the gate metrics themselves computed PASS and even
 * if the CLI `.then(code)` mapping runs afterwards. Aborting stops further
 * dispatches but never touches already-persisted reserves. */
export function createFatalRejectionLatch({ audit, abort, setExitCode }) {
  let tripped = false;
  return {
    onFatalRejection: () => {
      if (tripped) return;
      tripped = true;
      try {
        abort?.();
      } catch {
        // stopping further dispatch is best effort
      }
      try {
        audit.finish({ status: "NOT-EVALUATED", errorCategory: "unhandled-rejection" });
      } catch {
        // the pre-transport audit record is already durable
      }
      setExitCode?.(2);
    },
    tripped: () => tripped,
    forcedStatus: (status) => (tripped ? "NOT-EVALUATED" : status),
    forcedExit: (code) => (tripped ? 2 : code),
  };
}
export function validateRunBudgets(maxCalls, timeoutMs, maxClassifierUsd) {
  check(
    Number.isInteger(maxCalls) &&
      maxCalls > 0 &&
      maxCalls <= 800 &&
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 900000,
    "invalid run budgets",
  );
  check(maxClassifierUsd > 0 && maxClassifierUsd <= 1.5, "classifier cap exceeds approved budget");
}

/** The SAME listener lifetime used by main and offline regressions. */
export async function withFatalLatchScope({ audit, controller, setExitCode }, fn) {
  const latch = createFatalRejectionLatch({ audit, abort: () => controller.abort(), setExitCode });
  process.once("unhandledRejection", latch.onFatalRejection);
  try {
    return await fn(latch);
  } finally {
    process.removeListener("unhandledRejection", latch.onFatalRejection);
  }
}
export function withRecallTopK(config, topK) {
  return topK === undefined ? config : { ...config, recall: { ...config.recall, maxEntries: topK } };
}
export function withRecallThreshold(config, threshold) {
  return threshold === undefined ? config : { ...config, recall: { ...config.recall, threshold } };
}

/** Experimental override of only the new G2 U-layer entry cap; absent leaves production settings unchanged. */
export function parseRecallTopK(value) {
  if (value === undefined) return undefined;
  check(/^(?:[1-9]|10)$/.test(value), "invalid recall top-k (expected integer 1..10)");
  return Number(value);
}

export function parseRecallThreshold(value) {
  if (value === undefined) return undefined;
  check(
    /^0\.\d+$/.test(value) && Number(value) >= 0.5 && Number(value) <= 0.99,
    "invalid recall threshold (expected 0.5..0.99)",
  );
  return Number(value);
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (mode === "--help") {
    console.log(
      "memory36-gate.mjs g1|g2 --data DIR --baseline-dist /tmp/.../dist [--max-calls N] [--timeout-ms N]\nG2 experiments: [--recall-top-k 1..10] [--recall-threshold 0.5..0.99] affect only the new variant.\nOffline requires complete exact-request cache. Live requires PI_TOOLKIT_MEMORY36_GATE_LIVE=1. See pg-report.md for corpus schema and baseline build.",
    );
    return 0;
  }
  check(["g1", "g2"].includes(mode), "mode must be g1 or g2");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    check(rest[i]?.startsWith("--") && text(rest[i + 1]), "invalid arguments");
    options[rest[i].slice(2)] = rest[i + 1];
  }
  check(
    options["candidate-audit"] === undefined || options["candidate-audit"] === "on",
    "invalid candidate audit flag",
  );
  const recallTopK = parseRecallTopK(options["recall-top-k"]);
  const recallThreshold = parseRecallThreshold(options["recall-threshold"]);
  check(recallTopK === undefined || mode === "g2", "recall top-k is G2 only");
  check(recallThreshold === undefined || mode === "g2", "recall threshold is G2 only");
  const data = resolve(options.data ?? DEFAULT_DATA);
  const read = (name) => readFileSync(join(data, name), "utf8");
  const frozen = JSON.parse(read("freeze.json"));
  for (const name of ["corpus.json", "g1-pairs.jsonl", "g2-turns.jsonl", "label-report.json"])
    check(frozen[name] === digest(read(name)), "NOT-EVALUATED: dataset freeze hash mismatch");
  const labelReportHash = digest(read("label-report.json"));
  const rawCorpus = read("corpus.json"),
    rawLabels = read(`${mode === "g1" ? "g1-pairs" : "g2-turns"}.jsonl`);
  const raw = JSON.parse(rawCorpus);
  if (mode === "g1") {
    const labels = validateLabels(
      "g1",
      parseJsonl(rawLabels),
      raw.entries.map((e) => e.id),
    );
    const support = g1Support(labels);
    if (!support.sufficient || labels.some((r) => r.expected === "positive" && r.confidence === "moderate")) {
      console.log(
        JSON.stringify(
          {
            mode,
            status: "NOT-EVALUATED",
            reason: "BLOCKED: insufficient unambiguous G1 labels; no requests issued",
            support,
            corpusHash: digest(rawCorpus),
            labelsHash: digest(rawLabels),
            labelReportHash,
          },
          null,
          2,
        ),
      );
      return 2;
    }
  }
  check(text(options.dist), "NOT-EVALUATED: pinned current --dist required");
  const dist = resolve(options.dist);
  const currentManifest = JSON.parse(readFileSync(join(dist, "../memory36-baseline.json"), "utf8"));
  check(
    currentManifest.commit === (options["current-commit"] ?? "efa12f26") && currentManifest.distHash === treeHash(dist),
    "current snapshot provenance mismatch",
  );
  const p = await production(dist);
  const blockApi = {
    ...(await import(pathToFileURL(join(dist, "memory/blocks/format.js")).href)),
    ...(await import(pathToFileURL(join(dist, "memory/blocks/naming.js")).href)),
  };
  const planner = await import(pathToFileURL(join(dist, "memory/blocks/migrate-plan.js")).href);
  const mergedPreset = p.mergeTaxonomy();
  check(
    mergedPreset.ok && raw.sidecarProvenance?.preset?.taxonomyRev === mergedPreset.taxonomy.rev,
    "NOT-EVALUATED: taxonomy preset provenance mismatch",
  );
  for (const project of new Set(raw.files.map((f) => f.slug)))
    check(
      raw.sidecarProvenance?.taxonomy?.[project]?.present === false,
      "NOT-EVALUATED: custom taxonomy export required",
    );
  const corpus = adaptProductionCorpus(raw, planner, blockApi, mode === "g1");
  const labels = validateLabels(
    mode,
    parseJsonl(rawLabels).filter((r) => r.expected !== "excluded"),
    [...corpus.entries, ...(mode === "g1" ? (corpus.history ?? []) : [])].map((e) => e.id),
  );
  const prompts = mode === "g2" ? verifyTurnSources(labels, undefined, p.redactForJev) : new Map();
  const governance = await import(pathToFileURL(join(dist, "memory/govern/supersede.js")).href);
  const { TOPIC_USER_POOL_CAP } = await import(pathToFileURL(join(dist, "memory/govern/decay.js")).href);
  const live = process.env.PI_TOOLKIT_MEMORY36_GATE_LIVE === "1";
  const maxCalls = Number(options["max-calls"] ?? 400),
    timeoutMs = Number(options["timeout-ms"] ?? 900000);
  validateRunBudgets(maxCalls, timeoutMs, Number(options["max-classifier-usd"] ?? 0.5));
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
  const settingPath = options.settings ?? join(agentDir, "pi-toolkit.json");
  const userSettings = existsSync(settingPath) ? JSON.parse(readFileSync(settingPath, "utf8")).memory : undefined;
  const settings = p.parseMemorySettings(userSettings);
  // Formal G2 includes production P2. Model-off is not a gate substitute.
  settings.jev = {
    ...settings.jev,
    predict: { ...settings.jev.predict, enabled: true, model: { ...settings.jev.predict.model, enabled: true } },
  };
  const config = p.jevConfigOf(settings);
  check(config.classifiers.length > 0, "no production classifiers configured");
  const now = Date.parse(corpus.at ?? new Date().toISOString().slice(0, 10) + "T12:00:00+08:00");
  check(Number.isFinite(now), "invalid corpus evaluation date");
  const namespace = {
    version: 1,
    classifiers: config.classifiers,
    proxyHash: digest(config.proxy),
    day: new Date(now).toISOString().slice(0, 10),
  };
  check(
    Number(options["max-chat-usd"] ?? 0.28) > 0 &&
      Number(options["max-chat-usd"] ?? 0.28) <= 0.28 &&
      Number(options["max-chat-calls"] ?? 80) <= 80,
    "chat cap exceeds approved budget",
  );
  // Audit trail exists from BEFORE the first possible transport (runtime is
  // only created inside the run below): budgets, cache provenance and every
  // pre-transport reserve/call bump are already on disk when a SIGKILL or an
  // uncaught rejection cuts the process down.
  const cacheDir = join(data, "cache");
  const cacheFilesAtStart = existsSync(cacheDir) ? readdirSync(cacheDir).length : 0;
  const cacheProvenance = {
    mode: live ? "live" : "replay",
    filesAtStart: cacheFilesAtStart,
    freshEmptyAtStart: cacheFilesAtStart === 0,
  };
  const audit = createAuditState({
    dir: data,
    mode,
    budgets: {
      maxCalls,
      maxClassifierUsd: Number(options["max-classifier-usd"] ?? 0.5),
      maxChatCalls: Number(options["max-chat-calls"] ?? 80),
      maxChatUsd: Number(options["max-chat-usd"] ?? 0.28),
      timeoutMs,
    },
    cacheProvenance,
  });
  const summaryDir = join(data, "audit", `attempt-${audit.attemptId}-turns`);
  const expectedSamples = labels.flatMap((row, i) =>
    (mode === "g2" ? ["old", "new"] : ["new"]).map((variant) => ({
      evalId: audit.attemptId,
      sampleId: row.turnId ?? row.id,
      turn: i + 1,
      variant,
    })),
  );
  // This manifest is not a prediction. It records absent rounds explicitly.
  persistTurnSummary(summaryDir, { evalId: audit.attemptId, kind: "expected" }, { expectedSamples });
  const controller = new AbortController();
  // Sticky fatal-rejection latch for THIS main() activation (no module
  // state): an unhandled rejection aborts further dispatch, finalizes the
  // attempt's audit with the closed category and can never be turned back
  // into a PASS by metrics, a later normal finalize, or the CLI exit-code
  // mapping. No process.exit hard kill, no timers. The named listener is
  // removed by withFatalLatchScope on every exit path, so consecutive
  // activations leave no residue.
  let latch;
  const scratch = mkdtempSync(join(tmpdir(), "memory36-gate-"));
  let cache;
  let chat;
  const cacheLookups = options["candidate-audit"] === "on" ? [] : undefined;
  try {
    return await withFatalLatchScope(
      {
        audit,
        controller,
        setExitCode: (code) => {
          process.exitCode = code;
        },
      },
      async (activeLatch) => {
        latch = activeLatch;
        try {
          return await bounded(
            async (signal) => {
              const runtime = live ? await liveRuntime(signal) : undefined;
              const transport = runtime
                ? classifierTransport(
                    runtime,
                    p.WRITE_TAG_TOTAL_BUDGET_MS,
                    Number(options["max-classifier-usd"] ?? 0.5),
                    audit,
                  )
                : undefined;
              cache = createReplyCache({
                dir: join(data, "cache"),
                namespace,
                live,
                transport,
                maxCalls,
                signal,
                ...(cacheLookups ? { observeLookup: (event) => cacheLookups.push(event) } : {}),
              });
              chat =
                mode === "g2"
                  ? await createChatCache({
                      dir: join(data, "cache"),
                      models: config.predict.model.models,
                      namespace,
                      live,
                      runtime,
                      maxCalls: Number(options["max-chat-calls"] ?? 80),
                      maxUsd: Number(options["max-chat-usd"] ?? 0.28),
                      signal,
                      budgetMs: config.predict.model.requestBudgetMs,
                      audit,
                      estimate: (await import(pathToFileURL(join(dist, "memory/jev/predict/flight.js")).href))
                        .estimatePredictUsd,
                    })
                  : undefined;
              const models = classifierCatalog(join(data, "cache"), config.classifiers, runtime, live);
              const registry = registryFor(cache, models, chat);
              let oldP, baselineHash;
              if (mode === "g2") {
                check(text(options["baseline-dist"]), "NOT-EVALUATED: baseline dist required");
                const oldDist = resolve(options["baseline-dist"]);
                const manifest = JSON.parse(readFileSync(join(oldDist, "../memory36-baseline.json"), "utf8"));
                check(
                  manifest.commit === BASELINE && manifest.distHash === treeHash(oldDist),
                  "baseline provenance mismatch",
                );
                baselineHash = manifest.distHash;
                oldP = await production(oldDist);
              }
              const inputs = {
                p,
                oldP,
                corpus,
                labels,
                prompts,
                candidateAuditEnabled: options["candidate-audit"] === "on",
                cacheLookups,
                recallTopK,
                recallThreshold,
                scratch,
                registry,
                config,
                settings,
                signal,
                blockApi,
                governance,
                now,
                summaryDir,
                evalId: audit.attemptId,
              };
              const runs = mode === "g1" ? await runG1(inputs) : await runG2(inputs);
              const stats = cache.stats();
              const metrics = mode === "g1" ? metricsG1(labels, runs) : metricsG2(labels, runs);
              const chatStats = chat?.stats();
              if (registry.hardFailures().length) metrics.status = "NOT-EVALUATED";
              // Real P2 evidence is a formal-G2 requirement: without actual chat
              // calls/hits the run cannot PASS on rule-path output alone.
              const p2Evidence =
                mode === "g2"
                  ? g2P2Evidence(chatStats, stats, {
                      complete: runs.length === labels.length,
                      hardFailures: registry.hardFailures(),
                    })
                  : undefined;
              if (p2Evidence && !p2Evidence.satisfied) metrics.status = "NOT-EVALUATED";
              // Sticky fatal latch: a tripped attempt can never report PASS,
              // regardless of what the metrics computed. The report/details below
              // inherit the forced NOT-EVALUATED, and the finish keeps the latch's
              // closed error category (finish only replaces it when given one).
              metrics.status = latch.forcedStatus(metrics.status);
              const report = {
                mode,
                metrics,
                cache: stats,
                chat: chatStats,
                baseline: BASELINE,
                baselineHash,
                currentCommit: currentManifest.commit,
                currentDistHash: treeHash(dist),
                labelReportHash,
                corpusHash: digest(rawCorpus),
                labelsHash: digest(rawLabels),
                configHash: digest(config),
                ...(recallTopK === undefined && recallThreshold === undefined
                  ? {}
                  : {
                      ...(recallTopK === undefined ? {} : { experimentalRecallTopK: recallTopK }),
                      ...(recallThreshold === undefined ? {} : { experimentalRecallThreshold: recallThreshold }),
                      experimentalNewConfigHash: digest(
                        withRecallThreshold(withRecallTopK(config, recallTopK), recallThreshold),
                      ),
                    }),
                at: new Date(now).toISOString(),
                parameters: {
                  SUPERSEDE_AUTO_P: governance.SUPERSEDE_AUTO_P,
                  CONFLICT_AUTO_P: governance.CONFLICT_AUTO_P,
                  AUTO_PER_WRITE_MAX: governance.AUTO_PER_WRITE_MAX,
                  TOPIC_USER_POOL_CAP,
                },
                predict: "U+P2; model.enabled=true in both versions; isolated turns, separate production daily ledgers",
                classifiers: config.classifiers,
                cacheProvenance,
                audit: { attempt: audit.attemptId, file: audit.file },
                ...(p2Evidence ? { p2Evidence } : {}),
              };
              writePrivate(join(data, "audit", `attempt-${audit.attemptId}-${mode}-details.json`), { report, runs });
              console.log(JSON.stringify(report, null, 2));
              audit.finish({ status: metrics.status, cache: stats, chat: chatStats });
              // Even the CLI `.then(code => process.exitCode = code)` mapping cannot
              // turn a tripped attempt back into exit 0 — main returns 2.
              return latch.forcedExit(metrics.status === "PASS" ? 0 : metrics.status === "FAIL" ? 1 : 2);
            },
            timeoutMs,
            controller.signal,
          );
        } catch (err) {
          // Any abnormal exit (exception, deadline/abort, invalid runtime) still
          // finalizes the attempt's audit with a closed category and whatever cache
          // counters exist — an uncaught rejection never leaves a cost-less shell.
          // Once the fatal latch is tripped its `unhandled-rejection` category must
          // survive: no replacement category is supplied. A broken audit FS at
          // finalize cannot mask the run's own error (pre-transport record durable).
          try {
            audit.finish({
              status: "NOT-EVALUATED",
              ...(latch.tripped() ? {} : { errorCategory: classifyErrorCategory(err) }),
              cache: cache?.stats(),
              chat: chat?.stats(),
            });
          } catch {
            // best effort only
          }
          throw err;
        }
      },
    );
  } finally {
    controller.abort();
    try {
      const samples = expectedSamples.map((identity) => {
        const path = join(summaryDir, `${digest(identity)}.json`);
        return {
          ...identity,
          ...(existsSync(path)
            ? JSON.parse(readFileSync(path, "utf8"))
            : { complete: false, closedReason: "missing-sample", hits: null }),
        };
      });
      persistTurnSummary(
        summaryDir,
        { evalId: audit.attemptId, kind: "completion" },
        {
          complete: samples.every((r) => r.complete),
          samples,
          status: latch.forcedStatus(samples.every((r) => r.complete) ? "complete" : "NOT-EVALUATED"),
        },
      );
    } catch (err) {
      // Completion-summary failure is as fatal as pre-transport audit failure:
      // no later PASS finalize may conceal it (the return is still unwinding).
      try {
        audit.finish({ status: "NOT-EVALUATED", ...(latch.tripped() ? {} : { errorCategory: "audit-write" }) });
      } catch {
        /* disk unavailable, CLI still exits 2 */
      }
      throw err;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
export { treeHash, production, snapshots };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Standalone CLI needs a ref'd non-timer handle while replaying measured
  // latency. Production-compatible unref'd timers alone let Node exit early.
  const hold = new MessageChannel();
  hold.port1.on("message", () => {});
  main()
    .then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        console.error(
          "NOT-EVALUATED: missing/invalid dataset, cache, baseline or runtime; no gate pass asserted. See pg-report.md.",
        );
        process.exitCode = 2;
      },
    )
    .finally(() => {
      hold.port1.close();
      hold.port2.close();
    });
}
