/** Display-only, bounded reason vocabulary; never changes routing or wire schema. */
export function fabricWakeNotice(reason: unknown, lang: "zh" | "en" = "zh"): string {
  if (typeof reason !== "string" || reason.length > 48 || !/^(?:level_limit|rate_limited|root_[a-z_]+)$/.test(reason))
    return "";
  if (reason === "root_busy" || reason === "root_reserved") {
    return lang === "zh" ? `已排队，不新增唤醒（${reason}）` : `Queued; no additional wake (${reason})`;
  }
  return lang === "zh"
    ? `已送达但未唤醒（${reason}）；不代表 Root 已处理`
    : `Delivered without waking (${reason}); this does not mean Root has handled it`;
}

/** Parse only a complete generated first-line notice, never the user message body.
 * The formatter is the source of truth: changing its wording needs no parser update.
 */
export function parseWakeNotice(
  text: string,
  format: typeof fabricWakeNotice = fabricWakeNotice,
): { reason: string; prefix: string; rest: string } | null {
  const newline = text.indexOf("\n");
  const line = newline < 0 ? text : text.slice(0, newline);
  const header = /^(\[@[^\]\n]+\] · )/.exec(line);
  if (!header) return null;
  const prefix = header[1]!;
  const notice = line.slice(prefix.length);
  for (const match of notice.matchAll(/\b(?:level_limit|rate_limited|root_[a-z_]+)\b/g)) {
    const reason = match[0];
    if (reason.length <= 48 && (["zh", "en"] as const).some((lang) => format(reason, lang) === notice)) {
      return { reason, prefix, rest: newline < 0 ? "" : text.slice(newline) };
    }
  }
  return null;
}

/** Preserve everything outside the generated notice, including the body bytes. */
export function translateWakeNotice(text: string, lang: "zh" | "en"): string {
  const parsed = parseWakeNotice(text);
  return parsed ? parsed.prefix + fabricWakeNotice(parsed.reason, lang) + parsed.rest : text;
}
