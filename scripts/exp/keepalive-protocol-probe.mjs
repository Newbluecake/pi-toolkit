#!/usr/bin/env node
/**
 * Live measurement for docs/dev/cache-ttl-keepalive/protocol-probe-results.md:
 * would prompt-cache keepalive pings pay off on NON-Anthropic protocols
 * (openai-responses / openai-completions)?
 *
 * Builds RAW requests (no agent loop) in the shape pi's own openai-responses / openai-completions
 * providers send, and POSTs them to each route's endpoint. Endpoint + credential come from pi's own model
 * registry (ModelRuntime.getAuth); credentials live in memory only — never printed, logged or written.
 * The result file carries token counts / timings / usage KEY NAMES only, never message text.
 *
 * Usage (repo root):
 *   node scripts/exp/keepalive-protocol-probe.mjs --routes a/b,c/d,... [--cap-usd 5] [--out /tmp/keepalive-probe]
 *        [--tokens 20000] [--scale 1] [--dry]
 *   node scripts/exp/keepalive-protocol-probe.mjs --report /tmp/keepalive-probe/records.json
 *
 *   --scale  : multiplies every idle gap / ping interval (smoke tests: 0.01). Real runs use 1.
 *   --tokens : target prefix size (default 20000; smoke: 2500 — providers cache only >=1024 tokens).
 *
 * Per route (see render() for the tables):
 *   M0   write R0, then immediate EXACT replay (cache works at all?) and an agent-shaped APPENDED-TAIL request
 *        (prefix extension: assistant "OK" + new user turn — what a real next turn looks like); an
 *        abort-at-first-event write-then-repeat (does an ABORTED request populate the cache?); Responses-only
 *        prompt_cache_key vs none hit-stability series and a prompt_cache_retention:"24h" prefix re-requested at 21 min.
 *   M1   write, idle 6 / 11 / 21 min (independent prefixes, parallel), appended-tail re-request ⇒ cached share
 *        (on a miss at 21 min / M2: an exact replay 4 s later tells "expired" from "prefix-extension never hits").
 *   M2   write, ping every 4 min (replay with minimal output; mode first-event-abort = what ping-client does, or full
 *        tiny completion), real request at 11 / 21 min ⇒ cached share.
 *
 * Standalone Node process (NOT a pi extension): idle waits use ref'd timers on purpose (an unref'd wait would let node
 * exit silently mid-timeline); a global hard deadline kills the process if something wedges.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────── args ─────────────────────────
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const CAP_USD = Number(arg("cap-usd", 5));
const OUT_DIR = String(arg("out", "/tmp/keepalive-probe"));
const ROUTES = String(arg("routes", "")).split(",").filter(Boolean);
const TARGET_TOKENS = Number(arg("tokens", 20000));
const SCALE = Number(arg("scale", 1));
const DRY = arg("dry", false) === true;
/** per-route start delays in seconds (comma list aligned with --routes); lets rate-limited relays sharing a host breathe. */
const DELAYS = String(arg("delays", "")).split(",").filter(Boolean).map(Number);
const REPORT = arg("report", undefined);
const RECORDS_FILE = join(OUT_DIR, "records.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex")
    .slice(0, 12);
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Log-shaped deterministic filler (word-salad is refused by some models); nonce-seeded ⇒ globally unique. */
function filler(seed, chars) {
  const r = mulberry32(parseInt(sha(seed).slice(0, 8), 16));
  const o = [];
  let n = 0;
  while (n < chars) {
    const line = `2026-10-18T${String(Math.floor(r() * 24)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}Z INFO service-${Math.floor(r() * 7)} request id=${Math.floor(r() * 0xffffff).toString(16)} completed in ${20 + Math.floor(r() * 400)}ms status=${r() < 0.9 ? 200 : 500} user=u${Math.floor(r() * 900)}`;
    o.push(line);
    n += line.length + 1;
  }
  return o.join("\n").slice(0, chars);
}

