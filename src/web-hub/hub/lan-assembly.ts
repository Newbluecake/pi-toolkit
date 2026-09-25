/**
 * Default `LanAssembly` (plan §1.4.2): wires the real `LanStorePort` / `KdfPort`
 * / `LoginLimiterPort` / `KdfAdmissionPort` / `HostsPort` implementations into
 * a `LanFrontendDeps`. W1 stub — LD (S1-W3) fills this in. Only imports port
 * *types*, never `node:sqlite` (that stays out of the main thread entirely,
 * L19), so importing this module has zero runtime cost while it is a stub.
 */
import type { LanAssembly } from "./ports.js";

export const defaultLanAssembly: LanAssembly = {
  build() {
    return Promise.reject(new Error("E_NOT_IMPLEMENTED:LD"));
  },
};
