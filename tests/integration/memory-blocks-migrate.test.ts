import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration } from "../../src/memory/blocks/migrate.js";
import { legacyDrift } from "../../src/memory/blocks/legacy.js";
import { createMemoryToolV2 } from "../../src/memory/tool-v2.js";
import { parseMemorySettings } from "../../src/memory/settings.js";
import { memoryDirFor } from "../../src/memory/paths.js";
const roots: string[] = [];
const repo = join(import.meta.dirname, "../..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blocks-process-"));
  roots.push(root);
  const dir = join(root, "memory");
  writeFileSync(
    join(root, "worker.mts"),
    `
import { runMigration, rollbackMigration, resumeRollback } from ${JSON.stringify(join(repo, "src/memory/blocks/migrate.ts"))};
import { dirFormat } from ${JSON.stringify(join(repo, "src/memory/blocks/naming.ts"))};
import { readCorpus } from ${JSON.stringify(join(repo, "src/memory/blocks/store.ts"))};
import { renderTiered } from ${JSON.stringify(join(repo, "src/memory/tiered.ts"))};
import { renderBlocks } from ${JSON.stringify(join(repo, "src/memory/blocks/render.ts"))};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if(process.send)process.on("message",()=>{});
const dir=process.argv[2], mode=process.argv[3];process.env.ARMORY_MEMORY_ROOT=dir.slice(0,dir.lastIndexOf('/'));
if(mode==='read') {const format=dirFormat(dir); console.log(JSON.stringify({format,bodies:format==='blocks'?readCorpus(join(dir,'blocks')).blocks.map(b=>b.body):[readFileSync(join(dir,'core.md'),'utf8')],render:format==='blocks'?renderBlocks(readCorpus(join(dir,'blocks')),{slug:'memory',isChild:false,residentBytes:2048,today:'2026-11-06'}).text:renderTiered({cwd:'memory',profile:'full',access:'memory',coreBytes:2048,blockBytes:4096,indexMax:20}).text}));}
else if(mode.startsWith('rollback:')) {await rollbackMigration(dir,{phase:phase=>{if(phase===mode.slice(9))process.exit(91);}});}
else if(mode==='resume'){await resumeRollback(dir);console.log(dirFormat(dir));}
else {let cleaning=0;const result=await runMigration(dir,{phase:(phase)=>{if(phase===mode && (phase!=='cleaning' || ++cleaning===2))process.exit(91);}});console.log(JSON.stringify(result));process.disconnect?.();}
`,
  );
  return { root, dir, worker: join(root, "worker.mts") };
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const run = (worker: string, dir: string, mode: string) =>
  spawnSync(process.execPath, ["--import", "tsx", worker, dir, mode], { encoding: "utf8", timeout: 30000 });
