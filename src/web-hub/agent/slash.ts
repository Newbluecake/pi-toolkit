/**
 * §4.6 command parsing / classification + the `commands` slot (plan control-plan.md §3.2/§4.6,
 * package C11). Pure-ish: the only pi surface touched is the read-only `pi.getCommands()`
 * (injected as the narrow `CommandsPort` below, not the full `ExtensionAPI`, so this module and
 * its tests never need a real `pi`).
 */
import type { CommandInfoArgs } from "../protocol/command-args.js";
import type { CommandInfoWire, CommandsFrame } from "../protocol/messages.js";
import {
  BUILTIN_BRIDGE_NAMES,
  BUILTIN_DENY_NAMES,
  effectivePolicy,
  resolveCommandPolicy,
  type CommandKind,
  type CommandPolicy,
} from "./command-policy.js";

export interface SlashCommand {
  name: string;
  args: string;
}

const SLASH_RE = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/** `/name args` → `{name, args}`; `undefined` when `text` is not slash-shaped at all. Splitting
 *  only — charset / policy validation is `resolveCommandPolicy`'s job (§4.6: never fall back to
 *  plain text for an unparseable or unknown command). */
export function parseSlashCommand(text: string): SlashCommand | undefined {
  const m = SLASH_RE.exec(text);
  return m ? { name: m[1]!, args: m[2] ?? "" } : undefined;
}

/** `/${name} ${args}` (or bare `/${name}` when args is empty) — the inverse of
 *  `parseSlashCommand`, used to re-dispatch a `command` op's already-split `{name,args}` through
 *  `pi.sendUserMessage` (§4.6 step 4). */
export function buildSlashText(name: string, args: string): string {
  const trimmed = args.trim();
  return trimmed === "" ? `/${name}` : `/${name} ${trimmed}`;
}

interface RawSlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | string;
}
/** Narrow port over `pi.getCommands()` (the only pi call this file needs). */
export interface CommandsPort {
  getCommands(): RawSlashCommandInfo[];
}

function sourceToKind(source: RawSlashCommandInfo["source"]): CommandKind {
  if (source === "extension") return "extension";
  if (source === "skill") return "skill";
  return "template"; // "prompt" (pi's prompt-template source) and any unrecognized value
}

