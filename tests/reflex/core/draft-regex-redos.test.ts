/**
 * jev-reflex · #25 B0 DRX ReDoS isolation (BA §4.5 测试编排 r3 — THREE independent classes):
 *
 *  ① reject set — asserted WITHOUT execution in draft-regex.test.ts (main process, parse only).
 *  ② danger demo (below, `spawnSync` + `timeout: 2000`) — the classic `"a+".repeat(20)+"b"` shape
 *     evaluated by the NATIVE RegExp engine against 120 `a`s in a throwaway child. It is allowed
 *     to be killed by the deadline; the only acceptable outcomes are "killed by signal" or
 *     "survived but took > 1 s" — either proves the shape is genuinely dangerous, which is why DRX
 *     refuses it syntactically instead of trying to interrupt a synchronous match.
 *  ③ accept set (below, hard 5 s deadline) — 1,000 seeded-random DRX-compliant strong sources,
 *     each compiled by the native engine (anchored `^(?:…)$`) and run against 120cp adversarial
 *     NON-matching inputs (`2`×120, `吗`×120, alternating, strong-prefix + noise). The child must
 *     exit cleanly (status 0, no signal) and self-report < 2 s total — the empirical counterpart
 *     of the grammar's path-count argument (≤ 12·4·3 paths per start).
 *
 * This file is the ONLY reflex test that spawns child processes (TIER1_DECLARED, proc).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Deterministic PRNG (same shape as the settings-corpus generator). */
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

const WORDS = [
  "后台",
  "任务",
  "状态",
  "分支",
  "干净",
  "额度",
  "job",
  "git",
  "第",
  "个",
  "在跑",
  "看看",
  " ",
  "？",
  "清点",
];
const TAILS = ["", "(?:吗|呢)?"];

/** Build one seeded random DRX-valid strong source: ≤12 branches, ≤1 `\d{1,4}` inserted BETWEEN
 *  non-digit words (never adjacent to a digit literal — the grammar requirement), optional tail. */
function randomStrongSource(rnd: () => number): string {
  const branches = 1 + Math.floor(rnd() * 12);
  const generated: string[] = [];
  for (let b = 0; b < branches; b++) {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => WORDS[Math.floor(rnd() * WORDS.length)]!);
    const useDigits = rnd() < 0.6;
    const at = useDigits ? Math.floor(rnd() * (words.length + 1)) : -1; // insertion index
    let seq = "";
    for (let i = 0; i <= words.length; i++) {
      if (i === at) seq += "\\d{1,4}";
      if (i < words.length) seq += words[i];
    }
    seq += TAILS[Math.floor(rnd() * TAILS.length)]!;
    generated.push(seq);
  }
  // Length-budget join (never truncate mid-escape: only WHOLE branches join, total ≤ 160).
  const out: string[] = [];
  let len = 0;
  for (const seq of generated) {
    const extra = seq.length + (out.length > 0 ? 1 : 0);
    if (len + extra > 160) break;
    out.push(seq);
    len += extra;
  }
  if (out.length === 0) out.push("后台"); // pathological guard — the budget always fits one word
  return out.join("|");
}

const ADVERSARIAL_INPUTS = [
  "2".repeat(120),
  "吗".repeat(120),
  "2吗".repeat(60),
  "后台第" + "2".repeat(113) + "个 job",
  "后台任务状态".repeat(24),
  "第2个第2个第2个",
  "git git git git git git git git git git git git git git git git git git git git git git git git",
];

describe("DRX ReDoS isolation (BA §4.5 r3)", () => {
  it("class ② danger demo: native (a+){20}b vs 120 a's — killed or > 1 s (either proves the point)", () => {
    const child = [
      `const re = new RegExp(${JSON.stringify("a+".repeat(20) + "b")});`,
      `const hit = re.test("a".repeat(120));`,
      `process.stdout.write(String(hit));`,
    ].join("\n");
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, ["-e", child], { timeout: 2000, encoding: "utf8" });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // Acceptance: the deadline killed it (signal SIGTERM), OR it finished but took > 1 s.
    // (On any real machine this shape hangs; the disjunction keeps the test honest without
    // depending on engine speed.)
    const killed = r.signal !== null;
    expect(
      killed || elapsedMs > 1_000,
      `signal=${String(r.signal)} status=${String(r.status)} elapsed=${elapsedMs.toFixed(0)}ms`,
    ).toBe(true);
  });

  it("class ③ accept set: 1,000 DRX sources × adversarial inputs in an isolated child — clean exit, < 2 s", () => {
    const rnd = mulberry32(0x5eed_2026);
    const sources = Array.from({ length: 1_000 }, () => randomStrongSource(rnd));
    const child = [
      `let buf = "";`,
      `process.stdin.setEncoding("utf8");`,
      `process.stdin.on("data", (d) => (buf += d));`,
      `process.stdin.on("end", () => {`,
      `  const t0 = process.hrtime.bigint();`,
      `  const { sources, inputs } = JSON.parse(buf);`,
      `  let runs = 0;`,
      `  for (const src of sources) {`,
      `    const re = new RegExp("^(?:" + src + ")$");`,
      `    for (const input of inputs) { runs++; re.test(input); }`,
      `  }`,
      `  const ms = Number(process.hrtime.bigint() - t0) / 1e6;`,
      `  process.stdout.write(JSON.stringify({ ok: true, runs, ms }));`,
      `});`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["-e", child], {
      input: JSON.stringify({ sources, inputs: ADVERSARIAL_INPUTS }),
      timeout: 5_000,
      encoding: "utf8",
    });
    expect(r.error).toBeUndefined();
    expect(r.signal, `child killed by signal: ${String(r.signal)}`).toBeNull();
    expect(r.status, `child stderr: ${r.stderr ?? ""}`).toBe(0);
    const report = JSON.parse(r.stdout.trim().split("\n").pop()!) as { ok: boolean; runs: number; ms: number };
    expect(report.ok).toBe(true);
    expect(report.runs).toBe(1_000 * ADVERSARIAL_INPUTS.length);
    expect(report.ms, `self-reported ${report.ms}ms must stay under 2 s`).toBeLessThan(2_000);
  });
});
