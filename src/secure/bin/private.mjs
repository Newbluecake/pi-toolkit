// pi-secure helper — the `--private` command bodies, split out of helper.mjs (#56 ⑩-S): the record
// subcommands that run under mount.lock (`__private-claim|update|release|abort-start|terminate`),
// the external `lock` of a private instance (lockPrivate/lockOuter), the P0→P1 mount worker
// (`__mount-work`) and the in-namespace supervisor (`__ns-root`). Loaded lazily
// (`await import("./private.mjs")`) by helper.mjs, so a copy of helper.mjs alone still runs every
// other command. Plain ESM, zero dependencies beyond Node ≥22; the pure primitives (record parsing,
// scanning, budgets, spawn specs) stay in helper.mjs and are imported from it — a cycle that is only
// ever entered through helper.mjs. The in-namespace finalize steps live in finalize.mjs.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CliError,
  EXIT,
  HEX32_RE,
  LAZY_DETACHED_TEXT,
  PASSWORD_TRIES,
  PRIVATE_BUDGET,
  REC,
  RETRY_DELAYS_MS,
  TIMEOUT,
  applyRecordPatch,
  armHardExit,
  auditParsedArgs,
  checkLayout,
  closeMountPointPin,
  deadlineRace,
  describePrivateState,
  devMajMin,
  ensureVaultDirs,
  err,
  freshView,
  fsyncDirSync,
  gocryptfsSpawnSpec,
  homeDir,
  identityState,
  inheritedMountProblems,
  innerPiSpawnSpec,
  leaseIdentitySync,
  loadPiParseArgs,
  loadSecureConfig,
  lockPrivateDecision,
  mountPointPinStillValid,
  must,
  nsRootSelfCheck,
  otherRegisteredVaults,
  out,
  outerPrivateCleanup,
  parseArgsShapeOk,
  parsePrivateRecord,
  physicalPaths,
  piChildEnv,
  pinMountPoint,
  privateInstanceState,
  privateRecordPath,
  probeLease,
  probeMountState,
  readBootIdSync,
  readNsLinkSync,
  readPrivateRecord,
  readPrivateRecordSync,
  readProcStartSync,
  readTextOr,
  releaseRecord,
  releaseRecordHoldingMountLock,
  relocateInNs,
  replacePrivateRecord,
  requireNewLayout,
  resolveRunCwd,
  resolveVault,
  runBounded,
  runWorker,
  scanNsMembers,
  signalVerified,
  sleep,
  syncProjectSettings,
  termThenKill,
  terminateInstance,
  testWorkerDelayMs,
  updateRecord,
  vaultMountState,
  verifyMountPointIdentity,
  verifyRunPaths,
  writePrivateRecordExclusive,
} from "./helper.mjs";
import { finalizeInNs, lazyDetach } from "./finalize.mjs";

function deletePrivateRecordSync(v) {
  fs.unlinkSync(privateRecordPath(v));
  fsyncDirSync(v.dir);
}

// ───────────────────────────── record subcommands (run under flock) ─────────────────────────────

/** `__private-update <name> <instanceId> <patchJson>` — UNDER mount.lock. Prints {ok,record?}. */
export function cmdPrivateUpdate(name, instanceId, patchJson) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  let patch;
  try {
    patch = JSON.parse(patchJson);
  } catch {
    return EXIT.FAIL;
  }
  const r = applyRecordPatch(cur.record, instanceId, patch);
  if (r.error === "mismatch") return REC.MISMATCH;
  if (r.error) {
    err(`记录更新被拒：${r.error}`);
    return EXIT.FAIL;
  }
  replacePrivateRecord(v, r.record);
  out(JSON.stringify({ ok: true }));
  return REC.OK;
}

/**
 * `__private-release <name> <instanceId>` — the ONLY record deleter (I-P3). Runs while the caller's
 * flock holds mount.lease (proving every fd-9 holder exited) AND mount.lock; outside the ns.
 * Deletes iff instanceId matches ∧ (bootId differs ∨ the recorded ns has no member — complete scan).
 */
export async function cmdPrivateRelease(name, instanceId) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.ns && rec.bootId === readBootIdSync()) {
    const s = await scanNsMembers(rec.ns.mnt, {
      deadline: Date.now() + PRIVATE_BUDGET.scanMs,
      minStart: rec.supervisor?.start,
    });
    if (s.kind !== "done") {
      out(JSON.stringify({ ok: false, incomplete: s.reason }));
      return REC.INCOMPLETE;
    }
    if (s.members.length) {
      out(JSON.stringify({ ok: false, members: s.members.slice(0, 16) }));
      return REC.MEMBERS;
    }
  }
  deletePrivateRecordSync(v);
  out(JSON.stringify({ ok: true }));
  return REC.OK;
}

