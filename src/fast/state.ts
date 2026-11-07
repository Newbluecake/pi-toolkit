/** Pure session-history and command helpers. No persistence or activation state. */
import type { FastMode, FastRecord, FastSeed } from "../core/types.js";
import type { FastSnapshot } from "./ports.js";

export const FAST_CUSTOM_TYPE = "subagent:fast";

function ordinary(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
export function validateFastRecord(data: unknown): FastRecord | undefined {
  try {
    if (!ordinary(data) || own(data, "v") !== 1) return undefined;
    const mode = own(data, "mode");
    return mode === "inherit" || mode === "on" || mode === "off" ? { v: 1, mode } : undefined;
  } catch {
    return undefined;
  }
}
export interface FastBranchState {
  readonly mode: FastMode;
  readonly invalidRecord: boolean;
}
/** The last own Fast custom entry is authoritative, even when malformed/future. */
export function foldFastBranch(branch: readonly unknown[]): FastBranchState {
  for (let i = branch.length - 1; i >= 0; i--) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(branch, String(i));
      if (!descriptor || !("value" in descriptor)) return { mode: "inherit", invalidRecord: true };
      const entry: unknown = descriptor.value;
      if (entry === null || typeof entry !== "object") continue;
      if (!ordinary(entry)) return { mode: "inherit", invalidRecord: true };
      const custom = Object.getOwnPropertyDescriptor(entry, "customType");
      if (custom && !("value" in custom)) return { mode: "inherit", invalidRecord: true };
      if (own(entry, "customType") !== FAST_CUSTOM_TYPE) continue;
      const type = Object.getOwnPropertyDescriptor(entry, "type");
      if (type && !("value" in type)) return { mode: "inherit", invalidRecord: true };
      if (own(entry, "type") !== "custom") return { mode: "inherit", invalidRecord: true };
      const record = validateFastRecord(own(entry, "data"));
      return record ? { mode: record.mode, invalidRecord: false } : { mode: "inherit", invalidRecord: true };
    } catch {
      return { mode: "inherit", invalidRecord: true };
    }
  }
  return { mode: "inherit", invalidRecord: false };
}
export function readFastMode(branch: readonly unknown[]): FastMode {
  return foldFastBranch(branch).mode;
}
/** Explicit projection: never spread revision, incarnation or owner into a seed. */
export function snapshotToFastSeed(snapshot: FastSnapshot): FastSeed {
  return { v: 1, mode: snapshot.mode };
}
export function toggleFast(mode: FastMode): "on" | "off" {
  return mode === "on" ? "off" : "on";
}
export type FastCommandResult =
  { readonly kind: "command"; readonly command: FastMode | "toggle" | "status" } | { readonly kind: "usage" };
export function parseFastCommand(args: string): FastCommandResult {
  const arg = args.trim().toLowerCase();
  switch (arg) {
    case "":
    case "toggle":
      return { kind: "command", command: "toggle" };
    case "reset":
      return { kind: "command", command: "inherit" };
    case "inherit":
    case "on":
    case "off":
    case "status":
      return { kind: "command", command: arg };
    default:
      return { kind: "usage" };
  }
}
/** Undefined means zero transition (usage, status, or idempotent command). Caller persists first. */
export function resolveFastCommandMode(current: FastMode, parsed: FastCommandResult): FastMode | undefined {
  if (parsed.kind === "usage" || parsed.command === "status") return undefined;
  const next = parsed.command === "toggle" ? toggleFast(current) : parsed.command;
  return next === current ? undefined : next;
}
