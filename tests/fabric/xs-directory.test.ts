import { describe, expect, it } from "vitest";
import {
  createXsDirectoryCache,
  type XsDirectoryRow,
  type XsDirectorySourcePort,
} from "../../src/fabric/xs/directory.js";

/**
 * fabric reply-plan §9.2 (package M): the @mention directory cache — single-flight, ≥30s
 * refresh interval, 3s fetch deadline, failure keeps old rows, 10-min staleness, identity-key
 * change (epoch bump / leave / `/new`) clears, not-joined ⇒ rows [] + refresh no-op.
 */

function row(ref: string, name?: string): XsDirectoryRow {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/repo",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 5,
  };
}

interface Harness {
  cache: ReturnType<typeof createXsDirectoryCache>;
  fetched: number;
  setKey(key: string | undefined): void;
  setFetch(impl: () => Promise<readonly XsDirectoryRow[] | undefined>): void;
  advance(ms: number): void;
  now(): number;
}

function harness(init?: { key?: string | null }): Harness {
  let key: string | null | undefined = init?.key === undefined ? "s1#0" : init.key; // null ⇒ not joined
  let fetchImpl: () => Promise<readonly XsDirectoryRow[] | undefined> = async () => [row("ab12cd34")];
  let now = 1_000_000;
  let fetched = 0;
  const source: XsDirectorySourcePort = {
    view: () => (key == null ? undefined : { key }),
    fetch: () => {
      fetched += 1;
      return fetchImpl();
    },
  };
  const cache = createXsDirectoryCache({ source, now: () => now });
  return {
    cache,
    get fetched() {
      return fetched;
    },
    setKey(next: string | null | undefined) {
      key = next;
    },
    setFetch(impl: () => Promise<readonly XsDirectoryRow[] | undefined>) {
      fetchImpl = impl;
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe("xs directory cache (reply-plan §9.2)", () => {
  it("not joined: rows() is [] and refresh is a no-op (never fetches)", async () => {
    const h = harness({ key: null });
    expect(h.cache.rows()).toEqual([]);
    expect(h.cache.lookupExact("ab12cd34")).toBeUndefined();
    await h.cache.refresh("complete");
    expect(h.fetched).toBe(0);
  });

  it("refresh stores rows and lookupExact resolves the UNIQUE exact name/ref hit", async () => {
    const h = harness();
    h.setFetch(async () => [row("ab12cd34", "builder"), row("ef9911aa")]);
    await h.cache.refresh("complete");
    expect(h.cache.rows()).toHaveLength(2);
    expect(h.cache.lookupExact("builder")?.ref).toBe("ab12cd34"); // by name
    expect(h.cache.lookupExact("ef9911aa")?.ref).toBe("ef9911aa"); // by ref
  });

  it("lookupExact: zero hits and 2+ hits (incl. name/ref cross hits) are undefined", async () => {
    const h = harness();
    h.setFetch(async () => [row("ab12cd34", "builder"), row("ef9911aa"), row("77aa", "builder")]);
    await h.cache.refresh("complete");
    expect(h.cache.lookupExact("nobody")).toBeUndefined();
    expect(h.cache.lookupExact("builder")).toBeUndefined(); // duplicate name
    expect(h.cache.lookupExact("ab12cd34")?.ref).toBe("ab12cd34"); // a unique ref still resolves
  });

  it("refresh is throttled to one attempt per interval and single-flights concurrent calls", async () => {
    const h = harness();
    await h.cache.refresh("complete");
    expect(h.fetched).toBe(1);
    // within 30s: no new attempt
    h.advance(10_000);
    await h.cache.refresh("complete");
    expect(h.fetched).toBe(1);
    // single-flight: concurrent callers share one fetch
    h.advance(30_000);
    await Promise.all([h.cache.refresh("complete"), h.cache.refresh("complete"), h.cache.refresh("complete")]);
    expect(h.fetched).toBe(2);
  });

  it("a failed or timed-out fetch keeps the old rows (never throws)", async () => {
    const h = harness();
    h.setFetch(async () => [row("ab12cd34", "builder")]);
    await h.cache.refresh("complete");
    // rejection keeps old data
    h.advance(30_000);
    h.setFetch(async () => {
      throw new Error("hub down");
    });
    await expect(h.cache.refresh("complete")).resolves.toBeUndefined();
    expect(h.cache.lookupExact("builder")?.ref).toBe("ab12cd34");
    // an undefined fetch result (explicit failure) also keeps old data
    h.advance(30_000);
    h.setFetch(async () => undefined);
    await h.cache.refresh("complete");
    expect(h.cache.lookupExact("builder")?.ref).toBe("ab12cd34");
    // a hanging fetch is bounded by the deadline (fast variant covered by the deps-override
    // test below; here just assert the rejected/undefined paths never throw)
  });

  it("rows older than the staleness window behave as empty (RR8: bare form passes through)", async () => {
    const h = harness();
    h.setFetch(async () => [row("ab12cd34", "builder")]);
    await h.cache.refresh("complete");
    expect(h.cache.rows()).toHaveLength(1);
    h.advance(10 * 60_000 + 1);
    expect(h.cache.rows()).toEqual([]);
    expect(h.cache.lookupExact("builder")).toBeUndefined();
    // an empty-but-fresh result is still fresh (distinct from stale)
    h.advance(30_000);
    h.setFetch(async () => []);
    await h.cache.refresh("complete");
    expect(h.cache.rows()).toEqual([]);
    h.advance(60_000);
    expect(h.cache.rows()).toEqual([]); // fresh empty stays []
  });

  it("identity change (epoch bump / leave / /new) clears the cache", async () => {
    const h = harness();
    h.setFetch(async () => [row("ab12cd34", "builder")]);
    await h.cache.refresh("complete");
    expect(h.cache.lookupExact("builder")).toBeDefined();
    // epoch bump (attach/join/leave)
    h.setKey("s1#1");
    expect(h.cache.rows()).toEqual([]);
    expect(h.cache.lookupExact("builder")).toBeUndefined();
    // /new: session replaced
    await h.cache.refresh("complete");
    expect(h.cache.rows()).toHaveLength(1);
    h.setKey("s2#0");
    expect(h.cache.rows()).toEqual([]);
    // leave: view ⇒ undefined
    await h.cache.refresh("complete");
    h.setKey(undefined);
    expect(h.cache.rows()).toEqual([]);
    expect(h.fetched).toBe(3); // the not-joined refresh was a no-op
  });

  it("a fetch settling AFTER an identity change is not stored for the old key", async () => {
    const h = harness();
    let release: ((rows: readonly XsDirectoryRow[]) => void) | undefined;
    h.setFetch(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.cache.refresh("complete");
    h.setKey("s1#1"); // leave/join happens while the fetch is in flight
    release!([row("ab12cd34", "builder")]);
    await pending;
    expect(h.cache.rows()).toEqual([]);
    expect(h.cache.lookupExact("builder")).toBeUndefined();
  });

  it("ingest installs fresh rows and arms the refresh-interval gate", async () => {
    const h = harness();
    h.cache.ingest([row("ab12cd34", "builder")]);
    expect(h.cache.lookupExact("builder")?.ref).toBe("ab12cd34");
    await h.cache.refresh("complete"); // within 30s of the ingest ⇒ no fetch
    expect(h.fetched).toBe(0);
    h.advance(30_000);
    await h.cache.refresh("complete");
    expect(h.fetched).toBe(1);
  });

  it("ingest is ignored while not joined", () => {
    const h = harness({ key: null });
    h.cache.ingest([row("ab12cd34", "builder")]);
    h.setKey("s1#0");
    expect(h.cache.rows()).toEqual([]); // nothing was installed
  });

  it("dispose: lookups are empty and a settling fetch is not stored", async () => {
    const h = harness();
    let release: ((rows: readonly XsDirectoryRow[]) => void) | undefined;
    h.setFetch(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.cache.refresh("complete");
    h.cache.dispose();
    release!([row("ab12cd34", "builder")]);
    await pending;
    expect(h.cache.rows()).toEqual([]);
    expect(h.cache.lookupExact("ab12cd34")).toBeUndefined();
    await expect(h.cache.refresh("complete")).resolves.toBeUndefined();
    expect(h.fetched).toBe(1);
  });

  it("a throwing view() counts as not joined (fail closed)", async () => {
    let now = 0;
    let viewThrows = false;
    const cache = createXsDirectoryCache({
      source: {
        view: () => {
          if (viewThrows) throw new Error("membership unreadable");
          return { key: "s1#0" };
        },
        fetch: async () => [row("ab12cd34")],
      },
      now: () => now,
    });
    await cache.refresh("complete");
    expect(cache.rows()).toHaveLength(1);
    viewThrows = true;
    expect(cache.rows()).toEqual([]);
    expect(cache.lookupExact("ab12cd34")).toBeUndefined();
    now += 60_000;
    await cache.refresh("complete"); // no-op
  });

  it("honors the deps overrides (short deadline bounds a hanging fetch)", async () => {
    let now = 0;
    const cache = createXsDirectoryCache({
      source: {
        view: () => ({ key: "s1#0" }),
        fetch: () => new Promise(() => undefined), // hangs forever
      },
      now: () => now,
      refreshMinIntervalMs: 0,
      fetchDeadlineMs: 20,
      staleMs: 60_000,
    });
    await expect(cache.refresh("complete")).resolves.toBeUndefined(); // resolved by the 20ms deadline
    expect(cache.rows()).toEqual([]);
  });
});