/** §3.2 unique exception: the BUSY shell chain never built an ns ⇒ P0 drops its own `starting` record. */
export function cmdPrivateAbortStart(name, instanceId) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.phase !== "starting" || rec.ns || rec.supervisor) return REC.MEMBERS;
  deletePrivateRecordSync(v);
  return REC.OK;
}

/**
 * `__private-terminate <name> <instanceId> <budgetMs>` — UNDER mount.lock (instanceId re-checked
 * inside the lock, I-P4). Signals ONLY recorded identities and ns members whose ns id and
 * starttime (≥ supervisor.start) are re-verified right before each signal. Non-gocryptfs members
 * first (TERM → ≤2 s → KILL), then gocryptfs (TERM → ≤2 s → KILL). Never calls fusermount (I-P7).
 */
export async function cmdPrivateTerminate(name, instanceId, budgetMs) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.bootId !== readBootIdSync()) {
    out(JSON.stringify({ ok: true, killed: [], remaining: [] }));
    return REC.OK;
  }
  // review N4-r2 #1: outer cleanup presupposes a DEAD supervisor — re-proved here, under mount.lock
  if (rec.supervisor) {
    const ss = await identityState(rec.supervisor);
    if (ss !== "dead") {
      out(JSON.stringify({ ok: false, killed: [], remaining: [], supervisor: ss }));
      return REC.SUPERVISOR;
    }
  }
  const r = await terminateInstance(rec, { deadline: Date.now() + Math.max(500, Number(budgetMs) || 0) });
  out(JSON.stringify(r));
  return r.ok ? REC.OK : REC.MEMBERS;
}

/**
 * `__private-claim <name> <instanceId> <ownerPid> <ownerStart> <mode>` — UNDER mount.lock (§2.2-4).
 * Any doubt refuses. Writes the `starting` record with O_EXCL semantics.
 */
export async function cmdPrivateClaim(name, instanceId, ownerPid, ownerStart, mode = "run") {
  const { vault: v, enabled } = must(resolveVault(name));
  requireNewLayout(v);
  void enabled;
  if (!HEX32_RE.test(instanceId ?? "")) throw new CliError(EXIT.FAIL, "内部错误：instanceId 不合法");
  // 1. global mountinfo for THIS vault
  const st = await probeMountState(v);
  if (st === "mounted")
    throw new CliError(
      EXIT.BUSY,
      `${name} 已普通挂载（对所有同用户进程可见）。先 pi-secure lock ${name}，再 run --private；或去掉 --private`,
    );
  if (st === "foreign") throw new CliError(EXIT.FAIL, `${v.mnt} 上挂着别的文件系统（mountinfo 不符），拒绝挂载`);
  if (st === "hung") throw new CliError(EXIT.DEADLINE, `${v.mnt} 的挂载探测超时（FUSE 卡住？），拒绝操作`);
  // 2. Q10: another registered vault mounted globally would be copied into the new ns
  const { cfg } = loadSecureConfig(homeDir());
  for (const o of cfg.valid ? cfg.vaults : []) {
    if (o.name === v.name) continue;
    const ost = await probeMountState(o);
    if (ost === "mounted" || ost === "stale")
      throw new CliError(
        EXIT.BUSY,
        `保险库 ${o.name} 正全局挂载：私有命名空间会复制这个挂载，且无法在其中单独拆除，导致 ${o.name} 之后无法干净卸载。先 pi-secure lock ${o.name}`,
      );
    if (ost === "hung")
      throw new CliError(EXIT.DEADLINE, `保险库 ${o.name} 的挂载探测超时，无法确认它是否全局挂载——拒绝 run --private`);
  }
  // 3. existing record ⇒ judge; only `stale` may be released (non-blocking lease: we hold mount.lock)
  const li = leaseIdentitySync(v);
  if (li.problem) throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${li.problem}`);
  const recNow = readPrivateRecordSync(v);
  if (recNow.kind !== "none") {
    const s = await privateInstanceState(v, { record: recNow });
    if (s.state !== "stale") throw new CliError(EXIT.BUSY, describePrivateState(name, s, v));
    const rel = releaseRecordHoldingMountLock(v, recNow.record.instanceId);
    if (rel.kind !== "released")
      throw new CliError(EXIT.BUSY, `${describePrivateState(name, s, v)}，但无法清理（${rel.kind}）——拒绝`);
    err(`${name}：清理了失效的 --private 记录`);
  }
  // 4. lease (read-only probe)
  const lease = await probeLease(li);
  if (lease === "held") throw new CliError(EXIT.BUSY, describePrivateState(name, { state: "unrecorded" }, v));
  if (lease !== "free") throw new CliError(EXIT.DEADLINE, `无法读取 /proc/locks 判断 ${name} 的挂载租约——拒绝`);
  // 5. stale global mount: lease is free ⇒ no gocryptfs holds it ⇒ safe to clean
  if (st === "stale") {
    err(`${name}：发现失效挂载（守护进程已不在），先清理`);
    spawnSync("fusermount3", ["-u", v.mnt], { stdio: "ignore", timeout: 5_000 });
    if ((await probeMountState(v)) !== "absent")
      throw new CliError(EXIT.FAIL, `无法清理失效挂载 ${v.mnt}：fusermount3 -uz ${v.mnt}`);
  }
  // 6. layout + sentinels (outside view must be pristine)
  const lay = checkLayout(v, { mounted: false, others: otherRegisteredVaults(v) });
  if (lay.problems.length)
    throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${lay.problems.join("\n  - ")}`);
  const bootId = readBootIdSync();
  if (!bootId) throw new CliError(EXIT.PREREQ, "无法读取 /proc/sys/kernel/random/boot_id");
  const { realMnt, realCipher } = physicalPaths(v);
  const rec = {
    v: 3,
    instanceId,
    name,
    phase: "starting",
    mode: mode === "setup" ? "setup" : "run",
    bootId,
    createdAt: new Date().toISOString(),
    realCipher,
    realMnt,
    lease: { dev: li.dev, ino: li.ino },
    owner: { pid: Number(ownerPid), start: Number(ownerStart) },
  };
  if (parsePrivateRecord(JSON.stringify(rec)).kind !== "ok") throw new CliError(EXIT.FAIL, "内部错误：记录不合法");
  try {
    writePrivateRecordExclusive(v, rec);
  } catch (e) {
    if (e && e.code === "EEXIST") throw new CliError(EXIT.BUSY, `${name}：另一个 --private 实例抢先认领`);
    throw new CliError(EXIT.FAIL, `无法写入 ${privateRecordPath(v)}：${e && e.message}`);
  }
  return EXIT.OK;
}

