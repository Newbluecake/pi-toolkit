/**
 * #56 batch 2 ⑧ — zero-behaviour proof for the settings decomposition.
 *
 * `__corpus__/settings-corpus.json` was captured ONCE on the baseline `90dbb88e` (before any symbol left
 * `src/config/settings.ts`). It pins, byte for byte (key order included — `HubConfig` & co. serialise
 * settings sub-objects), the `JSON.stringify` of:
 *   - `DEFAULT_SETTINGS`;
 *   - `loadSettings(input)` for (a) every distinct input the `tests/config/**` suites feed to
 *     `parseSettingsSource` (`captured`), (b) a seeded random family built from the frozen `template`
 *     (`random`: whole-file mutations) and (c) per-block mutations of every top-level block (`blocks`);
 *   - the `console.warn` lines emitted while parsing, and the three file-reading warning loaders
 *     (`loadWebHubLanSettingsWarnings` / `loadWebHubProxyWarnings` / `loadFeishuBotWarnings`) run on the
 *     same input written to a file — that is how the web-hub/feishu block parsers' `warnings` stay pinned.
 * The corpus stores a sha256 per case, not the 5 KB outputs. On a mismatch the failure names the case;
 * run with `GOV_CORPUS_DUMP=<dir>` to write the actual strings (diff them against a baseline checkout).
 *
 * `GOV_CORPUS_GENERATE=<captured.json>` rewrites the corpus — only ever to be used on the baseline commit.
 * Inputs are generated from the frozen `template`, never from live code, so the corpus is independent of
 * the refactor under test. Never regenerate it to make a refactor pass.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadFeishuBotWarnings,
  loadSettings,
  loadWebHubLanSettingsWarnings,
  loadWebHubProxyWarnings,
} from "../../src/config/settings.js";

import { getPath, normalizeTimeUnits } from "../../src/config/time-units.js";

const CORPUS_PATH = join(import.meta.dirname, "__corpus__", "settings-corpus.json");

interface Corpus {
  baseline: string;
  seed: number;
  randomCount: number;
  blocksPerKey: number;
  /** DEFAULT_SETTINGS exactly as serialised on the baseline. */
  template: unknown;
  /** every `*Ms` path that the file stores as `*S` seconds (TIME_SETTING_MS_PATHS on the baseline). */
  timePaths: string[];
  /** Internal `*Ms` paths whose settings field was later REMOVED (#26 dropped
   *  `memory.jev.confirmTimeoutMs`). The frozen `template` above still carries
   *  them, so generated inputs keep feeding the retired key to `loadSettings`
   *  (proving stale keys are tolerated); only the defaults comparison strips
   *  them. */
  retiredPaths?: string[];
  defaultsSha: string;
  captured: { input: unknown; sha: string }[];
  randomShas: string[];
  blockShas: string[];
}

/** Tag the values JSON cannot carry so that the archive keeps undefined / NaN / ±Infinity. */
function tagReplacer(_k: string, v: unknown): unknown {
  if (v === undefined) return "__undef__";
  if (typeof v === "number" && !Number.isFinite(v)) return `__num:${v}`;
  return v;
}
function untag(_k: string, v: unknown): unknown {
  if (v === "__undef__") return undefined;
  if (typeof v === "string" && v.startsWith("__num:")) return Number(v.slice(6));
  return v;
}
const stringify = (v: unknown): string => JSON.stringify(v, tagReplacer);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRING_POOL = [
  "",
  "x",
  "on",
  "off",
  "auto",
  "all",
  "none",
  "loopback",
  "wake",
  "deliver",
  "replies",
  "display",
  "background",
  "crit",
  "warn",
  "strict",
  "legacy",
  "tiered",
  "v2",
  "core",
  "full",
  "keep",
  "kill",
  "verify",
  "chain",
  "static",
  "dynamic",
  "known",
  "roots",
  "bound",
  "buttons",
  "stable",
  "diagnose_only",
  "terminate_on_stall",
  "provider/model",
  "a, b ,c",
  "7900-7949",
  "7900-7900",
  "10-5",
  "127.0.0.1",
  "10.0.0.0/8",
  "192.168.0.0/33",
  "https://example.com",
  "http://a.b:80",
  "droid",
  "5h",
  "week",
  "month",
  "zai,kimi-coding",
  "default",
  "Plan",
  "../x",
  "/tmp/x",
];
const NUMBER_POOL = [0, 1, -1, 2, 3, 0.5, 7, 10, 25, 60, 99, 100, 1000, 4096, 65535, 70000, 1e6, 1e9, 1e12, -5000];

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)] as T;
}

