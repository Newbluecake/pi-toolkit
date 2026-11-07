/**
 * jev-reflex · #25 B1 corpus extraction (BA §4.2): jsonl session lines → `Turn` +
 * `CorrectionFact`, with the fork-family index, cross-file dedup (BD5), origin classification
 * and per-turn acceptance facts (`unknownFacts`, r3 sourceMode criteria).
 *
 * Purity: no fs — the orchestrator (B3) feeds `beginFile`/`line`/`endFile`; everything lives
 * in the builder closure (I4). pi-free (R-I10).
 *
 * FEEDING CONTRACT (root ruling 2026-11-05, B1-report §3.1): the orchestrator MUST feed files
 * in header-timestamp ASCENDING order (ancestors before forks). The claim map still resolves
 * out-of-order feeds via steal+revocation (`takeRevoked`) so the surviving set equals "earliest
 * header wins" regardless of order (BD5); only `sourceMode` evidence attribution is computed
 * at turn-close time, so an out-of-order steal can leave a stale-native evidence view on turns
 * returned earlier — feeding in the contracted order makes that unreachable (out-of-order
 * feeds degrade confirmed→lenient only, the conservative direction).
 */

import { basename, dirname, resolve } from "node:path";
import { allShapes } from "../../../memory/jev/predict/shape.js";
import { requestDigest } from "../digest.js";
import { CORRECTION_RE } from "../gate.js";
import { normalizeInput } from "../normalize.js";
import { scanReflexLine } from "../shadow-scan.js";
import type {
  CorrectionFact,
  CorpusFilter,
  FamilyIndex,
  GateFactName,
  SessionHeaderFact,
  Turn,
  TurnOrigin,
} from "../types.js";
import {
  HUD_TUI_GATE_SINCE,
  HUD_TIME_ENTRY_TYPE,
  ORIGIN_MARKERS,
  SUBAGENT_CHILD_MARKER,
  SUBAGENT_RUN_MARKER,
  isInjectedText,
} from "./markers.js";
import { splitForRoot } from "./split.js";

// ---------------------------------------------------------------------------
// header parsing + family index (BA §4.2 first pass, BD4)
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** ISO string or epoch-ms → epoch-ms (undefined when unparsable). */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * Strict parse of a `{type:"session",…}` header line. Anything malformed ⇒ undefined (the
 * orchestrator then skips the file entirely — it cannot join a family anyway).
 */
export function parseSessionHeader(file: string, raw: unknown): SessionHeaderFact | undefined {
  if (!isObj(raw) || raw["type"] !== "session") return undefined;
  const id = str(raw["id"]);
  const cwd = str(raw["cwd"]);
  const timestamp = parseTimestamp(raw["timestamp"]);
  if (id === undefined || cwd === undefined || timestamp === undefined) return undefined;
  const parentSession = str(raw["parentSession"]);
  return { file, id, ...(parentSession !== undefined ? { parentSession } : {}), timestamp, cwd };
}

/** First pass over EVERY session file's header (scan range ignores `--cwd`, BA §4.2). */
export function buildFamilyIndex(headers: readonly SessionHeaderFact[]): FamilyIndex {
  const byPath = new Map<string, SessionHeaderFact>();
  const byId = new Map<string, SessionHeaderFact>();
  const counts = new Map<string, number>();
  for (const h of headers) {
    byPath.set(resolve(h.file), h);
    counts.set(h.id, (counts.get(h.id) ?? 0) + 1);
    if (!byId.has(h.id)) byId.set(h.id, h);
  }
  const duplicateIds = new Set<string>();
  for (const [id, n] of counts) if (n >= 2) duplicateIds.add(id);
  return { byPath, byId, duplicateIds };
}

/** Why a file's family root could not be resolved (report header distribution, BA §4.2). */
export type UnresolvedReason = "not-in-index" | "missing-parent" | "cycle" | "duplicate-id";

export interface FamilyResolution {
  /** Root session id; ABSENT ⇔ unresolved. */
  familyRoot?: string;
  reason?: UnresolvedReason;
}

/** `^.+_(<uuid>)\.jsonl$` — pi fork filenames are `<ts>_<newId>.jsonl`; the id run is loose
 *  (uuid-shaped) so synthetic fixtures need not fake real uuids. */
