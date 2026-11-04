// command-port tests (jev-plan §4 J4 第 6 条: report 各行、probe 强制刷新、
// retag/reset-index、tags 增删停启、review 流).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createJevCommandPort, type JevCommandPortDeps } from "../../../src/memory/jev/command-port.js";
import { readIndex, readTaxonomyFile, writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { getHealthTable } from "../../../src/memory/jev/health.js";
import { DEFAULT_JEV_FAST_PATH } from "../../../src/memory/jev/contracts.js";
import type {
  ClassifierRegistryLike,
  EntryTags,
  JevAnswer,
  JevClient,
  JevOutcome,
  JevRequest,
  JevStatus,
} from "../../../src/memory/jev/contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  getHealthTable().clear();
});

function fixture(): { dir: string; cwd: string } {
  const tmp = mkdtempSync(join(tmpdir(), "jev-cmd-"));
  roots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(tmp, "memroot", "slug");
  mkdirSync(dir, { recursive: true });
  return { dir, cwd };
}

function writeCorpus(dir: string, entries: readonly string[]): void {
  writeFileSync(
    join(dir, "core.md"),
    ["---", "source: agent", "---", "", "# Core", "", "## Rules", "", ...entries].join("\n") + "\n",
    "utf8",
  );
}

function record(over: Record<string, unknown> = {}): EntryTags {
  return {
    file: "core.md",
    type: "rule",
    typeP: 0.9,
    importance: 1,
    tags: {},
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13-free",
    at: "2026-10-20T10:00:00.000Z",
    taxonomyRev: "rrrrrrrr",
    ...over,
  };
}

interface ClientScript {
  answer?: (
    duty: JevRequest["duty"],
    questions: Record<string, JevRequest["questions"][string]>,
  ) => Record<string, JevAnswer>;
  status?: JevStatus;
}

function fakeClient(script: ClientScript = {}): JevClient & { asks: readonly JevRequest[] } {
  const asks: JevRequest[] = [];
  const client: JevClient = {
    status: (): JevStatus => script.status ?? { kind: "full", model: "opencode/jev-1.13-free" },
    ask: async (req: JevRequest): Promise<JevOutcome> => {
      asks.push(req);
      const answers: Record<string, JevAnswer> = {};
      const answer = script.answer;
      if (answer !== undefined) {
        Object.assign(answers, answer(req.duty, req.questions));
      } else {
        for (const [id, q] of Object.entries(req.questions)) {
          if (q.type === "bool") answers[id] = { type: "bool", probability: 0.9 };
          else if (q.type === "score") answers[id] = { type: "score", score: 1, confidence: 0.9 };
          else {
            const first = Object.keys(q.criteria)[0]!;
            answers[id] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
          }
        }
      }
      return { ok: true, model: "opencode/jev-1.13-free", answers, missing: [], costUsd: 0.0001, latencyMs: 1 };
    },
    probe: async (): Promise<JevStatus> => script.status ?? { kind: "full", model: "opencode/jev-1.13-free" },
  };
  return Object.assign(client, { asks });
}

const registry = {} as ClassifierRegistryLike;

function makePort(dir: string, cwd: string, client: JevClient, over: Partial<JevCommandPortDeps> = {}) {
  const bulk: string[] = [];
  const deps: JevCommandPortDeps = {
    client,
    entryIndex: new EntryIndex(),
    dirFor: (c) => (c === cwd ? dir : undefined),
    now: () => Date.parse("2026-10-30T12:00:00.000Z"),
    isChildSession: false,
    triggerBulk: (c) => bulk.push(c),
    config: {
      classifiers: ["opencode/jev-1.13-free", "opencode/jev-1.13"],
      proxy: "",
      childSessions: true,
      recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 2000 },
      reviewIntervalDays: 7,
      maxCostUsd: 0.5,
      maxCalls: 800,
      confirmTimeoutMs: 60_000,
      fastPath: DEFAULT_JEV_FAST_PATH,
    },
    usage: () => ({ costUsd: 0.0061, calls: 37 }),
    segment: () => ({ injectedByLayer: { U: 3, A: 1, E: 1 }, injectedTotal: 5 }),
    health: getHealthTable(),
    ...over,
  };
  return { port: createJevCommandPort(deps), bulk, deps };
}

