import { describe, expect, it } from "vitest";
import { createXsDirectoryCache, type XsDirectoryRow } from "../../src/fabric/xs/directory.js";
import { XS_LIST_MAX_ROWS } from "../../src/web-hub/protocol/xs.js";

function row(ref: string, name?: string, channels?: string[]): XsDirectoryRow {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/x",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 1,
    ...(channels !== undefined ? { channels } : {}),
  };
}

function make(view: () => { key: string; channels?: readonly string[] } | undefined) {
  let now = 1_000_000;
  const cache = createXsDirectoryCache({ source: { view, fetch: async () => undefined }, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

describe("channel-plan §4.3 directory (CH5)", () => {
  it("exactly XS_LIST_MAX_ROWS rows ⇒ truncated: lookupExact undefined, rows() intact", () => {
    const { cache } = make(() => ({ key: "k" }));
    const full = Array.from({ length: XS_LIST_MAX_ROWS }, (_, i) => row(`r${i}`, i === 0 ? "alice" : `n${i}`));
    cache.ingest(full);
    expect(cache.truncated()).toBe(true);
    expect(cache.lookupExact("alice")).toBeUndefined();
    expect(cache.rows()).toHaveLength(XS_LIST_MAX_ROWS);
  });

  it("19 rows ⇒ not truncated, unique name resolves", () => {
    const { cache } = make(() => ({ key: "k" }));
    cache.ingest(Array.from({ length: XS_LIST_MAX_ROWS - 1 }, (_, i) => row(`r${i}`, i === 0 ? "alice" : `n${i}`)));
    expect(cache.truncated()).toBe(false);
    expect(cache.lookupExact("alice")?.ref).toBe("r0");
  });

  it("uniqueness is judged over the visible union (rows across channels)", () => {
    const { cache } = make(() => ({ key: "k" }));
    cache.ingest([row("a1", "bob", ["a"]), row("b1", "carol", ["b"])]);
    expect(cache.lookupExact("bob")?.ref).toBe("a1");
    expect(cache.lookupExact("carol")?.ref).toBe("b1");
    cache.ingest([row("a1", "bob", ["a"]), row("b1", "bob", ["b"])]);
    expect(cache.lookupExact("bob")).toBeUndefined();
  });

  it("local channel change clears the cache; same key+channels keeps it", () => {
    let channels: string[] = ["default"];
    const { cache } = make(() => ({ key: "k", channels }));
    cache.ingest([row("a1", "bob")]);
    expect(cache.lookupExact("bob")).toBeDefined();
    expect(cache.lookupExact("bob")).toBeDefined();
    channels = ["default", "a"];
    expect(cache.rows()).toEqual([]);
    expect(cache.lookupExact("bob")).toBeUndefined();
  });

  it("others changing channels does not clear; data still expires at 10 min", () => {
    const { cache, advance } = make(() => ({ key: "k", channels: ["a"] }));
    cache.ingest([row("a1", "bob", ["a"])]);
    expect(cache.lookupExact("bob")).toBeDefined(); // no event can clear it
    advance(10 * 60_000 + 1);
    expect(cache.lookupExact("bob")).toBeUndefined();
  });
});