// ───────────────────────────── external lock (§3.7) ─────────────────────────────

const LOCK_WAIT_MS = 10_000;

/**
 * Wait ≤ms for the instance `instanceId` to disappear (record gone / owned by a successor),
 * re-judging liveness about once a second. → {kind:"gone"} | {kind:"stale"|"orphan"|"timeout", view}
 */
async function waitInstanceGone(v, instanceId, ms) {
  const end = Date.now() + ms;
  let nextJudge = Date.now() + 1_000;
  for (;;) {
    const r = await readPrivateRecord(v, { deadline: Date.now() + PRIVATE_BUDGET.scanMs });
    if (r.kind === "none" || (r.kind === "ok" && r.record.instanceId !== instanceId)) return { kind: "gone" };
    const last = Date.now() >= end;
    if (last || Date.now() >= nextJudge) {
      const view = await freshView(v);
      if (view.state === "none" || (view.record && view.record.instanceId !== instanceId)) return { kind: "gone" };
      if (view.state === "stale") return { kind: "stale", view };
      if (view.state === "orphan" || view.state === "orphan-ns") return { kind: "orphan", view };
      if (last) return { kind: "timeout", view };
      nextJudge = Date.now() + 1_000;
    }
    await sleep(200);
  }
}

/** §3.5 from `lock` (hard backstop outerCleanupMs + 0.5 s ⇒ 75). */
async function lockOuter(v, instanceId) {
  const hard = armHardExit(
    PRIVATE_BUDGET.outerCleanupMs + PRIVATE_BUDGET.hardGraceMs,
    `--private 外部收尾未完成（${v.name}），记录保留`,
  );
  try {
    const c = await outerPrivateCleanup(v, instanceId);
    for (const l of c.lines) (c.code === EXIT.OK ? out : err)(l);
    if (c.code === EXIT.OK) out(`${v.name}：已终止并清理 --private 实例`);
    return c.code;
  } finally {
    clearTimeout(hard);
  }
}

/** Read /proc/<pid>/mountinfo of the supervisor (initial-ns caller; bounded). undefined = unreadable. */
async function supervisorMountinfo(sup, procRoot = "/proc") {
  const t = await deadlineRace(
    fsp.readFile(path.join(procRoot, String(sup.pid), "mountinfo"), "utf8"),
    Date.now() + PRIVATE_BUDGET.scanMs,
  ).catch(() => TIMEOUT);
  return typeof t === "string" && readProcStartSync(sup.pid, procRoot) === sup.start ? t : undefined;
}

/**
 * Execute a lockPrivateDecision. `depth` bounds re-judging (a state that changes under us is
 * re-dispatched at most once more).
 */