const FILENAME_ID_RE = /^.+_([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl$/;

/**
 * Walk the parent chain to the family root (BD4): `parentSession` is the PARENT'S FILE PATH —
 * resolve by normalized path first, then fall back to extracting an id from the basename
 * (moved files); duplicate ids are never adopted. Cycle / duplicate anywhere on the chain
 * (including the file itself) or a missing parent ⇒ unresolved ⇒ turns land in "unscored".
 */
export function resolveFamily(file: string, index: FamilyIndex): FamilyResolution {
  let current = index.byPath.get(resolve(file));
  if (current === undefined) return { reason: "not-in-index" };
  const seen = new Set<string>();
  for (;;) {
    const node: SessionHeaderFact = current;
    if (index.duplicateIds.has(node.id)) return { reason: "duplicate-id" };
    if (seen.has(node.id)) return { reason: "cycle" };
    seen.add(node.id);
    const parentRaw = node.parentSession;
    if (parentRaw === undefined) return { familyRoot: node.id };
    let next = index.byPath.get(resolve(parentRaw));
    if (next === undefined) {
      const m = FILENAME_ID_RE.exec(basename(parentRaw));
      const pid = m?.[1];
      if (pid !== undefined && !index.duplicateIds.has(pid)) next = index.byId.get(pid);
    }
    if (next === undefined) return { reason: "missing-parent" };
    current = next;
  }
}

// ---------------------------------------------------------------------------
// corpus builder (second pass)
// ---------------------------------------------------------------------------

/** Summary of one entry kept for parent-chain classification (per file, cleared at endFile). */
interface ParentRef {
  customType?: string;
  role?: string;
  stopReason?: string;
}

/** Nearest preceding conversational message (idle derivability, BA §4.2). */
interface LastMsg {
  role: string;
  stopReason?: string;
}

/** Fence replay state (topicSwitchActive / goalBusy derivability). */
interface FenceState {
  seenAny: boolean;
  active: boolean;
  derivable: boolean;
}

const FENCE_INIT: FenceState = { seenAny: false, active: false, derivable: true };

interface OpenTurn {
  entryKey?: string;
  entryId: string;
  at: number;
  text: string;
  imageCount: number;
  origin: TurnOrigin;
  shapes: string[];
  toolCount: number;
  hasWrite: boolean;
  /** Any entry followed the user message inside the interval. */
  sawEntry: boolean;
  hudNative: boolean;
  reflexDigests: Set<string>;
  idleUnknown: boolean;
  /** Fence states snapshotted at OPEN time — the runtime gate reads them at input time, and
   *  entries inside the turn's own interval (e.g. a hold resolving) must not rewrite history. */
  topicSwitchUnknown: boolean;
  goalBusyUnknown: boolean;
}

interface FileState {
  file: string;
  header: SessionHeaderFact;
  cwdMatch: boolean;
  familyRoot?: string;
  split: ReturnType<typeof splitForRoot>;
  isChild: boolean;
  turns: Turn[];
  corrections: CorrectionFact[];
  open: OpenTurn | undefined;
  lastTs: number;
  lastMsg: LastMsg | undefined;
  parents: Map<string, ParentRef>;
  topicSwitch: FenceState;
  goal: FenceState;
}

interface Claim {
  file: string;
  headerTs: number;
  emitted?: { turn?: Turn; correction?: CorrectionFact };
}

export interface CorpusBuilder {
  beginFile(file: string, header: unknown): "skip-child" | "ok";
  line(raw: string): void;
  endFile(): { turns: readonly Turn[]; corrections: readonly CorrectionFact[] };
  /** Live set of files known to be subagent children (self-marker or a main session's
   *  `subagent:run` reference, mirrored from `session-nav/provenance.ts`'s two sources). */
  childFiles(): ReadonlySet<string>;
  /** Turns/corrections revoked because a later-fed file with an OLDER header timestamp stole
   *  their entry key. Subtract these from previously returned endFile() results (BD5). */
  takeRevoked(): { turns: readonly Turn[]; corrections: readonly CorrectionFact[] };
}

/**
 * Stream one session file's lines. A user message's ORIGIN comes from its parent entry
 * (web⇒excluded, wake⇒excluded, topic-switch⇒replay KEPT, toolUse-assistant/toolResult⇒steer,
 * else tui) with injected text prefixes overriding to "injected"; web/injected entries still
 * produce CorrectionFacts (the full timeline, Major 9) but never Turns.
 */
export function createCorpusBuilder(f: CorpusFilter, families: FamilyIndex): CorpusBuilder {
  const children = new Set<string>();
  const claims = new Map<string, Claim>();
  const revokedTurns: Turn[] = [];
  const revokedCorrections: CorrectionFact[] = [];
  let st: FileState | undefined;

  const claimKey = (id: string | undefined, ts: number | undefined): string | undefined =>
    id !== undefined && ts !== undefined ? `${id}\u0000${ts}` : undefined;

  /** First claim wins; a later file with an OLDER header steals (and revokes emissions). */
  const claim = (key: string | undefined): boolean => {
    if (key === undefined || st === undefined) return true; // keyless synthetic entries: native
    const prev = claims.get(key);
    if (prev === undefined) {
      claims.set(key, { file: st.file, headerTs: st.header.timestamp });
      return true;
    }
    if (prev.file === st.file) return false; // same-file duplicate id: first occurrence only
    if (st.header.timestamp < prev.headerTs) {
      if (prev.emitted !== undefined) {
        if (prev.emitted.turn !== undefined) revokedTurns.push(prev.emitted.turn);
        if (prev.emitted.correction !== undefined) revokedCorrections.push(prev.emitted.correction);
      }
      claims.set(key, { file: st.file, headerTs: st.header.timestamp });
      return true;
    }
    return false;
  };

  const classifyOrigin = (parent: ParentRef | undefined, text: string): TurnOrigin => {
    if (parent?.customType === ORIGIN_MARKERS.web) return "web";
    if (parent?.customType === ORIGIN_MARKERS.wake) return "injected";
    if (isInjectedText(text)) return "injected";
    if (parent?.customType === ORIGIN_MARKERS.topicSwitch) return "replay";
    if (parent?.role === "toolResult") return "steer";
    if (parent?.role === "assistant" && parent.stopReason === "toolUse") return "steer";
    return "tui";
  };

  const closeOpen = (): void => {
    const o = st?.open;
    if (st === undefined || o === undefined) return;
    st.open = undefined;
    const inWindow = o.at >= f.since && (f.until === undefined || o.at < f.until);
    if (!inWindow) return; // outside [--days window: no turn, no evidence (claims still hold)
    const facts: GateFactName[] = [];
    if (o.idleUnknown) facts.push("idle", "pendingMessages");
    if (o.topicSwitchUnknown) facts.push("topicSwitchActive");
    if (o.goalBusyUnknown) facts.push("goalBusy");
    // inFlight is always derivable offline (BA §4.2) — never an unknown fact.
    const norm = normalizeInput(o.text).norm;
    const hudAdmissible = o.hudNative && o.at >= HUD_TUI_GATE_SINCE;
    if (!hudAdmissible && !o.reflexDigests.has(requestDigest(norm))) facts.push("sourceMode");
    const turn: Turn = {
      session: st.header.id,
      ...(st.familyRoot !== undefined ? { familyRoot: st.familyRoot } : {}),
      split: st.split,
      entryId: o.entryId,
      at: o.at,
      settledAt: o.sawEntry ? st.lastTs : o.at,
      cwd: st.header.cwd,
      text: o.text,
      digest: requestDigest(norm),
      imageCount: o.imageCount,
      origin: o.origin,
      shapes: [...o.shapes],
      toolCount: o.toolCount,
      hasWrite: o.hasWrite,
      unknownFacts: facts,
    };
    st.turns.push(turn);
    if (o.entryKey !== undefined) {
      const c = claims.get(o.entryKey);
      if (c !== undefined) c.emitted = { ...(c.emitted ?? {}), turn };
    }
  };

  const applyTopicSwitch = (data: unknown): void => {
    if (st === undefined) return;
    const kind = isObj(data) ? data["kind"] : undefined;
    if (typeof kind !== "string") {
      st.topicSwitch.derivable = false;
      return;
    }
    st.topicSwitch.seenAny = true;
    st.topicSwitch.derivable = true; // a well-formed entry re-derives the state
    if (kind === "pending" || kind === "delivering") st.topicSwitch.active = true;
    else if (kind === "outcome" || kind === "resolved" || kind === "handoff") st.topicSwitch.active = false;
    // cooldown: not a fence — leaves `active` untouched.
    else if (kind !== "cooldown") st.topicSwitch.derivable = false;
  };

  const applyGoal = (data: unknown): void => {
    if (st === undefined) return;
    const state = isObj(data) ? data["state"] : undefined;
    if (typeof state !== "string") {
      st.goal.derivable = false;
      return;
    }
    st.goal.seenAny = true;
    st.goal.derivable = true; // a well-formed entry re-derives the state
    if (state === "active") st.goal.active = true;
    else if (state === "paused" || state === "stopped" || state === "none") st.goal.active = false;
    else st.goal.derivable = false;
  };

  const markChild = (sessionFile: unknown): void => {
    if (typeof sessionFile !== "string" || sessionFile === "" || st === undefined) return;
    const abs = sessionFile.startsWith("/") ? sessionFile : resolve(dirname(st.file), sessionFile);
    children.add(abs);
  };

  /** sourceMode evidence ② — a NATIVE reflex record/answer whose requestDigest equals the
   *  turn's digest (records read `data.requestDigest`, answers `details.requestDigest`). */
  const collectReflexEvidence = (raw: string): void => {
    if (st === undefined || st.open === undefined) return;
    const row = scanReflexLine(raw).row;
    if (row === undefined) return;
    const digest =
      row.kind === "record" ? row.rec.requestDigest : row.kind === "answer" ? row.details.requestDigest : undefined;
    if (digest !== undefined) st.open.reflexDigests.add(digest);
  };

  return {
    beginFile(file, header) {
      const abs = resolve(file);
      if (children.has(abs)) return "skip-child";
      const h = parseSessionHeader(file, header);
      // An unparseable header cannot join a family (and the orchestrator pre-parses headers
      // for the index anyway) — the sketch's single skip channel carries it.
      if (h === undefined) return "skip-child";
      const res = resolveFamily(file, families);
      st = {
        file: abs,
        header: h,
        cwdMatch: f.cwd === undefined || resolve(h.cwd) === resolve(f.cwd),
        ...(res.familyRoot !== undefined ? { familyRoot: res.familyRoot } : {}),
        split: splitForRoot(res.familyRoot),
        isChild: false,
        turns: [],
        corrections: [],
        open: undefined,
        lastTs: h.timestamp,
        lastMsg: undefined,
        parents: new Map(),
        topicSwitch: { ...FENCE_INIT },
        goal: { ...FENCE_INIT },
      };
      return "ok";
    },

    line(raw) {
      if (st === undefined) return;
      let e: unknown;
      try {
        e = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isObj(e)) return;
      const id = str(e["id"]);
      const ts = parseTimestamp(e["timestamp"]);
      const type = e["type"];
      const message = isObj(e["message"]) ? e["message"] : undefined;
      const role = message !== undefined && typeof message["role"] === "string" ? message["role"] : undefined;
      const isUser = type === "message" && role === "user";
      // The interval boundary is the NEXT user entry — even a fork-copy duplicate closes the
      // previous turn, so `settledAt`/evidence never bleed across a duplicated boundary.
      if (isUser) closeOpen();
      const prevTs = st.lastTs;
      if (ts !== undefined) st.lastTs = ts;
      const key = claimKey(id, ts);
      if (!claim(key)) return; // fork copy (or same-file dup): no further effects
      if (st.open !== undefined && !isUser) st.open.sawEntry = true;

      if (type === "custom") {
        const customType = str(e["customType"]);
        const data = e["data"];
        if (customType === SUBAGENT_CHILD_MARKER) st.isChild = true;
        else if (customType === SUBAGENT_RUN_MARKER && isObj(data)) {
          const diag = isObj(data["diag"]) ? data["diag"] : undefined;
          markChild(diag?.["sessionFile"]);
        } else if (customType === ORIGIN_MARKERS.topicSwitch) applyTopicSwitch(data);
        else if (customType === "subagent:goal") applyGoal(data);
        else if (customType === HUD_TIME_ENTRY_TYPE) {
          // sourceMode evidence ① — native HUD timing entry inside the interval (admitted
          // only for turns starting at/after HUD_TUI_GATE_SINCE, checked at close).
          if (st.open !== undefined) st.open.hudNative = true;
        } else if (customType === "subagent:reflex-record") collectReflexEvidence(raw);
        if (id !== undefined) st.parents.set(id, { ...(customType !== undefined ? { customType } : {}) });
        return;
      }

      if (type === "custom_message") {
        // sourceMode evidence ② (answer path): the AUTO answer carries details.requestDigest.
        if (str(e["customType"]) === "subagent:reflex") collectReflexEvidence(raw);
        return;
      }

      if (type !== "message" || message === undefined || role === undefined) return;

      if (role === "assistant") {
        const stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : undefined;
        if (st.open !== undefined) {
          const content = message["content"];
          if (Array.isArray(content)) {
            for (const part of content) {
              if (!isObj(part) || part["type"] !== "toolCall") continue;
              const name = typeof part["name"] === "string" ? part["name"] : "";
              if (name === "") continue;
              st.open.toolCount += 1;
              const args = part["arguments"];
              if (name === "bash") {
                const command =
                  isObj(args) && typeof args["command"] === "string" ? (args["command"] as string) : undefined;
                if (command !== undefined) {
                  for (const shape of allShapes(command))
                    if (!st.open.shapes.includes(shape)) st.open.shapes.push(shape);
                  continue;
                }
              }
              const shape =
                name === "bash_job"
                  ? `bash_job:${isObj(args) && typeof args["action"] === "string" ? (args["action"] as string) : name}`
                  : name;
              if (!st.open.shapes.includes(shape)) st.open.shapes.push(shape);
            }
          }
          st.open.hasWrite = st.open.shapes.some((s) => s === "edit" || s === "write");
        }
        st.lastMsg = { role: "assistant", ...(stopReason !== undefined ? { stopReason } : {}) };
        if (id !== undefined)
          st.parents.set(id, { role: "assistant", ...(stopReason !== undefined ? { stopReason } : {}) });
        return;
      }

      if (role === "toolResult") {
        st.lastMsg = { role: "toolResult" };
        if (id !== undefined) st.parents.set(id, { role: "toolResult" });
        return;
      }

      if (role === "user") {
        const content = message["content"];
        let text = "";
        let imageCount = 0;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (!isObj(part)) continue;
            if (part["type"] === "text" && typeof part["text"] === "string") text += part["text"] as string;
            else if (part["type"] === "image") imageCount += 1;
          }
        }
        const parentId = typeof e["parentId"] === "string" ? (e["parentId"] as string) : undefined;
        const parent = parentId !== undefined ? st.parents.get(parentId) : undefined;
        const origin = classifyOrigin(parent, text);
        const at = ts ?? prevTs;
        // Full correction timeline (Major 9): EVERY user entry, any origin/length/lines.
        if (st.cwdMatch && at >= f.since) {
          const fact: CorrectionFact = {
            session: st.header.id,
            entryId: id ?? "",
            at,
            origin,
            corrHit: CORRECTION_RE.test(normalizeInput(text).norm),
          };
          st.corrections.push(fact);
          if (key !== undefined) {
            const c = claims.get(key);
            if (c !== undefined) c.emitted = { ...(c.emitted ?? {}), correction: fact };
          }
        }
        if (origin !== "web" && origin !== "injected") {
          const lastMsg = st.lastMsg;
          st.open = {
            ...(key !== undefined ? { entryKey: key } : {}),
            entryId: id ?? "",
            at,
            text,
            imageCount,
            origin,
            shapes: [],
            toolCount: 0,
            hasWrite: false,
            sawEntry: false,
            hudNative: false,
            reflexDigests: new Set<string>(),
            idleUnknown: !(lastMsg === undefined || (lastMsg.role === "assistant" && lastMsg.stopReason !== "toolUse")),
            topicSwitchUnknown: !st.topicSwitch.derivable || (st.topicSwitch.seenAny && st.topicSwitch.active),
            goalBusyUnknown: !st.goal.derivable || (st.goal.seenAny && st.goal.active),
          };
        }
        st.lastMsg = { role: "user" };
        if (id !== undefined) st.parents.set(id, { role: "user" });
        return;
      }

      // system messages are envelope preamble, not conversational turns: neither a steer
      // parent nor an idle-derivation ancestor.
      if (id !== undefined) st.parents.set(id, { role });
    },

    endFile() {
      closeOpen();
      const s = st;
      st = undefined;
      if (s === undefined || s.isChild) {
        if (s !== undefined) children.add(s.file);
        return { turns: [], corrections: [] };
      }
      if (!s.cwdMatch) return { turns: [], corrections: [] };
      return { turns: s.turns, corrections: s.corrections };
    },

    childFiles() {
      return children;
    },

    takeRevoked() {
      const out = { turns: [...revokedTurns], corrections: [...revokedCorrections] };
      revokedTurns.length = 0;
      revokedCorrections.length = 0;
      return out;
    },
  };
}
