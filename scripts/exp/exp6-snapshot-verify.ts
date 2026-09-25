#!/usr/bin/env node
/**
 * Experiment 6 — E-code snapshot fidelity check (README §7 amendment).
 * Exports `git archive <commit>` of the expert's repo into /tmp/exp6-snap-<tag>
 * and checks that EVERY `read` result inside the expert session matches the
 * snapshot file line-for-line (so a re-read in the fork sees exactly what the
 * expert saw).
 *
 *   npx tsx scripts/exp/exp6-snapshot-verify.ts <session.jsonl> <repoRoot> <commit> <tag>
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadContext } from "./exp6-lib.js";

const [file, repo, commit, tag] = process.argv.slice(2);
if (!file || !repo || !commit || !tag) throw new Error("usage: <session> <repo> <commit> <tag>");
const snap = `/tmp/exp6-snap-${tag}`;
if (!existsSync(join(snap, ".exp6-commit")) || readFileSync(join(snap, ".exp6-commit"), "utf8").trim() !== commit) {
  rmSync(snap, { recursive: true, force: true });
  mkdirSync(snap, { recursive: true });
  execSync(`git -C ${JSON.stringify(repo)} archive ${commit} | tar -x -C ${JSON.stringify(snap)}`);
  execSync(`echo ${commit} > ${JSON.stringify(join(snap, ".exp6-commit"))}`);
}
const { messages } = loadContext(file);
const calls = new Map<string, any>();
for (const m of messages)
  if (m.role === "assistant") for (const b of m.content ?? []) if (b.type === "toolCall") calls.set(b.id, b);
let ok = 0;
const bad: string[] = [];
for (const m of messages) {
  if (m.role !== "toolResult") continue;
  const c = calls.get(m.toolCallId);
  if (c?.name !== "read") continue;
  const p0: string = c.arguments?.path ?? "";
  const p = p0.startsWith("/") ? p0 : join(repo, p0); // relative reads resolve against the session cwd (= repo root here)
  if (!p.startsWith(repo + "/")) continue;
  const rel = p.slice(repo.length + 1);
  const snapFile = join(snap, rel);
  const text: string = (m.content ?? []).map((b: any) => b.text ?? "").join("");
  if (m.isError) {
    bad.push(`${rel}: error result in session`);
    continue;
  }
  if (!existsSync(snapFile)) {
    bad.push(`${rel}: missing in snapshot`);
    continue;
  }
  const fileLines = readFileSync(snapFile, "utf8").split("\n");
  const offset = Math.max(1, Number(c.arguments?.offset ?? 1));
  // pi appends a trailing notice ("\n\n[... use offset=...]") on truncation — compare only content lines
  const body = text.replace(/\n\n\[[^\n]*\]\s*$/, "");
  const resLines = body.split("\n");
  let mismatch = -1;
  for (let i = 0; i < resLines.length; i++) {
    const want = fileLines[offset - 1 + i];
    if (want === undefined && resLines[i] === "") continue;
    if (resLines[i] !== want) {
      mismatch = i;
      break;
    }
  }
  if (mismatch >= 0)
    bad.push(
      `${rel}@${offset}: line ${offset + mismatch} differs: ${JSON.stringify(resLines[mismatch]?.slice(0, 80))} vs ${JSON.stringify(fileLines[offset - 1 + mismatch]?.slice(0, 80))}`,
    );
  else ok++;
}
console.log(JSON.stringify({ file, commit, snap, readsMatched: ok, mismatches: bad }, null, 2));
