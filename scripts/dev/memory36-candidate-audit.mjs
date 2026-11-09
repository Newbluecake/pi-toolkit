// G2 diagnostic projection. Runs only after the production turn has settled;
// never feeds information back into selection or a classifier request.
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Project the exact classifier questions and answers onto snapshot entries.
 * Collisions are reported, never resolved by guessing. No raw text is returned. */
export function candidateAudit({
  entries,
  calls,
  redact,
  renderInfo,
  budgetStats,
  settings,
  config,
  outboundLimit,
  chat,
  messages = [],
  cacheLookups = [],
  contextHash,
  rendered,
  prompt,
}) {
  const candidates = entries.map(({ id, entry, rev }) => {
    const excerpt = redact(entry.body, "entry");
    return {
      labelId: id,
      blockId: entry.block?.id ?? null,
      rev: rev ?? null,
      bodyBytes: Buffer.byteLength(entry.body, "utf8"),
      bodySha256: sha(entry.body),
      matchSuffix: ` from ${entry.file}: 「${excerpt}」. Would reminding the assistant`,
      residentAtRender: entry.block !== undefined && renderInfo?.residentBlocks?.includes(entry.block.id) === true,
      aliases: [],
    };
  });
  const batches = [];
  for (const call of calls) {
    if (call.req.duty !== "recall") continue;
    const answers = call.outcome?.answers ?? {};
    const questions = [];
    for (const [alias, q] of Object.entries(call.req.questions)) {
      const matches = candidates.filter((c) => q.instructions.includes(c.matchSuffix));
      const matchIds = matches.map((c) => c.labelId);
      for (const c of matches) c.aliases.push({ callseq: call.callseq, alias, ambiguous: matches.length !== 1 });
      const a = answers[alias];
      questions.push({
        alias,
        matchIds,
        match: matches.length === 1 ? "unique" : matches.length === 0 ? "unmapped" : "ambiguous",
        answer:
          a?.type === "bool" && Number.isFinite(a.probability)
            ? { type: "bool", probability: a.probability }
            : a
              ? { type: a.type }
              : null,
      });
    }
    const inputHash = contextHash?.({ state: call.req.state, questions: call.req.questions });
    batches.push({
      callseq: call.callseq,
      ok: call.outcome?.ok === true,
      ...(typeof call.outcome?.detail === "string" && /timeout after \d+ms/.test(call.outcome.detail)
        ? { timeoutMs: Number(call.outcome.detail.match(/timeout after (\d+)ms/)[1]) }
        : {}),
      inputBytes: Buffer.byteLength(JSON.stringify({ state: call.req.state, questions: call.req.questions }), "utf8"),
      cache: inputHash === undefined ? [] : cacheLookups.filter((lookup) => lookup.contextHash === inputHash),
      questions,
    });
  }
  return {
    version: 1,
    byteMeasurements: {
      systemMemorySectionBytes: typeof rendered === "string" ? Buffer.byteLength(rendered, "utf8") : null,
      userPromptBytes: typeof prompt === "string" ? Buffer.byteLength(prompt, "utf8") : null,
      injectedMessageBytes: messages.reduce(
        (total, m) => total + (typeof m.content === "string" ? Buffer.byteLength(m.content, "utf8") : 0),
        0,
      ),
    },
    delivered: messages.flatMap((message) => {
      const details = message.details;
      return (details?.parts ?? [details]).flatMap((part) =>
        (part?.items ?? []).map((item) => ({
          layer: part.layer ?? null,
          labelIds: entries.filter(({ entry }) => entry.hash === item.hash).map(({ id }) => id),
          probability: typeof item.p === "number" && Number.isFinite(item.p) ? item.p : null,
        })),
      );
    }),
    candidates: candidates.map(({ matchSuffix: _suffix, ...c }) => ({
      ...c,
      observedInRecall: c.aliases.length > 0,
      exclusion: c.aliases.length ? null : "unknown",
    })),
    batches,
    budgets: {
      resident: budgetStats?.resident ?? null,
      index: budgetStats?.index ?? null,
      outboundLimitBytes: outboundLimit ?? null,
      outboundObservedBytes: chat.map((context) => {
        const content = context?.messages?.[0]?.content;
        return typeof content === "string" ? Buffer.byteLength(content, "utf8") : null;
      }),
      recall: config?.recall ?? null,
      legacyRender:
        settings?.layout === "tiered"
          ? { coreBytes: settings.coreBytes, blockBytes: settings.blockBytes, indexMax: settings.indexMax }
          : null,
    },
    limitations: [
      "Absence from recall questions is not a proven exclusion reason; selection internals and P-layer candidate selection are not exposed.",
      "residentAtRender is a renderer observation, not proof of the later ledger verdict.",
      "A legacy file entry has no production block id or block revision; labelId is the corpus correspondence only.",
    ],
  };
}
