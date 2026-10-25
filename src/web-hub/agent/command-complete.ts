/**
 * web-hub-slash-args plan §4.3/§4.4/§4.5 (P1): the agent-side `/name␠` dynamic-completion
 * engine behind the `complete_req` → `complete_reply` frame pair (P0-frozen in
 * `protocol/command-args.ts`).
 *
 * Pi-free core (only the narrow `CommandsPort` of `slash.ts`, the policy tables of
 * `command-policy.ts` and the shared `sanitizeText` of `command-capture.ts`):
 *
 * - **S-own** (every mode): pi-toolkit's own commands — `wrapCommandApi`'s registerCommand
 *   proxy stores each command's raw `getArgumentCompletions` into the shared
 *   `argCompleters` Map (`command-capture.ts` §4.4). All current toolkit completers are
 *   reviewed pure functions; new ones must pass review (AGENTS.md constraint).
 * - **S-tui** (only while `mode === "all"` and a TUI provider was captured, §4.5): the
 *   passthrough `addAutocompleteProvider` factory's `current` — covers third-party
 *   extension commands, pi builtins and anything else pi's base provider knows.
 * - Neither available ⇒ `ok:true, items:[]` (a normal answer — the UI keeps the static
 *   usage hint; `complete:true` on the wire is deliberately optimistic, r1 #9).
 *
 * Invariants (§4.3): `answer()` NEVER throws and never hangs (every completer call races
 * the `CMD_ARGS.agentCallTimeoutMs` hard timeout; the loser's late result is dropped —
 * only the in-flight bookkeeping still runs); agent-global in-flight ≤
 * `CMD_ARGS.agentInflightMax` (beyond ⇒ `E_RATE` retryable); a completer EXCEPTION
 * degrades to `ok:true, items:[]` (exception text is never leaked) while a TIMEOUT answers
 * `E_DEADLINE`; deny commands never complete (base policy) and deny ITEMS are dropped /
 * confirm items carry `policy:"confirm"` (per-item policy, the execution path's own
 * tables). Accepted residual (r1 #4): a third-party completer that hangs SYNCHRONOUSLY
 * blocks the JS thread before the race can fire — timeouts/in-flight caps cannot save it;
 * `webHub.commandComplete: "toolkit"|"off"` is the escape hatch and the settings
 * description says so.
 */
import {
  CMD_ARGS,
  COMMAND_NAME_PATTERN,
  type CmdArgsReplyCode,
  type CompleteItemWire,
  type CompleteReplyFrame,
  type CompleteReqFrame,
} from "../protocol/command-args.js";
import { sanitizeText } from "../../commands/capture.js";
import { effectivePolicy, resolveCommandPolicy, type CommandPolicy } from "./command-policy.js";
import { classifyCommand, type CommandsPort } from "./slash.js";

/** pi's `RegisteredCommand.getArgumentCompletions` shape (types.d.ts:1175) — the RAW
 *  function is stored at registration time (never a wrapped handler); every call here is
 *  try/catch + timeout guarded. */
export type ArgCompleter = (
  argumentPrefix: string,
) =>
  | { value: unknown; label: unknown; description?: unknown }[]
  | null
  | Promise<{ value: unknown; label: unknown; description?: unknown }[] | null>;

/** Structural slice of pi-tui's `AutocompleteProvider`. The S-tui call only trusts a
 *  result whose `prefix` equals the requested prefix (§4.3 #5 — a wrapper that fell
 *  through to, e.g., the file-path branch answers a different prefix and is discarded). */
export interface AutocompleteProviderLike {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: unknown; prefix: unknown } | null | undefined>;
}

export interface CommandCompleteDeps {
  commands: CommandsPort | undefined;
  /** The shared `argCompleters` Map `wrapCommandApi` fills (§4.4) — by reference, same
   *  pattern as `ownedCommandNames`; unset ⇒ no S-own source. */
  own: () => ReadonlyMap<string, ArgCompleter> | undefined;
  /** The passthrough-captured TUI provider (§4.5); unset until pi first calls the factory. */
  tui: () => AutocompleteProviderLike | undefined;
  /** `webCommandPolicy` overrides — resolved BEFORE the builtin/toolkit tables, exactly like
   *  the execution path (`resolveCommandPolicy`). */
  overrides?: Record<string, CommandPolicy>;
  /** `webHub.commandComplete`: "toolkit" never consults S-tui. ("off" never builds this
   *  service at all — the wiring omits the binding.) */
  mode: "all" | "toolkit";
  now?: () => number;
  /** Timer seam (tests use a manual queue); production `setTimeout` + `unref()`. */
  setTimer?: (ms: number, fn: () => void) => { cancel(): void };
}

