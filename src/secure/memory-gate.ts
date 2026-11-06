/** Per-operation memory write guard. Captures are activation-local, never global. */
import { lstatSync, realpathSync } from "node:fs";
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
  };
}
