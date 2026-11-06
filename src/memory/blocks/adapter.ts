import { createHash } from "node:crypto";
import { normalizeBody, entryHash } from "../jev/entries.js";
import { namedPrograms } from "../jev/match.js";
import { looksSecret } from "../secret-patterns.js";
import type { MemEntry, InlineMeta } from "../jev/contracts.js";
import type { ParsedBlock } from "./format.js";
export function blockToEntry(b: ParsedBlock, _today: string): MemEntry {
  const m = b.meta,
    body = normalizeBody(b.body);
  const inline: InlineMeta = {
    present: true,
    authority: m.authority === "user" ? "user" : "lesson",
    ...(m.scope === undefined ? {} : { scope: m.scope }),
    ...(m.audience === undefined ? {} : { audience: m.audience }),
    ...(m.expires === undefined ? {} : { expires: m.expires }),
    ...(m.until === undefined ? {} : { until: m.until }),
    ...(m.tags === undefined ? {} : { tagsAdd: m.tags.add, tagsRemove: m.tags.remove }),
    ...(m.private ? { isPrivate: true } : {}),
    ...(m.title === undefined ? {} : { title: m.title }),
    ...(m.when === undefined ? {} : { when: m.when }),
  };
  return {
    file: `${b.id}.md`,
    section: m.section ?? "",
    ...(m.heading === undefined ? {} : { heading: m.heading }),
    ordinal: b.seq,
    lineStart: 1,
    lineEnd: body.split("\n").length,
    raw: body,
    body,
    hash: entryHash(body),
    guardHash: createHash("sha1").update(body).digest("hex"),
    inline,
    inlineErrors: b.errors,
    authority: m.authority,
    fileStatus: "active",
    secret: looksSecret(body),
    namedPrograms: namedPrograms(body),
    block: {
      id: b.id,
      ...(m.scope === undefined ? {} : { scope: m.scope }),
      ...(m.audience === undefined ? {} : { audience: m.audience }),
      status: m.status,
      ...(m.supersededBy === undefined ? {} : { supersededBy: m.supersededBy }),
      updated: m.updated,
    },
  };
}
