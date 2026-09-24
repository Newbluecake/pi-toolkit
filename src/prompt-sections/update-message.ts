import type { SectionName, SectionUpdate } from "./stable-section.js";

export const SECTION_UPDATE_CUSTOM_TYPE = "subagent:prompt-section-update";
export type { SectionName } from "./stable-section.js";

type RenderUpdate = { section: SectionName; title: string; pointerHint?: string } & SectionUpdate;

export function renderSectionUpdateMessage(updates: ReadonlyArray<RenderUpdate>): {
  customType: typeof SECTION_UPDATE_CUSTOM_TYPE;
  content: string;
  display: false;
  details: { v: 1; updates: Array<{ section: SectionName; kind: SectionUpdate["kind"] }> };
} {
  const parts = updates.map((update) => {
    const quoted = JSON.stringify(update.title);
    if (update.kind === "removed")
      return `The section of your system prompt headed by the line beginning with ${quoted} no longer applies; ignore it and any earlier update of it.`;
    if (update.kind === "pointer") {
      const hint = update.pointerHint ? ` ${update.pointerHint}` : "";
      return `The section of your system prompt headed by the line beginning with ${quoted} has changed again; further full copies are withheld to bound context size. Treat that section and its earlier updates as possibly outdated.${hint} It will be rewritten in your system prompt at a later refresh point.`;
    }
    return `The block below REPLACES the section of your system prompt headed by the line beginning with ${quoted} and any earlier update of it; treat it as authoritative until a newer update appears.\n<pi_section_update name="${update.section}">\n${update.content}\n</pi_section_update>`;
  });
  return {
    customType: SECTION_UPDATE_CUSTOM_TYPE,
    content: `[pi-toolkit] System prompt section update. ${parts.join("\n\n")}`,
    display: false,
    details: { v: 1, updates: updates.map(({ section, kind }) => ({ section, kind })) },
  };
}