describe("statusLine", () => {
  test("full status shows model, coverage and usage", () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha about releases", "- rule beta about testing"]);
    const { index } = readIndex(dir);
    const seeded: Record<string, EntryTags> = {};
    void index;
    const entryIndex = new EntryIndex();
    const entries = entryIndex.get(dir);
    seeded[entries[0]!.hash] = record();
    void writeIndexPatch;
    return (async () => {
      await writeIndexPatch(dir, { upsert: seeded });
      const { port } = makePort(dir, cwd, fakeClient());
      expect(port.statusLine(cwd)).toBe("jev: full · opencode/jev-1.13-free · 1/2 tagged · 37 calls $0.006");
    })();
  });

  test("no memory dir ⇒ probing line without coverage", () => {
    const { dir, cwd } = fixture();
    const client = fakeClient({ status: { kind: "probing" } });
    const { port } = makePort(dir, cwd, client);
    expect(port.statusLine(join(dir, "nope"))).toBe("jev: probing");
  });
});

describe("report (§9.4 structure)", () => {
  test("proxy line: absent without a proxy, credentials masked, unsupported scheme shown as ignored", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha about releases"]);
    const base = makePort(dir, cwd, fakeClient()).deps.config!;
    const lineOf = async (proxy: string) => {
      const { port } = makePort(dir, cwd, fakeClient(), { config: { ...base, proxy } });
      return (await port.report(cwd, registry)).split("\n").find((l) => l.startsWith("proxy"));
    };
    expect(await lineOf("")).toBeUndefined();
    expect(await lineOf("http://user:pass@127.0.0.1:7890")).toBe("proxy    http://***@127.0.0.1:7890");
    const socks = await lineOf("socks5://u:p@127.0.0.1:1080");
    expect(socks).toContain("socks5://***@127.0.0.1:1080");
    expect(socks).toContain("ignored (only http:// proxies are supported)");
    expect(socks).not.toContain("u:p");
  });

  test("full status on Linux: all rows present with expected shapes", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha about releases"]);
    const { port } = makePort(dir, cwd, fakeClient());
    const text = await port.report(cwd, registry);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^jev +enabled · full · opencode\/jev-1\.13-free$/);
    expect(lines.find((l) => l.startsWith("models"))).toContain("1 opencode/jev-1.13-free");
    expect(text).toContain("2 opencode/jev-1.13");
    expect(lines.find((l) => l.startsWith("stopped"))).toBeUndefined();
    expect(lines.find((l) => l.startsWith("running"))).toContain("recall U");
    expect(lines.find((l) => l.startsWith("running"))).toContain("review list");
    expect(lines.find((l) => l.startsWith("tags"))).toContain("0/1 tagged");
    expect(lines.find((l) => l.startsWith("evidence"))).toBeUndefined();
    expect(lines.find((l) => l.startsWith("usage"))).toBe(
      "usage    37 calls · $0.0061 / $0.50 · per activation (/reload resets)",
    );
    expect(lines.find((l) => l.startsWith("segment"))).toContain("injected 5 (U3 A1 E1)");
    expect(lines.find((l) => l.startsWith("review"))).toContain("0 open → /mem review");
  });

  test("review line shows a DATE-ONLY lastRunAt (§9.4 `last 2026-10-28`)", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    // Seed a full-ISO stamp the way runReviewPass stores it; the report
    // must trim it to YYYY-MM-DD at the view edge (sidecar keeps the ISO —
    // §6.3.1 intervalDays needs the timestamp).
    await writeIndexPatch(dir, {
      review: {
        lastRunAt: "2026-10-28T09:15:30.000Z",
        corpusFp: "fp",
        suggestions: [],
        dismissed: [],
      },
    });
    const { port } = makePort(dir, cwd, fakeClient());
    const text = await port.report(cwd, registry);
    expect(text).toContain("review   last 2026-10-28 · 0 open → /mem review");
    expect(text).not.toMatch(/review {3}last \d{4}-\d{2}-\d{2}T/);
  });

  test("partial status lists stopped judged duties and running zero-call duties", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port } = makePort(dir, cwd, fakeClient({ status: { kind: "partial", reason: "451", inactive: false } }));
    const text = await port.report(cwd, registry);
    expect(text).toContain("stopped  recall U · error recall E · write tagging · review run");
    expect(text).toContain("running  action fast path A · re-inject after compaction B · review list");
  });

  test("bad sidecar JSON ⇒ status line appends `index rebuilt`", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    mkdirSync(join(dir, ".jev"), { recursive: true });
    writeFileSync(join(dir, ".jev", "index.json"), "{broken", "utf8");
    const { port } = makePort(dir, cwd, fakeClient());
    const text = await port.report(cwd, registry);
    expect(text.split("\n")[0]).toContain("index rebuilt");
  });

  test("unavailable model rows carry code, until-time and the 451 hint", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const health = getHealthTable();
    health.set("opencode/jev-1.13-free", {
      state: "unavailable",
      code: "451",
      until: Date.parse("2026-10-30T12:40:00.000Z"),
    });
    health.set("opencode/jev-1.13", {
      state: "unavailable",
      code: "402",
      until: Date.parse("2026-10-30T12:41:00.000Z"),
    });
    const { port } = makePort(dir, cwd, fakeClient(), { health });
    const text = await port.report(cwd, registry);
    const hhmmLocal = (iso: string): string => {
      const d = new Date(Date.parse(iso));
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    expect(text).toContain(
      `unavailable (451) until ${hhmmLocal("2026-10-30T12:40:00.000Z")} — 451 多为地区拦截，可设 memory.jev.proxy`,
    );
    expect(text).toContain(`unavailable (402) until ${hhmmLocal("2026-10-30T12:41:00.000Z")}`);
  });
});