// ───────────────────────── report ─────────────────────────
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(4)}` : "n/a");
function render(data) {
  const L = [];
  L.push(
    `Total known spend: ${usd(data.spentKnownUsd)} (+ estimated aborted-ping spend ${usd(data.spentEstUsd)}); cap ${usd(data.capUsd)}.`,
  );
  L.push("");
  for (const R of data.routes) {
    L.push(`### ${R.route} (${R.api}, ${R.baseHost})`);
    L.push("");
    L.push(
      `Prices $/M: input ${R.price.input}, cacheRead ${R.price.cacheRead}, cacheWrite ${R.price.cacheWrite ?? 0}, output ${R.price.output}. Usage key paths seen: ${[...new Set(R.usageKeys.map((k) => k.replace(/attribution\.items\.[^.]+/, "attribution.items.<id>")))].join(", ") || "none"}.`,
    );
    L.push("");
    L.push("| t(s) | arm | req | mode | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost | note |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const q of R.records) {
      const own = q.promptTokens
        ? ((q.cached - (q.baseline ?? 0)) / Math.max(1, q.promptTokens - (q.baseline ?? 0))) * 100
        : NaN;
      const share = q.promptTokens
        ? `${((q.cached / q.promptTokens) * 100).toFixed(0)}%${q.baseline ? ` (own ${own.toFixed(0)}%)` : ""}`
        : "n/a";
      L.push(
        `| ${f1(q.tStartS)} | ${q.arm} | ${q.req} | ${q.mode} | ${q.status || "-"} | ${q.promptTokens ?? "n/a"} | ${q.cached ?? "n/a"} | ${share} | ${q.output ?? "n/a"} | ${q.ttfeMs ?? "-"} | ${q.costUsd !== undefined ? usd(q.costUsd) : q.costEstUsd !== undefined ? `~${usd(q.costEstUsd)}` : "n/a"} | ${[q.cacheWrite ? `cw=${q.cacheWrite}` : "", q.note ?? q.error ?? ""].filter(Boolean).join(" ").slice(0, 90)} |`,
      );
    }
    L.push("");
    L.push(`Route spend: known ${usd(R.spendKnownUsd)}, est. aborted ${usd(R.spendEstUsd)}.`);
    L.push("");
  }
  return L.join("\n");
}
if (REPORT) {
  const data = JSON.parse(readFileSync(String(REPORT), "utf8"));
  console.log(render(data));
  process.exit(0);
}

// ───────────────────────── setup ─────────────────────────
if (ROUTES.length === 0) {
  console.error("[probe] --routes required");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });
const { ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({
  authPath: join(getAgentDir(), "auth.json"),
  modelsPath: join(getAgentDir(), "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});

const secrets = [];
function redact(s) {
  let t = String(s);
  for (const x of secrets) if (typeof x === "string" && x.length > 6) t = t.split(x).join("[REDACTED]");
  return t.replace(/(bearer\s+)[^\s"]+/gi, "$1[REDACTED]");
}

// ───────────────────────── global spend ledger ─────────────────────────
const LEDGER = { knownUsd: 0, estUsd: 0, requests: 0 };
const spentNow = () => LEDGER.knownUsd + LEDGER.estUsd;
let STOP = false;
const RESERVE = 0.3; // headroom for in-flight requests
const T_ORIGIN = Date.now();
const ROUTE_STATE = []; // for persistence

function persist() {
  const data = {
    capUsd: CAP_USD,
    spentKnownUsd: Number(LEDGER.knownUsd.toFixed(6)),
    spentEstUsd: Number(LEDGER.estUsd.toFixed(6)),
    stoppedByCap: STOP,
    scale: SCALE,
    targetTokens: TARGET_TOKENS,
    routes: ROUTE_STATE.map((R) => ({
      route: R.route,
      api: R.api,
      baseHost: R.baseHost,
      price: R.price,
      usageKeys: [...R.usageKeys],
      notes: R.notes,
      prefixTokens: R.prefixTokens,
      spendKnownUsd: Number(R.spendKnownUsd.toFixed(6)),
      spendEstUsd: Number(R.spendEstUsd.toFixed(6)),
      records: R.records,
    })),
  };
  writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2));
}

function flattenKeys(o, prefix = "", out = []) {
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenKeys(v, p, out);
    else out.push(p);
  }
  return out;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Provider-neutral usage normaliser. Records which field supplied the cached count. */
function normUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  const prompt = num(u.input_tokens) ?? num(u.prompt_tokens);
  const out = num(u.output_tokens) ?? num(u.completion_tokens) ?? 0;
  const cands = [
    ["input_tokens_details.cached_tokens", u.input_tokens_details?.cached_tokens],
    ["prompt_tokens_details.cached_tokens", u.prompt_tokens_details?.cached_tokens],
    ["prompt_cache_hit_tokens", u.prompt_cache_hit_tokens],
    ["cached_tokens", u.cached_tokens],
    ["cache_read_input_tokens", u.cache_read_input_tokens],
  ];
  let cached = 0;
  let cachedField = "none";
  for (const [name, v] of cands) {
    if (num(v) !== undefined) {
      cached = num(v);
      cachedField = name;
      break;
    }
  }
  if (prompt === undefined) return undefined;
  // cache-WRITE tokens (relay-reported; a subset of the prompt, billed at the route's cacheWrite price when it has one)
  let cacheWrite = 0;
  for (const v of [
    u.input_tokens_details?.cache_write_tokens,
    u.prompt_tokens_details?.cache_write_tokens,
    u.cache_creation_input_tokens,
  ]) {
    if (num(v) !== undefined) {
      cacheWrite = num(v);
      break;
    }
  }
  return { prompt, cached, cacheWrite, out, cachedField };
}

// ───────────────────────── route runner ─────────────────────────
async function setupRoute(routeRef) {
  const i = routeRef.indexOf("/");
  const provider = routeRef.slice(0, i);
  const modelId = routeRef.slice(i + 1);
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`route ${routeRef} not in registry`);
  const api = model.api;
  if (api !== "openai-responses" && api !== "openai-completions")
    throw new Error(`route ${routeRef} api=${api} unsupported`);
  const auth = await runtime.getAuth(model);
  const apiKey = auth?.auth?.apiKey;
  if (!apiKey) throw new Error(`no credentials for ${routeRef}`);
  secrets.push(apiKey, ...Object.values(auth?.auth?.headers ?? {}), ...Object.values(model.headers ?? {}));
  const base = (auth.auth.baseUrl ?? model.baseUrl).replace(/\/$/, "");
  const R = {
    route: routeRef,
    api,
    model,
    modelId,
    base,
    baseHost: new URL(base).host.replace(/^\d+\.\d+\.\d+\.\d+/, "<ip>"),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(model.headers ?? {}),
      ...(auth?.auth?.headers ?? {}),
    },
    price: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    usageKeys: new Set(),
    records: [],
    notes: [],
    spendKnownUsd: 0,
    spendEstUsd: 0,
    prefixTokens: 0,
    charsPerToken: /gpt/i.test(modelId) ? 2.6 : /kimi/i.test(modelId) ? 2.3 : 2.5, // measured on smoke runs (log-shaped filler)
    effort: model.thinkingLevelMap?.off ?? "none",
    urlOverride: undefined,
    seq: 0,
  };
  ROUTE_STATE.push(R);
  return R;
}

/**
 * cost for a normalised usage, $. Uncached input is billed at the INPUT price; tokens the provider reports as cache
 * writes (usage.cacheWrite, subset of the prompt) at the route's cacheWrite price when it has one (> 0), else input.
 * (The first live run dropped cache_write_tokens and billed them at input — see protocol-probe-results.md.)
 */
function costOf(R, u) {
  const p = R.price;
  const w = Math.min(u.cacheWrite ?? 0, Math.max(0, u.prompt - u.cached));
  const miss = Math.max(0, u.prompt - u.cached - w);
  return (
    (miss * p.input + w * (p.cacheWrite > 0 ? p.cacheWrite : p.input) + u.cached * p.cacheRead + u.out * p.output) / 1e6
  );
}

function isOutputEvent(R, ev) {
  if (R.api === "openai-responses") {
    const t = ev?.type;
    return (
      typeof t === "string" &&
      t.startsWith("response.") &&
      !["response.created", "response.in_progress", "response.queued"].includes(t)
    );
  }
  const ch = ev?.choices?.[0];
  if (!ch) return !!ev?.usage;
  const d = ch.delta ?? {};
  return !!(d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length || ch.finish_reason);
}

function url(R) {
  if (R.urlOverride) return R.urlOverride;
  return `${R.base}${R.api === "openai-responses" ? "/responses" : "/chat/completions"}`;
}

/** One HTTP attempt. mode: full | first-event | first-output */
async function attempt(R, body, mode, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const out = {
    status: 0,
    ok: false,
    usage: undefined,
    events: 0,
    aborted: false,
    ttfeMs: undefined,
    rawUsageKeys: [],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(url(R), {
      method: "POST",
      headers: R.headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    out.status = res.status;
    if (!res.ok) {
      out.error = redact(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dl = chunk.split("\n").filter((l) => l.startsWith("data:"));
        if (dl.length === 0) continue;
        const payload = dl.map((l) => l.slice(5).trim()).join("\n");
        if (payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        out.events++;
        if (out.ttfeMs === undefined) out.ttfeMs = Date.now() - t0;
        const rawU = ev?.usage ?? ev?.response?.usage;
        if (rawU && typeof rawU === "object") {
          const nu = normUsage(rawU);
          if (nu) {
            out.usage = nu;
            out.rawUsageKeys = flattenKeys(rawU);
          }
        }
        if (ev?.type === "response.failed" || ev?.type === "error")
          out.error = redact(JSON.stringify(ev).slice(0, 300));
        if (mode === "first-event") {
          out.aborted = true;
          out.ok = true;
          ctl.abort(new Error("early-abort"));
          return out;
        }
        if (mode === "first-output" && isOutputEvent(R, ev)) {
          out.aborted = true;
          out.ok = true;
          ctl.abort(new Error("early-abort"));
          return out;
        }
      }
    }
    out.ok = out.usage !== undefined;
    if (!out.ok && !out.error) out.error = "stream ended without usage";
    return out;
  } catch (e) {
    if (out.aborted) return out;
    out.error = redact(String(e?.message ?? e));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Send with retry on transient failures (429/5xx/network). Returns the final record. */
async function send(R, g, req, body, mode, extra = {}) {
  const rec = { arm: g.name, req, mode, tStartS: Number(((Date.now() - T_ORIGIN) / 1000).toFixed(1)), ...extra };
  if (STOP) {
    rec.error = "skipped: spend cap";
    rec.status = 0;
    R.records.push(rec);
    persist();
    return rec;
  }
  let res;
  for (let k = 0; k < 10; k++) {
    res = await attempt(R, body, mode, mode === "full" ? 120_000 : 60_000);
    // cr-response style relays: fall back to /v1 once on 404 for the first request.
    if (res.status === 404 && !R.urlOverride && R.api === "openai-responses" && !R.base.endsWith("/v1")) {
      R.urlOverride = `${R.base}/v1/responses`;
      R.notes.push("base has no /v1 and /responses 404 ⇒ used /v1/responses");
      continue;
    }
    if (
      res.status === 400 &&
      body.reasoning &&
      /reasoning|Unsupported value/i.test(res.error ?? "") &&
      R.effort !== "low"
    ) {
      R.effort = "low";
      body.reasoning = { effort: "low" };
      R.notes.push("reasoning.effort 'none' rejected ⇒ used 'low'");
      continue;
    }
    const transient = res.status === 429 || res.status >= 500 || (res.status === 0 && !res.aborted && !res.ok);
    if (!transient) break;
    rec.retries = (rec.retries ?? 0) + 1;
    await sleep([8000, 20000, 40000, 60000][k] ?? 60000);
  }
  rec.status = res.status;
  rec.ttfeMs = res.ttfeMs;
  if (res.error) rec.error = res.error;
  for (const k of res.rawUsageKeys) R.usageKeys.add(k);
  if (res.usage) {
    rec.promptTokens = res.usage.prompt;
    rec.cached = res.usage.cached;
    rec.output = res.usage.out;
    if (res.usage.cacheWrite) rec.cacheWrite = res.usage.cacheWrite;
    rec.cachedField = res.usage.cachedField;
    rec.baseline = g.writeCached ?? 0; // cached tokens the WRITE already showed (shared/injected prefix on some relays)
    rec.costUsd = Number(costOf(R, res.usage).toFixed(6));
    LEDGER.knownUsd += rec.costUsd;
    R.spendKnownUsd += rec.costUsd;
  } else if (res.status === 200 && res.aborted) {
    // aborted before any usage: estimate at hit price (optimistic) — refined in the report from real-request evidence.
    const pt = g.promptTokens ?? R.prefixTokens;
    rec.note = "aborted; usage not reported";
    rec.costEstUsd = Number(((pt * R.price.cacheRead) / 1e6).toFixed(6));
    rec.costMissUsd = Number(((pt * R.price.input) / 1e6).toFixed(6));
    LEDGER.estUsd += rec.costEstUsd;
    R.spendEstUsd += rec.costEstUsd;
  }
  LEDGER.requests++;
  rec.tEndS = Number(((Date.now() - T_ORIGIN) / 1000).toFixed(1));
  R.records.push(rec);
  if (spentNow() >= CAP_USD - RESERVE && !STOP) {
    STOP = true;
    console.error(`[probe] SPEND CAP reached (${spentNow().toFixed(3)} / ${CAP_USD}) — stopping new requests`);
  }
  persist();
  const tag = res.status === 200 ? "ok " : `ERR${res.status}`;
  console.log(
    `[${String(rec.tStartS).padStart(7)}s] ${R.route.padEnd(30)} ${tag} ${g.name}/${req} ${mode} prompt=${rec.promptTokens ?? "-"} cached=${rec.cached ?? "-"} out=${rec.output ?? "-"} ttfe=${rec.ttfeMs ?? "-"}ms ${rec.costUsd !== undefined ? "$" + rec.costUsd : ""}${rec.error ? " " + rec.error : ""}${rec.note ? " (" + rec.note + ")" : ""}`,
  );
  return rec;
}

// ───────────────────────── payload builders ─────────────────────────
function makeGroup(R, name, opts = {}) {
  const nonce = randomBytes(12).toString("hex");
  const chars = Math.round(TARGET_TOKENS * R.charsPerToken);
  return {
    name,
    nonce,
    key: `kp-${nonce.slice(0, 16)}`,
    sys: `Nonce ${nonce}. You are a terse log triage assistant. Answer with a single short word.`,
    user: `Log excerpt follows.\n${filler(nonce, chars)}\n\n`,
    useKey: opts.useKey ?? true,
    retention: opts.retention ?? false,
    promptTokens: undefined,
  };
}
const QTEXT = (n) => `Task ${n}: ignore the log and reply with exactly the word OK.`;

/** variant "same": exactly the Q0 prompt (exact replay). "tail": Q0 prompt + assistant "OK" + new user turn Qn (conversation growth). */
function buildBody(R, g, n, { maxOut, variant = "tail" }) {
  const tail = variant === "tail" && n > 0;
  if (R.api === "openai-responses") {
    const input = [
      { role: R.model.reasoning ? "developer" : "system", content: g.sys },
      { role: "user", content: [{ type: "input_text", text: g.user + QTEXT(0) }] },
    ];
    if (tail)
      input.push(
        { role: "assistant", content: "OK" },
        { role: "user", content: [{ type: "input_text", text: QTEXT(n) }] },
      );
    const body = { model: R.modelId, input, stream: true, store: false, max_output_tokens: Math.max(16, maxOut) };
    if (g.useKey) body.prompt_cache_key = g.key;
    if (g.retention) body.prompt_cache_retention = "24h";
    if (R.model.reasoning) body.reasoning = { effort: R.effort };
    return body;
  }
  const messages = [
    { role: "system", content: g.sys },
    { role: "user", content: g.user + QTEXT(0) },
  ];
  if (tail) messages.push({ role: "assistant", content: "OK" }, { role: "user", content: QTEXT(n) });
  const body = { model: R.modelId, messages, stream: true, stream_options: { include_usage: true } };
  if (R.model.compat?.supportsStore !== false && !/glm/i.test(R.modelId)) body.store = false;
  body[R.model.compat?.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"] = maxOut;
  return body;
}
const REAL_MAX_OUT = 48;
/** The ping mutation (mirror of ping-client.preparePingPayload): same payload, minimal output. */
function pingBody(R, captured) {
  const b = { ...captured };
  if (R.api === "openai-responses")
    b.max_output_tokens = 16; // API floor
  else if ("max_completion_tokens" in b) b.max_completion_tokens = 1;
  else b.max_tokens = 1;
  return b;
}

// ───────────────────────── arms ─────────────────────────
const waitUntil = (tMs) => sleep(Math.max(0, tMs - Date.now()));
const S = (sec) => sec * 1000 * SCALE;

async function writeFull(R, g) {
  const body = buildBody(R, g, 0, { maxOut: REAL_MAX_OUT });
  const rec = await send(R, g, "write", body, "full");
  if (rec.promptTokens) {
    g.promptTokens = rec.promptTokens;
    g.writeCached = rec.cached;
  }
  g.captured = body;
  g.tw = Date.now();
  return rec;
}
/** hit = (cached − what the write already showed) covers ≥80% of the remaining prompt. */
function isHit(rec, g) {
  if (!rec?.promptTokens) return false;
  const base = g.writeCached ?? 0;
  return (rec.cached - base) / Math.max(1, rec.promptTokens - base) >= 0.8;
}

/** M1 / M2 arm: write, then schedule pings / real requests relative to write completion. */
async function timelineArm(R, g, { events, replayOnMiss = false }) {
  const w = await writeFull(R, g);
  if (!w.promptTokens) return;
  for (const ev of events) {
    await waitUntil(g.tw + S(ev.atS));
    if (ev.kind === "ping") {
      await send(R, g, `ping@${ev.atS / 60}m`, pingBody(R, g.captured), ev.mode, { atS: ev.atS });
    } else {
      const rec = await send(R, g, `real@${ev.atS / 60}m`, buildBody(R, g, 1, { maxOut: REAL_MAX_OUT }), "full", {
        atS: ev.atS,
      });
      if (replayOnMiss && rec.promptTokens && !isHit(rec, g) && spentNow() < CAP_USD * 0.75) {
        await sleep(4000);
        await send(R, g, `replay@${ev.atS / 60}m`, buildBody(R, g, 0, { maxOut: REAL_MAX_OUT }), "full", {
          atS: ev.atS,
          note: "exact replay after a miss: expired vs prefix-extension-never-hits",
        });
      }
    }
  }
}

async function m0Basic(R) {
  const g = makeGroup(R, "M0");
  const w = await writeFull(R, g);
  if (!w.promptTokens) {
    R.notes.push("M0 write failed — route skipped");
    return false;
  }
  R.prefixTokens = w.promptTokens;
  const tries = async (label, variant, n) => {
    for (let k = 0; k < 3; k++) {
      await sleep(k === 0 ? 2500 : 10_000);
      const r = await send(
        R,
        g,
        `${label}${k ? "#" + (k + 1) : ""}`,
        buildBody(R, g, n, { maxOut: REAL_MAX_OUT, variant }),
        "full",
      );
      if (isHit(r, g)) return { hit: true, afterTry: k + 1 };
      if (!r.promptTokens) return { hit: false, afterTry: k + 1 };
    }
    return { hit: false, afterTry: 3 };
  };
  const exact = await tries("R0'(exact)", "same", 0);
  const tail = await tries("R0''(tail)", "tail", 1);
  R.notes.push(
    `M0 exact-replay hit=${exact.hit} (try ${exact.afterTry}); appended-tail hit=${tail.hit} (try ${tail.afterTry})`,
  );
  if (!exact.hit && !tail.hit) R.notes.push("M0: no cache hit on repeats ⇒ route has NO usable cache");
  return exact.hit || tail.hit;
}

async function m0AbortTest(R) {
  const g = makeGroup(R, "M0-first-event");
  const body = buildBody(R, g, 0, { maxOut: REAL_MAX_OUT });
  g.promptTokens = R.prefixTokens;
  await send(R, g, "abort-write", pingBody(R, body), "first-event", { note: "aborted write (ping-shaped)" });
  await sleep(3000);
  const r1 = await send(R, g, "repeat#1(exact)", buildBody(R, g, 0, { maxOut: REAL_MAX_OUT }), "full");
  if (r1.promptTokens && r1.cached === 0 && spentNow() < CAP_USD * 0.75) {
    await sleep(10_000);
    await send(R, g, "repeat#2(exact)", buildBody(R, g, 0, { maxOut: REAL_MAX_OUT }), "full");
  }
}

async function stability(R, variants) {
  // hit stability: same prefix, four agent-shaped tail requests 15 s apart, with vs without prompt_cache_key
  for (const useKey of variants) {
    const g = makeGroup(R, `M0-stab-key=${useKey}`, { useKey });
    const w = await writeFull(R, g);
    if (!w.promptTokens) continue;
    for (let n = 1; n <= 4; n++) {
      await sleep(S(15));
      await send(R, g, `repeat#${n}(tail)`, buildBody(R, g, n, { maxOut: REAL_MAX_OUT }), "full");
    }
  }
}

async function runRoute(routeRef, delayS) {
  if (delayS) await sleep(delayS * 1000);
  const R = await setupRoute(routeRef);
  if (DRY) {
    console.log(
      `[dry] ${R.route} api=${R.api} host=${R.baseHost} price=${JSON.stringify(R.price)} reasoning=${R.model.reasoning}`,
    );
    return R;
  }
  console.log(`[probe] ${R.route} start (${R.api})`);
  const ok = await m0Basic(R);
  if (!ok) return R;
  const jobs = [];
  let delay = 0;
  const launch = (fn) => {
    const d = delay;
    delay += 2500;
    jobs.push(
      sleep(d)
        .then(fn)
        .catch((e) => {
          R.notes.push(`arm error: ${redact(String(e?.message ?? e))}`);
          console.error(`[probe] ${R.route} arm error: ${redact(String(e?.message ?? e))}`);
        }),
    );
  };
  // M1: independent idle prefixes
  for (const m of [6, 11, 21]) {
    launch(() =>
      timelineArm(R, makeGroup(R, `M1-idle${m}m`), { events: [{ kind: "real", atS: m * 60 }], replayOnMiss: m === 21 }),
    );
  }
  // M2: pings every 4 min
  const pings = (until, mode) => {
    const a = [];
    for (let t = 240; t < until * 60; t += 240) a.push({ kind: "ping", atS: t, mode });
    return a;
  };
  launch(() =>
    timelineArm(R, makeGroup(R, "M2-A-real11"), { events: [...pings(11, "first-event"), { kind: "real", atS: 660 }] }),
  );
  launch(() =>
    timelineArm(R, makeGroup(R, "M2-A-real21"), {
      events: [...pings(21, "first-event"), { kind: "real", atS: 1260 }],
      replayOnMiss: true,
    }),
  );
  launch(() =>
    timelineArm(R, makeGroup(R, "M2-B-real21"), {
      events: [...pings(21, "full"), { kind: "real", atS: 1260 }],
      replayOnMiss: true,
    }),
  );
  launch(() => m0AbortTest(R));
  if (R.api === "openai-responses") {
    launch(() => stability(R, [true, false]));
    launch(() =>
      timelineArm(R, makeGroup(R, "M1-retention24h-idle21m", { retention: true }), {
        events: [{ kind: "real", atS: 1260 }],
        replayOnMiss: true,
      }),
    );
  }
  await Promise.all(jobs);
  return R;
}

// hard deadline: 45 min × scale + slack
const killTimer = setTimeout(
  () => {
    console.error("[probe] HARD DEADLINE — exiting");
    persist();
    process.exit(3);
  },
  S(45 * 60) + 120_000,
);
killTimer.unref?.();

const results = await Promise.allSettled(ROUTES.map((r, i) => runRoute(r, DELAYS[i] ?? 0)));
for (const [i, r] of results.entries())
  if (r.status === "rejected")
    console.error(`[probe] ${ROUTES[i]} failed: ${redact(String(r.reason?.message ?? r.reason))}`);
persist();
console.log(
  `[probe] done: ${LEDGER.requests} requests, known $${LEDGER.knownUsd.toFixed(4)} + est $${LEDGER.estUsd.toFixed(4)}; records: ${RECORDS_FILE}`,
);
process.exit(0);
