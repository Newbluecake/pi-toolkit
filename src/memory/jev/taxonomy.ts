// Preset taxonomy, project-tag merging and criteria generation
// (jev-arch §4.3, jev-plan J1). The 22 preset tag descriptions are J1's
// finalized wording (English, ≤240B — they double as the Jev `criteria.true`
// text, so they must distinguish scenarios, not just name them). Types and
// importance are FIXED in code (extending them would break comparability of
// historical tags). Pi-free root; immutable module-scope constants only (I4).

import { createHash } from "node:crypto";
import {
  MAX_ENABLED_TAGS,
  type EntryType,
  type JevQuestion,
  type TagDef,
  type TagDefInput,
  type Taxonomy,
  type TaxonomyFileV1,
} from "./contracts.js";

// ───────────────────────────── fixed types & importance (§4.3.1) ─────────────────────────────

export const ENTRY_TYPES: readonly { id: EntryType; description: string }[] = [
  { id: "rule", description: "A rule, requirement or prohibition the assistant must follow." },
  { id: "pitfall", description: "A known pitfall, failure cause or workaround." },
  { id: "procedure", description: "Steps of a workflow to perform." },
  { id: "preference", description: "The user's personal preference or communication style." },
  { id: "fact", description: "Background fact about the project or environment." },
  { id: "pointer", description: "Only points to another document or file." },
];

export const IMPORTANCE_LABELS: readonly string[] = ["background", "useful", "important", "critical"];

// ───────────────────────────── preset tags (§4.3.2, J1 final wording) ─────────────────────────────

/** 22 preset scenario tags, `H` = high risk. Descriptions are the finalized
 *  criteria wording (arch §4.3.2 initial draft, J1 定稿): English, ≤240B,
 *  scenario-distinguishing. Presets can be disabled but never removed. */