export interface CommandCompleteService {
  /** §4.3: answer one `complete_req`. Never rejects; never hangs (hard timeout race). */
  answer(frame: CompleteReqFrame): Promise<CompleteReplyFrame>;
  /** Whether the S-tui provider has been captured (§4.5's readiness signal). */
  hasTui(): boolean;
  /** Current agent-global in-flight completion calls (diagnostic). */
  inflight(): number;
  /** Stop answering (`E_UNSUPPORTED`) and reset in-flight bookkeeping (permanent teardown —
   * session boundaries do NOT call this: the service is activation-scoped and read-only). */
  dispose(): void;
}

const NAME_RE = new RegExp(COMMAND_NAME_PATTERN);
const ELLIPSIS = "\u2026";
/** Race sentinel — distinct from every legal completer result, including `null`. */
const TIMEOUT = Symbol("cmd-args-timeout");

function errReply(rid: string, code: CmdArgsReplyCode, retryable: boolean): CompleteReplyFrame {
  return { t: "complete_reply", rid, ok: false, code, retryable };
}

function isControlByte(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c < 0x20 && c !== 0x09) || c === 0x7f;
}

function prefixValid(prefix: string): boolean {
  if (Buffer.byteLength(prefix, "utf8") > CMD_ARGS.prefixMaxBytes) return false;
  for (const ch of prefix) if (isControlByte(ch)) return false;
  return true;
}

/** UTF-8-safe byte truncation (same walk-back approach as `command-capture.ts`, no
 *  ellipsis — a completion VALUE is a token, an ellipsis would corrupt it). */
function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  for (let end = maxBytes; end >= 0 && end > maxBytes - 4; end--) {
    const candidate = buf.toString("utf8", 0, end);
    if (Buffer.byteLength(candidate, "utf8") === end) return candidate;
  }
  return buf.toString("utf8", 0, Math.max(0, maxBytes - 4));
}

