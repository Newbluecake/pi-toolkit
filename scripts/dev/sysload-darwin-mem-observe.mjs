#!/usr/bin/env node
/**
 * sysload darwin-plan §2.9 / §7.2 M15 — `kern.memorystatus_level` evidence collector.
 *
 * Read-only observer for the D1 decision point (should darwin mem ever enter the gate?):
 * samples `kern.memorystatus_level` for N beats (default 30 × 2 s) and cross-checks it
 * against the kernel's OWN pressure signal (`kern.memorystatus_vm_pressure_level`),
 * `/usr/bin/memory_pressure`'s "System-wide memory free percentage" (when present) and
 * `vm_stat` page evidence. Prints a per-beat table plus a closing「D1 决策建议素材」summary.
 *
 * Pure standalone dev script: no build, no imports from src/, never shipped. Every
 * subprocess it starts is bounded (absolute binary, positive timeout, SIGKILL on expiry).
 * On any non-darwin platform it prints one line and exits 0.
 *
 * Usage:
 *   node scripts/dev/sysload-darwin-mem-observe.mjs [--beats 30] [--interval-ms 2000]
 *        [--scenario idle|normal|stress] [--csv /path/to/out.csv]
 *
 * Scenarios (plan §2.9): `idle` = terminal only; `normal` = regular dev workload running
 * alongside; `stress` = run your controlled allocator (50/70/85/92% of hw.memsize, held 3 min
 * each, watch vm.swapusage) in a SEPARATE process while this observer records. This script
 * itself never allocates — it must stay read-only so it cannot perturb what it measures.
 */
import { execFile as execFileCb } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SYSCTL = "/usr/sbin/sysctl";
const VM_STAT = "/usr/bin/vm_stat";
const MEMORY_PRESSURE = "/usr/bin/memory_pressure";
const SUBPROCESS_TIMEOUT_MS = 2_000;
const MAX_BUFFER = 256 * 1024;

/** args */
function parseArgs(argv) {
  const out = { beats: 30, intervalMs: 2_000, scenario: "idle", csv: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (arg === "--beats") out.beats = Number(next());
    else if (arg === "--interval-ms") out.intervalMs = Number(next());
    else if (arg === "--scenario") out.scenario = String(next());
    else if (arg === "--csv") out.csv = String(next());
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(out.beats) || out.beats < 1 || out.beats > 10_000) throw new Error("--beats: 1..10000");
  if (!Number.isInteger(out.intervalMs) || out.intervalMs < 200 || out.intervalMs > 60_000)
    throw new Error("--interval-ms: 200..60000");
  if (!["idle", "normal", "stress"].includes(out.scenario)) throw new Error("--scenario: idle|normal|stress");
  return out;
}