export async function lockPrivate(v, view, d, opts, depth = 0) {
  const name = v.name;
  const rec = view.record;
  const rejudge = async (why) => {
    const nv = await freshView(v);
    const nd = lockPrivateDecision(v, nv, opts);
    if (nd.action === "plain") {
      out(`${name}：--private 实例已不在${why ? `（${why}）` : ""}`);
      return EXIT.OK;
    }
    if (depth >= 1) {
      err(`${name}：--private 实例状态在操作期间变化（${nv.state}），未完成；pi-secure status ${name}`);
      return nd.action === "refuse" ? nd.code : EXIT.DEADLINE;
    }
    return lockPrivate(v, nv, nd, opts, depth + 1);
  };
  switch (d.action) {
    case "refuse": {
      err(d.text);
      for (const h of view.holders ?? [])
        err(`  持有者 pid ${h.pid} ${h.comm ?? "(已退出/不可读)"}（/proc/locks，只报告）`);
      for (const m of view.classes?.unverified ?? [])
        err(`  命名空间成员 pid ${m.pid} ${m.comm}（无法证明属于该实例，只报告、不终止）`);
      return d.code;
    }
    case "release": {
      const rel = await releaseRecord(v, rec.instanceId, { waitMs: 1_000 });
      if (rel.kind === "released" || rel.kind === "none") {
        out(`${name}：清理了失效的 --private 记录`);
        return EXIT.OK;
      }
      if (rel.kind === "mismatch") return rejudge("记录已换成另一个实例");
      if (depth >= 1) {
        err(`${name}：无法清理失效的 --private 记录（${rel.kind}）；pi-secure status ${name}`);
        return rel.kind === "timeout" || rel.kind === "lease-busy" ? EXIT.DEADLINE : EXIT.BUSY;
      }
      return rejudge();
    }
    case "outer":
      if (d.degrade)
        err(
          `${name}：监督进程已不在，无法在私有命名空间内摘除挂载路径（--lazy 退化）：改为终止有证明归属的进程（含 gocryptfs）并清理记录`,
        );
      return lockOuter(v, rec.instanceId);
    case "kill": {
      const sup = rec.supervisor;
      if (!sup || !signalVerified(sup, "SIGTERM", { nsMnt: rec.ns?.mnt }))
        return depth >= 1 ? EXIT.BUSY : rejudge("监督进程已变化");
      out(`${name}：已通知监督进程（pid ${sup.pid}）结束会话并收尾（≤10 s）…`);
      const hard = armHardExit(LOCK_WAIT_MS + PRIVATE_BUDGET.scanMs * 2 + 2_000, `等待 --private 收尾超时（${name}）`);
      let w;
      try {
        w = await waitInstanceGone(v, rec.instanceId, LOCK_WAIT_MS);
      } finally {
        clearTimeout(hard);
      }
      if (w.kind === "gone") {
        out(`${name}：--private 会话已结束并收尾`);
        return EXIT.OK;
      }
      if (w.kind === "stale") return lockPrivate(v, w.view, { action: "release" }, opts, depth + 1);
      err(`${name}：${w.kind === "orphan" ? "监督进程已退出但收尾未完成" : "10 s 内未完成收尾"}，执行外部收尾`);
      return lockOuter(v, rec.instanceId);
    }
    case "wait": {
      out(`${name}：--private 实例正在收尾，等待（≤10 s）…`);
      const hard = armHardExit(LOCK_WAIT_MS + PRIVATE_BUDGET.scanMs * 2 + 2_000, `等待 --private 收尾超时（${name}）`);
      let w;
      try {
        w = await waitInstanceGone(v, rec.instanceId, LOCK_WAIT_MS);
      } finally {
        clearTimeout(hard);
      }
      if (w.kind === "gone") {
        out(`${name}：--private 实例已收尾`);
        return EXIT.OK;
      }
      if (w.kind === "stale") return lockPrivate(v, w.view, { action: "release" }, opts, depth + 1);
      if (w.kind === "orphan") return lockPrivate(v, w.view, { action: "outer", degrade: opts.lazy }, opts, depth + 1);
      err(`${name}：--private 实例 10 s 内仍未收尾（${w.view.state}）；稍后 pi-secure status ${name}`);
      return EXIT.DEADLINE;
    }
    case "lazy": {
      const sup = rec.supervisor;
      const gone = (mi) => mi !== undefined && vaultMountState(mi, rec.realMnt, rec.realCipher) === "absent";
      if (!sup) return rejudge();
      if (gone(await supervisorMountinfo(sup))) {
        out(`${name}：${LAZY_DETACHED_TEXT}`);
        return EXIT.OK;
      }
      if (!signalVerified(sup, "SIGUSR2", { nsMnt: rec.ns?.mnt }))
        return depth >= 1 ? EXIT.BUSY : rejudge("监督进程已变化");
      const end = Date.now() + 3_000;
      while (Date.now() < end) {
        await sleep(100);
        const mi = await supervisorMountinfo(sup);
        if (mi === undefined && readProcStartSync(sup.pid) !== sup.start) return rejudge("监督进程已退出");
        if (gone(mi)) {
          out(`${name}：${LAZY_DETACHED_TEXT}`);
          return EXIT.OK;
        }
      }
      err(
        `${name}：未能确认私有命名空间内的挂载路径已摘除（监督进程 pid ${sup.pid} 的 mountinfo 仍有该条目）；pi-secure status ${name}；要结束访问请用 --kill`,
      );
      return EXIT.DEADLINE;
    }
    default:
      throw new CliError(EXIT.FAIL, `内部错误：未知 lock 动作 ${d.action}`);
  }
}