function safeGetCommands(pi: CommandsPort | undefined): RawSlashCommandInfo[] {
  if (pi === undefined) return [];
  try {
    const list = pi.getCommands();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export interface ClassifyResult {
  kind: CommandKind;
  description?: string;
}

/**
 * §4.6 step 2: `pi.getCommands()` hit ⇒ extension/template/skill; else the builtin name tables
 * ⇒ builtin; else `undefined` (the caller replies `E_UNKNOWN_COMMAND` — a `/xxx` this bridge does
 * not recognize is NEVER silently redispatched as plain text).
 */
export function classifyCommand(pi: CommandsPort | undefined, name: string): ClassifyResult | undefined {
  const found = safeGetCommands(pi).find((c) => c.name === name);
  if (found !== undefined) {
    const result: ClassifyResult = { kind: sourceToKind(found.source) };
    if (found.description !== undefined) result.description = found.description;
    return result;
  }
  if (BUILTIN_BRIDGE_NAMES.has(name) || BUILTIN_DENY_NAMES.has(name)) return { kind: "builtin" };
  return undefined;
}

const DESCRIPTION_MAX_CHARS = 120;
const COMMANDS_FRAME_MAX_ITEMS = 400;

export interface ListSlashCommandsOptions {
  busy?: boolean;
  overrides?: Record<string, CommandPolicy>;
  /** §4.9: `capture.owns(name)` — marks a pi-toolkit command's output as web-visible. */
  output?: (name: string) => "captured" | "terminal" | undefined;
  /** web-hub-slash-args plan §3.1/§3.2 (P1): static `args` hints (usage + optimistic
   *  `complete` marker). Present whenever `webHub.commandComplete !== "off"`. r1 评审 #1
   *  ①： building the frame NEVER depends on hub caps — the `commands` slot always carries
   *  `args`, and the slot-flush path (`connection.ts` + `stripCommandArgs`) removes them per
   *  the CURRENT hello_ack.caps right before every write (an un-upgraded hub's closed schema
   *  would otherwise drop the whole `commands` frame). */
  args?: CommandArgsHints;
}

/** The `args`-hint port `listSlashCommands` consumes (pure callbacks, pi-free). */
export interface CommandArgsHints {
  /** §3.2 priority chain (toolkit table > builtin table > description heuristic);
   *  `undefined` ⇒ no `usage` field (the UI falls back to the description). */
  usage(name: string, kind: CommandKind, description: string | undefined): string | undefined;
  /** §3.1: the agent will ATTEMPT dynamic completion — S-own hit, or (mode "all";
   *  r1 #9) optimistically for any extension command reachable over S-tui. Empty results
   *  are a normal state, never an error. */
  complete(name: string, kind: CommandKind): boolean;
}

function toCommandInfo(
  name: string,
  kind: CommandKind,
  description: string | undefined,
  opts: ListSlashCommandsOptions,
): CommandInfoWire {
  const decision = resolveCommandPolicy({
    name,
    args: "",
    kind,
    ...(opts.overrides !== undefined ? { overrides: opts.overrides } : {}),
  });
  const policy = effectivePolicy(decision, false); // §7.7's `commandPolicyFor` applies the busy
  // override client-side from `policyBusy`; the advertised base `policy` here is always the
  // idle/no-argument decision (sub-command-level nuance is resolved at call time, §4.6 step 3).
  const item: CommandInfoWire = { name, kind, policy };
  if (description !== undefined) item.description = description.slice(0, DESCRIPTION_MAX_CHARS);
  if (decision.policyBusy !== undefined) item.policyBusy = decision.policyBusy;
  const output = opts.output?.(name);
  if (output !== undefined) item.output = output;
  const hints = opts.args;
  if (hints !== undefined) {
    const args: CommandInfoArgs = {};
    const usage = hints.usage(name, kind, description);
    if (usage !== undefined && usage !== "") args.usage = usage;
    if (hints.complete(name, kind) === true) args.complete = true;
    if (args.usage !== undefined || args.complete !== undefined) item.args = args;
  }
  return item;
}

/** §4.6's `commands` slot payload (`CommandsFrame.items`): every extension/template/skill
 *  command `pi.getCommands()` reports, plus the builtin bridge table, deduplicated by name and
 *  capped at 400 (the wire limit). Recomputed by the caller on `session_start` /
 *  `resources_discover` (§4.1). */
export function listSlashCommands(
  pi: CommandsPort | undefined,
  opts: ListSlashCommandsOptions = {},
): CommandInfoWire[] {
  const seen = new Set<string>();
  const items: CommandInfoWire[] = [];
  for (const c of safeGetCommands(pi)) {
    if (seen.has(c.name) || items.length >= COMMANDS_FRAME_MAX_ITEMS) continue;
    seen.add(c.name);
    items.push(toCommandInfo(c.name, sourceToKind(c.source), c.description, opts));
  }
  for (const name of [...BUILTIN_BRIDGE_NAMES, ...BUILTIN_DENY_NAMES]) {
    if (seen.has(name) || items.length >= COMMANDS_FRAME_MAX_ITEMS) continue;
    seen.add(name);
    items.push(toCommandInfo(name, "builtin", undefined, opts));
  }
  return items;
}

/** r1 评审 #1 ② (P1): strip `args` from every item of a `commands` frame — the slot-flush
 *  transform applied right before each write while the CURRENT hub caps lack
 *  `cmd.args.v1` (un-upgraded/downgraded hub: its closed `CommandInfoSchema` would silently
 *  drop the whole frame, taking the name palette down with it). Pure; untouched items are
 *  reused by reference, only `args`-carrying ones are shallow-copied. */
export function stripCommandArgs(frame: CommandsFrame): CommandsFrame {
  let touched = false;
  const items = frame.items.map((item) => {
    if (item.args === undefined) return item;
    touched = true;
    const { args: _args, ...rest } = item;
    return rest as CommandInfoWire;
  });
  return touched ? { ...frame, items } : frame;
}
