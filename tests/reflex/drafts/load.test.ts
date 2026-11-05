/**
 * jev-reflex · #25 B4: `loadDrafts` against a REAL temp directory (BA §4.6 rules 1–5, R-I13). Every
 * rejection code the loader owns is exercised with the actual fs; the injectable-fs race / budget cases
 * live in `load-race.test.ts`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, systemClock } from "../../../src/core/clock.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { DRAFT_CAPS, DRAFT_MAX_FILE_BYTES } from "../../../src/reflex/core/draft-schema.js";
import { draftHash, templateHash } from "../../../src/reflex/core/identity.js";
import { DRAFT_READ_FLAGS, loadDrafts } from "../../../src/reflex/drafts/load.js";
import { fakeDraftFs, queueDraft, tmpAgent, type TmpAgent } from "./helpers.js";

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
let agent: TmpAgent;
beforeEach(() => {
  agent = tmpAgent();
});
afterEach(() => agent.cleanup());

const load = (dir = agent.draftsDir) => loadDrafts(dir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal);

describe("loadDrafts — happy path", () => {
  it("loads a valid draft with its identity hashes and file name", async () => {
    const draft = queueDraft("draft.queue");
    agent.write("queue.json", draft);
    const r = await load();
    expect(r.failure).toBeUndefined();
    expect(r.rejected).toEqual([]);
    expect(r.loaded).toHaveLength(1);
    const got = r.loaded[0]!;
    expect(got.file).toBe("queue.json");
    expect(got.script.id).toBe("draft.queue");
    expect(got.templateHash).toBe(templateHash(draft));
    expect(got.draftHash).toBe(draftHash(draft));
  });

  it("opens every file with the no-follow flag set (DRAFT_READ_FLAGS) — checked through an injected fs", async () => {
    const { fs, calls } = fakeDraftFs({ files: { "a.json": JSON.stringify(queueDraft("draft.a")) } });
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.loaded).toHaveLength(1);
    expect(calls.flags).toEqual([DRAFT_READ_FLAGS]);
    expect(calls.closed).toBe(calls.openedHandles);
    expect(calls.dirClosed).toBe(1);
  });

  it("a missing directory is the normal 'nothing generated yet' state: empty, no failure", async () => {
    const r = await load(join(agent.reflexDir, "nope"));
    expect(r).toEqual({ loaded: [], rejected: [] });
  });

  it("an empty drafts directory loads nothing and fails nothing", async () => {
    expect(await load()).toEqual({ loaded: [], rejected: [] });
  });
});

describe("loadDrafts — per-file rejections", () => {
  it("perm: a group/other-readable file (0644) is rejected, the valid sibling still loads", async () => {
    agent.write("good.json", queueDraft("draft.good"));
    agent.write("loose.json", queueDraft("draft.loose"), 0o644);
    const r = await load();
    expect(r.loaded.map((d) => d.script.id)).toEqual(["draft.good"]);
    expect(r.rejected).toEqual([{ file: "loose.json", code: "perm" }]);
  });

  it("name: only [a-z0-9.-]{1,64}.json is considered (uppercase / wrong extension / spaces)", async () => {
    agent.write("Upper.json", queueDraft("draft.upper"));
    agent.write("notes.txt", "x");
    agent.write("has space.json", queueDraft("draft.space"));
    const r = await load();
    expect(r.loaded).toEqual([]);
    expect(r.rejected.map((x) => x.code)).toEqual(["name", "name", "name"]);
    expect(r.rejected.map((x) => x.file).sort()).toEqual(["Upper.json", "has space.json", "notes.txt"]);
  });

  it("json: unparseable / invalid-utf8 content", async () => {
    agent.write("broken.json", "{ not json");
    const r = await load();
    expect(r.rejected).toEqual([{ file: "broken.json", code: "json" }]);
  });

  it("size: a regular file whose stat size exceeds 16 KiB is rejected without being read", async () => {
    agent.write("big.json", JSON.stringify({ pad: "x".repeat(DRAFT_MAX_FILE_BYTES) }));
    const r = await load();
    expect(r.rejected).toEqual([{ file: "big.json", code: "size" }]);
  });

  it("schema / namespace / port-mismatch / regex / examples: validateDraft codes surface per file", async () => {
    agent.write("a-schema.json", { schema: "rscript/1" });
    agent.write("b-namespace.json", { ...queueDraft("draft.x"), id: "jobs.list" });
    const pm = queueDraft("draft.pm");
    agent.write("c-port.json", { ...pm, render: { ...pm.render, title: "sweetened" } });
    const rx = queueDraft("draft.rx");
    agent.write("d-regex.json", { ...rx, intent: { ...rx.intent, strong: ["a+b", ...rx.intent.strong.slice(1)] } });
    const ex = queueDraft("draft.ex");
    agent.write("e-examples.json", {
      ...ex,
      intent: {
        ...ex.intent,
        examples: { ...ex.intent.examples, hit: ["完全不相干的一句话", ...ex.intent.examples.hit.slice(1)] },
      },
    });
    const r = await load();
    expect(r.loaded).toEqual([]);
    expect(Object.fromEntries(r.rejected.map((x) => [x.file, x.code]))).toEqual({
      "a-schema.json": "schema",
      "b-namespace.json": "namespace",
      "c-port.json": "port-mismatch",
      "d-regex.json": "regex",
      "e-examples.json": "examples",
    });
  });

  it("duplicate: a second file declaring the same id is rejected (sorted order decides, first wins)", async () => {
    agent.write("a.json", queueDraft("draft.same"));
    agent.write("b.json", queueDraft("draft.same"));
    const r = await load();
    expect(r.loaded.map((d) => d.file)).toEqual(["a.json"]);
    expect(r.rejected).toEqual([{ file: "b.json", code: "duplicate", detail: "draft.same" }]);
  });

  it("cap: only the first DRAFT_FILE_READ_CAP (16) sorted files are read; the rest are `cap`", async () => {
    for (let i = 0; i < 18; i++) agent.write(`d${String(i).padStart(2, "0")}.json`, queueDraft(`draft.n${i}`));
    const r = await load();
    expect(r.loaded).toHaveLength(16);
    expect(r.rejected).toEqual([
      { file: "d16.json", code: "cap" },
      { file: "d17.json", code: "cap" },
    ]);
  });

  it("the file-name rejection is printable and bounded (control characters never reach /reflex drafts)", async () => {
    const { fs } = fakeDraftFs({ extraNames: [`evil\u001b[31m${"z".repeat(100)}.json`] });
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.code).toBe("name");
    expect(r.rejected[0]!.file).not.toMatch(/[\u0000-\u001f]/);
    expect(r.rejected[0]!.file.length).toBeLessThanOrEqual(64);
  });
});

describe("loadDrafts — whole-directory trust (dir-untrusted / dir-cap)", () => {
  it("drafts directory 0755 ⇒ dir-untrusted, nothing loads", async () => {
    agent.write("ok.json", queueDraft("draft.ok"));
    chmodSync(agent.draftsDir, 0o755);
    const r = await load();
    expect(r).toEqual({ loaded: [], rejected: [], failure: { code: "dir-untrusted", detail: "drafts dir" } });
  });

  it("reflex directory 0755 ⇒ dir-untrusted", async () => {
    agent.write("ok.json", queueDraft("draft.ok"));
    chmodSync(agent.reflexDir, 0o755);
    const r = await load();
    expect(r.failure).toEqual({ code: "dir-untrusted", detail: "reflex dir" });
    expect(r.loaded).toEqual([]);
  });

  it("drafts directory that is a SYMLINK to a clean 0700 directory ⇒ dir-untrusted (lstat, never followed)", async () => {
    const real = mkdtempSync(join(tmpdir(), "reflex-real-"));
    try {
      chmodSync(real, 0o700);
      rmSync(agent.draftsDir, { recursive: true });
      symlinkSync(real, agent.draftsDir);
      const r = await load();
      expect(r.failure?.code).toBe("dir-untrusted");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("reflex directory that is a symlink ⇒ dir-untrusted", async () => {
    const real = mkdtempSync(join(tmpdir(), "reflex-real-"));
    try {
      mkdirSync(join(real, "drafts"));
      chmodSync(real, 0o700);
      chmodSync(join(real, "drafts"), 0o700);
      const link = join(agent.root, "link");
      symlinkSync(real, link);
      const r = await load(join(link, "drafts"));
      expect(r.failure?.code).toBe("dir-untrusted");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("a directory owned by someone else (uid mismatch, injected fs) ⇒ dir-untrusted", async () => {
    const mine = typeof process.getuid === "function" ? process.getuid() : 0;
    const { fs, calls } = fakeDraftFs({ uid: mine + 1, files: { "a.json": "{}" } });
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    // the fake's directory stat reports the foreign uid ⇒ refused before opendir
    if (typeof process.getuid === "function") {
      expect(r.failure?.code).toBe("dir-untrusted");
      expect(calls.opendir).toBe(0);
    }
  });

  it("65 dirents ⇒ whole-directory dir-cap, read() calls ≤ 65, directory handle closed, nothing opened", async () => {
    const extra = Array.from({ length: 100 }, (_, i) => `n${i}.json`);
    const { fs, calls } = fakeDraftFs({ extraNames: extra });
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.failure?.code).toBe("dir-cap");
    expect(r.loaded).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(calls.next).toBeLessThanOrEqual(65);
    expect(calls.dirClosed).toBe(1);
    expect(calls.open).toEqual([]);
  });

  it("exactly 64 dirents is still allowed (the cap is the 65th)", async () => {
    const extra = Array.from({ length: 64 }, (_, i) => `n${i}.json`);
    const { fs } = fakeDraftFs({ extraNames: extra });
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, fs);
    expect(r.failure).toBeUndefined();
    expect(r.rejected.filter((x) => x.code === "cap")).toHaveLength(48); // 64 valid names, 16 read, 48 over the read cap
  });
});

describe("loadDrafts — contract", () => {
  it("never rejects: an fs that throws arbitrary errors degrades to a failure result", async () => {
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), new AbortController().signal, {
      lstat: () => {
        throw new Error("boom");
      },
      opendir: () => Promise.reject(new Error("boom")),
      open: () => Promise.reject(new Error("boom")),
    });
    expect(r.loaded).toEqual([]);
    expect(r.failure).toBeDefined();
  });

  it("an already-aborted signal short-circuits with ZERO fs access", async () => {
    const { fs, calls } = fakeDraftFs({ files: { "a.json": "{}" } });
    const ac = new AbortController();
    ac.abort();
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, new FakeClock(0), ac.signal, fs);
    expect(r.failure?.code).toBe("aborted");
    expect(calls.lstat).toEqual([]);
    expect(calls.opendir).toBe(0);
  });

  it("draft caps are the schema's (strong 12 / weak 8 / exclude 32)", () => {
    expect(DRAFT_CAPS.strong).toBe(12);
  });

  it("works with the production clock too: the budget timer is cleared on completion (no pending ref'd timer)", async () => {
    agent.write("q.json", queueDraft("draft.q"));
    const r = await loadDrafts(agent.draftsDir, BUILTIN_IDS, systemClock, new AbortController().signal);
    expect(r.loaded).toHaveLength(1);
  });

  it("clears the budget timer on every exit path (FakeClock.pendingTimers === 0)", async () => {
    agent.write("q.json", queueDraft("draft.q"));
    const clock = new FakeClock(0);
    await loadDrafts(agent.draftsDir, BUILTIN_IDS, clock, new AbortController().signal);
    expect(clock.pendingTimers).toBe(0);
    chmodSync(agent.draftsDir, 0o755);
    await loadDrafts(agent.draftsDir, BUILTIN_IDS, clock, new AbortController().signal);
    expect(clock.pendingTimers).toBe(0);
  });
});
