import { describe, expect, it } from "vitest";
import {
  buildPrefix,
  logFiller,
  makeRunId,
  nonceOf,
  sessionIdOf,
  systemPromptOf,
  userTextOf,
} from "../../src/cache-ttl/measure-prefix.js";
import { PREFIX_CHARS } from "../../src/cache-ttl/measure-types.js";

describe("measure prefix", () => {
  it("runId = m-<base36 now>-<8 hex>, with an injectable random part", () => {
    expect(makeRunId(1_792_300_000_000, () => "1f2e3d4c")).toBe(`m-${(1_792_300_000_000).toString(36)}-1f2e3d4c`);
    expect(makeRunId(5)).toMatch(/^m-[0-9a-z]+-[0-9a-f]{8}$/);
  });

  it("nonce = 24 hex of sha256(runId:slot:attempt); distinct per slot and per attempt", () => {
    const n = nonceOf("m-x-1", 0, 0);
    expect(n).toMatch(/^[0-9a-f]{24}$/);
    const all = new Set<string>();
    for (let slot = 0; slot < 6; slot++)
      for (let attempt = 0; attempt < 3; attempt++) all.add(nonceOf("m-x-1", slot, attempt));
    expect(all.size).toBe(18);
    expect(nonceOf("m-x-2", 0, 0)).not.toBe(n);
  });

  it("is deterministic: same (run, slot, attempt) ⇒ byte-identical prefix", () => {
    const a = buildPrefix("m-run-aaaa1111", 2, 0);
    const b = buildPrefix("m-run-aaaa1111", 2, 0);
    expect(a).toEqual(b);
    expect(a.userText).toBe(b.userText);
  });

  it("nonce sits at the START of both the system prompt and the user text", () => {
    const p = buildPrefix("m-run-aaaa1111", 3, 1);
    expect(p.systemPrompt.startsWith(`Nonce ${p.nonce}. `)).toBe(true);
    expect(p.userText.startsWith(`Nonce ${p.nonce}. Log excerpt follows.\n`)).toBe(true);
    expect(p.systemPrompt).toBe(systemPromptOf(p.nonce));
    expect(p.userText).toBe(userTextOf(p.nonce));
  });

  it("~37,500 chars of filler (exact) and the task suffix at the end", () => {
    const p = buildPrefix("m-run-aaaa1111", 0, 0);
    const header = `Nonce ${p.nonce}. Log excerpt follows.\n`;
    const suffix = "\n\nTask: ignore the log and reply with exactly the word OK.";
    expect(p.userText.length).toBe(header.length + PREFIX_CHARS + suffix.length);
    expect(p.userText.endsWith(suffix)).toBe(true);
    expect(logFiller(p.nonce, PREFIX_CHARS)).toHaveLength(37_500);
  });

  it("different slots / replacement attempts never share a long common prefix", () => {
    const base = buildPrefix("m-run-aaaa1111", 0, 0);
    for (const other of [buildPrefix("m-run-aaaa1111", 1, 0), buildPrefix("m-run-aaaa1111", 0, 1)]) {
      let i = 0;
      while (i < base.userText.length && base.userText[i] === other.userText[i]) i++;
      // only the fixed "Nonce " lead can be shared — far below any cache block size
      expect(i).toBeLessThan(10);
      let j = 0;
      while (j < base.systemPrompt.length && base.systemPrompt[j] === other.systemPrompt[j]) j++;
      expect(j).toBeLessThan(10);
    }
  });

  it("sessionId is stable per prefix and unique per attempt", () => {
    const a0 = buildPrefix("m-r", 4, 0);
    const a1 = buildPrefix("m-r", 4, 1);
    expect(a0.sessionId).toBe(sessionIdOf("m-r", 4, 0));
    expect(a0.sessionId).toBe("ttl-measure-m-r-4-0");
    expect(a1.sessionId).not.toBe(a0.sessionId);
  });

  it("context = system prompt + exactly one user message with the user text", () => {
    const p = buildPrefix("m-r", 1, 0);
    expect(p.context.systemPrompt).toBe(p.systemPrompt);
    expect(p.context.messages).toHaveLength(1);
    expect(p.context.messages[0]).toMatchObject({ role: "user", content: p.userText });
    expect(p.context.tools).toBeUndefined();
  });

  it("filler is log-shaped (not word salad)", () => {
    const f = logFiller("seed", 2000);
    expect(f.split("\n")[0]).toMatch(
      /^2026-10-18T\d\d:\d\d:\d\dZ INFO service-\d request id=[0-9a-f]+ completed in \d+ms status=\d+ user=u\d+/,
    );
  });
});
