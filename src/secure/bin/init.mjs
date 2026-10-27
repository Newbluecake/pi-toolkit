// pi-secure helper — `pi-secure init` (cmdInit), split out of helper.mjs (#56 ⑩-S). Loaded lazily
// (`await import("./init.mjs")`) by helper.mjs's dispatcher, so a copy of helper.mjs alone still runs
// every other command. Plain ESM, zero dependencies beyond Node ≥22; it takes its primitives from
// helper.mjs (a cycle that is only ever entered through helper.mjs, never the other way round).

import tty from "node:tty";
import {
  CliError,
  EXIT,
  PASSWORD_TRIES,
  checkLayout,
  closeInitHolds,
  createLayout,
  deriveVault,
  err,
  expandSecurePath,
  finalizeBounded,
  fixSettingsRelocate,
  formatInitCleanup,
  getVaultEntryRaw,
  homeDir,
  initCleanupHint,
  initWrittenEntry,
  legacyRefusal,
  lstatOrNull,
  must,
  otherRegisteredVaults,
  out,
  prepareInitCipher,
  printWarnings,
  privatePreflight,
  probeMountState,
  promptLine,
  recordInitCipher,
  refuseUnfinished,
  registerVault,
  removeInitVault,
  requireNewLayout,
  requirePrereqs,
  requireTty,
  resolveVault,
  runInherited,
  runPrivate,
  setAsideInitSkeleton,
  unlockVault,
  usageText,
} from "./helper.mjs";

