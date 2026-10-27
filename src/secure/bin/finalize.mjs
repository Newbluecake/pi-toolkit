// pi-secure helper — the in-namespace unmount/finalize half of the `--private` supervisor
// (finalizeInNs, lazyDetach), split out of helper.mjs (#56 ⑩-S). Used only by private.mjs's `__ns-root`
// entry. Loaded lazily; plain ESM, zero dependencies beyond Node ≥22; primitives come from helper.mjs.

import {
  EXIT,
  PRIVATE_BUDGET,
  TIMEOUT,
  armHardExit,
  readNsLinkSync,
  readProcStartSync,
  runBounded,
  scanNsMembers,
  signalVerified,
  sleep,
  testFinalizeStallMs,
  updateRecord,
} from "./helper.mjs";

export async function lazyDetach(v, realMnt, id, S, say) {
  if (S.lazyBusy || S.stage !== "session") return;
  S.lazyBusy = true;
  try {
    const r = await runBounded("umount", ["-n", "-l", realMnt], {
      deadline: Date.now() + 1_000,
      killGraceMs: 200,
      abandonMs: 200,
    });
    if (r.kind === "exit" && r.code === 0) {
      await updateRecord(v, id, { lazyDetachedAt: new Date().toISOString() });
      say(
        "已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）",
      );
    }
  } finally {
    S.lazyBusy = false;
  }
}

/**
 * §3.4 ns-internal finalize (P1): members TERM→KILL (≤3 rounds), umount -n (EBUSY ⇒ -l), wait /
 * TERM / KILL gocryptfs, verify, record inNsDone. NEVER deletes the record (I-P3). Budget 10 s,
 * hard backstop 10.5 s ⇒ exit 75.
 */
export async function finalizeInNs(v, { realMnt, id, S, say, exitCode }) {
  const deadline = Date.now() + PRIVATE_BUDGET.finalizeInNsMs;
  const hard = armHardExit(PRIVATE_BUDGET.finalizeInNsMs + PRIVATE_BUDGET.hardGraceMs, `ns 内收尾未完成（${v.name}）`);
  const stall = testFinalizeStallMs();
  if (stall) await sleep(stall); // TEST-ONLY (see testFinalizeStallMs): the hard backstop above still fires
  const pending = [];
  const nsMnt = readNsLinkSync("self", "mnt");
  const myStart = readProcStartSync(process.pid);
  const gocryPid = S.gocry?.pid;
  const scan = () =>
    scanNsMembers(nsMnt, {
      deadline: Math.min(deadline, Date.now() + PRIVATE_BUDGET.scanMs),
      minStart: myStart,
      exclude: [process.pid, ...(gocryPid ? [gocryPid] : [])],
      deniedMeans: "outside",
    });
  try {
    // 2. members (re-verified per signal), at most 3 rounds, ≤3.5 s
    const memberDl = Math.min(deadline, Date.now() + 3_500);
    let listed = false;
    const gocryKids = new Map();
    for (let round = 0; round < 3; round++) {
      const s = await scan();
      if (s.kind !== "done") {
        pending.push(`members:${s.reason}`);
        break;
      }
      // gocryptfs' own helpers (its syslog `logger`, started because -notifypid marks it as the
      // daemon child) belong to gocryptfs: they end with it — killing them first could SIGPIPE it.
      for (const m of s.members) if (gocryPid && m.ppid === gocryPid) gocryKids.set(m.pid, m);
      s.members = s.members.filter((m) => !gocryKids.has(m.pid));
      if (!s.members.length) break;
      if (!listed) {
        say(`收尾：终止命名空间内遗留的进程（仅本次 ns 内启动的；外部启动的 tmux server 等不受影响）：`);
        listed = true;
      }
      for (const m of s.members) {
        say(`  pid ${m.pid} ${m.comm}`);
        signalVerified(m, round === 0 ? "SIGTERM" : "SIGKILL", { nsMnt });
      }
      const waitEnd = Math.min(memberDl, Date.now() + (round === 0 ? 2_000 : 500));
      while (Date.now() < waitEnd) {
        if (s.members.every((m) => readProcStartSync(m.pid) !== m.start)) break;
        await sleep(100);
      }
      for (const m of s.members) if (readProcStartSync(m.pid) === m.start) signalVerified(m, "SIGKILL", { nsMnt });
      if (Date.now() >= memberDl) break;
    }
    // 3. umount inside the ns (private mounts are invisible to outer fusermount3)
    if (S.gocry) {
      const left = () => deadline - Date.now();
      const u = await runBounded("umount", ["-n", realMnt], {
        deadline: Date.now() + Math.min(2_000, Math.max(100, left() - 3_000)),
        killGraceMs: 0,
        abandonMs: 100,
      });
      if (!(u.kind === "exit" && u.code === 0)) {
        const notMounted = u.kind === "exit" && /not mounted|未挂载/i.test(u.stderr);
        if (!notMounted) {
          const l = await runBounded("umount", ["-n", "-l", realMnt], {
            deadline: Date.now() + 1_000,
            killGraceMs: 0,
            abandonMs: 100,
          });
          if (!(l.kind === "exit" && l.code === 0)) pending.push("umount");
        }
      }
      // 4. gocryptfs (our direct child, -fg) exits once unmounted
      const gone = await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(2_000).then(() => TIMEOUT)]);
      if (gone === TIMEOUT && S.gocryId) {
        signalVerified(S.gocryId, "SIGTERM");
        const g2 = await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(500).then(() => TIMEOUT)]);
        if (g2 === TIMEOUT) {
          signalVerified(S.gocryId, "SIGKILL");
          await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(300)]);
        }
      }
      if (S.gocryId && readProcStartSync(S.gocryId.pid) === S.gocryId.start) pending.push("gocryptfs");
    }
    // 5. verify: no member left besides us (gocryptfs' helpers get ≤0.5 s to see EOF, then KILL)
    let fin = await scan();
    const isKid = (m) => gocryKids.get(m.pid)?.start === m.start;
    if (fin.kind === "done" && fin.members.length && fin.members.every(isKid)) {
      await sleep(500);
      fin = await scan();
      if (fin.kind === "done") for (const m of fin.members) signalVerified(m, "SIGKILL", { nsMnt });
      if (fin.kind === "done" && fin.members.length) {
        await sleep(200);
        fin = await scan();
      }
    }
    if (fin.kind !== "done") pending.push(`verify:${fin.reason}`);
    else if (fin.members.length) pending.push(`members:${fin.members.map((m) => m.pid).join(",")}`);
    const done = pending.length === 0;
    await updateRecord(v, id, done ? { inNsDone: true } : { inNsDone: false, inNsPending: pending.slice(0, 16) });
    if (!done) {
      say(`ns 内收尾未完成（${pending.join("，")}），将由启动器做外部收尾`);
      return EXIT.DEADLINE;
    }
    return exitCode;
  } finally {
    clearTimeout(hard);
  }
}
