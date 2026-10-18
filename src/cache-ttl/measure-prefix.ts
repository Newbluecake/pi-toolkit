/**
 * Deterministic synthetic prefix for `/cache-ttl measure` (measure-plan.md r4 §3.1). Pure and pi-free (node:crypto
 * only).
 *
 * Every (runId, slot, attempt) maps to ONE byte-identical prefix: the nonce is `sha256(runId:slot:attempt)` (24 hex)
 * and seeds the log filler, so two slots — and a replacement write of the same slot — can never share a cached prefix.
 * The nonce sits at the very START of both the system prompt and the user text, so no provider-side prefix match can
 * survive across nonces. The session id is identical on every send of one prefix (it is also the Responses
 * `prompt_cache_key` source) and different per attempt.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Millis } from "../core/types.js";
import type { PipelinePingContext } from "./pipeline-ping-types.js";
import { PREFIX_CHARS, type SyntheticPrefix } from "./measure-types.js";

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `m-<base36 now>-<8 hex>`; `randomHex` is a test seam (default: 4 random bytes). */
export function makeRunId(now: Millis, randomHex: () => string = () => randomBytes(4).toString("hex")): string {
  return `m-${Math.max(0, Math.floor(now)).toString(36)}-${randomHex().slice(0, 8).padEnd(8, "0")}`;
}

/** 24 hex chars; a replacement write (attempt + 1) always gets a new nonce. */
export function nonceOf(runId: string, slot: number, attempt: number): string {
  return sha256Hex(`${runId}:${slot}:${attempt}`).slice(0, 24);
}

export function sessionIdOf(runId: string, slot: number, attempt: number): string {
  return `ttl-measure-${runId}-${slot}-${attempt}`;
}

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

/**
 * Log-shaped deterministic filler (word-salad is refused by some models); nonce-seeded ⇒ globally unique. Copied in
 * shape from `scripts/exp/keepalive-protocol-probe.mjs` (filler); exactly `chars` characters.
 */
export function logFiller(seed: string, chars: number): string {
  const r = mulberry32(parseInt(sha256Hex(seed).slice(0, 8), 16));
  const lines: string[] = [];
  let n = 0;
  while (n < chars) {
    const hh = String(Math.floor(r() * 24)).padStart(2, "0");
    const mm = String(Math.floor(r() * 60)).padStart(2, "0");
    const ss = String(Math.floor(r() * 60)).padStart(2, "0");
    const line =
      `2026-10-18T${hh}:${mm}:${ss}Z INFO service-${Math.floor(r() * 7)} request ` +
      `id=${Math.floor(r() * 0xffffff).toString(16)} completed in ${20 + Math.floor(r() * 400)}ms ` +
      `status=${r() < 0.9 ? 200 : 500} user=u${Math.floor(r() * 900)}`;
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join("\n").slice(0, chars);
}

export function systemPromptOf(nonce: string): string {
  return `Nonce ${nonce}. You are a terse log triage assistant. Answer with a single short word.`;
}

export function userTextOf(nonce: string, fillerChars: number = PREFIX_CHARS): string {
  return (
    `Nonce ${nonce}. Log excerpt follows.\n` +
    logFiller(nonce, fillerChars) +
    `\n\nTask: ignore the log and reply with exactly the word OK.`
  );
}

export function buildPrefix(runId: string, slot: number, attempt: number): SyntheticPrefix {
  const nonce = nonceOf(runId, slot, attempt);
  const systemPrompt = systemPromptOf(nonce);
  const userText = userTextOf(nonce);
  // `timestamp` is not on the wire; a constant keeps the context itself deterministic.
  const context: PipelinePingContext = {
    systemPrompt,
    messages: [{ role: "user", content: userText, timestamp: 0 }],
  };
  return { slot, attempt, nonce, sessionId: sessionIdOf(runId, slot, attempt), systemPrompt, userText, context };
}