// ───────────────────────────── worker (§2.6) ─────────────────────────────

/** `__mount-work` (env PI_SECURE_WORK_SPEC): sync fs under the mount, isolated in a KILLable process. */
export async function cmdMountWork() {
  let spec;
  try {
    spec = JSON.parse(process.env.PI_SECURE_WORK_SPEC ?? "");
  } catch {
    out(JSON.stringify({ ok: false, code: EXIT.FAIL, message: "worker spec 无效" }));
    return EXIT.FAIL;
  }
  delete process.env.PI_SECURE_WORK_SPEC;
  const delay = testWorkerDelayMs(spec?.op);
  if (delay) await sleep(delay);
  try {
    const { vault: v } = must(resolveVault(spec.name));
    const { realMnt } = physicalPaths(v);
    if (spec.op === "readdir") {
      fs.readdirSync(v.mnt);
      out(JSON.stringify({ ok: true }));
      return EXIT.OK;
    }
    if (spec.op === "verify") {
      const pin = { ...spec.pin, fd: spec.pinFd, closed: true };
      verifyMountPointIdentity(v, pin, { readlink: () => fs.readlinkSync(`/proc/${spec.pinPid}/fd/${spec.pinFd}`) });
      out(JSON.stringify({ ok: true }));
      return EXIT.OK;
    }
    if (spec.op === "post-mount") {
      const notes = [];
      ensureVaultDirs(v, { realMnt });
      const r = syncProjectSettings(v, { fix: spec.fix === true });
      if (r.kind === "conflict") throw new CliError(EXIT.CONFIG, r.message);
      if (r.kind === "written") notes.push(`已写入 ${path.join(v.work, ".pi", "settings.json")} 的 sessionDir`);
      if (r.kind === "fixed")
        notes.push(
          `已改写 sessionDir（原文件备份为 ${r.backup}${r.droppedOtherKeys ? "；原文件不是 JSON 对象，其余内容只在备份里" : ""}）`,
        );
      if (spec.mode === "setup") {
        out(JSON.stringify({ ok: true, notes }));
        return EXIT.OK;
      }
      const cwd = resolveRunCwd(v, spec.sub ?? undefined, { physical: true, realMnt });
      const parseArgs = await loadPiParseArgs(spec.piPkg);
      if (!parseArgsShapeOk(parseArgs))
        throw new CliError(EXIT.REFUSED_ARGS, "pi parseArgs 的结果结构变了，参数审查无法保证，拒绝启动");
      const a2 = auditParsedArgs(parseArgs(spec.piArgs ?? []), {
        cwd,
        sessionsRoot: path.join(realMnt, "state", "sessions"),
        physical: true,
      });
      if (!a2.ok) throw new CliError(EXIT.REFUSED_ARGS, `参数被拒：${a2.reason}`);
      verifyRunPaths(v, cwd, { realMnt });
      out(JSON.stringify({ ok: true, cwd, notes }));
      return EXIT.OK;
    }
    throw new CliError(EXIT.FAIL, `未知 worker op：${spec.op}`);
  } catch (e) {
    const code = e instanceof CliError ? e.code : EXIT.FAIL;
    out(JSON.stringify({ ok: false, code, message: String((e && e.message) || e) }));
    return code;
  }
}

/** Poll /proc/<pid>/ns/user until it differs from `outerUser` (the inner unshare ran) — ≤ maxMs. */
async function waitInnerUserNs(pid, outerUser, maxMs = 1_000) {
  const end = Date.now() + maxMs;
  for (;;) {
    const u = readNsLinkSync(pid, "user");
    if (u && u !== outerUser) return u;
    if (u === undefined || Date.now() >= end) return undefined;
    await sleep(10);
  }
}

