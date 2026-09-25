import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { BashToolParams, createBashTool } from "../../src/tools/bash-tool.js";
import { BashJobToolParams, createBashJobTool } from "../../src/tools/bash-job-tool.js";

/**
 * P0a / T0 (docs/dev/bash-timeout-grace/plan.md §5.3, §6.2, §7): a golden
 * fixture of the **current, unmodified** `bash` / `bash_job` tool surfaces
 * (description/schema only — no process behavior), recorded once before any
 * bash-timeout-grace code change so later packages (P2-P5) can prove they did
 * not silently change a model-facing surface that the plan did not intend to
 * touch.
 *
 * Canonical serialization (§5.3, exact spec): take
 * `{name, label, description, promptSnippet, promptGuidelines, parameters}`
 * off the live tool definition, deep-sort every object's keys (arrays keep
 * their order), drop symbol keys (typebox's `Kind` marker — `Object.keys` /
 * `JSON.stringify` already only see string keys, so this is automatic, not an
 * extra step), then `JSON.stringify(v, null, 2) + "\n"`. A field the tool
 * definition does not set (e.g. `bash_job` has no `promptGuidelines`) is
 * `undefined` on the extracted record, which `JSON.stringify` drops from
 * object output — so the fixture simply omits the key rather than writing
 * `null`/an empty value.
 *
 * One finishing step beyond the plan's literal wording: the
 * `JSON.stringify(v, null, 2)` output is re-wrapped through Prettier's own
 * `json` parser before being written or compared. AGENTS.md's `format:check`
 * gate applies to every tracked file including fixtures (unlike
 * `tests/fixtures/compact-hint-golden.json`, which happens to contain no
 * short scalar arrays and so passes Prettier's default output unmodified,
 * this fixture's `required`/`promptGuidelines` arrays would otherwise get
 * silently rewritten — array-collapsed onto one line — by the repo's
 * pre-commit hook (`prettier --write`), permanently drifting the checked-in
 * file away from what `JSON.stringify(v, null, 2)` produces and breaking the
 * byte-for-byte comparison on every future run for a reason that has nothing
 * to do with the tool surface itself. Content and key order are unaffected —
 * Prettier's JSON printer never reorders object keys or changes string
 * content, it only rewraps whitespace — so this is formatting-only and does
 * not weaken the "byte-for-byte" guarantee over the meaningful content.
 * See "待确认取舍" in the P0a delivery report.
 *
 * Generation command (plan §5.3, **only** on unmodified master, **only**
 * once, for P0a):
 *
 *   UPDATE_BASH_GOLDEN=1 npx vitest run tests/tools/bash-tools-golden.test.ts
 *
 * After that the fixture is frozen (same discipline as
 * `tests/fixtures/compact-hint-golden.json` — never regenerate it). The guard
 * below refuses to run with `UPDATE_BASH_GOLDEN` set once the fixture already
 * exists, so a later, accidental re-run of the generation command cannot
 * silently overwrite the frozen baseline.
 */

const FIXTURE_PATH = resolve(process.cwd(), "tests/fixtures/bash-tools-golden.json");

/**
 * The `bash` override's description embeds the auto-background threshold via
 * `formatDescriptionSuffix` (`src/tools/bash-tool.ts`), so the fixture needs a
 * fixed value. We pin it to the real shipped default
 * (`DEFAULT_SETTINGS.bashJobs.autoBackgroundMs`, currently 290_000ms) rather
 * than an arbitrary constant: the fixture then proves the surface a real
 * default-configuration session actually sees, and a future default-value
 * change (§6.2 P2) is exactly the kind of "did this move a model-facing
 * surface" event T0 exists to catch — see "待确认取舍" in the delivery report.
 */
const GOLDEN_AUTO_BACKGROUND_MS = DEFAULT_SETTINGS.bashJobs.autoBackgroundMs;

interface ToolSurface {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: unknown;
}

