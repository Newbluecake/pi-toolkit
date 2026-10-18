/**
 * `/cache-ttl measure` argument parser (measure-plan.md r4 §1). Pure and pi-free — shared by the command handler (P4)
 * and the web-hub command policy.
 *
 * `parseMeasureArgs` works on the RAW argument text (the current `/cache-ttl` handler lowercases everything, so the
 * measure branch must run before that). Only the verb(s) and flags are case-normalised; the `<provider>/<id>` model
 * reference keeps its case. Anything unknown or ambiguous is a usage error — nothing is guessed and nothing is sent.
 *
 * Accepted shapes (flag order is free; the leading `measure` verb is optional so both `"measure --long"` and
 * `"--long"` parse):
 *   measure [<provider>/<id>] [--long] [--estimate] [--yes]
 *   measure status
 *   measure cancel
 */

import type { MeasureArgs, MeasureArgsError } from "./measure-types.js";

const FLAGS = ["--long", "--estimate", "--yes"] as const;
type Flag = (typeof FLAGS)[number];

function fail(error: MeasureArgsError, detail: string): MeasureArgs {
  return { ok: false, error, detail };
}

/** Split `provider/id` at the FIRST `/` (ids may themselves contain `/`, e.g. router-style ids). */
function parseModelRef(token: string): { provider: string; id: string } | undefined {
  const slash = token.indexOf("/");
  if (slash <= 0 || slash === token.length - 1) return undefined;
  const provider = token.slice(0, slash);
  const id = token.slice(slash + 1);
  if (provider.trim() === "" || id.trim() === "") return undefined;
  return { provider, id };
}

export function parseMeasureArgs(rawArgs: string | readonly string[]): MeasureArgs {
  const tokens = (typeof rawArgs === "string" ? rawArgs.split(/\s+/) : [...rawArgs]).filter((t) => t !== "");
  // Optional leading `measure` verb (case-insensitive). Only ONE is stripped: a second one is `unexpected-argument`.
  if (tokens.length > 0 && tokens[0]!.toLowerCase() === "measure") tokens.shift();

  const first = tokens[0]?.toLowerCase();
  if (first === "status" || first === "cancel") {
    if (tokens.length > 1) {
      return fail("flags-after-subcommand", `\`${first}\` takes no further arguments (got \`${tokens[1]}\`)`);
    }
    return { ok: true, command: first };
  }

  const seen = new Set<Flag>();
  let model: { provider: string; id: string } | undefined;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      const flag = token.toLowerCase();
      if (!(FLAGS as readonly string[]).includes(flag)) return fail("unknown-flag", `unknown flag \`${token}\``);
      if (seen.has(flag as Flag)) return fail("duplicate-flag", `flag \`${flag}\` given twice`);
      seen.add(flag as Flag);
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "status" || lower === "cancel" || lower === "measure") {
      return fail("unexpected-argument", `\`${token}\` is only valid as the first argument`);
    }
    if (model !== undefined) return fail("extra-model", `a second model \`${token}\` was given`);
    const parsed = parseModelRef(token);
    if (parsed === undefined) return fail("bad-model-ref", `\`${token}\` is not <provider>/<id>`);
    model = parsed;
  }
  return {
    ok: true,
    command: "start",
    ...(model !== undefined ? { model } : {}),
    long: seen.has("--long"),
    estimate: seen.has("--estimate"),
    yes: seen.has("--yes"),
  };
}
