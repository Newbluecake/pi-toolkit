/**
 * web-resume plan §2.2 (P1, frozen API): the shared subagent rule + display-title normalizer.
 *
 * `isSubagentSession` = the §2.1 rule, no heuristics (D2): the file's own `subagent:child`
 * self-marker (from its head) OR membership in the dir-wide provenance index. Callers pass the
 * head they read anyway for the list row, so the v0.4.0+ guarantee holds even when the index is
 * capacity-truncated or still backfilling.
 *
 * `displayTitle` produces the web row title (≤120 UTF-16, C0→space, never splits a surrogate
 * pair): the user rename if any, else the first user message with the skill envelope stripped
 * (`[skill名] 真实输入`, reusing skill-titles.ts's `stripSkillEnvelope`). Pi-free.
 */
import { stripSkillEnvelope } from "./skill-titles.js";
import type { ProvenanceIndex } from "./provenance.js";
import type { SessionHead } from "./session-head.js";

export const TITLE_MAX_UTF16 = 120;

/** §2.1 sub rule (frozen §2.2): self-marker OR provenance index hit. Current session is never checked here. */
export function isSubagentSession(
  absPath: string,
  head: { child: boolean } | undefined,
  index: ProvenanceIndex,
): boolean {
  if (head?.child) return true;
  return index.has(absPath);
}

/** C0 → space, trim, cap at 120 UTF-16 units without splitting a surrogate pair. */
function normalizeTitle(text: string): string {
  const spaced = text.replace(/[\u0000-\u001f]/g, " ").trim();
  if (spaced.length <= TITLE_MAX_UTF16) return spaced;
  const cut = spaced.slice(0, TITLE_MAX_UTF16);
  const boundary = cut.charCodeAt(TITLE_MAX_UTF16 - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) return cut.slice(0, TITLE_MAX_UTF16 - 1);
  return cut;
}

export function displayTitle(head: SessionHead): { title: string; source: "name" | "first" | "none" } {
  const name = head.name?.trim();
  if (name) return { title: normalizeTitle(name), source: "name" };
  const firstMessage = head.firstMessage;
  if (firstMessage !== undefined && firstMessage.trim() !== "") {
    const parsed = stripSkillEnvelope(firstMessage);
    const title =
      parsed === null
        ? firstMessage
        : parsed.rest.trim() !== ""
          ? `[${parsed.name}] ${parsed.rest.trim()}`
          : `[${parsed.name}]`;
    return { title: normalizeTitle(title), source: "first" };
  }
  return { title: "", source: "none" };
}