export async function cmdInit(args) {
  let name;
  let mntArg;
  let fix = false;
  let priv = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path") mntArg = args[++i];
    else if (a.startsWith("--path=")) mntArg = a.slice(7);
    else if (a === "--fix-settings") fix = true;
    else if (a === "--private") priv = true;
    else if (!name && !a.startsWith("-")) name = a;
    else throw new CliError(EXIT.USAGE, usageText());
  }
  if (!name) throw new CliError(EXIT.USAGE, usageText());
  const home = homeDir();
  if (fix) {
    if (mntArg !== undefined) throw new CliError(EXIT.USAGE, "--fix-settings 不与 --path 同用");
    if (priv)
      throw new CliError(
        EXIT.USAGE,
        `--fix-settings 不与 --private 同用（已登记库是否私有由 secure.vaults.${name}.private 决定）`,
      );
    const { vault: v } = must(resolveVault(name));
    requireNewLayout(v); // §L.3
    refuseUnfinished(v, { allowRelocate: true }); // §3.5: pending ⇒ 76
    // convert-plan §3.4 (V6): a pending relocation turns --fix-settings into the controlled
    // relocation entry. Without the marker the original paths below run unchanged.
    if (v.relocate !== undefined) return await fixSettingsRelocate(v, home);
    if (v.private === true) {
      // §1.1: a private vault is fixed INSIDE its private ns (P1 setup mode), then unmounted.
      const code = await runPrivate(v, { mode: "setup", fix: true });
      if (code === EXIT.OK) out(`${name}：sessionDir 已对齐（在私有命名空间内完成，已卸载）`);
      return code;
    }
    await unlockVault(v, { fix: true });
    out(`${name}：sessionDir 已对齐；保险库保持挂载（pi-secure lock ${name} 卸载）`);
    return EXIT.OK;
  }
  const r = must(resolveVault(name, { allowUnregistered: true }));
  if (r.registered && r.vault.layout === "legacy") {
    throw new CliError(EXIT.CONFIG, legacyRefusal(r.vault)); // §L.3: re-init over a legacy vault
  }
  // Security review V6 #2: never re-create over an unfinished convert/import (pending, malformed
  // keys, relocate, or state files for this name) — and the registration below is a settings-lock
  // CAS against exactly what was read here (absent ⇒ expectAbsent; present ⇒ the same raw entry).
  refuseUnfinished(r.vault, { home });
  const entryBefore = r.registered ? getVaultEntryRaw(name, home) : undefined;
  if (lstatOrNull(r.vault.dir)) {
    const lay = checkLayout(r.vault, {
      mounted: (await probeMountState(r.vault)) !== "absent",
      others: otherRegisteredVaults(r.vault),
    });
    throw new CliError(
      EXIT.FAIL,
      lay.problems.length
        ? `${r.vault.dir} 已存在但布局不完整（上次 init 未完成？）：\n  - ${lay.problems.join("\n  - ")}\n${initCleanupHint(r.vault)}`
        : `保险库 ${name} 已存在（${r.vault.dir}）。修正项目 sessionDir 用：pi-secure init ${name} --fix-settings`,
    );
  }
  let v = r.vault;
  if (mntArg !== undefined) {
    // §L.1: --path is the MOUNT POINT location now (used to be the entry symlink).
    const m = expandSecurePath(mntArg, home);
    if (!m) throw new CliError(EXIT.USAGE, `--path 须为绝对路径或 ~/ 开头：${mntArg}`);
    v = deriveVault(name, v.dir, m);
  }
  requirePrereqs();
  if (priv) {
    // Before anything is created: a host without usable user namespaces gets nothing half-made.
    const pf = await privatePreflight();
    if (!pf.ok)
      throw new CliError(
        EXIT.PREREQ,
        `--private 前置检查失败，未创建任何东西：\n  - ${pf.problems.join("\n  - ")}\n  去掉 --private 仍可创建普通保险库`,
      );
  }
  requireTty("init");
  if (!tty.isatty(1))
    throw new CliError(EXIT.USAGE, "init 会在终端打印 master key，stdout 必须是终端（不要重定向到文件/管道）");
  // identities of what THIS run created, recorded at creation (review V6 round 2 + init cleanup)
  const made = createLayout(v, { others: otherRegisteredVaults(v), hold: true });
  const written = initWrittenEntry(v, priv);
  // Registered BEFORE gocryptfs -init so an interrupted init shows up in `status` as incomplete.
  // (N2 call site migrated to the V0 entry-object signature; the written bytes are identical.)
  try {
    registerVault(
      name,
      written,
      entryBefore === undefined ? { home, expectAbsent: true } : { home, expectEntry: entryBefore },
    );
  } catch (e) {
    // Lost the claim to a concurrent convert/import (or the entry changed since it was read):
    // NOTHING is deleted (review V6 round 2) — the skeleton this run created is renamed aside
    // (identity-checked, no-replace) so the winner's publish is not blocked; anything else stays.
    closeInitHolds(made); // the set-aside path is rename-only and needs no held evidence
    const r2 = await setAsideInitSkeleton(v, made);
    const lines = [String(e && e.message), "  本次 init 未完成，未登记。"];
    for (const m of r2.moved) lines.push(`  ${m.from} → ${m.to}`);
    if (r2.moved.length) lines.push("  以上目录为本次创建的空骨架，核对后可自行删除。");
    for (const k of r2.kept) lines.push(`  保留未动：${k.path}（${k.reason}）`);
    if (r2.kept.length) lines.push(initCleanupHint(v));
    throw new CliError(EXIT.CONFIG, lines.join("\n"));
  }
  out(
    `即将创建保险库 ${name}：gocryptfs 会要求输入两次新口令，然后在终端打印 master key（只显示这一次，请抄下离线保存）。`,
  );
  // NOT -q: with -q gocryptfs 1.8 does not print the master key (P0 C1).
  prepareInitCipher(v, made); // held cipher dir still empty + start time for the provenance check
  const code = await runInherited("gocryptfs", ["-init", "--", v.cipher]);
  recordInitCipher(v, made); // provable -init products only (success or failure)
  const cleanup = () => removeInitVault(v, made, { written, before: entryBefore, home });
  if (code !== 0) {
    // init cleanup ① (user ruling 2026-10-24): nothing usable was created — remove it automatically
    const r = await cleanup();
    throw new CliError(
      EXIT.FAIL,
      [`gocryptfs -init 失败（exit ${code}）；清理本次创建的内容：`, ...formatInitCleanup(v, r)].join("\n"),
    );
  }
  /** init cleanup ② (ruling): the first mount failed with 3 wrong passwords — ask (TTY only). */
  const offerRemoval = async (what) => {
    err(`${name}：${what}`);
    const ok = tty.isatty(0)
      ? /^(y|yes)$/i.test(
          String(
            await promptLine(
              `是否删除刚创建的空保险库 ${name}？删除后刚才打印的 master key 作废，需要重新 pi-secure init ${name}。[y/N] `,
            ),
          ).trim(),
        )
      : false;
    if (!ok) {
      closeInitHolds(made);
      err(
        `已保留保险库 ${name}（已创建并登记${priv ? "为 --private" : ""}）：用正确的口令执行 pi-secure init ${name} --fix-settings 补齐目录与 sessionDir`,
      );
      return;
    }
    const r = await cleanup();
    for (const l of [`${name}：按要求清理本次创建的内容：`, ...formatInitCleanup(v, r)]) err(l);
  };
  if (priv) {
    // §1.1: first mount + dirs + sessionDir + unmount all happen inside the private ns (setup).
    out(`首次私有挂载以建立目录结构（再输入一次口令；在私有命名空间内完成，结束后自动卸载）：`);
    const code = await runPrivate(v, { mode: "setup" });
    if (code === EXIT.BAD_PASSWORD) {
      await offerRemoval(`首次私有挂载失败：口令连续错误 ${PASSWORD_TRIES} 次`);
      return code;
    }
    closeInitHolds(made);
    if (code !== EXIT.OK) {
      err(
        `${name}：首次私有挂载未完成（exit ${code}）。保险库已创建并登记为 --private；可再执行 pi-secure init ${name} --fix-settings 补齐目录与 sessionDir`,
      );
      return code;
    }
    printWarnings();
    out(
      [
        `完成：私有保险库 ${name}（secure.vaults.${name}.private=true），挂载点 ${v.mnt}，项目放在 ${v.work}，会话落在 ${v.sessionDir}。`,
        `master key 仍留在终端回滚里：现在执行 clear；若在 tmux 中再执行 tmux clear-history（尽力清理，不等于安全擦除）。`,
        `之后：pi-secure run ${name}（默认 --private：明文只在本次 pi 的私有命名空间里可见）`,
      ].join("\n"),
    );
    return EXIT.OK;
  }
  out(`首次解锁以建立目录结构（再输入一次口令）：`);
  try {
    await unlockVault(v);
  } catch (e) {
    if (!(e instanceof CliError) || e.code !== EXIT.BAD_PASSWORD) throw e;
    await offerRemoval(`首次挂载失败：${e.message}`);
    return EXIT.BAD_PASSWORD;
  } finally {
    closeInitHolds(made); // idempotent; nothing below needs the evidence (and finalize scans fds)
  }
  const f = await finalizeBounded(v);
  for (const l of f.lines) (f.code === 0 ? out : err)(l);
  printWarnings();
  out(
    [
      `完成：挂载点 ${v.mnt}，项目放在 ${v.work}，会话落在 ${v.sessionDir}。`,
      `master key 仍留在终端回滚里：现在执行 clear；若在 tmux 中再执行 tmux clear-history（尽力清理，不等于安全擦除）。`,
      `之后：pi-secure run ${name}  或  pi-secure unlock ${name}`,
    ].join("\n"),
  );
  return f.code === 0 ? EXIT.OK : f.code;
}
