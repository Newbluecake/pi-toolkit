/**
 * jev-reflex · #25 B4 perf (BA §4.5/§4.6): the cost a loaded draft set adds to an input that PASSES S0 and
 * MISSES the builtin catalog — i.e. the draft matcher's failing-match path. 16 maxed-out drafts
 * (strong 12 / weak 8 / exclude 32, every source DRX-valid), 10,000 recorded matches over ordinary and
 * adversarial inputs; asserts p99 and reports max.
 *
 * This measures; it does NOT replace the DRX grammar proof (matching cost is bounded by the grammar —
 * ≤12·4·3 paths per start — not by this benchmark). The 5 ms bound is the 1 ms target ×5 CI tolerance
 * (same convention as `core/perf.test.ts`); a loaded CI host may jitter, so max is only printed.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { parseDrx } from "../../../src/reflex/core/draft-regex.js";
import { evaluateGate } from "../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../src/reflex/core/match.js";
import { MVP_PORTS, portDefaultsOf } from "../../../src/reflex/core/port-defaults.js";
import type { Capability, RScriptV1 } from "../../../src/reflex/core/types.js";

const CAPS: ReadonlySet<Capability> = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);
const N = 10_000;

/** Distinct-vocabulary literals so every draft carries real, different regexes. */
function fullDraft(k: number): RScriptV1 {
  const port = MVP_PORTS[k % MVP_PORTS.length]!;
  const d = portDefaultsOf(port)!;
  const strong = Array.from({ length: 12 }, (_, i) =>
    i % 3 === 0
      ? `词${k}段${i}第\\d{1,4}项(?:吗|呢)?`
      : i % 3 === 1
        ? `词${k}段${i}还剩多少`
        : `词${k}段${i}\\.现在怎样`,
  );
  const weak = Array.from({ length: 8 }, (_, i) => `弱词${k}${i}`);
  const exclude = Array.from({ length: 32 }, (_, i) => `排除词${k}号${i}`);
  return {
    schema: "rscript/1",
    id: `draft.perf-${k}`,
    version: 1,
    origin: "extracted",
    risk: "readonly",
    intent: { strong, weak, exclude, examples: { hit: [], miss: [] } },
    port: { id: port },
    requires: [...d.requires],
    render: { ...d.render },
    agreement: { tools: [...d.agreement.tools], bashShapes: [...d.agreement.bashShapes] },
  };
}

const DRAFTS = Array.from({ length: 16 }, (_, k) => fullDraft(k));

function inputs(): string[] {
  const base = [
    "你好",
    "帮我看看这个函数为什么返回 undefined",
    "what is the weather like today in shanghai",
    "词3段4还剩",
    "词3段0第12项",
    "词5段1还剩多少多",
    "排除词2号3",
    "弱词00 其他内容",
  ];
  const adversarial = [
    "2".repeat(120),
    "吗".repeat(120),
    "第".repeat(120),
    "项".repeat(120),
    "词3段0第".repeat(15),
    "1吗1吗1吗".repeat(20).slice(0, 120),
    "词1段0第" + "9".repeat(110),
    "词1段0第1234项" + "吗".repeat(100),
    "词1段2.现在怎样".repeat(8),
    "a".repeat(119) + "!",
  ];
  const out: string[] = [];
  for (let i = 0; out.length < N; i++)
    out.push(i % 4 === 0 ? adversarial[(i >> 2) % adversarial.length]! : base[i % base.length]!);
  return out;
}

describe("draft matcher failing-match latency", () => {
  it("every perf source is DRX-valid (so the numbers describe what can actually load)", () => {
    for (const d of DRAFTS) {
      for (const s of d.intent.strong) expect(parseDrx(s, "strong").ok, s).toBe(true);
      for (const s of d.intent.weak) expect(parseDrx(s, "weak").ok, s).toBe(true);
      for (const s of d.intent.exclude) expect(parseDrx(s, "exclude").ok, s).toBe(true);
      expect([d.intent.strong.length, d.intent.weak.length, d.intent.exclude.length]).toEqual([12, 8, 32]);
    }
  });

  it("S0 passes + builtin misses ⇒ 16 full drafts: 10k matches, p99 ≤ 5 ms (target 1 ms, ×5 CI tolerance)", () => {
    const builtin = compileCatalog(BUILTIN_SCRIPTS);
    const drafts = compileCatalog(DRAFTS);
    // keep only inputs that reach the draft layer (S0 pass ∧ builtin miss) — that is the path being priced
    const norms: string[] = [];
    for (const text of inputs()) {
      const g = evaluateGate({
        source: "interactive",
        mode: "tui",
        streamingBehavior: undefined,
        idle: true,
        pendingMessages: false,
        imageCount: 0,
        text,
        topicSwitchActive: false,
        goalBusy: false,
        inFlight: false,
      });
      if (g.pass && builtin.match(g.norm.norm, CAPS).kind === "miss") norms.push(g.norm.norm);
    }
    expect(norms.length).toBeGreaterThan(N / 3); // the filter must not hollow the benchmark out
    const samples: number[] = [];
    for (let i = 0; samples.length < N; i++) {
      const norm = norms[i % norms.length]!;
      const t0 = performance.now();
      drafts.match(norm, CAPS);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)]!;
    const max = samples[samples.length - 1]!;
    console.log(
      `[reflex draft perf] n=${samples.length} reachable=${norms.length} p99=${p99.toFixed(4)}ms max=${max.toFixed(4)}ms`,
    );
    expect(p99).toBeLessThanOrEqual(5);
  });
});