interface SurfaceSource {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: unknown;
}

function extractSurface(tool: SurfaceSource): ToolSurface {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  };
}

/** Deep, deterministic key order for objects; arrays keep their own order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
    return sorted;
  }
  return value;
}

async function canonicalize(value: unknown): Promise<string> {
  const raw = JSON.stringify(sortKeysDeep(value), null, 2);
  return prettier.format(raw, { parser: "json", printWidth: 120, tabWidth: 2 });
}

/** Builds the two tool surfaces this package covers (§6.2 P0a: bash, bash_job only). */
function buildGolden(): Record<string, ToolSurface> {
  const bash = createBashTool({ manager: () => undefined, autoBackgroundMs: () => GOLDEN_AUTO_BACKGROUND_MS });
  const bashJob = createBashJobTool({ manager: () => undefined });
  return {
    bash: extractSurface(bash),
    bash_job: extractSurface(bashJob),
  };
}

describe("bash tool surfaces — golden fixture (T0)", () => {
  it("matches tests/fixtures/bash-tools-golden.json byte-for-byte", async () => {
    const serialized = await canonicalize(buildGolden());

    if (process.env.UPDATE_BASH_GOLDEN) {
      if (existsSync(FIXTURE_PATH)) {
        throw new Error(
          "UPDATE_BASH_GOLDEN=1 refused: tests/fixtures/bash-tools-golden.json already exists. Per " +
            "docs/dev/bash-timeout-grace/plan.md §5.3 this fixture is generated exactly once, on unmodified " +
            "master, for package P0a — it must never be regenerated afterward (same discipline as " +
            "tests/fixtures/compact-hint-golden.json). Delete the file by hand first only if you are certain " +
            "this really is that one-time P0a generation, not an attempt to launder a later behavior change " +
            "through the baseline.",
        );
      }
      writeFileSync(FIXTURE_PATH, serialized);
      // Fail the run on purpose: generation must never be mistaken for a pass,
      // and a script/CI invocation that leaves UPDATE_BASH_GOLDEN set can
      // never silently succeed.
      throw new Error(
        `UPDATE_BASH_GOLDEN=1 wrote ${FIXTURE_PATH}. Re-run the test WITHOUT the env var to verify the new ` +
          "fixture, then never set UPDATE_BASH_GOLDEN again for this file.",
      );
    }

    if (!existsSync(FIXTURE_PATH)) {
      throw new Error(
        "tests/fixtures/bash-tools-golden.json is missing. Generate it once, on unmodified master, with " +
          "`UPDATE_BASH_GOLDEN=1 npx vitest run tests/tools/bash-tools-golden.test.ts` (docs/dev/bash-timeout-grace/plan.md §5.3).",
      );
    }
    const expected = readFileSync(FIXTURE_PATH, "utf8");
    expect(serialized).toBe(expected);
  });

  it("pins the bash `timeout` parameter description to pi's own createBashToolDefinition text", () => {
    const inner = createBashToolDefinition(process.cwd());
    const innerProps = (inner.parameters as unknown as { properties: Record<string, { description?: string }> })
      .properties;
    expect(BashToolParams.properties.timeout.description).toBe(innerProps.timeout?.description);
  });

  it("pins the bash description to start with pi's own createBashToolDefinition text verbatim", () => {
    const inner = createBashToolDefinition(process.cwd());
    const tool = createBashTool({ manager: () => undefined, autoBackgroundMs: () => GOLDEN_AUTO_BACKGROUND_MS });
    expect(tool.description.startsWith(inner.description)).toBe(true);
  });

  it("pins bash_job's action enum to exactly status/wait/kill/list (§5.3 off-baseline: `extend` not yet implemented)", () => {
    const action = BashJobToolParams.properties.action as unknown as { anyOf: Array<{ const: string }> };
    const values = action.anyOf.map((entry) => entry.const).sort();
    expect(values).toEqual(["kill", "list", "status", "wait"]);
  });
});