function randomLeaf(rnd: () => number, sample: unknown, strings: readonly string[]): unknown {
  const r = rnd();
  if (r < 0.1) return null;
  if (r < 0.18) return pick(rnd, [undefined, "", [], {}, true, false, 0, "7", [1, "a"], { a: 1 }] as unknown[]);
  if (typeof sample === "boolean") return r < 0.7 ? !sample : pick(rnd, [true, false]);
  if (typeof sample === "number") {
    if (r < 0.5) return pick(rnd, NUMBER_POOL);
    if (r < 0.7) return sample * 2;
    if (r < 0.8) return Math.floor(sample / 2);
    return sample + (rnd() < 0.5 ? 0.5 : 1);
  }
  if (typeof sample === "string") return r < 0.8 ? pick(rnd, strings) : pick(rnd, STRING_POOL);
  if (Array.isArray(sample)) {
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => pick(rnd, [...strings, 3, true, null] as unknown[]));
  }
  return pick(rnd, strings);
}

function mutate(
  rnd: () => number,
  sample: unknown,
  strings: readonly string[],
  timeKeys: ReadonlySet<string>,
  path: string,
  keep: number,
): unknown {
  if (sample === null || typeof sample !== "object" || Array.isArray(sample)) return randomLeaf(rnd, sample, strings);
  const out: Record<string, unknown> = {};
  const entries = Object.entries(sample as Record<string, unknown>);
  // shuffle the key order sometimes — the parsers must not depend on input key order
  if (rnd() < 0.3) entries.sort(() => rnd() - 0.5);
  for (const [key, value] of entries) {
    if (rnd() > keep) continue;
    const here = path === "" ? key : `${path}.${key}`;
    let outKey = key;
    let v: unknown = mutate(rnd, value, strings, timeKeys, here, keep);
    if (timeKeys.has(here) && rnd() < 0.6) {
      outKey = `${key.slice(0, -2)}S`;
      if (typeof v === "number" && rnd() < 0.8) v = Math.round(v / 1000);
    }
    out[outKey] = v;
  }
  if (rnd() < 0.15) out.__unknownKey = pick(rnd, [1, "x", null, { a: 1 }] as unknown[]);
  return out;
}

function generate(corpus: Pick<Corpus, "seed" | "randomCount" | "blocksPerKey" | "template" | "timePaths">): {
  random: unknown[];
  blocks: unknown[];
} {
  const rnd = mulberry32(corpus.seed);
  const timeKeys = new Set(corpus.timePaths);
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === "object") Object.values(v as object).forEach(collect);
  };
  collect(corpus.template);
  const template = corpus.template as Record<string, unknown>;
  const random: unknown[] = [];
  for (let i = 0; i < corpus.randomCount; i++) {
    const keep = pick(rnd, [0.2, 0.5, 0.9, 1]);
    random.push(mutate(rnd, template, strings, timeKeys, "", keep));
  }
  const blocks: unknown[] = [];
  for (const key of Object.keys(template)) {
    for (let i = 0; i < corpus.blocksPerKey; i++) {
      const keep = pick(rnd, [0.3, 0.7, 1]);
      blocks.push({ [key]: mutate(rnd, template[key], strings, timeKeys, key, keep) });
    }
  }
  return { random, blocks };
}

