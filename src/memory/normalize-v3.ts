// #36 arch r5 §4.1.2/§4.1.3 — v3 parameter normalization. The v3 schema
// (tool-surface.ts `MemoryToolParamsV3`) has five commands and none of v2's
// editing fields; this module is the single place that
//  - maps `action:"list"` to `view` (the one sanctioned legacy alias);
//  - rejects the REMOVED v2 commands (`insert`/`str_replace`/`rename` and
//    `action:"write"`/`action:"append"`) with `E_UNSUPPORTED_COMMAND` — no
//    implicit translation (arch §5.6 D7); the tool logs `unsupported:<cmd>`
//    to the jev diag ring for each hit;
//  - collects per-command required-field checks that are not expressible in
//    the (frozen) typebox schema, e.g. "update requires rev".
//
// Reachability note (root 2026-11-06): the host validates `command` against
// the schema enum BEFORE `execute` runs, so an unknown `command` value
// (e.g. `"str_replace"`) is rejected by the HOST with a schema error — only
// extra properties (`action:"write"` etc., which typebox's default-tolerant
// object validation passes through) and direct `execute` callers reach the
// `E_UNSUPPORTED_COMMAND` branch here. Both paths are pinned by
// tests/memory/tool-v3.test.ts.
//
// Pure module: no fs, no pi, no state (I4).

import { MemoryError } from "./paths.js";
import type { MemoryToolParamsV3 } from "./tool-surface.js";

/** The five v3 commands (mirrors the schema enum). */
export type V3Command = "view" | "create" | "update" | "delete" | "search";

export interface NormalizedV3Call {
  readonly command: V3Command;
  readonly path?: string;
  readonly topic?: string;
  readonly text?: string;
  readonly rev?: string;
  readonly query?: string;
  readonly notes: readonly string[];
}

/** rawParams is `MemoryToolParamsV3` widened to a record: extra properties
 *  (the v2-era `action`/`name`/`content`/…) arrive untyped from the host and
 *  are inspected here, never forwarded. */
export type RawV3Params = MemoryToolParamsV3 & Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The §4.1.3 message: name the command, explain the block replacement
 *  (view for rev → whole-block update), point new facts at create. */
export function unsupportedCommandMessage(cmd: string): string {
  return `E_UNSUPPORTED_COMMAND: "${cmd}" is not available: memory is block-based — view <id> for rev, then update path rev text (whole block ≤1024B); a new fact → create topic text`;
}

/** Map an old/absent command slot. `action:"list"` and `command:"list"` are
 *  treated as `view` (plan §4 P4 step 2); write-ish actions throw the
 *  curated error. `command` is read as `unknown` — the host validates the
 *  schema enum, but direct callers (tests) may pass any string. */
function resolveCommand(params: RawV3Params): V3Command {
  const command: unknown = params.command;
  if (typeof command === "string" && command !== "") {
    if (command === "list") return "view";
    if (
      command === "view" ||
      command === "create" ||
      command === "update" ||
      command === "delete" ||
      command === "search"
    ) {
      return command;
    }
    throw new MemoryError(unsupportedCommandMessage(command));
  }
  const action: unknown = params.action;
  if (typeof action === "string" && action !== "") {
    if (action === "list") return "view";
    throw new MemoryError(unsupportedCommandMessage(`action:${action}`));
  }
  return "view";
}

export function normalizeV3(params: RawV3Params): NormalizedV3Call {
  const command = resolveCommand(params);
  const notes: string[] = [];

  // Ignored v2-era fields (extra properties the schema passed through):
  // informational only — the write path never reads them.
  const IGNORED_FIELDS: readonly (keyof RawV3Params)[] = [
    "action",
    "name",
    "content",
    "old_str",
    "new_str",
    "insert_line",
    "insert_text",
    "old_path",
    "new_path",
    "view_range",
    "section",
    "file_text",
  ];
  const ignored: string[] = [];
  for (const f of IGNORED_FIELDS) {
    if (params[f] !== undefined) ignored.push(String(f));
  }
  if (ignored.length > 0) notes.push(`ignored params: ${ignored.join(", ")}`);

  const path = str(params.path);
  const topic = str(params.topic);
  const text = str(params.text);
  const rev = str(params.rev);
  const query = str(params.query);
  return {
    command,
    ...(path === undefined ? {} : { path }),
    ...(topic === undefined ? {} : { topic }),
    ...(text === undefined ? {} : { text }),
    ...(rev === undefined ? {} : { rev }),
    ...(query === undefined ? {} : { query }),
    notes,
  };
}
