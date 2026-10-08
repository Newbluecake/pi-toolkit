/**
 * web-hub session-history plan §4.5.2 (`title.ts`, PD19): title cleaning and the search blob.
 *
 * `stripSkillEnvelope` is the SAME algorithm as `src/session-nav/skill-titles.ts` (ported
 * inline rather than imported — that module is outside the `src/web-hub/{protocol,hub}`
 * boundary this directory is held to, and pulls in `node:readline`/`createReadStream` this
 * module has no business touching). `title.test.ts` pins the two against the same fixture
 * corpus.
 */
import { HISTORY_TITLE_MAX } from "../../../protocol/session-history.js";

const SKILL_OPEN_RE = /^<skill\s+name="([^"]+)"[^>]*>/;
const SKILL_REFERENCES_RE = /^\s*References are relative to \S*\.?\s*/;

export function stripSkillEnvelope(text: string): { name: string; rest: string } | null {
  const open = SKILL_OPEN_RE.exec(text);
  if (open === null) return null;
  const name = open[1];
  if (name === undefined) return null;
  const closeIndex = text.indexOf("</skill>");
  const rest =
    closeIndex >= 0
      ? text.slice(closeIndex + "</skill>".length)
      : text.slice(open[0].length).replace(SKILL_REFERENCES_RE, "");
  return { name, rest: rest.trim() };
}

/** Fold any run of whitespace (incl. newlines) into a single ASCII space, then trim. */
function foldWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate to `max` UTF-16 units WITHOUT splitting a surrogate pair. */
function truncateUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  // if the char just before `end` is a high surrogate, back off one more unit so we don't
  // split it from its low surrogate.
  const prev = s.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

export type TitleSource = "name" | "first" | "none";

export interface TitleInput {
  /** Card's live `session.name`, when the card's `sessionId === id` (highest priority). */
  cardName?: string;
  /** The header window's `session_info.name`. */
  headerName?: string;
  /** The raw first user message text (may already be skill-enveloped). */
  firstMessage?: string;
}

export interface TitleResult {
  title?: string;
  titleSource: TitleSource;
}

/** Priority: card name > header name > cleaned first message > none. Skill envelopes are
 * stripped from the first-message fallback only (a card/header name is never a skill payload). */
export function resolveTitle(input: TitleInput): TitleResult {
  const card = input.cardName === undefined ? undefined : foldWhitespace(input.cardName);
  if (card !== undefined && card.length > 0) {
    return { title: truncateUnits(card, HISTORY_TITLE_MAX), titleSource: "name" };
  }
  const header = input.headerName === undefined ? undefined : foldWhitespace(input.headerName);
  if (header !== undefined && header.length > 0) {
    return { title: truncateUnits(header, HISTORY_TITLE_MAX), titleSource: "name" };
  }
  if (input.firstMessage !== undefined) {
    const stripped = stripSkillEnvelope(input.firstMessage.trimStart());
    const raw =
      stripped !== null
        ? stripped.rest.length > 0
          ? `[${stripped.name}] ${stripped.rest}`
          : `[${stripped.name}]`
        : input.firstMessage;
    const cleaned = foldWhitespace(raw);
    if (cleaned.length > 0) return { title: truncateUnits(cleaned, HISTORY_TITLE_MAX), titleSource: "first" };
  }
  return { titleSource: "none" };
}

/** `search = (cwd + " " + display + " " + firstMessage).normalize("NFKC").toLowerCase()`,
 * truncated to 1 KiB (UTF-16 units — the plan gives no explicit byte/unit rule here, and this
 * value never crosses the wire, so unit truncation keeps it simple and surrogate-pair-safe). */
export function buildSearchBlob(cwd: string, display: string | undefined, firstMessage: string | undefined): string {
  const parts = [cwd, display ?? "", firstMessage ?? ""];
  const joined = parts.join(" ").normalize("NFKC").toLowerCase();
  return truncateUnits(joined, 1024);
}