describe("probe / retag / reset-index", () => {
  test("probe returns the refreshed status text; no registry ⇒ explicit text", async () => {
    const { dir, cwd } = fixture();
    const { port } = makePort(dir, cwd, fakeClient());
    expect(await port.probe(registry)).toBe("jev: probe → enabled · full · opencode/jev-1.13-free");
    expect(await port.probe(undefined)).toContain("no classifier registry");
  });

  test("retag tags pending entries and persists them to the sidecar", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha about releases", "- rule beta about testing"]);
    const client = fakeClient();
    const { port } = makePort(dir, cwd, client);
    const text = await port.retag(cwd, false, registry);
    expect(text).toContain("retag 2/2 tagged");
    // 22 tag-major + 2 entry-major calls.
    expect(client.asks).toHaveLength(24);
    const { index } = readIndex(dir);
    expect(Object.keys(index.entries)).toHaveLength(2);
    expect(index.lastTaggedAt).toBeDefined();
  });

  test("retag --all re-tags even entries that already have records", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha about releases"]);
    const entryIndex = new EntryIndex();
    const seeded: Record<string, EntryTags> = {};
    seeded[entryIndex.get(dir)[0]!.hash] = record();
    await writeIndexPatch(dir, { upsert: seeded });
    const client = fakeClient();
    const { port } = makePort(dir, cwd, client);
    await port.retag(cwd, true, registry);
    // No base ⇒ the entry re-runs the entry part (22 + 1 calls).
    expect(client.asks.filter((a) => a.duty === "tag")).toHaveLength(1);
  });

  test("retag refused for child sessions and missing registry; nothing to tag is reported", async () => {
    const { dir, cwd } = fixture();
    const client = fakeClient();
    const child = makePort(dir, cwd, client, { isChildSession: true });
    expect(await child.port.retag(cwd, false, registry)).toContain("main-session only");
    const { port } = makePort(dir, cwd, client);
    expect(await port.retag(cwd, false, undefined)).toContain("no classifier registry");
    expect(await port.retag(join(dir, "nope"), false, registry)).toContain("no memory directory");
  });

  test("reset-index clears the index but keeps taxonomy", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    await writeIndexPatch(dir, { upsert: { a: record() } });
    const { port } = makePort(dir, cwd, fakeClient());
    expect(await port.resetIndex(cwd)).toContain("cleared");
    expect(existsSync(join(dir, ".jev", "index.json"))).toBe(false);
    const child = makePort(dir, cwd, fakeClient(), { isChildSession: true });
    expect(await child.port.resetIndex(cwd)).toContain("main-session only");
  });
});

