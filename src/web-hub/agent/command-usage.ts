/**
 * web-hub-slash-args plan §3.2 (P1): static `/name␠` argument-usage hints for the
 * `CommandInfoWire.args.usage` field (P0-frozen shape in `protocol/command-args.ts`).
 *
 * Pure module — no pi imports, no I/O. Priority chain (plan §3.2, D5 拍板):
 *   `TOOLKIT_USAGE` (handwritten table, values lifted verbatim from each command's own
 *   USAGE constant / description) > `BUILTIN_USAGE` (pi `BUILTIN_SLASH_COMMANDS`
 *   argumentHints, copied — an optional conformance test may deep-import pi's table and
 *   WARN on drift) > `usageFromDescription` (heuristic `[..]/<..>` extraction from a
 *   third-party description). Nothing is ever invented: no source ⇒ no usage (the UI
 *   falls back to the description).
 *
 * Every produced line is single-line, control-char-free and ≤ `CMD_ARGS.usageMaxChars`
 * (200, r1 #3): over-long source text is truncated at the last whitespace before the cap
 * and suffixed "…" (`clampUsageLine`). r1 #3 also asked the hand-written table itself to
 * stay within the cap — `command-usage.test.ts` asserts every value.
 */
import { CMD_ARGS } from "../protocol/command-args.js";
import type { CommandKind } from "./command-policy.js";
import { sanitizeText } from "./command-capture.js";

/**
 * Hand-written usage lines for pi-toolkit's own commands. Values are taken from the
 * commands' existing USAGE constants / descriptions (§3.2 — 不「发明」用法); `cache-ttl`
 * carries the condensed form of its `USAGE` constant per r1 #3. Commands with no
 * arguments (`clear`, `tasklist`, `watch`, `pi-hud-refresh`, …) deliberately have no
 * entry — an absent entry simply means "no hint".
 */
export const TOOLKIT_USAGE: Readonly<Record<string, string>> = {
  // src/commands/status.ts description (`/agent status <runId>` / costs / settings / reload).
  agent: "status [runId] | costs | fleet | settings (list | set <k> <v> | reset <k>) | reload (now | cancel)",
  // src/memory/command.ts DESCRIPTION.
  mem: "list | init | import [--force] [slug|all] | path | doctor | tidy [--batch] | restore [--legacy]",
  // src/cache-ttl/cache-ttl.ts `USAGE` constant minus the "usage: /cache-ttl " prefix
  // (r1 #3 condensed form).
  "cache-ttl":
    "on | off | auto | save | keepalive on|off|reset | status | probe | measure [<provider>/<id>] [--long] [--estimate] [--yes] | measure status|cancel",
  // src/goal/command.ts description.
  goal: '<goal> [--until-cmd "cmd"] [--until "condition"] [--max-turns N] [--budget-tokens N] [--max-minutes N] | status | pause | resume | clear',
  // src/title/command.ts description.
  title: "status | auto",
  // src/commands/webhub.ts description (subcommands beyond `status` are web-deny — the
  // usage line documents the terminal surface; the per-item policy filter still drops
  // deny candidates from dynamic completion, §4.3 #7).
  webhub: "status | open | restart | stop | start | passwd | unlock | 2fa | user | feishu | proxy",
  // src/topic-switch/command.ts description (`__go <nonce>` is the internal trampoline,
  // never advertised).
  "topic-switch": "status | last [--send]",
  // src/session-nav/index.ts.
  "resume-recent": "[--all]",
};

/**
 * pi's own `BUILTIN_SLASH_COMMANDS` argumentHints (dist/core/slash-commands.js), copied
 * per §3.2. Most builtins are bridge-deny for web execution anyway (`BUILTIN_DENY_NAMES`);
 * `model`/`thinking` are the bridged ones that matter. Drift is monitored by an optional
 * deep-import comparison in tests (WARN only — pi adding a hint must not break us).
 */
export const BUILTIN_USAGE: Readonly<Record<string, string>> = {
  model: "<provider/model>",
  thinking: "<level>",
  bug: "<description>",
  login: "<provider>",
};

/** §3.2 heuristic: the first `/<name>␠<fragment>` in the description whose fragment starts
 *  with `<`/`[` (the plan sketch, refined: the fragment ends at a sentence boundary —
 *  end-of-string, `;`/`，`/`。`/`)` or `.␠` — so a closing `]` INSIDE the usage stays).
 *  Capped at 100 chars by the regex itself. */
const USAGE_FROM_DESC_RE = /\/([A-Za-z0-9:_.-]+)\s+([<\[][^\n]{1,100}?)(?=$|[；，。;)]|\.\s)/;

/**
 * Extract a usage fragment from a third-party command description (D5 拍板 — low-harm,
 * mis-extraction yields no hint rather than a wrong one). Only matches the command's OWN
 * `/name <…>` form; the fragment must contain `<…>`/`[…]` (the regex anchors on those) or
 * a `|` — otherwise no usage is produced. Never invents text.
 */
export function usageFromDescription(name: string, description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const m = USAGE_FROM_DESC_RE.exec(description);
  if (m === null) return undefined;
  if (m[1] !== name) return undefined; // a `/other <x>` mention is not our usage
  const frag = m[2] ?? "";
  if (!/[<>[\]|]/.test(frag)) return undefined; // defensive: the regex already anchors on < or [
  const cleaned = frag
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;，。]+$/, "");
  return cleaned === "" ? undefined : cleaned;
}

/**
 * Single-line clamp for a candidate usage line (r1 #3): sanitize control chars/ANSI
 * (shared `sanitizeText`), collapse runs of whitespace, and cap at
 * `CMD_ARGS.usageMaxChars` chars — truncating at the last whitespace before the cap when
 * one exists (falling back to a hard cut) and appending "…".
 */
export function clampUsageLine(raw: string): string {
  const oneLine = sanitizeText(raw)
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cap = CMD_ARGS.usageMaxChars;
  if (oneLine.length <= cap) return oneLine;
  const ellipsis = "\u2026";
  const head = oneLine.slice(0, cap - 1); // leave room for "…"
  const ws = head.lastIndexOf(" ");
  const cut = ws > cap * 0.5 ? ws : cap - 1; // prefer a whitespace boundary unless it'd halve the line
  return `${head.slice(0, cut).trimEnd()}${ellipsis}`;
}

/**
 * §3.2 priority chain. `kind` only documents where the command came from — the chain is
 * name-based so a toolkit name always wins even if pi reports it late, and the heuristic
 * only runs for descriptions that actually carry a `/name <…>` form.
 */
export function resolveCommandUsage(
  name: string,
  _kind: CommandKind,
  description: string | undefined,
): string | undefined {
  const toolkit = TOOLKIT_USAGE[name];
  if (toolkit !== undefined) return clampUsageLine(toolkit);
  const builtin = BUILTIN_USAGE[name];
  if (builtin !== undefined) return clampUsageLine(builtin);
  const heuristic = usageFromDescription(name, description);
  if (heuristic !== undefined) return clampUsageLine(heuristic);
  return undefined;
}
