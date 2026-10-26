// Byte-level assertion for the one-off A-tier golden rename (plan §6.3 + r3 R2-B2).
// Usage: BASE=HEAD node docs/dev/result-tool-rename/golden-assert.mjs   (after commit: BASE=HEAD~1)
import fs from "node:fs";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "HEAD";
const OLD = "get_subagent_result";
const NEW = "get_run_result";
const git = (...a) => execFileSync("git", a); // Buffer, never through JSON
const count = (s, sub) => s.split(sub).length - 1;

function original(path, oldCount) {
  const buf = git("show", `${BASE}:${path}`);
  const str = buf.toString("utf8");
  assert.ok(Buffer.from(str, "utf8").equals(buf), `${path}: utf8 round-trip`);
  assert.equal(count(str, OLD), oldCount, `${path}: old-name count`);
  assert.equal(count(str, NEW), 0, `${path}: new name pre-existing`);
  return str;
}
function compare(path, expected) {
  const actual = fs.readFileSync(path);
  assert.ok(actual.equals(Buffer.from(expected, "utf8")), `${path}: bytes differ from the allowed transform`);
}

// fabric-xs-off: replace by OCCURRENCE POSITION. The reservedToolNames legacy entry stays in place
// (its position is frozen); mainSessionTools[..] is renamed; the new name is appended at the END of
// reservedToolNames (unique anchor).
{
  const path = "tests/fixtures/fabric-xs-off-golden.json";
  const str = original(path, 2);
  const k = str.indexOf('"reservedToolNames": [');
  assert.ok(k > 0 && count(str, '"reservedToolNames": [') === 1, "reservedToolNames anchor");
  const head = str.slice(0, k).split(OLD).join(NEW); // exactly the mainSessionTools occurrence
  const anchor = `    "switch_context"\n  ],\n  "messageAgentSchema"`;
  let tail = str.slice(k);
  assert.equal(count(tail, anchor), 1, "tail anchor unique");
  tail = tail.replace(anchor, () => `    "switch_context",\n    "${NEW}"\n  ],\n  "messageAgentSchema"`);
  const expected = head + tail;
  // self-check the expectation BEFORE comparing: reserved list has OLD once (index 1, original place) and NEW once (last)
  const exp = JSON.parse(expected);
  const reserved = exp.reservedToolNames;
  assert.equal(reserved.filter((n) => n === OLD).length, 1, "reserved: legacy once");
  assert.equal(reserved.filter((n) => n === NEW).length, 1, "reserved: new once");
  assert.equal(reserved.indexOf(OLD), 1, "reserved: legacy stays at index 1");
  assert.equal(reserved.at(-1), NEW, "reserved: new appended last");
  assert.ok(!exp.mainSessionTools.includes(OLD) && exp.mainSessionTools.includes(NEW), "mainSessionTools renamed");
  assert.equal(count(expected, OLD), 1, "expected: exactly one legacy occurrence overall");
  compare(path, expected);
}
// schedule-off / nested-surface: every occurrence renamed, exact counts
for (const [path, n] of [
  ["tests/fixtures/schedule-off-golden.json", 4],
  ["tests/fixtures/tools/agent-nested-surface-golden.json", 2],
]) {
  compare(path, original(path, n).split(OLD).join(NEW));
}
// exactly these 3 fixtures changed, nothing untracked under fixtures
const changed = git("diff", "--name-only", BASE, "--", "tests/fixtures").toString().split("\n").filter(Boolean).sort();
assert.deepStrictEqual(changed, [
  "tests/fixtures/fabric-xs-off-golden.json",
  "tests/fixtures/schedule-off-golden.json",
  "tests/fixtures/tools/agent-nested-surface-golden.json",
]);
assert.equal(git("ls-files", "--others", "--exclude-standard", "--", "tests/fixtures").toString().trim(), "");
console.log("golden rename diff OK (byte-exact)");