export const PRESET_TAGS: readonly TagDef[] = (
  [
    {
      id: "git-commit",
      label: "Git commit",
      description:
        "Creating git commits — what may be committed, scope and message rules, and checks to run before committing.",
      risk: "high",
      match: { commands: ["git commit"] },
    },
    {
      id: "git-push",
      label: "Push / PR",
      description:
        "Publishing to a remote: git push, opening or merging pull requests, and the confirmations required first.",
      risk: "high",
      match: { commands: ["git push", "gh pr create", "gh pr merge"] },
    },
    {
      id: "git-history",
      label: "History & branches",
      description:
        "Rewriting or switching git history and branches: reset, rebase, checkout, switch, merge, cherry-pick, stash.",
      risk: "high",
      match: {
        commands: [
          "git reset",
          "git rebase",
          "git checkout",
          "git switch",
          "git merge",
          "git cherry-pick",
          "git stash",
        ],
      },
    },
    {
      id: "release",
      label: "Release",
      description:
        "Cutting a release: tags, version bumps, publishing packages, release scripts, and rules that hold only while releasing.",
      risk: "high",
      match: { commands: ["git tag", "npm publish", "npm version", "gh release", "*release*.sh"] },
    },
    {
      id: "deletion",
      label: "Deletion",
      description: "Deleting files or data, or commands that destroy work (rm, git rm, trash, find -delete).",
      // NO tools:["memory"] — main-session ruling on J1 report item 3: matching
      // the tool name would make EVERY memory write (create/str_replace/
      // insert/append) hit a high-risk tag; memory's own delete is already
      // covered by the user-order two-phase guard. (Historically this also
      // skipped a synchronous gate call; the gate was removed 2026-11, the
      // risk:"high" classification still feeds the A-layer fast path.)
      risk: "high",
      match: { commands: ["rm", "git rm", "git clean", "find -delete", "trash"] },
    },
    {
      id: "dispatch",
      label: "Subagent dispatch",
      description:
        "Dispatching or steering subagents and workflows — parallel lanes, prompts, constraints and acceptance rules for delegated work.",
      risk: "high",
      match: { tools: ["Agent", "SubagentWorkflow", "steer_subagent"] },
    },
    {
      id: "dependencies",
      label: "Dependencies",
      description:
        "Adding, upgrading or removing package dependencies (npm/pnpm/yarn installs, package.json edits) and dependency hygiene rules.",
      risk: "high",
      match: { commands: ["npm install", "npm i", "pnpm add", "yarn add"], paths: ["package.json"] },
    },
    {
      id: "credentials",
      label: "Credentials",
      description:
        "Secrets, tokens, keys, login or authentication material — how to store, pass, rotate or never leak them.",
      risk: "high",
      match: { paths: ["**/.env*", "**/*.pem", "**/auth.json"] },
    },
    {
      id: "frozen-files",
      label: "Frozen goldens",
      description:
        "Frozen goldens and fixtures that must stay byte-identical; regenerating, editing or deleting them is forbidden.",
      risk: "high",
      match: { paths: ["tests/fixtures/**"], commands: ["*UPDATE*GOLDEN*"] },
    },
    {
      id: "model-routing",
      label: "Model routing",
      description:
        "Which model to use for which task: routing tables, lane scoring, per-phase model choices and escalation rules.",
      risk: "normal",
      match: { tools: ["Agent", "set_model"] },
    },
    {
      id: "testing",
      label: "Testing",
      description:
        "Running tests or test suites (npm test, vitest), flake triage, test-writing and test-hygiene rules.",
      risk: "normal",
      match: { commands: ["npm test", "npx vitest", "vitest"] },
    },
    {
      id: "build",
      label: "Build & typecheck",
      description:
        "Building the project and running type checks (npm run build, npm run typecheck, tsc) and their gates.",
      risk: "normal",
      match: { commands: ["npm run build", "npm run typecheck", "tsc"] },
    },
    {
      id: "ci",
      label: "CI",
      description: "CI pipelines and GitHub Actions: required checks, gates, reruns, and release-blocking green rules.",
      risk: "normal",
      match: { commands: ["gh run", "gh workflow"] },
    },
    {
      id: "network",
      label: "Network",
      description:
        "Network access: proxies, curl, git fetch/pull/clone, gh over the network, regional blocks and offline workarounds.",
      risk: "normal",
      match: { commands: ["curl", "git fetch", "git pull", "git clone", "gh"] },
    },
    {
      id: "config",
      label: "Settings files",
      description:
        "Settings and configuration files (settings*.json, pi-toolkit.json): which keys exist, defaults, and how they may change.",
      risk: "normal",
      match: { paths: ["**/settings*.json", "**/pi-toolkit.json"] },
    },
    {
      id: "shell-env",
      label: "Shell environment",
      description:
        "Shell environment differences (bash vs zsh), timeout wrapping, quoting and command-portability pitfalls.",
      risk: "normal",
      match: { commands: ["timeout", "bash", "zsh"] },
    },
    {
      id: "background-jobs",
      label: "Background jobs",
      description:
        "Long-running commands moved to background and the bash_job tool: listing, waiting, extending and killing them.",
      risk: "normal",
      match: { tools: ["bash_job"] },
    },
    {
      id: "session-context",
      label: "Context handoff",
      description:
        "Context handoff and compaction: switch_context, compact_context, and what a handoff must carry to be resumable.",
      risk: "normal",
      match: { tools: ["switch_context", "compact_context"] },
    },
    {
      id: "docs",
      label: "Documentation",
      description: "Documentation conventions: where docs live, doc style and README rules, doc updates and reviews.",
      risk: "normal",
      match: { paths: ["docs/**", "*.md"] },
    },
    {
      id: "communication",
      label: "User communication",
      description:
        "How to communicate with the user: when to ask instead of deciding, reporting formats, tone and language preferences.",
      risk: "normal",
    },
    {
      id: "workflow",
      label: "Dev workflow",
      description:
        "The development workflow itself: lanes, gates, planning, review, acceptance, commit and release rules.",
      risk: "normal",
    },
    {
      id: "memory-system",
      label: "Memory maintenance",
      description:
        "Maintaining project memory itself: /mem usage, entry style, maintenance rules, tagging and inline authority syntax.",
      risk: "normal",
      match: { tools: ["memory"] },
    },
  ] as ReadonlyArray<Omit<TagDef, "source" | "rev"> & { source?: "preset"; rev?: number }>
).map((t) => ({ ...t, source: "preset" as const, rev: t.rev ?? 1 }));

// ───────────────────────────── validation & merging ─────────────────────────────

const TAG_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

export type ValidateTagDefResult = { ok: true; def: TagDef } | { ok: false; error: string };

/** Validate a `/mem tags add` input. Id: `^[a-z][a-z0-9-]{1,31}$`, must not
 *  collide with a preset id; label ≤40B; description ≤240B. Never throws. */