function truncateChars(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}${ELLIPSIS}`;
}

interface LooseItem {
  value: string;
  label: string;
  description?: string;
}

/** Coerce one raw completer item to the loose shape; `undefined` when it is not
 *  item-shaped at all (silently skipped, §4.3 #6). */
function looseItem(raw: unknown): LooseItem | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== "string" || typeof o.label !== "string") return undefined;
  return {
    value: o.value,
    label: o.label,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
  };
}

type CommandKindLike = "extension" | "template" | "skill" | "builtin";
type OkItems = CompleteItemWire[];

/** §4.3 #6/#7: shape-validate → sanitize → cap → dedupe → per-item policy. Returns the
 *  wire items plus whether any cap clipped. */
function normalize(
  name: string,
  kind: CommandKindLike,
  rawItems: unknown,
  overrides: Record<string, CommandPolicy> | undefined,
): { items: OkItems; truncated: boolean } {
  const list = Array.isArray(rawItems) ? rawItems : [];
  const out: OkItems = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let truncated = false;
  for (const raw of list) {
    if (out.length >= CMD_ARGS.itemMax) {
      truncated = true;
      break;
    }
    const loose = looseItem(raw);
    if (loose === undefined) continue;
    const value = sanitizeText(loose.value);
    // §4.3 #6: no leading whitespace (it would break `/name <value>` reassembly), not
    // empty, no embedded newlines (the composer is single-line).
    if (value === "" || /^\s/.test(value) || /[\r\n]/.test(value)) continue;
    const valueB = truncateBytes(value, CMD_ARGS.itemValueMaxBytes);
    if (Buffer.byteLength(valueB, "utf8") < Buffer.byteLength(value, "utf8")) truncated = true;
    if (seen.has(valueB)) continue; // dedupe by value, first wins
    const label = truncateChars(sanitizeText(loose.label).replace(/[\r\n]+/g, " "), CMD_ARGS.itemLabelMaxChars);
    const description =
      typeof loose.description === "string" && loose.description !== ""
        ? truncateChars(sanitizeText(loose.description).replace(/[\r\n]+/g, " "), CMD_ARGS.itemDescMaxChars)
        : undefined;
    // §4.3 #7: per-item policy — deny items are DROPPED (never surfaced), confirm items
    // carry policy:"confirm" (the UI draws the same chip as the command palette).
    const decision = resolveCommandPolicy({
      name,
      args: valueB,
      kind,
      ...(overrides !== undefined ? { overrides } : {}),
    });
    if (effectivePolicy(decision, false) === "deny") continue;
    const item: CompleteItemWire = {
      value: valueB,
      label,
      ...(description !== undefined ? { description } : {}),
      ...(decision.policy === "confirm" ? { policy: "confirm" } : {}),
    };
    const itemBytes =
      Buffer.byteLength(item.value, "utf8") +
      Buffer.byteLength(item.label, "utf8") +
      Buffer.byteLength(item.description ?? "", "utf8");
    if (totalBytes + itemBytes > CMD_ARGS.itemsTotalMaxBytes) {
      truncated = true;
      break;
    }
    totalBytes += itemBytes;
    seen.add(valueB);
    out.push(item);
  }
  return { items: out, truncated };
}

function okReply(rid: string, items: OkItems, source: "own" | "tui", truncated: boolean): CompleteReplyFrame {
  const reply: CompleteReplyFrame = { t: "complete_reply", rid, ok: true, items, source };
  if (truncated) (reply as { truncated?: true }).truncated = true;
  return reply;
}

export function createCommandComplete(deps: CommandCompleteDeps): CommandCompleteService {
  const setTimer =
    deps.setTimer ??
    ((ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
  let inflight = 0;
  let disposed = false;

  /** One guarded completer call: hard-timeout race (§4.3 #4). `null` = the completer
   *  itself answered "no completions" (legal); `TIMEOUT` = raced past
   *  `CMD_ARGS.agentCallTimeoutMs` (the abort hook fires the moment the timeout wins);
   *  anything else = raw items. Exceptions ⇒ `null` (never leaked). */
  async function raceCall(run: () => unknown, onTimeout: () => void): Promise<typeof TIMEOUT | unknown> {
    let handle: { cancel(): void } | undefined;
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      handle = setTimer(CMD_ARGS.agentCallTimeoutMs, () => {
        onTimeout();
        resolve(TIMEOUT);
      });
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(run)
          .catch(() => null),
        timeoutPromise,
      ]);
    } finally {
      handle?.cancel();
    }
  }

  async function answer(frame: CompleteReqFrame): Promise<CompleteReplyFrame> {
    const rid = typeof frame.rid === "string" ? frame.rid : "";
    if (disposed) return errReply(rid, "E_UNSUPPORTED", false);
    // §4.3 #1 — second-line defense (the hub route already validated).
    if (
      typeof frame.name !== "string" ||
      !NAME_RE.test(frame.name) ||
      typeof frame.prefix !== "string" ||
      !prefixValid(frame.prefix)
    )
      return errReply(rid, "E_BAD_REQUEST", false);
    const classified = classifyCommand(deps.commands, frame.name);
    if (classified === undefined) return errReply(rid, "E_UNKNOWN_COMMAND", false);
    // §4.3 #2 — base policy on the bare name (idle, no args): a deny command never
    // completes (its very argument surface must not leak, §4.6).
    const base = resolveCommandPolicy({
      name: frame.name,
      args: "",
      kind: classified.kind,
      ...(deps.overrides !== undefined ? { overrides: deps.overrides } : {}),
    });
    if (effectivePolicy(base, false) === "deny") return errReply(rid, "E_COMMAND_DENIED", false);

    // §4.3 #3 — source selection: S-own first, then S-tui (extension + mode "all" +
    // provider captured), else the normal empty answer.
    const own = deps.own()?.get(frame.name);
    const provider = deps.tui();
    const useTui =
      own === undefined && classified.kind === "extension" && deps.mode === "all" && provider !== undefined;
    if (own === undefined && !useTui) return okReply(rid, [], "own", false);

    // §4.3 #4 — agent-global in-flight cap (only an actual call consumes a slot).
    if (inflight >= CMD_ARGS.agentInflightMax) return errReply(rid, "E_RATE", true);
    inflight += 1;
    try {
      let raw: unknown;
      let timedOut = false;
      if (useTui) {
        const abort = new AbortController();
        const line = `/${frame.name} ${frame.prefix}`;
        raw = await raceCall(
          () => provider!.getSuggestions([line], 0, line.length, { signal: abort.signal, force: false }),
          () => abort.abort(),
        );
        timedOut = raw === TIMEOUT;
        if (!timedOut) {
          // §4.3 #5 — only trust a result whose prefix equals the request (a wrapper that
          // fell through to another branch answers a different prefix; discard wholesale).
          const res = raw as { items?: unknown; prefix?: unknown } | null | undefined;
          if (res === null || typeof res !== "object" || res.prefix !== frame.prefix) {
            return okReply(rid, [], "tui", false);
          }
          raw = res.items;
        }
      } else {
        raw = await raceCall(
          () => own!(frame.prefix),
          () => undefined,
        );
        timedOut = raw === TIMEOUT;
      }
      if (timedOut) return errReply(rid, "E_DEADLINE", true);
      if (disposed) return errReply(rid, "E_UNSUPPORTED", false);
      const { items, truncated } = normalize(frame.name, classified.kind, raw, deps.overrides);
      return okReply(rid, items, useTui ? "tui" : "own", truncated);
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  }

  return {
    answer,
    hasTui: () => deps.tui() !== undefined,
    inflight: () => inflight,
    dispose() {
      disposed = true;
      inflight = 0;
    },
  };
}