describe("tags add/rm/disable/enable", () => {
  test("add writes the taxonomy file and kicks the bulk backfill", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port, bulk } = makePort(dir, cwd, fakeClient());
    const out = await port.tags.add(cwd, {
      id: "my-tag",
      label: "My Tag",
      description: "About my custom scenario.",
      risk: "high",
      commands: ["foo bar"],
    });
    expect(out).toContain("added my-tag");
    expect(bulk).toEqual([cwd]);
    const file = readTaxonomyFile(dir)!;
    expect(file.tags[0]).toMatchObject({ id: "my-tag", source: "user", risk: "high", rev: 1 });
    expect(file.tags[0]!.match).toEqual({ commands: ["foo bar"] });
  });

  test("re-add with a changed description bumps rev; unchanged description does not", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port } = makePort(dir, cwd, fakeClient());
    await port.tags.add(cwd, { id: "my-tag", label: "L", description: "v1 wording" });
    const out = await port.tags.add(cwd, { id: "my-tag", label: "L", description: "v2 wording" });
    expect(out).toContain("rev bumped");
    expect(readTaxonomyFile(dir)!.tags[0]!.rev).toBe(2);
    const same = await port.tags.add(cwd, { id: "my-tag", label: "L", description: "v2 wording" });
    expect(same).toContain("updated");
    expect(readTaxonomyFile(dir)!.tags[0]!.rev).toBe(2);
  });

  test("preset ids cannot be added; invalid input surfaces validateTagDef errors", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port, bulk } = makePort(dir, cwd, fakeClient());
    expect(await port.tags.add(cwd, { id: "git-push", label: "L", description: "D" })).toContain("preset tag");
    expect(await port.tags.add(cwd, { id: "Bad_Id", label: "L", description: "D" })).toContain("must match");
    expect(bulk).toEqual([]);
  });

  test("rm refuses presets, removes user tags", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port } = makePort(dir, cwd, fakeClient());
    await port.tags.add(cwd, { id: "my-tag", label: "L", description: "D" });
    expect(await port.tags.remove(cwd, "git-push")).toContain("presets can be disabled");
    expect(await port.tags.remove(cwd, "nope")).toContain("no user tag");
    expect(await port.tags.remove(cwd, "my-tag")).toContain("removed");
    expect(readTaxonomyFile(dir)!.tags).toHaveLength(0);
  });

  test("disable/enable toggle presets via disabledPresets; disabling a user tag removes it", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port, bulk } = makePort(dir, cwd, fakeClient());
    expect(await port.tags.setEnabled(cwd, "docs", false)).toContain("docs disabled");
    expect(readTaxonomyFile(dir)!.disabledPresets).toEqual(["docs"]);
    expect(await port.tags.setEnabled(cwd, "docs", false)).toContain("already disabled");
    expect(await port.tags.setEnabled(cwd, "docs", true)).toContain("docs enabled");
    expect(bulk).toEqual([cwd]); // enable kicks a backfill
    expect(readTaxonomyFile(dir)!.disabledPresets).toEqual([]);
    await port.tags.add(cwd, { id: "my-tag", label: "L", description: "D" });
    expect(await port.tags.setEnabled(cwd, "my-tag", false)).toContain("removed");
    expect(await port.tags.setEnabled(cwd, "my-tag", true)).toContain("re-added");
  });

  test("list renders presets and user tags with disabled presets at the end", async () => {
    const { dir, cwd } = fixture();
    writeCorpus(dir, ["- rule alpha"]);
    const { port } = makePort(dir, cwd, fakeClient());
    await port.tags.add(cwd, { id: "my-tag", label: "My Tag", description: "Custom scenario." });
    await port.tags.setEnabled(cwd, "docs", false);
    const text = port.tags.list(cwd);
    expect(text.split("\n")[0]).toMatch(/^tags \d+ enabled \/ 64 max · taxonomy [0-9a-f]{8}$/);
    expect(text).toContain("git-push");
    expect(text).toContain("my-tag");
    expect(text).toContain("My Tag");
    expect(text).toContain("disabled presets: docs");
  });
});

