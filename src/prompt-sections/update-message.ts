import type { SectionName, SectionUpdate } from "./stable-section.js";

export const SECTION_UPDATE_CUSTOM_TYPE = "subagent:prompt-section-update";
export type { SectionName } from "./stable-section.js";

type RenderUpdate = {
  section: SectionName;
  title: string;
  pointerHint?: string;
  absentFromHead?: boolean;
} & SectionUpdate;

export function renderSectionUpdateMessage(updates: ReadonlyArray<RenderUpdate>): {
  customType: typeof SECTION_UPDATE_CUSTOM_TYPE;
  content: string;
  display: false;
  details: { v: 1; updates: Array<{ section: SectionName; kind: SectionUpdate["kind"] }> };
} {
  const parts = updates.map((update) => {
    const quoted = JSON.stringify(update.title);
    // absentFromHead: the frozen system prompt never contained this section (its snapshot is
    // empty, e.g. no memory files when the session started), so there is nothing to "replace" —
    // the section only exists through these tail updates until the next refresh point.
    const fresh = update.absentFromHead === true;
    if (update.kind === "removed")
      return fresh
        ? `The section headed by the line beginning with ${quoted}, introduced by an earlier update (it is not part of your system prompt), no longer applies; ignore that update.`
        : `The section of your system prompt headed by the line beginning with ${quoted} no longer applies; ignore it and any earlier update of it.`;
    if (update.kind === "pointer") {
      const hint = update.pointerHint ? ` ${update.pointerHint}` : "";
      const subject = fresh
        ? `The section headed by the line beginning with ${quoted}, introduced by an earlier update,`
        : `The section of your system prompt headed by the line beginning with ${quoted}`;
      return `${subject} has changed again; further full copies are withheld to bound context size. Treat that section and its earlier updates as possibly outdated.${hint} It will be rewritten in your system prompt at a later refresh point.`;
    }
    const lead = fresh
      ? `The block below ADDS a section to your system prompt (it was absent when your system prompt was frozen) and replaces any earlier update of it; treat it as authoritative until a newer update appears.`
      : `The block below REPLACES the section of your system prompt headed by the line beginning with ${quoted} and any earlier update of it; treat it as authoritative until a newer update appears.`;
    return `${lead}\n<pi_section_update name="${update.section}">\n${update.content}\n</pi_section_update>`;
  });
  return {
    customType: SECTION_UPDATE_CUSTOM_TYPE,
    content: `[pi-toolkit] System prompt section update. ${parts.join("\n\n")}`,
    display: false,
    details: { v: 1, updates: updates.map(({ section, kind }) => ({ section, kind })) },
  };
}
