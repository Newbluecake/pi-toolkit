/** Per-operation memory write guard. Captures are activation-local, never global. */
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryWriteGate } from "../memory/contracts.js";
import { canonicalPath, inVaultWriteZone, readProcMountinfo, type SecureDomain } from "./domain.js";
import { vaultMountState } from "./config.js";
import { join } from "node:path";

export function secureMemoryWriteGate(
  domain: SecureDomain,
  deps: { readMountinfo?: () => string } = {},
): MemoryWriteGate {
  const identities = new Map<string, { real: string; dev: number; ino: number }>();
  const mounted = (): boolean =>
    domain.kind === "secure" &&
    vaultMountState(
      (deps.readMountinfo ?? readProcMountinfo)(),
      domain.vault.mntReal,
      join(domain.vault.root, "cipher"),
    ) === "mounted";
  return {
    capture(memDir) {
      if (domain.kind !== "secure") return;
      identities.delete(memDir);
      try {
        if (!mounted()) return;
        const real = realpathSync(memDir);
        if (!inVaultWriteZone(real, domain.vault)) return;
        const st = lstatSync(real);
        if (st.isDirectory() && !st.isSymbolicLink()) identities.set(memDir, { real, dev: st.dev, ino: st.ino });
      } catch {
        /* missing or unsafe paths must not become writable */
      }
    },
    check(memDir) {
      if (domain.kind === "plain") return { ok: true };
      if (domain.kind === "locked") return { ok: false, reason: "locked" };
      try {
        if (!mounted()) return { ok: false, reason: "unmounted" };
        if (!inVaultWriteZone(canonicalPath(memDir), domain.vault)) return { ok: false, reason: "path-escaped" };
        const captured = identities.get(memDir);
        if (!captured) return { ok: false, reason: "identity-changed" };
        const real = realpathSync(memDir),
          st = lstatSync(real);
        if (real !== captured.real || !st.isDirectory() || st.dev !== captured.dev || st.ino !== captured.ino)
          return { ok: false, reason: "identity-changed" };
        return { ok: true };
      } catch {
        return { ok: false, reason: "identity-changed" };
      }
    },
    // #36 P4 修复轮（root 2026-11-06）：显式创建前的受控验证（contracts.ts
    //  MemoryWriteGate.bootstrap 契约）。验证链：locked → 挂载有效 → 写区 →
    //  「目录若已存在则拒绝（bootstrap 只针对尚不存在的目录，已有目录走
    //  check/capture）」→ 最近存在祖先必须是写区内的真实目录（非符号链接、
    //  非挂载点本身），且若曾被 capture 须与记录身份一致。通过 ⇒ 调用方
    //  ensureMemoryDir 后立即 capture，锁内照常 checkWrite。自动路径永不
    //  调用（不获得 mkdir 能力）。
    bootstrap(memDir) {
      if (domain.kind === "plain") return { ok: true };
      if (domain.kind === "locked") return { ok: false, reason: "locked" };
      try {
        if (!mounted()) return { ok: false, reason: "unmounted" };
        const canonical = canonicalPath(memDir);
        if (!inVaultWriteZone(canonical, domain.vault)) return { ok: false, reason: "path-escaped" };
        try {
          const l = lstatSync(canonical);
          if (!l.isDirectory() || l.isSymbolicLink()) return { ok: false, reason: "identity-changed" };
          // An EXISTING directory goes through capture/check, never bootstrap.
          return { ok: false, reason: "identity-changed" };
        } catch {
          /* not created yet — the expected bootstrap state */
        }
        let ancestor = dirname(canonical);
        for (let hops = 0; hops < 16 && ancestor !== dirname(ancestor); hops++) {
          let ast: { dev: number; ino: number; dir: boolean; link: boolean };
          try {
            const l = lstatSync(ancestor);
            ast = { dev: l.dev, ino: l.ino, dir: l.isDirectory(), link: l.isSymbolicLink() };
          } catch {
            ancestor = dirname(ancestor);
            continue;
          }
          if (!ast.dir || ast.link) return { ok: false, reason: "identity-changed" };
          const realAncestor = realpathSync(ancestor);
          if (!inVaultWriteZone(realAncestor, domain.vault)) return { ok: false, reason: "identity-changed" };
          const capturedAncestor = identities.get(ancestor);
          if (
            capturedAncestor !== undefined &&
            (capturedAncestor.real !== realAncestor ||
              capturedAncestor.dev !== ast.dev ||
              capturedAncestor.ino !== ast.ino)
          ) {
            return { ok: false, reason: "identity-changed" };
          }
          break;
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: "identity-changed" };
      }
    },
  };
}
