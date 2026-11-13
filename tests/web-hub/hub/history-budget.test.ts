import { describe, expect, it, vi } from "vitest";
import type { HistoryPayload } from "../../../src/web-hub/protocol/http-contract.js";
import type { InflightState, WireEntry, WireMessage } from "../../../src/web-hub/protocol/messages.js";
import {
  buildCappedHistoryPayload,
  createHistoryService,
  MAX_HISTORY_PAYLOAD_BYTES,
} from "../../../src/web-hub/hub/history.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import { formatSseFrame } from "../../../src/web-hub/hub/sse.js";
import { memLog } from "./helpers.js";

type Build = (entries: WireEntry[]) => HistoryPayload;
type Frame = (payload: HistoryPayload) => string;

// Deliberately retain the old algorithm, independent of the production byte arithmetic.
function legacyCap(entries: readonly WireEntry[], maxBytes: number, build: Build, frame: Frame): HistoryPayload {
  let total = 0;
  let cut = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(entries[i]), "utf8");
    if (i !== entries.length - 1 && total + size > maxBytes) break;
    total += size;
    cut = i;
  }
  let capped = entries.slice(cut);
  let payload = build(capped);
  while (capped.length > 1 && Buffer.byteLength(frame(payload), "utf8") > maxBytes) {
    capped = capped.slice(1);
    payload = build(capped);
  }
  return payload;
}

const entry = (id: string, content: string): WireEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-11-14T00:00:00.000Z",
  message: { role: "user", content },
});

function builder(
  entries: readonly WireEntry[],
  opts: { more?: boolean; tailMessages?: WireMessage[]; inflight?: InflightState; source?: "file" | "agent" } = {},
): Build {
  return (candidate) => {
    // Same property insertion order and candidate-dependent fields as snapshot/page.
    const payload: HistoryPayload = {
      agentKey: '种子🧪"\\\n',
      entries: candidate,
      tailMessages: opts.tailMessages ?? [],
      fromSeq: 123456789,
      hasMore: opts.more === true || candidate.length < entries.length,
      source: opts.source ?? "file",
    };
    if (opts.inflight !== undefined) {
      payload.sessionId = "session-🧪";
      payload.inflight = opts.inflight;
    }
    const oldest = candidate[0]?.id;
    if (oldest !== undefined) payload.oldestEntryId = oldest;
    return payload;
  };
}

const renderers: Record<string, Frame> = {
  snapshot: (p) => formatSseFrame("history", p),
  page: (p) => JSON.stringify(p),
};

function parity(entries: WireEntry[], budget: number, build: Build, frame: Frame): HistoryPayload {
  const expected = legacyCap(entries, budget, build, frame);
  const actual = buildCappedHistoryPayload(entries, budget, build, frame);
  expect(Buffer.from(frame(actual)).equals(Buffer.from(frame(expected)))).toBe(true);
  expect(actual.entries.at(-1)).toEqual(entries.at(-1));
  expect(actual.oldestEntryId).toBe(actual.entries[0]?.id);
  if (actual.entries.length > 1) expect(Buffer.byteLength(frame(actual))).toBeLessThanOrEqual(budget);
  return actual;
}

