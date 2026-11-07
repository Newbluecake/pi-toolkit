import { describe, expect, it } from "vitest";
import {
  generationHistoryIndex,
  sanitizeGenerationCore,
  sanitizeGenerationMetadata,
  WEB_MESSAGE_SPEED_ENTRY_TYPE,
} from "../../../src/web-hub/protocol/message-generation.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import { projectMessage } from "../../../src/web-hub/agent/event-tap.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
const core = { v: 1, tokens: 10, genMs: 500, deltaCount: 2 };
const entry = (id: string, type: string, extra: Record<string, unknown>) => ({
  id,
  parentId: null,
  timestamp: "2026-01-01",
  type,
  ...extra,
});
const message = (id: string) =>
  entry(id, "message", { message: { role: "assistant", content: [], timestamp: 0, piToolkitGeneration: core } });
const metadata = (id: string, mid: string, extra: Record<string, unknown> = {}) =>
  entry(id, "custom", { customType: WEB_MESSAGE_SPEED_ENTRY_TYPE, piToolkitGeneration: { ...core, mid, ...extra } });
describe("generation shared contract", () => {
  it("live has no mid requirement, persistence requires exact bounded mid and strips extras", () => {
    expect(sanitizeGenerationCore({ ...core, secret: "no" })).toEqual(core);
    expect(sanitizeGenerationMetadata(core)).toBeUndefined();
    expect(sanitizeGenerationMetadata({ ...core, mid: " x ", secret: "no" })).toEqual({ ...core, mid: " x " });
    for (const mid of ["", "a".repeat(257), "a\n", 1, null])
      expect(sanitizeGenerationMetadata({ ...core, mid })).toBeUndefined();
  });
  it.each([
    ["v", 0],
    ["v", "1"],
    ["tokens", 0],
    ["tokens", 1.5],
    ["tokens", 10_000_001],
    ["tokens", NaN],
    ["tokens", Infinity],
    ["genMs", 499],
    ["genMs", 86_400_001],
    ["genMs", NaN],
    ["deltaCount", 1],
    ["deltaCount", 1.5],
    ["deltaCount", 1_000_001],
  ])("rejects %s=%s", (key, value) =>
    expect(sanitizeGenerationCore({ ...core, [key as string]: value })).toBeUndefined(),
  );
  it("accepts exact upper bounds and fractional monotonic milliseconds", () => {
    expect(
      sanitizeGenerationCore({ v: 1, tokens: 10_000_000, genMs: 86_400_000, deltaCount: 1_000_000 }),
    ).toBeDefined();
    expect(sanitizeGenerationCore({ ...core, genMs: 500.25 })).toEqual({ ...core, genMs: 500.25 });
  });
  it("rejects inherited/accessor/throwing descriptors without invoking getters", () => {
    let calls = 0;
    const obj = { ...core };
    Object.defineProperty(obj, "tokens", {
      get() {
        calls++;
        throw new Error("getter");
      },
    });
    expect(sanitizeGenerationCore(obj)).toBeUndefined();
    expect(calls).toBe(0);
    expect(sanitizeGenerationCore(Object.create(core))).toBeUndefined();
    expect(
      sanitizeGenerationCore(
        new Proxy(core, {
          getOwnPropertyDescriptor() {
            throw new Error("trap");
          },
        }),
      ),
    ).toBeUndefined();
  });
  it("strips SDK spoofed containers in live and history; projects only valid explicit metadata", () => {
    const raw = message("mid");
    expect(projectMessage(raw.message, { truncated: false })).not.toHaveProperty("piToolkitGeneration");
    expect(projectSessionEntry(raw)?.message).not.toHaveProperty("piToolkitGeneration");
    const projected = projectSessionEntry(
      entry("meta", "custom", {
        customType: WEB_MESSAGE_SPEED_ENTRY_TYPE,
        data: { piToolkitGeneration: { ...core, mid: "mid", secret: "no" } },
      }),
    );
    expect(projected?.piToolkitGeneration).toEqual({ ...core, mid: "mid" });
    expect(projected?.display).toBe(false);
    expect(projected).not.toHaveProperty("data");
    const invalid = projectSessionEntry(
      entry("meta", "custom", { customType: WEB_MESSAGE_SPEED_ENTRY_TYPE, data: { piToolkitGeneration: core } }),
    );
    expect(invalid).not.toHaveProperty("piToolkitGeneration");
  });
  it("loaded-only exact-mid index caps at 512 and rebuild removes, replaces, changes branches", () => {
    const loaded = Array.from({ length: 513 }, (_, i) => message(`mid${i}`));
    const metas = Array.from({ length: 513 }, (_, i) => metadata(`meta${i}`, `mid${i}`));
    const index = generationHistoryIndex([...loaded, ...metas]);
    expect(index.size).toBe(512);
    expect(index.has("mid0")).toBe(false);
    expect(index.get("mid512")).toEqual(core);
    expect(generationHistoryIndex([loaded[1], metas[1], metadata("wrong", "not-loaded")]).size).toBe(1);
    expect(generationHistoryIndex([loaded[1]])).toEqual(new Map());
    expect(generationHistoryIndex([metas[1]])).toEqual(new Map());
    expect(generationHistoryIndex([])).toEqual(new Map());
    expect(
      generationHistoryIndex([
        loaded[1],
        metas[1],
        metadata("new", "mid1", { tokens: 20 }),
        metadata("invalid", "mid1", { tokens: 0 }),
      ]).get("mid1"),
    ).toEqual({ ...core, tokens: 20 });
    // Metadata can precede its explicit message; no adjacent-entry inference.
    expect(generationHistoryIndex([metas[1], loaded[1]]).get("mid1")).toEqual(core);
  });
  it("both-version compat: old consumers ignore append-only field, old agents hide, PROTO unchanged", () => {
    const legacy = { role: "assistant", content: [], timestamp: 0 };
    const newMessage = { ...legacy, piToolkitGeneration: core };
    const oldConsumer = ({ role, content, timestamp }: { role: string; content: unknown[]; timestamp: number }) => ({
      role,
      content,
      timestamp,
    });
    expect(oldConsumer(newMessage)).toEqual(legacy);
    expect(sanitizeGenerationCore((legacy as Record<string, unknown>).piToolkitGeneration)).toBeUndefined();
    expect(PROTO).toEqual({ major: 1, minor: 2 });
  });
});