export async function cmdNsRoot() {
  // stderr EIO (terminal gone) must never crash the supervisor (K13).
  process.stderr.on("error", () => {});
  process.stdout.on("error", () => {});
  const say = (s) => {
    try {
      process.stderr.write(`pi-secure: ${s}\n`);
    } catch {
      /* EIO */
    }
  };
  const S = {
    stage: "init",
    gocry: undefined, // ChildProcess
    gocryId: undefined,
    pi: undefined,
    piId: undefined,
    abort: false,
    readyResolve: undefined,
    lazyBusy: false,
  };
  // Signals FIRST (gocryptfs' SIGUSR1 would otherwise kill us — default action terminates).
  process.on("SIGUSR1", () => S.readyResolve?.("usr1"));
  // N2: SIGUSR2 (`lock --lazy`) is handled from the start too — `lock` may read phase:"session"
  // the instant the record is written, before this process resumes; the default action would
  // kill the supervisor. lazyDetach itself is a no-op outside the session stage.
  process.on("SIGUSR2", () => {
    if (S.onUsr2) S.onUsr2();
    else if (S.stage === "launching") S.usr2Pending = true; // the race window right before "session"
  });
  const interrupt = () => {
    S.onRelocAbort?.(); // V6: a running relocation worker is aborted (setup stage only)
    if (S.stage === "mounting") {
      S.abort = true;
      signalVerified(S.gocryId ?? { pid: -1, start: -1 }, "SIGTERM"); // identity-checked (review N1 #4)
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGQUIT", interrupt);
  process.on("SIGHUP", () => {
    try {
      S.pi && S.pi.kill("SIGHUP");
    } catch {
      /* gone */
    }
  });
  process.on("SIGTERM", () => {
    S.abort = true;
    S.onRelocAbort?.();
    if (S.stage === "mounting") interrupt();
    if (S.pi) {
      try {
        S.pi.kill("SIGTERM");
      } catch {
        /* gone */
      }
      const t = setTimeout(() => {
        try {
          S.pi?.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, PRIVATE_BUDGET.sessionKillGraceMs);
      t.unref();
    }
  });

  let spec;
  try {
    spec = JSON.parse(process.env.PI_SECURE_NS_SPEC ?? "");
  } catch {
    say("内部错误：缺少 ns 规格");
    return EXIT.FAIL;
  }
  delete process.env.PI_SECURE_NS_SPEC;
  const problems = nsRootSelfCheck({
    uid: process.getuid(),
    uidMap: readTextOr("/proc/self/uid_map", ""),
    gidMap: readTextOr("/proc/self/gid_map", ""),
    spec,
  });
  const { vault: v } = (() => {
    const r = resolveVault(spec?.name);
    return r.kind === "ok" ? r : { vault: undefined };
  })();
  if (!v) problems.push("无法解析保险库");
  let rec;
  if (v) {
    const cur = readPrivateRecordSync(v);
    if (cur.kind !== "ok") problems.push(`记录不可用（${cur.kind}）`);
    else if (cur.record.instanceId !== spec.instanceId) problems.push("记录属于另一个实例");
    else if (cur.record.phase !== "starting") problems.push(`记录阶段不是 starting（${cur.record.phase}）`);
    else rec = cur.record;
  }
  // fd 9 must be the lease (dev/ino) AND this very description must hold the flock.
  if (rec) {
    let st;
    try {
      st = fs.fstatSync(9);
    } catch {
      problems.push("fd 9 不存在");
    }
    if (st) {
      const { maj, min } = devMajMin(st.dev);
      if (`${maj}:${min}` !== rec.lease.dev || st.ino !== rec.lease.ino) problems.push("fd 9 不是本库的 mount.lease");
      else {
        const self = await runBounded("flock", ["-n", "9"], {
          deadline: Date.now() + 1_000,
          stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
          killGraceMs: 200,
          abandonMs: 200,
        });
        if (!(self.kind === "exit" && self.code === 0)) problems.push("fd 9 未持有租约锁");
      }
    }
  }
  if (problems.length) {
    say(`私有命名空间自检失败，未挂载：${problems.join("；")}`);
    return EXIT.FAIL; // never touches the record of another instance; P0 releases ours
  }
  const id = spec.instanceId;
  const update = async (patch) => {
    const r = await updateRecord(v, id, patch);
    if (r !== "ok") S.abort = true;
    return r;
  };
  const myStart = readProcStartSync(process.pid);
  const nsMnt = readNsLinkSync("self", "mnt");
  const nsUser = readNsLinkSync("self", "user");
  if (
    (await update({
      phase: "mounting",
      supervisor: { pid: process.pid, start: myStart },
      ns: { mnt: nsMnt, user: nsUser },
    })) !== "ok"
  ) {
    say("记录变迁失败（instanceId 不符或 mount.lock 超时），未挂载");
    return EXIT.FAIL;
  }
  S.stage = "mounting";
  const { realMnt, realCipher } = physicalPaths(v);
  let failCode;
  let failMsg;
  let pin;
  try {
    // Review N1 #3: Q10 re-checked on what THIS namespace actually inherited (closes the window
    // between the claim's global check and unshare). Unreadable ⇒ refuse.
    const mi = await deadlineRace(
      fsp.readFile("/proc/self/mountinfo", "utf8"),
      Date.now() + PRIVATE_BUDGET.scanMs,
    ).catch(() => TIMEOUT);
    if (typeof mi !== "string") throw new CliError(EXIT.DEADLINE, "无法读取私有命名空间的 mountinfo，拒绝挂载");
    const others = otherRegisteredVaults(v).map((o) => ({ name: o.name, realMnt: physicalPaths(o).realMnt }));
    const inherited = inheritedMountProblems(mi, { realMnt, others });
    if (inherited.length)
      throw new CliError(
        EXIT.BUSY,
        `私有命名空间继承了不应存在的挂载，拒绝挂载（另一保险库在认领后被全局解锁？先 lock 它再试）：\n  - ${inherited.join("\n  - ")}`,
      );
    // Inside the userns every unmapped owner (root included) reads as the overflow uid, so the
    // ancestor-chain rule cannot be evaluated here — the claim (initial ns, under mount.lock)
    // already enforced it; everything else (dir/lease/sentinels/position) is re-checked here.
    const lay = checkLayout(v, { mounted: false, others: otherRegisteredVaults(v), ancestors: false });
    if (lay.problems.length)
      throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${lay.problems.join("\n  - ")}`);
    pin = pinMountPoint(v);
    let mounted = false;
    for (let attempt = 1; attempt <= PASSWORD_TRIES && !mounted; attempt++) {
      if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
      mountPointPinStillValid(v, pin);
      const g = gocryptfsSpawnSpec(realCipher, realMnt, process.pid);
      const child = spawn(g.cmd, g.args, g.opts);
      S.gocry = child;
      // Identity captured at spawn (review N1 #4): every later signal re-verifies pid+starttime.
      const gStart = child.pid ? readProcStartSync(child.pid) : undefined;
      S.gocryId = gStart === undefined ? undefined : { pid: child.pid, start: gStart };
      const exited = new Promise((resolve) => {
        child.on("error", () => resolve(127));
        child.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
      });
      const ready = new Promise((resolve) => (S.readyResolve = resolve));
      let attemptTimer;
      const timeout = new Promise((resolve) => {
        attemptTimer = setTimeout(() => resolve("timeout"), PRIVATE_BUDGET.mountAttemptMs);
        attemptTimer.unref();
      });
      const first = await Promise.race([ready, exited.then((c) => ({ exit: c })), timeout]);
      clearTimeout(attemptTimer);
      S.readyResolve = undefined;
      if (first === "timeout") {
        termThenKill(S.gocryId, { graceMs: PRIVATE_BUDGET.mountKillGraceMs, exited });
        await Promise.race([exited, sleep(PRIVATE_BUDGET.mountKillGraceMs + PRIVATE_BUDGET.mountAbandonMs)]);
        throw new CliError(EXIT.DEADLINE, "gocryptfs 在 180 s 内未完成挂载（口令提示无人应答？）");
      }
      if (first !== "usr1") {
        const code = first.exit;
        S.gocry = undefined;
        S.gocryId = undefined;
        if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
        if (code === 12) {
          if (attempt < PASSWORD_TRIES) {
            say(`口令错误（${attempt}/${PASSWORD_TRIES}）`);
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }
          throw new CliError(EXIT.BAD_PASSWORD, `口令连续错误 ${PASSWORD_TRIES} 次`);
        }
        const why =
          code === 10
            ? "挂载点非空"
            : code === 19
              ? "挂载点不可写"
              : code === 23
                ? "gocryptfs.conf 无法读取"
                : code >= 128
                  ? "被中断"
                  : `exit ${code}`;
        throw new CliError(EXIT.FAIL, `gocryptfs 挂载失败（${why}）`);
      }
      // SIGUSR1 seen (Node cannot see the sender; the mountinfo + readdir checks below prove it).
      S.gocryExited = exited;
      mounted = true;
    }
    const readyDl = Date.now() + PRIVATE_BUDGET.readyMs;
    let st = "absent";
    while (Date.now() < readyDl) {
      const mi = await fsp.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
      st = vaultMountState(mi, realMnt, realCipher);
      if (st === "mounted") break;
      await sleep(50);
    }
    if (st !== "mounted") throw new CliError(EXIT.FAIL, `gocryptfs 已就绪但 ns 内 mountinfo 不符（${st}）`);
    const rd = await runWorker({ op: "readdir", name: v.name }, PRIVATE_BUDGET.readyMs);
    if (!rd.ok) throw new CliError(rd.code ?? EXIT.FAIL, `挂载探活失败：${rd.message}`);
    if (!S.gocryId) throw new CliError(EXIT.FAIL, "无法读取 gocryptfs 的进程身份");
    const nextPhase = spec.mode === "setup" ? "setup" : "launching";
    if ((await update({ phase: nextPhase, gocryptfs: S.gocryId })) !== "ok")
      throw new CliError(EXIT.FAIL, "记录变迁失败，中止");
    S.stage = nextPhase;
    const vf = await runWorker(
      {
        op: "verify",
        name: v.name,
        pinPid: process.pid,
        pinFd: pin.fd,
        pin: { path: pin.path, dev: pin.dev, ino: pin.ino, parent: pin.parent },
      },
      PRIVATE_BUDGET.readyMs,
    );
    closeMountPointPin(pin);
    if (!vf.ok) throw new CliError(vf.code ?? EXIT.FAIL, vf.message);
    if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
    // convert-plan §3.4 (V6): setup mode carrying a relocation runs the fd-anchored relocation steps
    // (archive.mjs, workers) on this RAW private mount instead of the path-based post-mount writes.
    const pm =
      spec.mode === "setup" && typeof spec.relocateTxid === "string"
        ? await relocateInNs(v, spec.relocateTxid, realMnt, S)
        : await runWorker(
            {
              op: "post-mount",
              name: v.name,
              mode: spec.mode,
              fix: spec.fix === true,
              sub: spec.sub ?? null,
              piArgs: spec.piArgs ?? [],
              piPkg: spec.piPkg,
            },
            PRIVATE_BUDGET.postMountMs,
          );
    for (const n of pm.notes ?? []) say(n);
    if (!pm.ok) throw new CliError(pm.code ?? EXIT.FAIL, pm.message);
    if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
    if (spec.mode !== "setup") {
      const ps = innerPiSpawnSpec({
        uid: spec.uid,
        gid: spec.gid,
        piBin: spec.piBin,
        sessionDir: v.sessionDir,
        piArgs: spec.piArgs ?? [],
        cwd: pm.cwd,
        env: piChildEnv(v, pm.cwd, process.env, { ns: true }),
      });
      const pi = spawn(ps.cmd, ps.args, ps.opts);
      S.pi = pi;
      const piExited = new Promise((resolve) => {
        pi.on("error", (e) => {
          say(`无法启动 pi：${e && e.message}`);
          resolve(127);
        });
        pi.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
      });
      let piDone = false;
      piExited.then(() => (piDone = true));
      // Review N1 #5: the session (pi identity + its inner userns id) MUST be published before
      // the open-ended wait. Any failure ⇒ stop the just-started pi (ChildProcess-guarded TERM,
      // bounded KILL), then the normal bounded finalize with a failure code.
      const ps0 = pi.pid ? readProcStartSync(pi.pid) : undefined;
      if (ps0 !== undefined) S.piId = { pid: pi.pid, start: ps0 };
      const innerUser = S.piId ? await waitInnerUserNs(pi.pid, nsUser) : undefined;
      let published = "skipped";
      if (!piDone) {
        published =
          S.piId && innerUser
            ? await update({ phase: "session", pi: S.piId, ns: { mnt: nsMnt, user: nsUser, innerUser } })
            : "identity";
      }
      if (published !== "ok" && published !== "skipped" && !piDone) {
        say(
          `会话身份登记失败（${published === "failed" ? "mount.lock 超时或写入失败" : published === "mismatch" ? "记录已不属于本实例" : "无法读取 pi 的进程身份"}），终止 pi 并收尾`,
        );
        S.abort = true;
        try {
          pi.kill("SIGTERM"); // ChildProcess.kill is a no-op once the child was reaped
        } catch {
          /* gone */
        }
        if (
          (await Promise.race([piExited, sleep(PRIVATE_BUDGET.sessionKillGraceMs).then(() => TIMEOUT)])) === TIMEOUT
        ) {
          try {
            pi.kill("SIGKILL");
          } catch {
            /* gone */
          }
          await Promise.race([piExited, sleep(1_000)]);
        }
        S.pi = undefined;
        S.stage = "finalizing";
        const fc = published === "failed" ? EXIT.DEADLINE : EXIT.FAIL;
        await update({ phase: "finalizing", failCode: fc });
        return await finalizeInNs(v, { realMnt, id, S, say, exitCode: fc });
      }
      S.stage = "session";
      S.onUsr2 = () => void lazyDetach(v, realMnt, id, S, say);
      if (S.usr2Pending) {
        S.usr2Pending = false;
        S.onUsr2();
      }
      const code = await piExited;
      S.pi = undefined;
      S.stage = "finalizing";
      await update({ phase: "finalizing", piExit: { code } });
      return await finalizeInNs(v, { realMnt, id, S, say, exitCode: code });
    }
  } catch (e) {
    failCode = e instanceof CliError ? e.code : EXIT.FAIL;
    failMsg = e instanceof CliError ? e.message : String((e && e.message) || e);
  } finally {
    closeMountPointPin(pin);
  }
  if (failMsg) say(failMsg);
  S.stage = "finalizing";
  const code = failCode ?? EXIT.OK;
  await update({ phase: "finalizing", ...(failCode ? { failCode } : {}) });
  return await finalizeInNs(v, { realMnt, id, S, say, exitCode: code });
}
