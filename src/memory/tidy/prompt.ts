// §7.1/§7.3/§8 tidy prompt construction — todo #22 P4. Pure function: given
// the target files' raw bytes, builds the model-facing prompt asking for a
// `TidyProposal` (contracts.ts's `TIDY_SCHEMA` is passed separately as the
// spawn request's `schema`, so this text never needs to spell the schema
// out — it only needs to state the RULES the schema can't express).

export interface TidyPromptFile {
  name: string;
  body: string;
  isPrimaryCore: boolean;
  handWritten: boolean;
}

export interface TidyPromptInput {
  cwd: string;
  files: readonly TidyPromptFile[];
  /** §8: no `core.md` in the directory ⇒ migration-mode instructions
   *  (produce one, split oversized mixed files, backfill frontmatter). */
  migrationMode: boolean;
  coreBytes: number;
  topicMaxBytes: number;
}

const RULES = [
  "Return ONLY a JSON object matching the provided schema — no prose outside it.",
  '`files[]` lists EVERY target file exactly once: action "keep" (untouched), "rewrite" (new `content` replaces it), ' +
    '"create" (a brand-new file, `content` required), "delete" (dropped — content must be accounted for below), or ' +
    '"rename" (same or new `content`, `newName` required).',
  "Content conservation is mandatory: every non-empty, non-heading line of a file you rewrite/delete/rename must " +
    "appear (normalized) in SOME output file's content, or be listed in `dropped[]` with `from` set to the " +
    "original file name and a short `reason`. Do not silently drop information.",
  "Hand-written files (marked below) are shown for context only — your proposal for them will be offered as a " +
    "suggestion (diff), never auto-applied. You may still propose changes to them.",
];

export function buildTidyPrompt(input: TidyPromptInput): string {
  const lines: string[] = [];
  lines.push(
    `You are tidying the project memory directory for ${input.cwd} (${String(input.files.length)} file(s)). ` +
      "Propose a cleanup: merge/trim redundant content, keep each file focused, and improve frontmatter " +
      "(description/read_when/topic/status) where it's missing or wrong.",
  );
  lines.push("");
  lines.push("Rules:");
  for (const r of RULES) lines.push(`- ${r}`);
  lines.push(`- \`core.md\`'s final content must be ≤ ${String(input.coreBytes)} bytes (UTF-8).`);
  lines.push(`- Any other file's final content must be ≤ ${String(input.topicMaxBytes)} bytes (UTF-8).`);
  if (input.migrationMode) {
    lines.push("");
    lines.push("Migration mode (no core.md exists yet):");
    lines.push("- Produce a core.md with only rules needed EVERY turn; leave a `→ <file>` pointer for sunk topics.");
    lines.push('- Split any oversized mixed file into focused topic files (action "rewrite" + new "create"s).');
    lines.push("- Backfill description/read_when/topic/status on every agent-written topic file.");
    lines.push(
      "- Content overlapping AGENTS.md/skills/docs/dev is either a one-line pointer to the source doc, marked " +
        "`status: stale`, or dropped with a reason in `dropped[]` — never silently deleted.",
    );
  }
  lines.push("");
  lines.push("Target files:");
  for (const f of input.files) {
    lines.push("");
    lines.push(`### ${f.name}${f.isPrimaryCore ? " (primary core)" : ""}${f.handWritten ? " (hand-written)" : ""}`);
    lines.push(f.body);
  }
  return lines.join("\n");
}