describe("history complete-wire linear budget", () => {
  it.each(Object.entries(renderers))(
    "%s: seeded UTF-8/escape payloads are byte-identical to the old algorithm",
    (_name, frame) => {
      let seed = 0x36b2026;
      const random = (max: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
      };
      const alphabet = ["a", "中", "🧪", '"', "\\", "\n", "\r\t", "\ud800", "é"];
      const text = (count: number): string =>
        Array.from({ length: count }, () => alphabet[random(alphabet.length)]!).join("");
      for (let round = 0; round < 64; round++) {
        const entries = Array.from({ length: random(45) }, (_, i) =>
          entry(`${i}-${text(random(80))}`, text(random(600))),
        );
        const build = builder(entries, {
          more: random(2) === 0,
          source: random(2) === 0 ? "agent" : "file",
          tailMessages: [{ role: "custom", customType: "seed", content: text(random(1200)) }],
          inflight: { tools: [{ toolCallId: "call", toolName: "bash", args: { command: text(random(2400)) } }] },
        });
        const fullBytes = Buffer.byteLength(frame(build(entries)));
        const newestBytes = Buffer.byteLength(frame(build(entries.slice(-1))));
        const entriesOnly = entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0);
        for (const budget of [
          0,
          1,
          newestBytes - 1,
          newestBytes,
          fullBytes - 1,
          fullBytes,
          entriesOnly,
          random(fullBytes + 1),
        ]) {
          parity(entries, budget, build, frame);
        }
      }
    },
  );

  it.each(Object.entries(renderers))(
    "%s: exact budget, +/-1 byte, newest-only and small-entry separator boundaries",
    (_name, frame) => {
      const entries = Array.from({ length: 400 }, (_, i) => entry(`e${i}`, ""));
      const build = builder(entries);
      const exact = Buffer.byteLength(frame(build(entries)));
      expect(parity(entries, exact, build, frame).entries).toHaveLength(400);
      expect(parity(entries, exact + 1, build, frame).entries).toHaveLength(400);
      expect(parity(entries, exact - 1, build, frame).entries).toHaveLength(399);
      const newest = Buffer.byteLength(frame(build(entries.slice(-1))));
      expect(parity(entries, newest, build, frame).entries).toHaveLength(1);
      expect(parity(entries, newest - 1, build, frame).entries).toHaveLength(1);
      expect(parity([], 0, builder([]), frame).entries).toHaveLength(0);
    },
  );

  it("does not assume cursor-size monotonicity, and accounts for hasMore false → true", () => {
    const entries = [entry("x".repeat(3000), ""), entry("短🧪", ""), entry("z".repeat(6000), ""), entry("new", "")];
    const build = builder(entries);
    const frame = renderers.snapshot!;
    const budget = Buffer.byteLength(frame(build(entries.slice(1))));
    const p = parity(entries, budget, build, frame);
    expect(p.entries).toHaveLength(3);
    expect(p.hasMore).toBe(true);
    expect(p.oldestEntryId).toBe("短🧪");
  });

  it("measures each entry once and serializes only fixed + final payload, even with large fixed data", () => {
    const entries = Array.from({ length: 400 }, (_, i) => entry(`e${i}`, "x".repeat(4000)));
    const tailMessages: WireMessage[] = [{ role: "user", content: "🧪".repeat(100_000) }];
    const inflight = {
      tools: [{ toolCallId: "call", toolName: "bash", args: { parts: Array(20).fill("z".repeat(60_000)) } }],
    };
    const build = builder(entries, { tailMessages, inflight });
    const original = JSON.stringify;
    const entryCalls = new Map<WireEntry, number>();
    const entrySet = new Set(entries);
    const payloads: HistoryPayload[] = [];
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      if (entrySet.has(value as WireEntry))
        entryCalls.set(value as WireEntry, (entryCalls.get(value as WireEntry) ?? 0) + 1);
      if ((value as HistoryPayload | null)?.agentKey === '种子🧪"\\\n') payloads.push(value as HistoryPayload);
      return original(value);
    });
    let actual: HistoryPayload;
    try {
      actual = buildCappedHistoryPayload(entries, MAX_HISTORY_PAYLOAD_BYTES, build, renderers.snapshot!);
    } finally {
      spy.mockRestore();
    }
    expect(entryCalls.size).toBe(400);
    expect([...entryCalls.values()]).toEqual(Array(400).fill(1));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]!.entries).toHaveLength(0);
    expect(payloads[1]).toBe(actual);
    expect(actual.tailMessages).toBe(tailMessages);
    expect(actual.inflight).toBe(inflight);
    expect(actual.entries.length).toBeGreaterThan(1);
    expect(actual.entries.length).toBeLessThan(400);
    expect(formatSseFrame("history", actual)).toBe(
      formatSseFrame("history", legacyCap(entries, MAX_HISTORY_PAYLOAD_BYTES, build, renderers.snapshot!)),
    );
  });

  it.each([0, 600_000, 1_200_000])(
    "production snapshot: %i inflight characters use constant full-payload serializations",
    async (inflightBytes) => {
      const entries = Array.from({ length: 400 }, (_, i) => entry(`e${i}`, "x".repeat(4000)));
      const inflight =
        inflightBytes === 0
          ? undefined
          : {
              tools: [
                {
                  toolCallId: "call",
                  toolName: "bash",
                  args: { parts: Array(inflightBytes / 60_000).fill("z".repeat(60_000)) },
                },
              ],
            };
      const registry = {
        get: () => ({ seq: 10, status: { leafId: "e399" }, session: { leafId: "e399" } }),
        bus: { subscribe: () => () => {} },
        request: async (_key: string, f: { t: string }) => {
          if (f.t === "snapshot_req")
            return { seq: 10, leafId: "e399", recent: [], ...(inflight === undefined ? {} : { inflight }) };
          if (f.t === "branch_req") return { entries, truncated: false };
          throw new Error(`Unexpected request: ${f.t}`);
        },
      } as unknown as Registry;
      const h = createHistoryService({ registry, log: memLog() });
      const original = JSON.stringify;
      let calls = 0;
      const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
        if ((value as HistoryPayload | null)?.agentKey === "perf-history") calls++;
        return original(value);
      });
      let p: HistoryPayload;
      const start = performance.now();
      try {
        p = await h.snapshot("perf-history");
      } finally {
        spy.mockRestore();
        h.dispose();
      }
      const elapsed = performance.now() - start;
      expect(calls).toBe(2);
      expect(p.entries.at(-1)?.id).toBe("e399");
      expect(p.fromSeq).toBe(11);
      expect(p.source).toBe("agent");
      expect(p.inflight).toEqual(inflight);
      expect(p.oldestEntryId).toBe(p.entries[0]?.id);
      expect(p.hasMore).toBe(p.entries.length < 400);
      expect(Buffer.byteLength(formatSseFrame("history", p))).toBeLessThanOrEqual(MAX_HISTORY_PAYLOAD_BYTES);
      console.log(
        `history linear budget: inflight=${inflightBytes} entries=${p.entries.length} serializations=${calls} snapshot=${elapsed.toFixed(3)}ms`,
      );
    },
  );
});