describe("review list/run/dismiss/resolve", () => {
  async function seedReviewState(dir: string): Promise<void> {
    // Two similar entries; review run with duplicate answers seeds a pair
    // suggestion, plus a user-like suggestion from the sidecar.
    writeCorpus(dir, [
      "- rule alpha about the release flow and tags",
      "- rule beta about the release flow and tags",
      "- agent lesson that reads like a user order: never push on Fridays",
    ]);
  }

  test("run persists suggestions; list marks stale; dismiss/resolve update the sidecar", async () => {
    const { dir, cwd } = fixture();
    await seedReviewState(dir);
    const entryIndex = new EntryIndex();
    const entries = entryIndex.get(dir);
    const seeded: Record<string, EntryTags> = {};
    for (const e of entries) {
      seeded[e.hash] = record(
        e.body.includes("user order")
          ? { userLike: 0.9 }
          : { tags: { release: { p: 0.9, rev: 1 } }, temporal: "event" },
      );
    }
    await writeIndexPatch(dir, { upsert: seeded });
    const client = fakeClient({
      answer: (duty, questions) => {
        const answers: Record<string, JevAnswer> = {};
        for (const id of Object.keys(questions)) {
          if (id.startsWith("p")) {
            answers[id] = { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.9 }, confidence: 0.9 };
          } else {
            answers[id] = { type: "bool", probability: 0.9 };
          }
        }
        void duty;
        return answers;
      },
    });
    const { port } = makePort(dir, cwd, client);
    const runText = await port.review.run(cwd, registry);
    expect(runText).toContain("review pass complete");
    let views = [...port.review.list(cwd)];
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.every((v) => !v.stale)).toBe(true);

    // Stale: drop the file (whole corpus gone) ⇒ every suggestion stale.
    rmSync(join(dir, "core.md"));
    views = [...port.review.list(cwd)];
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views.every((v) => v.stale)).toBe(true);
    writeCorpus2(dir);

    // Dismiss one pair suggestion: removed from list, persisted in dismissed.
    const pairView = views.find((v) => v.suggestion.kind === "duplicate")!.suggestion;
    await port.review.dismiss(cwd, pairView.id);
    const after = [...port.review.list(cwd)];
    expect(after.some((v) => v.suggestion.id === pairView.id)).toBe(false);
    const dismissed = readIndex(dir).index.review?.dismissed ?? [];
    expect(dismissed.length).toBe(1);
    expect(dismissed[0]!.hashKey).toBe(
      pairView.b === undefined ? pairView.a.hash : [pairView.a.hash, pairView.b.hash].sort().join("+"),
    );

    // Resolve the remaining user-like suggestion without a dismissed record.
    const ul = after.find((v) => v.suggestion.kind === "user-like")!.suggestion;
    await port.review.resolve(cwd, ul.id);
    const final = [...port.review.list(cwd)];
    expect(final.some((v) => v.suggestion.id === ul.id)).toBe(false);
    expect(readIndex(dir).index.review?.dismissed).toHaveLength(1);
  });

  test("run refuses child sessions / missing registry; run failure text on client error", async () => {
    const { dir, cwd } = fixture();
    await seedReviewState(dir);
    const child = makePort(dir, cwd, fakeClient(), { isChildSession: true });
    expect(await child.port.review.run(cwd, registry)).toContain("main-session only");
    const { port } = makePort(dir, cwd, fakeClient());
    expect(await port.review.run(cwd, undefined)).toContain("no classifier registry");
    const failing = makePort(dir, cwd, {
      ...fakeClient(),
      ask: async () => ({ ok: false, reason: "all-failed", detail: "System One API error (451)" }) as JevOutcome,
      status: () => ({ kind: "full", model: "m" }) as JevStatus,
      probe: async () => ({ kind: "full", model: "m" }) as JevStatus,
    });
    expect(await failing.port.review.run(cwd, registry)).toContain("review run failed (all-failed");
  });
});

function writeCorpus2(dir: string): void {
  // restore an equivalent corpus after rmSync (same bodies ⇒ same hashes)
  writeCorpus(dir, [
    "- rule alpha about the release flow and tags",
    "- rule beta about the release flow and tags",
    "- agent lesson that reads like a user order: never push on Fridays",
  ]);
}

void readFileSync;