it.each(["staging-created", "owner-written", "building", "built", "gen-bumped", "published"])(
  "independent reader sees complete layout at %s crash; restart converges",
  async (phase) => {
    const f = fixture();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(f.dir);
    const raw = "---\nsource: agent\n---\n- one\n- two\n";
    writeFileSync(join(f.dir, "core.md"), raw);
    const crash = run(f.worker, f.dir, phase);
    expect(crash.status, crash.stderr).toBe(91);
    const read = run(f.worker, f.dir, "read");
    expect(read.status, read.stderr).toBe(0);
    const result = JSON.parse(read.stdout);
    expect(result.format).toBe(phase === "published" ? "blocks" : "files");
    expect(result.bodies).toEqual(phase === "published" ? ["- one", "- two"] : [raw]);
    expect(result.render).toContain("Memory");
    if (phase !== "published") {
      expect(result.render).toContain("- one");
      expect(result.render).toContain("- two");
    }
    const restart = run(f.worker, f.dir, "run");
    expect(restart.status, restart.stderr).toBe(0);
    expect(JSON.parse(restart.stdout).outcome).toBe(phase === "published" ? "already-migrated" : "committed");
    expect(readFileSync(join(f.dir, "core.md"), "utf8")).toBe(raw);
    // Missing owner is intentionally retained for D25, never age-cleaned.
    if (phase === "staging-created")
      expect(readdirSync(f.dir).filter((n) => n.startsWith(".blocks-staging-"))).toHaveLength(1);
  },
);
it("two independent startup migrations publish exactly once", async () => {
  const f = fixture();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(f.dir);
  writeFileSync(join(f.dir, "core.md"), "- one\n- two\n");
  const launch = () =>
    new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ["--import", "tsx", f.worker, f.dir, "run"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let out = "",
        err = "";
      c.stdout.on("data", (b) => (out += b));
      c.stderr.on("data", (b) => (err += b));
      c.on("error", reject);
      c.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
    });
  const results = (await Promise.all([launch(), launch()])).map((s) => JSON.parse(s).outcome);
  expect(results.filter((s) => s === "committed")).toHaveLength(1);
  expect(["already-migrated", "aborted"].includes(results.find((s) => s !== "committed")!)).toBe(true);
  expect(JSON.parse(run(f.worker, f.dir, "read").stdout).bodies).toHaveLength(2);
});
it("real v2 tool refuses block paths but can append root legacy files, causing drift", async () => {
  const f = fixture(),
    paths = { memoryRoot: f.root, ccProjectsRoot: join(f.root, "cc") },
    cwd = "/old-session",
    dir = memoryDirFor(cwd, paths);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  writeFileSync(join(dir, "core.md"), "---\nsource: agent\n---\n- root\n");
  await runMigration(dir);
  const tool = createMemoryToolV2({
    paths,
    onAfterWrite: () => {},
    settings: parseMemorySettings({ layout: "tiered" }),
    isChildSession: false,
  });
  const before = readFileSync(join(dir, "blocks/general.001.md"), "utf8");
  const ctx = { cwd, hasUI: false } as Parameters<typeof tool.execute>[4];
  for (const args of [
    { command: "str_replace", path: "blocks/general.001.md", old_str: "root", new_str: "changed" },
    { command: "insert", path: "blocks/general.001.md", insert_line: 0, insert_text: "x" },
    { action: "append", name: "blocks/general.001.md", content: "x" },
    { command: "create", path: "blocks/general.001.md", file_text: "x" },
  ]) {
    // Current v2 with explicit tiered setting models the actual pre-reload writer (plan allows this fallback).
    await expect(tool.execute("call", args, undefined, undefined, ctx)).rejects.toThrow();
  }
  expect(readFileSync(join(dir, "blocks/general.001.md"), "utf8")).toBe(before);
  await tool.execute("call", { action: "append", name: "core.md", content: "- drift" }, undefined, undefined, ctx);
  expect(legacyDrift(dir).map((f) => f.name)).toEqual(["core.md"]);
});

it.each(["rollback-gen", "rollback-hold", "rollback-renamed"])(
  "independent reader and restart at %s boundary",
  async (phase) => {
    const f = fixture();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(f.dir);
    writeFileSync(join(f.dir, "core.md"), "- legacy rule\n");
    await runMigration(f.dir);
    const crashed = run(f.worker, f.dir, `rollback:${phase}`);
    expect(crashed.status, crashed.stderr).toBe(91);
    const read = JSON.parse(run(f.worker, f.dir, "read").stdout);
    expect(read.format).toBe(phase === "rollback-gen" ? "blocks" : "held");
    expect(read.render).toContain("Memory");
    if (phase !== "rollback-gen") {
      const resumed = run(f.worker, f.dir, "resume");
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout.trim()).toBe("held");
    }
  },
);

it("isolated partial cleanup crash is invisible; next lock holder continues deletion", async () => {
  const f = fixture();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(f.dir);
  const raw = "- original\n";
  writeFileSync(join(f.dir, "core.md"), raw);
  expect(run(f.worker, f.dir, "built").status).toBe(91);
  expect(run(f.worker, f.dir, "cleaning").status).toBe(91);
  const read = JSON.parse(run(f.worker, f.dir, "read").stdout);
  expect(read.format).toBe("files");
  expect(read.bodies).toEqual([raw]);
  expect(readdirSync(f.dir).some((n) => n.includes(".trash-"))).toBe(true);
  const restarted = run(f.worker, f.dir, "run");
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(JSON.parse(restarted.stdout).outcome).toBe("committed");
  expect(readdirSync(f.dir).some((n) => n.includes(".trash-"))).toBe(false);
});
