#!/usr/bin/env node
/**
 * traffic node-floor smoke — `docs/dev/traffic-merge/plan.md` r3 §3.1/§8.4（T7 口径，见 plan 末尾修订记录）。
 * 在当前 Node 上真实验证 node:sqlite 可用：加载 → 建临时库 → 写读一条 → 删除；失败非 0。
 * Node 22.5–22.12 需 `--experimental-sqlite`，脚本会在无 flag 时自动补 flag 重跑一次；≥22.13 直接可用。
 * CI 在 `web-min-node` job（Node 22.12.0）跑这一步（实测 <1s，纯 node 内建，无依赖）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadSqlite() {
  try {
    return process.getBuiltinModule?.("node:sqlite") ?? undefined;
  } catch {
    return undefined;
  }
}

let sqlite = loadSqlite();
if (!sqlite && !process.execArgv.some((a) => a.startsWith("--experimental-sqlite"))) {
  // Node 22.5–22.12 keeps node:sqlite behind the flag; re-exec once with it (no loop: the
  // execArgv guard above makes the child take the failure branch instead).
  const rerun = spawnSync(process.execPath, ["--experimental-sqlite", ...process.argv.slice(1)], {
    stdio: "inherit",
  });
  process.exit(rerun.status ?? 1);
}
if (!sqlite?.DatabaseSync) {
  console.error(
    `[traffic] node-floor-smoke: node:sqlite unavailable on ${process.version} ` +
      "(need >=22.13, or 22.5-22.12 with --experimental-sqlite)",
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "traffic-node-floor-"));
const dbPath = join(dir, "traffic.db");
try {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, note TEXT)");
  db.prepare("INSERT INTO smoke (note) VALUES (?)").run("pi-toolkit traffic");
  const row = db.prepare("SELECT id, note FROM smoke WHERE id = 1").get();
  db.close();
  if (row?.id !== 1 || row?.note !== "pi-toolkit traffic") {
    throw new Error(`read-back mismatch: ${JSON.stringify(row)}`);
  }
  console.log(`[traffic] node-floor-smoke OK — node ${process.version}, node:sqlite roundtrip (${dbPath})`);
} catch (err) {
  console.error(`[traffic] node-floor-smoke FAILED: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