export function validateTagDef(input: TagDefInput): ValidateTagDefResult {
  if (!TAG_ID_RE.test(input.id)) {
    return { ok: false, error: `tag id ${JSON.stringify(input.id)} must match ^[a-z][a-z0-9-]{1,31}$` };
  }
  if (PRESET_TAGS.some((t) => t.id === input.id)) {
    return {
      ok: false,
      error: `tag id ${JSON.stringify(input.id)} collides with a preset tag (presets can be disabled, not replaced)`,
    };
  }
  if (input.label.trim() === "") return { ok: false, error: "tag label must not be empty" };
  if (Buffer.byteLength(input.label, "utf8") > 40) return { ok: false, error: `tag label exceeds 40B` };
  if (input.description.trim() === "") return { ok: false, error: "tag description must not be empty" };
  if (Buffer.byteLength(input.description, "utf8") > 240) {
    return { ok: false, error: "tag description exceeds 240B" };
  }
  return {
    ok: true,
    def: {
      id: input.id,
      label: input.label.trim(),
      description: input.description.trim(),
      risk: input.risk === "high" ? "high" : "normal",
      ...(input.commands === undefined && input.paths === undefined && input.tools === undefined
        ? {}
        : {
            match: {
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              ...(input.commands === undefined ? {} : { commands: input.commands }),
              ...(input.paths === undefined ? {} : { paths: input.paths }),
            },
          }),
      source: "user",
      rev: 1,
    },
  };
}

export type MergeTaxonomyResult = { ok: true; taxonomy: Taxonomy } | { ok: false; error: string };

/** Merge presets with a project taxonomy file: disable the listed presets,
 *  add user tags (validated), cap the ENABLED total at 64. User tags
 *  duplicate-check against each other and against presets (an identical
 *  preset id is a disable/enable matter, never an override). */
export function mergeTaxonomy(file?: TaxonomyFileV1): MergeTaxonomyResult {
  const disabled = new Set((file?.disabledPresets ?? []).filter((id) => PRESET_TAGS.some((t) => t.id === id)));
  const tags: TagDef[] = PRESET_TAGS.filter((t) => !disabled.has(t.id)).map((t) => ({ ...t }));
  if (file !== undefined) {
    const seen = new Set(tags.map((t) => t.id));
    for (const raw of file.tags) {
      if (!TAG_ID_RE.test(raw.id)) return { ok: false, error: `tag id ${JSON.stringify(raw.id)} is invalid` };
      if (seen.has(raw.id)) return { ok: false, error: `duplicate tag id ${JSON.stringify(raw.id)}` };
      const validated = validateTagDef({
        id: raw.id,
        label: raw.label,
        description: raw.description,
        ...(raw.risk === undefined ? {} : { risk: raw.risk }),
        ...(raw.match?.commands === undefined ? {} : { commands: raw.match.commands }),
        ...(raw.match?.paths === undefined ? {} : { paths: raw.match.paths }),
        ...(raw.match?.tools === undefined ? {} : { tools: raw.match.tools }),
      });
      if (!validated.ok) return { ok: false, error: validated.error };
      // Preserve a stored rev (the file round-trips TagDef).
      seen.add(raw.id);
      tags.push({ ...validated.def, rev: raw.rev });
    }
  }
  if (tags.length > MAX_ENABLED_TAGS) {
    return { ok: false, error: `enabled tags exceed the cap (${tags.length} > ${MAX_ENABLED_TAGS})` };
  }
  tags.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    taxonomy: { rev: taxonomyRev(tags), types: ENTRY_TYPES, importance: IMPORTANCE_LABELS, tags },
  };
}

/** sha1 over the enabled tags (id order) of `id \n rev \n description`,
 *  first 8 hex chars. Changes when a description (or its rev — which only a
 *  description edit bumps) changes or the enabled set changes; matcher-only
 *  edits do NOT move it. */
export function taxonomyRev(tags: readonly TagDef[]): string {
  const sorted = [...tags].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = sorted.map((t) => `${t.id}\n${t.rev}\n${t.description}`).join("\n");
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);
}

/** The Jev question for one tag (§4.3.1 criteria shape). */
export function tagCriteria(tag: TagDef): JevQuestion {
  return {
    type: "bool",
    instructions: `Is this project-memory entry about the scenario below? ${tag.label}: ${tag.description}`,
    criteria: { true: tag.description, false: `Not about ${tag.label}` },
  };
}
