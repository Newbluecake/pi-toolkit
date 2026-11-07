import * as fs from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runMigration, snapshotMigrationSources } from "../../../src/memory/blocks/migrate.js";
import { sourceSha } from "../../../src/memory/blocks/migrate-plan.js";
import { readBlocksState, writeBlocksStateLocked, writeHoldLocked } from "../../../src/memory/blocks/state.js";
import { dirFormat } from "../../../src/memory/blocks/naming.js";
import { readProcIdentity } from "../../../src/memory/safe-fs.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
function root(): string {
  const p = fs.mkdtempSync(join(tmpdir(), "migrate-"));
  roots.push(p);
  fs.writeFileSync(join(p, "core.md"), "---\nsource: agent\n---\n- rule one <!-- mem user -->\n- rule two\n");
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
it("publishes once, leaves all source bytes untouched, complete manifest and no-op replay", async () => {
  const p = root(),
    before = snapshotMigrationSources(p);
  expect((await runMigration(p)).outcome).toBe("committed");
  expect(dirFormat(p)).toBe("blocks");
  expect(snapshotMigrationSources(p)).toEqual(before);
  const marker = JSON.parse(fs.readFileSync(join(p, "blocks/.layout.json"), "utf8"));
  expect(marker.gen).toBe(1);
  expect(marker.files.map((f: { path: string }) => f.path)).toContain("general.001.md");
  expect(fs.existsSync(join(p, "blocks/owner.json"))).toBe(false);
  expect((await runMigration(p)).outcome).toBe("already-migrated");
});
it.each(["hold", "gen", "blocks", "source", "owner", "extra", "missing", "sha", "symlink", "marker", "dirs"])(
  "submission rejects %s drift and isolates its staging",
  async (kind) => {
    const p = root();
    let staging = "";
    const result = await runMigration(p, {
      phase: (phase, s) => {
        if (phase !== "built") return;
        staging = s;
        if (kind === "hold") writeHoldLocked(p, { v: 1, at: "", gen: 0, reason: "manual" });
        if (kind === "gen") writeBlocksStateLocked(p, { v: 1, gen: 10, overBudgetStreak: 0 });
        if (kind === "blocks") fs.mkdirSync(join(p, "blocks"));
        if (kind === "source") fs.appendFileSync(join(p, "core.md"), "changed");
        if (kind === "owner") {
          const o = JSON.parse(fs.readFileSync(join(s, "owner.json"), "utf8"));
          o.runId = "20000101T000000000Z-1-abcdef";
          fs.writeFileSync(join(s, "owner.json"), JSON.stringify(o));
        }
        if (kind === "extra") fs.writeFileSync(join(s, "extra.md"), "extra");
        if (kind === "missing") fs.unlinkSync(join(s, "general.001.md"));
        if (kind === "sha") fs.appendFileSync(join(s, "general.001.md"), "modified");
        if (kind === "marker") {
          const path = join(s, "general.001.md");
          fs.appendFileSync(path, "forged");
          const marker = JSON.parse(fs.readFileSync(join(s, ".layout.json"), "utf8"));
          const file = marker.files.find((f: { path: string }) => f.path === "general.001.md");
          file.sha256 = sourceSha(fs.readFileSync(path, "utf8"));
          file.size = fs.statSync(path).size;
          fs.writeFileSync(join(s, ".layout.json"), JSON.stringify(marker));
        }
        if (kind === "dirs") fs.rmdirSync(join(s, "archive"));
        if (kind === "symlink") fs.symlinkSync(join(p, "core.md"), join(s, "bad.md"));
      },
    });
    expect(result.outcome).toBe("aborted");
    expect(dirFormat(p)).not.toBe("blocks");
    // Original staging dev/ino proves our tree even when its owner payload was tampered.
    expect(fs.existsSync(staging)).toBe(false);
  },
);
it("EXDEV leaves source and staging intact with aborted state, no copy fallback", async () => {
  const p = root(),
    real = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === join(p, "blocks")) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return real(from, to);
  });
  const result = await runMigration(p);
  expect(result.outcome).toBe("aborted");
  expect(result.reason).toContain("EXDEV");
  expect(dirFormat(p)).toBe("files");
  const names = fs.readdirSync(p);
  expect(names.filter((n) => n.startsWith(".blocks-staging-") && !n.includes(".trash-"))).toHaveLength(1);
  expect(readBlocksState(p).lastOutcome).toBe("aborted");
});
it("all-stage limits refuse oversized snapshots before staging; streak counts; build yields", async () => {
  const p = root();
  for (let i = 0; i < 2000; i++) fs.writeFileSync(join(p, `f${i}.md`), "- x");
  expect((await runMigration(p, { maxOps: 50000 })).outcome).toBe("over-budget");
  expect(fs.readdirSync(p).some((n) => n.startsWith(".blocks-staging"))).toBe(false);
  const q = root();
  for (let i = 0; i < 3; i++) expect((await runMigration(q, { maxOps: 40 })).outcome).toBe("over-budget");
  expect(readBlocksState(q).overBudgetStreak).toBe(3);
  const r = root();
  fs.writeFileSync(join(r, "many.md"), Array.from({ length: 50 }, (_, i) => `- item ${i}`).join("\n"));
  const yieldFn = vi.fn(async () => {});
  expect((await runMigration(r, { yield: yieldFn })).outcome).toBe("committed");
  expect(yieldFn.mock.calls.length).toBeGreaterThan(0);
  let time = 0;
  const s = root();
  expect((await runMigration(s, { now: () => time++, budgetMs: 3 })).outcome).toBe("over-budget");
  expect(dirFormat(s)).toBe("files");
});
it("shutdown abort and gate loss halt construction with zero later writes", async () => {
  const p = root(),
    controller = new AbortController();
  const result = await runMigration(p, {
    signal: controller.signal,
    phase: (phase) => {
      if (phase === "building") controller.abort();
    },
  });
  expect(result.outcome).toBe("aborted");
  expect(dirFormat(p)).toBe("files");
  let allow = true;
  const q = root();
  const denied = await runMigration(q, {
    gate: { capture: () => {}, check: () => (allow ? { ok: true } : { ok: false, reason: "unmounted" }) },
    phase: (phase) => {
      if (phase === "building") allow = false;
    },
  });
  expect(denied.outcome).toBe("aborted");
  const files = fs.readdirSync(
    join(
      q,
      fs.readdirSync(q).find((n) => n.startsWith(".blocks-staging"))!,
    ),
  );
  expect(files).toContain("general.001.md");
  expect(files).not.toContain("general.002.md");
  expect(fs.existsSync(join(q, "blocks"))).toBe(false);
});
it.each(["own", "dead", "ticks", "boot", "live", "missing", "foreign"])(
  "cleanup classifies %s owner by identity, never age",
  async (kind) => {
    const p = root(),
      id = "20000101T000000000Z-111-abcdef",
      name = `.blocks-staging-${id}`,
      path = join(p, name);
    fs.mkdirSync(path);
    fs.writeFileSync(join(path, "keep.md"), "keep");
    const actual = readProcIdentity(process.pid)!;
    if (kind !== "missing")
      fs.writeFileSync(
        join(path, "owner.json"),
        JSON.stringify({
          v: 1,
          runId: id,
          pid: kind === "own" ? process.pid : 111,
          startTicks: kind === "ticks" ? 999 : actual.startTicks,
          bootId: kind === "boot" ? "another-boot" : actual.bootId,
          hostname: kind === "foreign" ? "remote" : hostname(),
          createdAt: "",
        }),
      );
    fs.utimesSync(path, 0, 0);
    const result = await runMigration(p, { identity: () => actual, alive: () => kind !== "dead" });
    expect(result.outcome).toBe("committed");
    expect(fs.existsSync(path)).toBe(["live", "missing", "foreign"].includes(kind));
  },
);
it("explicit source drift is replanned at most once within the original budget", async () => {
  const p = root();
  let edits = 0;
  const result = await runMigration(p, {
    explicit: true,
    phase: (phase) => {
      if (phase === "built" && edits++ === 0) fs.appendFileSync(join(p, "core.md"), "\n- fresh rule\n");
    },
  });
  expect(result.outcome).toBe("committed");
  expect(edits).toBe(2);
  expect(result.plan?.blocks.some((b) => b.content.includes("fresh rule"))).toBe(true);
  const q = root();
  let tries = 0;
  expect(
    (
      await runMigration(q, {
        explicit: true,
        phase: (phase) => {
          if (phase === "built") {
            tries++;
            fs.appendFileSync(join(q, "core.md"), `\n- drift ${tries}\n`);
          }
        },
      })
    ).outcome,
  ).toBe("aborted");
  expect(tries).toBe(2);
});
it("source byte cap and non-roundtrippable UTF-8 fail before constructing blocks", async () => {
  const p = root();
  fs.writeFileSync(join(p, "huge.md"), "x".repeat(5000));
  expect((await runMigration(p, { maxBytes: 4000 })).outcome).toBe("over-budget");
  expect(fs.readdirSync(p).some((n) => n.startsWith(".blocks-staging"))).toBe(false);
  const q = root();
  fs.writeFileSync(join(q, "bad.md"), Buffer.from([0xff]));
  expect((await runMigration(q)).outcome).toBe("aborted");
  expect(dirFormat(q)).toBe("files");
  expect(fs.readFileSync(join(q, "bad.md"))).toEqual(Buffer.from([0xff]));
});
it("post-publication fsync failure warns without rolling back a complete directory", async () => {
  const p = root(),
    actual = fs.fsyncSync,
    parent = fs.statSync(p);
  let published = false;
  const diag = vi.fn();
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const st = fs.fstatSync(fd);
    if (published && st.ino === parent.ino && st.dev === parent.dev) throw new Error("forced parent fsync failure");
    return actual(fd);
  });
  const result = await runMigration(p, {
    diag,
    phase: (phase) => {
      if (phase === "published") published = true;
    },
  });
  expect(result.outcome).toBe("committed");
  expect(dirFormat(p)).toBe("blocks");
  expect(diag.mock.calls.some(([message]) => message.includes("parent fsync failed"))).toBe(true);
});