const scratch = mkdtempSync(join(tmpdir(), "settings-corpus-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fileSeq = 0;

/** One case → one canonical string (settings + console.warn lines + the three warning loaders). */
function evaluate(input: unknown, legacyFastProjection = false): string {
  const warns: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  let settings: unknown;
  let files: unknown = null;
  try {
    const loaded = loadSettings(input);
    settings = legacyFastProjection ? withoutFast(loaded, input) : loaded;
    if (input !== undefined) {
      const path = join(scratch, `case-${fileSeq++}.json`);
      writeFileSync(path, JSON.stringify(input));
      files = {
        lan: loadWebHubLanSettingsWarnings(path),
        proxy: loadWebHubProxyWarnings(path),
        feishu: loadFeishuBotWarnings(path),
      };
    }
  } finally {
    spy.mockRestore();
  }
  return stringify({ settings, warns, files });
}

const dumpDir = process.env.GOV_CORPUS_DUMP;
function dump(name: string, text: string): void {
  if (dumpDir) writeFileSync(join(dumpDir, `${name}.txt`), `${text}\n`);
}

/** Remove every retired path's leaf from a DEEP CLONE of the template —
 *  accepts either spelling (`confirmTimeoutMs` or its stored-seconds twin
 *  `confirmTimeoutS`) because the template only ever carries the `*Ms` form. */
function stripRetired(template: unknown, retiredPaths: readonly string[]): unknown {
  const out = JSON.parse(JSON.stringify(template, tagReplacer), untag) as unknown;
  let node: unknown = out;
  const paths = retiredPaths.map((p) => p.split("."));
  for (const segs of paths) {
    let cur = node as Record<string, unknown> | undefined;
    for (const seg of segs.slice(0, -1)) cur = cur?.[seg] as Record<string, unknown> | undefined;
    const leaf = segs[segs.length - 1]!;
    if (cur !== undefined) {
      delete cur[leaf];
      delete cur[`${leaf.slice(0, -2)}S`];
    }
  }
  return node;
}

/** task55: intentional additive /fast configuration. Preserve every old field's order/value
 * and all warns/files hashes, while checking the new block for every legacy input. The
 * generator continues to use the unprojected result; no corpus/template/hash is refreshed. */
function withoutFast(settings: typeof DEFAULT_SETTINGS, input?: unknown) {
  expect(settings.fast).toEqual({ enabled: true });
  // #39 declared additive keys only: every legacy case now parses both flags as true.
  // Preserve ALL old rows/fields/order; never regenerate or filter the frozen inputs.
  expect(settings.memory.scopes).toEqual({ session: true, hub: true });
  // #61 declared additive leaf only: every legacy case must parse the 9th wake leaf as the
  // default true (fabric/decision-input.ts owns the proof — the leaf alone mints nothing).
  expect(settings.fabric.wake.decisionRequests).toBe(true);
  // #62 intentional default change: only historical evaluations project the old budget.
  // Dedicated agent-min-total tests exercise the real 1800/600 defaults and live conversion.
  const { minTotalMs: _minTotal, ...oldBudget } = settings.budget;
  const normalizedInput =
    input !== null && typeof input === "object"
      ? normalizeTimeUnits(input as Record<string, unknown>, ["budget.totalGraceMs"])
      : {};
  // Preserve explicit historical overrides (including 0); only the fallback default was 90s.
  if (getPath(normalizedInput, "budget.totalGraceMs") === undefined) oldBudget.totalGraceMs = 90_000;
  // Count-only archive adds exactly one parsed leaf; dedicated settings tests pin
  // legacy alias and explicit-boolean precedence for the new behavior.
  expect(typeof settings.webHub.archiveEnabled).toBe("boolean");
  const { archiveEnabled: _archiveEnabled, ...oldWebHub } = settings.webHub;
  // Preserve valid explicit cooldown overrides; only old fallback values project to 8.
  const cooldown = getPath(normalizedInput, "todo.nudge.cooldownTurns");
  const validCooldown =
    typeof cooldown === "number" && Number.isFinite(cooldown) && Number.isInteger(cooldown) && cooldown > 0;
  const oldTodo = {
    ...settings.todo,
    nudge: { ...settings.todo.nudge, cooldownTurns: validCooldown ? settings.todo.nudge.cooldownTurns : 8 },
  };
  const { memory } = settings;
  const { scopes: _scopes, ...oldMemory } = memory;
  // #68 adds a bounded background queue; legacy corpus inputs have no such leaf.
  // Verify it explicitly, then project it out without changing frozen hashes/inputs.
  expect(memory.jev.backgroundQueueLimit).toBe(32);
  const { backgroundQueueLimit: _queueLimit, ...oldJev } = memory.jev;
  const legacyMemory = { ...oldMemory, jev: oldJev };
  const {
    fabric: {
      wake: { decisionRequests: _dr, ...oldWake },
    },
  } = settings;
  // Replace at the original memory position rather than appending it to the end.
  return Object.fromEntries(
    Object.entries(settings)
      .filter(([key]) => key !== "fast")
      .map(([key, value]) => [key, key === "budget" ? oldBudget : value])
      .map(([key, value]) => [key, key === "webHub" ? oldWebHub : value])
      .map(([key, value]) => [key, key === "todo" ? oldTodo : value])
      .map(([key, value]) => [key, key === "memory" ? legacyMemory : value])
      .map(([key, value]) => [key, key === "fabric" ? { ...value, wake: oldWake } : value]),
  );
}

const generateFrom = process.env.GOV_CORPUS_GENERATE;
if (generateFrom) {
  describe("settings corpus generation (baseline only)", () => {
    it("writes the corpus", async () => {
      const { TIME_SETTING_MS_PATHS } = await import("../../src/config/settings.js");
      const captured = (JSON.parse(readFileSync(generateFrom, "utf8")) as unknown[]).map(
        (item) => JSON.parse(JSON.stringify(item), untag) as unknown,
      );
      const head = {
        baseline: "90dbb88e",
        seed: 20261027,
        randomCount: 300,
        blocksPerKey: 14,
        template: JSON.parse(stringify(DEFAULT_SETTINGS)) as unknown,
        timePaths: [...TIME_SETTING_MS_PATHS],
      };
      const gen = generate(head);
      const corpus: Corpus = {
        ...head,
        defaultsSha: sha(stringify(DEFAULT_SETTINGS)),
        captured: captured.map((input) => ({
          input: JSON.parse(stringify(input)) as unknown,
          sha: sha(evaluate(input)),
        })),
        randomShas: gen.random.map((i) => sha(evaluate(i))),
        blockShas: gen.blocks.map((i) => sha(evaluate(i))),
      };
      writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 1));
      expect(corpus.captured.length).toBeGreaterThan(300);
    });
  });
} else {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;

  describe("settings decomposition corpus (byte-exact, key order included)", () => {
    it("DEFAULT_SETTINGS serialises identically (values + key order)", () => {
      const text = stringify(withoutFast(DEFAULT_SETTINGS));
      dump("defaults", text);
      expect(sha(text)).toBe(corpus.defaultsSha);
      // the frozen template is the same document MINUS retired paths (#26:
      //  confirmTimeoutMs left the live settings), so the generator below
      //  stays independent of live code AND generated inputs still cover
      //  the retired key as a tolerated stale input.
      expect(stringify(stripRetired(corpus.template, corpus.retiredPaths ?? []))).toBe(text);
    });

    it("captured tests/config inputs", () => {
      expect(corpus.captured.length).toBeGreaterThan(300);
      const bad: number[] = [];
      corpus.captured.forEach((c, i) => {
        const input = JSON.parse(JSON.stringify(c.input), untag) as unknown;
        const text = evaluate(input, true);
        dump(`captured-${i}`, text);
        if (sha(text) !== c.sha) bad.push(i);
      });
      expect(bad, `captured cases whose output changed (GOV_CORPUS_DUMP to inspect)`).toEqual([]);
    });

    it("seeded random whole-file mutations + per-block mutations", () => {
      const gen = generate(corpus);
      expect(gen.random).toHaveLength(corpus.randomShas.length);
      expect(gen.blocks).toHaveLength(corpus.blockShas.length);
      const bad: string[] = [];
      gen.random.forEach((input, i) => {
        const text = evaluate(input, true);
        dump(`random-${i}`, text);
        if (sha(text) !== corpus.randomShas[i]) bad.push(`random-${i}`);
      });
      gen.blocks.forEach((input, i) => {
        const text = evaluate(input, true);
        dump(`block-${i}`, text);
        if (sha(text) !== corpus.blockShas[i]) bad.push(`block-${i}`);
      });
      expect(bad, "generated cases whose output changed").toEqual([]);
    });

    it("the non-object sources keep their fallbacks", () => {
      for (const [name, input] of [
        ["undefined", undefined],
        ["null", null],
        ["number", 3],
        ["array", []],
      ] as const) {
        const text = evaluate(input, true);
        dump(`source-${name}`, text);
        expect(JSON.parse(text).settings.concurrencyLimit).toBe(DEFAULT_SETTINGS.concurrencyLimit);
      }
    });
  });
}