/** One bounded C-locale child run; resolves undefined on ANY failure (never throws). */
async function run(file, args) {
  try {
    const { stdout } = await execFile(file, args, {
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: SUBPROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

const sysctl = (names) => run(SYSCTL, ["-n", ...names]);
const intOf = (text) => {
  const value = Number(String(text ?? "").trim());
  return Number.isFinite(value) ? value : undefined;
};

/** `vm_stat` free-ish page pool (free+inactive+speculative+purgeable) as % of hw.memsize. */
function vmStatFreeishPct(text, pageSize, memSize) {
  if (text === undefined || pageSize === undefined || memSize === undefined) return undefined;
  let bytes = 0;
  let seen = 0;
  for (const name of ["free", "inactive", "speculative", "purgeable"]) {
    const match = text.match(new RegExp(`Pages ${name}:\\s+(\\d+).`));
    if (match) {
      bytes += Number(match[1]) * pageSize;
      seen++;
    }
  }
  if (seen === 0) return undefined;
  return Math.round((1000 * bytes) / memSize) / 10;
}

/** `/usr/bin/memory_pressure`'s "System-wide memory free percentage: NN%". */
function memoryPressureFreePct(text) {
  if (text === undefined) return undefined;
  const match = text.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/);
  return match ? Number(match[1]) : undefined;
}

const pct = (value) => (value === undefined ? "    n/a" : `${value.toFixed(1).padStart(6)}%`);
const pad = (value, width) => String(value).padStart(width);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`unsupported platform: ${process.platform} (darwin-only evidence collector)`);
    return;
  }
  const opts = parseArgs(process.argv.slice(2));

  // Machine facts for the coverage statement (plan §2.9: 只代表已测机型/RAM).
  const [model, memSizeText, pageSizeText] = await Promise.all([
    sysctl(["hw.model"]),
    sysctl(["hw.memsize"]),
    sysctl(["hw.pagesize"]),
  ]);
  const memSize = intOf(memSizeText);
  const pageSize = intOf(pageSizeText);
  const hasMemoryPressure = existsSync(MEMORY_PRESSURE);

  console.log("sysload darwin mem observe (darwin-plan §2.9 / M15 — D1 decision evidence)");
  console.log(
    `machine=${(model ?? "n/a").trim()} ram=${memSize ? `${(memSize / 2 ** 30).toFixed(0)}GiB` : "n/a"} ` +
      `scenario=${opts.scenario} beats=${opts.beats} interval=${opts.intervalMs}ms ` +
      `memory_pressure=${hasMemoryPressure ? "present" : "absent"}`,
  );
  console.log(
    "columns: beat | level(kern.memorystatus_level, 即换算 availPct) | vmPressure(内核 1/2/4) | " +
      "memory_pressure free% | vm_stat freeish% (free+inactive+spec+purgeable) | swapUsed",
  );

  const csvPath =
    opts.csv ?? `${tmpdir()}/sysload-darwin-mem-${opts.scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const csvLines = [
    "beat,scenario,level,vm_pressure,memory_pressure_free_pct,vm_stat_freeish_pct,swap_used_mib,at_iso",
  ];

  const rows = [];
  for (let beat = 1; beat <= opts.beats; beat++) {
    const at = new Date().toISOString();
    const [levelText, pressureText, swapText] = await Promise.all([
      sysctl(["kern.memorystatus_level"]),
      sysctl(["kern.memorystatus_vm_pressure_level"]),
      sysctl(["vm.swapusage"]),
    ]);
    const vmStatText = await run(VM_STAT, []);
    const mpText = hasMemoryPressure ? await run(MEMORY_PRESSURE, []) : undefined;
    const level = intOf(levelText);
    const vmPressure = intOf(pressureText);
    const mpFree = memoryPressureFreePct(mpText);
    const freeish = vmStatFreeishPct(vmStatText, pageSize, memSize);
    const swapUsed = (() => {
      const match = String(swapText ?? "").match(/used\s*=\s*([\d.]+)M/);
      return match ? Number(match[1]) : undefined;
    })();

    console.log(
      `${pad(beat, 4)} | ${pad(level ?? "n/a", 5)} | ${pad(vmPressure ?? "n/a", 9)} | ` +
        `${pad(mpFree === undefined ? "n/a" : mpFree.toFixed(0) + "%", 15)} | ` +
        `${pad(freeish === undefined ? "n/a" : freeish.toFixed(1) + "%", 18)} | ` +
        `${pad(swapUsed === undefined ? "n/a" : swapUsed.toFixed(0) + "MiB", 10)}`,
    );
    rows.push({ beat, level, vmPressure, mpFree, freeish, swapUsed });
    csvLines.push(
      [beat, opts.scenario, level ?? "", vmPressure ?? "", mpFree ?? "", freeish ?? "", swapUsed ?? "", at].join(","),
    );
    if (beat < opts.beats) await sleep(opts.intervalMs);
  }

  writeFileSync(csvPath, `${csvLines.join("\n")}\n`);
  console.log(`\nraw csv: ${csvPath}`);

  // ── D1 决策建议素材（§7.2 M15：只汇总已测样本，不代替 P1–P5 全量取证） ──
  const valid = rows.filter((row) => row.level !== undefined && row.vmPressure !== undefined);
  const normal1 = valid.filter((row) => row.vmPressure === 1);
  const pressured = valid.filter((row) => row.vmPressure >= 2);
  const p1Violations = normal1.filter((row) => row.level <= 8);
  const p1Share =
    normal1.length === 0 ? undefined : (100 * normal1.filter((r) => r.level > 15).length) / normal1.length;
  const p2SawLow = pressured.filter((row) => row.level <= 15);
  const p2SawCrit = pressured.filter((row) => row.level <= 8);
  const contradictions = valid.filter(
    (row) => (row.vmPressure >= 2 && row.level > 15) || (row.vmPressure === 1 && row.level <= 8),
  );

  console.log("\n── D1 决策建议素材（M15；结论仅覆盖本次采样，不代表压力/恢复全场景） ──");
  console.log(`样本有效率: ${valid.length}/${rows.length} 拍`);
  if (normal1.length > 0) {
    console.log(
      `P1（无假阳性）初步: vmPressure==1 共 ${normal1.length} 拍，level 最小 ${Math.min(...normal1.map((r) => r.level))}；` +
        `level>15 占比 ${p1Share.toFixed(1)}%；level≤8 的违例 ${p1Violations.length} 拍` +
        (p1Violations.length > 0 ? "（存在 ⇒ 不满足 P1）" : ""),
    );
  } else {
    console.log("P1（无假阳性）初步: 本轮无 vmPressure==1 样本，证据不足");
  }
  console.log(
    `P2（真阳性）初步: vmPressure≥2 共 ${pressured.length} 拍；其中 level≤15 的 ${p2SawLow.length} 拍、level≤8 的 ${p2SawCrit.length} 拍` +
      (pressured.length === 0 ? "（本轮无压力样本——需 S-stress 场景补测）" : ""),
  );
  console.log(
    `P5（现象解释）矛盾点: ${contradictions.length} 拍 vmPressure 与 level 口径相悖` +
      (contradictions.length === 0
        ? ""
        : `（拍号 ${contradictions.map((r) => r.beat).join(",")} — 需逐条解释或标注未解）`),
  );
  console.log("P3/P4（恢复/可分配性）: 需 S-stress 分配-释放场景另行取证（--scenario stress + 外部受控分配进程）");
  console.log(
    "\n决策提示: 上述素材仅是单轮采样。在 M15 全量取证（S-idle/S-normal/S-stress）完成并写入 darwin-report.md 之前，" +
      "DARWIN_MEM_ADVISORY 必须保持 true（D1 决策点，用户拍板，任何人不得翻转）。",
  );
}

main().catch((error) => {
  console.error(`sysload-darwin-mem-observe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
