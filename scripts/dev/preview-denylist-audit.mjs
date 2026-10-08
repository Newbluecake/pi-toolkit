#!/usr/bin/env node
/**
 * dir-plan v3.1 §2.7 (P1a): pre-release denylist audit — a READ-ONLY local scan.
 *
 * Walks $HOME to at most 4 levels (skipping node_modules / .git / .cache), and lists every
 * file that (a) the current uid can read, (b) the PREVIEW denylist v2 does NOT already
 * refuse, and (c) whose name matches the credential heuristic
 * (token|secret|credential|passw|auth|\.pem$|\.key$|cookies). Output goes to the local
 * terminal only — nothing is uploaded, written, or logged anywhere else. A human then judges
 * whether any row needs a new denylist rule (§2.7's release checklist step: 「运行 audit，
 * 确认没有需要补的规则」).
 *
 * The deny decision is THE REAL ONE — imported from src/web-hub/hub/preview/admit.ts so the
 * script can never drift from the shipped rules. That source is TypeScript with NodeNext
 * `.js`-suffixed relative imports, which plain `node` cannot resolve: the script first tries
 * the direct import and, failing that, re-execs itself under the repo's devDependency `tsx`
 * (same trick scripts/web-hub/*.ts use via `npx tsx`). If neither works it exits non-zero
 * with instructions.
 *
 * Usage: node scripts/dev/preview-denylist-audit.mjs [--deep]   (--deep ⇒ 6 levels instead of 4)
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The §2.7 credential-name heuristic (case-insensitive). */
const HEURISTIC = /token|secret|credential|passw|auth|\.pem$|\.key$|cookies/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache"]);
const MAX_DEPTH = process.argv.includes("--deep") ? 6 : 4;
const MAX_ROWS = 500;

let denyListHit;
let PREVIEW_DENYLIST_VERSION;
try {
  const mod = await import("../../src/web-hub/hub/preview/admit.ts");
  denyListHit = mod.denyListHit;
  PREVIEW_DENYLIST_VERSION = mod.PREVIEW_DENYLIST_VERSION;
} catch {
  // plain `node` cannot resolve the TS source's `.js`-suffixed imports — re-exec under tsx
  const bin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const again = spawnSync(bin, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (again.error !== undefined || again.status === null) {
    console.error(
      "preview-denylist-audit: cannot load the denylist (tsx re-exec failed — run inside the repo after `npm install`)",
    );
    process.exit(1);
  }
  process.exit(again.status ?? 0);
}

const home = process.env["HOME"] ?? ".";
const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(home, ".pi", "agent");

/** literal + realpath dedupe (resolvePreviewDenyContext's §2.6 shape, inline for a dev tool). */
const bases = (literal) => {
  const out = [];
  for (const b of [
    literal,
    (() => {
      try {
        return realpathSync(literal);
      } catch {
        return undefined;
      }
    })(),
  ]) {
    if (b === undefined) continue;
    if (!out.includes(b)) out.push(b);
  }
  return out;
};
const ctx = { homes: bases(home), agentDirs: bases(agentDir) };

/** Current-uid readability: the same kernel check the hub's open would face. */
const readable = (p) => {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const rows = [];
let scanned = 0;
const walk = (dir, depth) => {
  if (rows.length >= MAX_ROWS) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / vanished — not our business here
  }
  for (const ent of entries) {
    if (rows.length >= MAX_ROWS) return;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(ent.name)) walk(full, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    scanned += 1;
    if (!HEURISTIC.test(ent.name)) continue;
    if (!readable(full)) continue;
    if (denyListHit(full, ctx)) continue; // already refused by the denylist
    let size = -1;
    try {
      size = statSync(full).size;
    } catch {
      /* keep -1 */
    }
    rows.push({ path: full, size });
  }
};
walk(home, 0);

console.log(`preview-denylist-audit (denylist v${PREVIEW_DENYLIST_VERSION}) — READ-ONLY local scan`);
console.log(`home: ${home} · scanned files: ${scanned} · depth ≤ ${MAX_DEPTH} (skip: ${[...SKIP_DIRS].join(", ")})`);
console.log("");
if (rows.length === 0) {
  console.log("OK: no readable credential-heuristic file outside the denylist. Nothing to review.");
} else {
  console.log(`REVIEW: ${rows.length} readable credential-heuristic file(s) the denylist does NOT refuse:`);
  for (const r of rows) {
    console.log(`  ${String(r.size).padStart(9)}  ${r.path}`);
  }
  if (rows.length >= MAX_ROWS) console.log(`  … capped at ${MAX_ROWS} rows — rerun with a narrower scope if needed`);
  console.log("");
  console.log("Judge each row: a true credential ⇒ add a rule to admit.ts, bump PREVIEW_DENYLIST_VERSION,");
  console.log("and refresh tests/fixtures/preview-denylist-corpus.json in the same PR (§2.7).");
}
