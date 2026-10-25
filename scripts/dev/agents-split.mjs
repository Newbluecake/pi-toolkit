#!/usr/bin/env node
// P1 (source-governance plan-lowrisk §1.10/§1.11, appendix C): AGENTS.md → per-subsystem READMEs.
//   node scripts/dev/agents-split.mjs build <srcRev>   write the sinking blocks (D01–D66) into docs/dev/**/README.md
//   node scripts/dev/agents-split.mjs check <srcRev>   conservation check against `git show <srcRev>:AGENTS.md`
// Blocks are cut by CHARACTER OFFSET from marker strings (never by line numbers).
// HISTORICAL one-shot (#40 PS2): the D17 target `docs/dev/consult/README.md` was deleted when the consult
// subsystem was removed, so `build`/`check` against a pre-#40 srcRev no longer reproduce the repo; kept as the P1 record.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const [mode, srcRev] = process.argv.slice(2);
if (!["build", "check", "parts"].includes(mode) || !srcRev) {
  console.error("usage: agents-split.mjs build|check <srcRev>");
  process.exit(64);
}
const SRC = execFileSync("git", ["show", `${srcRev}:AGENTS.md`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

const MOVES = [
  ["src/service/cache-keepalive.ts", "src/cache-ttl/keepalive-service.ts"],
  ["src/tools/bash-tool.ts", "src/bash/tool.ts"],
  ["src/tools/bash-job-tool.ts", "src/bash/job-tool.ts"],
  ["src/tools/switch-context-tool.ts", "src/context-switch/tool.ts"],
  ["src/tools/compact-tool.ts", "src/compact-hint/compact-tool.ts"],
  ["src/tools/set-compact-threshold-tool.ts", "src/compact-hint/threshold-tool.ts"],
  ["src/web-hub/agent/command-capture.ts", "src/commands/capture.ts"],
  ["src/rpc/client.ts", "tests/rpc/helpers/rpc-client.ts"],
];

const WH = "docs/dev/web-hub/README.md";
const FAB = "docs/dev/fabric-cross-session/README.md";
const SPAWN = "docs/dev/web-hub-spawn/README.md";
const PREV = "docs/dev/web-hub-preview/README.md";
const PLUG = "docs/dev/plugin-merge/README.md";
const TRAF = "docs/dev/traffic-merge/README.md";
const e = (p) => `\`${p}\``;
// Entries in SOURCE ORDER. kind: h = `## ` heading (line excluded from blocks); a = stays in AGENTS.md; d = sinks.
// marker = unique string in the source; `line:true` markers are line-start items ("\n- `src/x/` —").
const E = [
  { id: "A0", kind: "a", at: 0, sec: "head" },
  { id: "H1", kind: "h", marker: "\n## What this is\n" },
  { id: "A1", kind: "a", sec: "What this is" },
  {
    id: "D01",
    kind: "d",
    marker: "It also absorbs eight formerly-standalone plugins",
    file: PLUG,
    title: "合并插件总览（原 What this is 第 4 段）",
  },
  { id: "H2", kind: "h", marker: "\n## Commands\n" },
  { id: "A2", kind: "a", sec: "Commands" },
  { id: "H3", kind: "h", marker: "\n## Repository layout\n" },
  { id: "A3a", kind: "a", sec: "Repository layout" },
  { id: "A3b", kind: "a", marker: "- `index.js` —", sec: "Repository layout" },
  { id: "A3c", kind: "a", marker: "- `skills/` —", sec: "Repository layout" },
  { id: "A3d", kind: "a", marker: "- `src/index.ts` —", sec: "Repository layout" },
  { id: "A3e", kind: "a", marker: "- `src/stack.ts` —", sec: "Repository layout" },
  { id: "D02", kind: "d", marker: "- `src/core/` —", file: "docs/dev/subagent-core/README.md", title: "src/core/" },
  {
    id: "D03",
    kind: "d",
    marker: "- `src/runtime/` —",
    file: "docs/dev/subagent-core/README.md",
    title: "src/runtime/",
  },
  {
    id: "D04",
    kind: "d",
    marker: "- `src/service/` —",
    file: "docs/dev/subagent-core/README.md",
    title: "src/service/",
  },
  {
    id: "D05",
    kind: "d",
    marker: "- `src/ask-user/` —",
    file: "docs/dev/ask-user-async/README.md",
    title: "src/ask-user/",
  },
  { id: "D06", kind: "d", marker: "- `src/feishu-notify/` —", file: PLUG, title: "src/feishu-notify/" },
  {
    id: "D07",
    kind: "d",
    marker: "- `src/bash/` —",
    file: "docs/dev/bash-timeout-grace/README.md",
    title: "src/bash/",
  },
  {
    id: "D08",
    kind: "d",
    marker: "- `src/compact-hint/` —",
    file: "docs/dev/compact-hint/README.md",
    title: "src/compact-hint/",
  },
  {
    id: "D09",
    kind: "d",
    marker: "- `src/context-switch/` —",
    file: "docs/dev/context-switch/README.md",
    title: "src/context-switch/",
  },
  {
    id: "D10",
    kind: "d",
    marker: "- `src/cache-ttl/` —",
    file: "docs/dev/cache-ttl-keepalive/README.md",
    title: "src/cache-ttl/",
  },
  { id: "A3f", kind: "a", marker: "- `src/child/` —", sec: "Repository layout" },
  { id: "D11", kind: "d", marker: "- `src/fabric/` —", file: FAB, title: "In-tree fabric" },
  { id: "D12", kind: "d", marker: "**Wake phase 1", file: FAB, title: "Wake phase 1" },
  { id: "D13", kind: "d", marker: "**Cross-session phase 2**", file: FAB, title: "Cross-session phase 2" },
  { id: "D14", kind: "d", marker: "**Request-reply", file: FAB, title: "Request-reply" },
  { id: "D15", kind: "d", marker: "**Channels + broadcast", file: FAB, title: "Channels + broadcast + unread inbox" },
  { id: "D16", kind: "d", marker: "**Session aliases", file: FAB, title: "Session aliases" },
  // D17 (src/consult/) — target README removed by #40; see header note.
  { id: "D17", kind: "d", marker: "- `src/consult/` —", file: "docs/dev/consult/README.md", title: "src/consult/" },
  { id: "D18", kind: "d", marker: "- `src/hud/` —", file: PLUG, title: "src/hud/" },
  { id: "D19", kind: "d", marker: "- `src/web-search/` —", file: PLUG, title: "src/web-search/" },
  { id: "D20", kind: "d", marker: "- `src/todo/` —", file: "docs/dev/todo-web/README.md", title: "src/todo/" },
  { id: "D21", kind: "d", marker: "- `src/memory/` —", file: "docs/dev/memory/README.md", title: "src/memory/" },
  {
    id: "D22",
    kind: "d",
    marker: "- `src/sysprompt/` + `src/prompt-sections/` —",
    file: "docs/dev/sysprompt-stable/README.md",
    title: "src/sysprompt/ + src/prompt-sections/",
  },
  {
    id: "D23",
    kind: "d",
    marker: "- `src/session-nav/` —",
    file: "docs/dev/web-resume/README.md",
    title: "src/session-nav/",
  },
  { id: "D24", kind: "d", marker: "- `src/web-hub/` —", file: WH, title: "概述与 P2 control-plane" },
  { id: "D25", kind: "d", marker: "**Web resume", file: WH, title: "Web resume (resume.v1)" },
  {
    id: "D26",
    kind: "d",
    marker: "**Feishu bot (",
    file: "docs/dev/feishu-bot/README.md",
    title: "开发者要点：Feishu bot",
  },
  {
    id: "D27",
    kind: "d",
    marker: "**Cross-session mirror (",
    file: "docs/dev/feishu-bot/README.md",
    title: "开发者要点：Cross-session mirror",
  },
  { id: "D28", kind: "d", marker: "**UI serving", file: WH, title: "UI serving 与 LAN access" },
  { id: "D29", kind: "d", marker: "**LAN security (", file: WH, title: "LAN security" },
  { id: "D30", kind: "d", marker: "**Managed spawn (", file: SPAWN, title: "Managed spawn" },
  { id: "D31", kind: "d", marker: "**Created dirs (", file: SPAWN, title: "Created dirs" },
  { id: "D32", kind: "d", marker: "**Restore across hub restarts", file: SPAWN, title: "Restore across hub restarts" },
  { id: "D33", kind: "d", marker: "**Relaunch an offline", file: SPAWN, title: "Relaunch" },
  { id: "D34", kind: "d", marker: "**Delete session (", file: SPAWN, title: "Delete session" },
  { id: "D35", kind: "d", marker: "**Worktree panel (", file: WH, title: "Worktree panel" },
  { id: "D36", kind: "d", marker: "**Bash-jobs panel (", file: WH, title: "Bash-jobs panel" },
  { id: "D37", kind: "d", marker: "**Fleet drawer archive (", file: WH, title: "Fleet drawer archive" },
  { id: "D38", kind: "d", marker: "**Cache keepalive panel (", file: WH, title: "Cache keepalive panel" },
  { id: "D39", kind: "d", marker: "**Content preview (", file: PREV, title: "Content preview" },
  { id: "D40", kind: "d", marker: "**Preview multi-windows**", file: PREV, title: "Preview multi-windows" },
  { id: "D41", kind: "d", marker: "**Chunked text preview**", file: PREV, title: "Chunked text preview" },
  { id: "D42", kind: "d", marker: "**Large-source virtualization**", file: PREV, title: "Large-source virtualization" },
  { id: "D43", kind: "d", marker: "**HTML preview (rendered)**", file: PREV, title: "HTML preview" },
  {
    id: "D44",
    kind: "d",
    marker: "**Worktree diff (",
    file: "docs/dev/worktree-diff/README.md",
    title: "Worktree diff",
  },
  {
    id: "D45",
    kind: "d",
    marker: "**Worktree graph**",
    file: "docs/dev/worktree-diff/README.md",
    title: "Worktree graph",
  },
  {
    id: "D46",
    kind: "d",
    marker: "**Local-service proxy (",
    file: "docs/dev/web-hub-proxy/README.md",
    title: "Local-service proxy",
  },
  {
    id: "D47",
    kind: "d",
    marker: "**In-page link preview (",
    file: "docs/dev/web-hub-proxy/README.md",
    title: "In-page link preview",
  },
  { id: "D48", kind: "d", marker: "**Avatar (", file: WH, title: "Avatar" },
  { id: "D49", kind: "d", marker: "**Privacy lock (", file: WH, title: "Privacy lock" },
  { id: "D50", kind: "d", marker: "**Channels in the web UI (", file: FAB, title: "Web UI：Channels" },
  { id: "D51", kind: "d", marker: "**Aliases in the web UI (", file: FAB, title: "Web UI：Aliases" },
  { id: "D52", kind: "d", marker: "**Session switching (", file: WH, title: "Session switching" },
  { id: "D53", kind: "d", marker: "**Session history (", file: SPAWN, title: "Session history" },
  { id: "D54", kind: "d", marker: "**`prompt-gate.ts`**", file: WH, title: "prompt-gate.ts" },
  { id: "D55", kind: "d", marker: "- **Slash-arg completion**", file: WH, title: "Slash-arg completion" },
  { id: "D56", kind: "d", marker: "- **Command history**", file: WH, title: "Command history" },
  {
    id: "D57",
    kind: "d",
    marker: "- `src/topic-switch/` —",
    file: "docs/dev/topic-switch/README.md",
    title: "src/topic-switch/",
  },
  { id: "A3g", kind: "a", marker: "- `src/git/` —", sec: "Repository layout" },
  { id: "A3h", kind: "a", marker: "- `src/config/` —", sec: "Repository layout" },
  {
    id: "D58",
    kind: "d",
    marker: "- `src/external-agent/` —",
    file: "docs/dev/external-agent/README.md",
    title: "开发者要点（自 AGENTS.md 下沉）",
  },
  { id: "D59", kind: "d", marker: "- `src/quota/` —", file: "docs/dev/quota/README.md", title: "src/quota/" },
  { id: "D60", kind: "d", marker: "- `src/sysload/` —", file: "docs/dev/sysload/README.md", title: "src/sysload/" },
  {
    id: "D61",
    kind: "d",
    marker: "- `src/secure/` —",
    file: "docs/dev/data-encryption/README.md",
    title: "src/secure/",
  },
  { id: "D62", kind: "d", marker: "- `src/traffic/` —", file: TRAF, title: "src/traffic/" },
  {
    id: "D63",
    kind: "d",
    marker: "- `src/schedule/` —",
    file: "docs/dev/scheduled-reports/README.md",
    title: "src/schedule/",
  },
  { id: "A3i", kind: "a", marker: "- `src/reload/` —", sec: "Repository layout" },
  { id: "A3j", kind: "a", marker: "- `src/goal/` —", sec: "Repository layout" },
  { id: "A3k", kind: "a", marker: "- `src/delivery/` —", sec: "Repository layout" },
  { id: "D64", kind: "d", marker: "- `src/workflow/` —", file: "docs/dev/workflow/README.md", title: "src/workflow/" },
  { id: "A3l", kind: "a", marker: "- `src/adapters/` —", sec: "Repository layout" },
  { id: "A3m", kind: "a", marker: "- `src/tools/`, `src/commands/`", sec: "Repository layout" },
  { id: "A3n", kind: "a", marker: "- `tests/` —", sec: "Repository layout" },
  { id: "A3o", kind: "a", marker: "- `docs/dev/` —", sec: "Repository layout" },
  { id: "A3p", kind: "a", marker: "- `scripts/release/package.sh` —", sec: "Repository layout" },
  { id: "H4", kind: "h", marker: "\n## Conventions\n" },
  { id: "A4", kind: "a", sec: "Conventions" },
  {
    id: "D65",
    kind: "d",
    marker: "**Also run `tests/conformance/traffic.test.ts`",
    file: TRAF,
    title: "Peer-bump conformance premises (traffic)",
  },
  {
    id: "D66",
    kind: "d",
    marker: "**Also run `tests/conformance/cmd-history.test.ts`**",
    file: WH,
    title: "Peer-bump conformance premises (cmd-history)",
  },
  { id: "H5", kind: "h", marker: "\n## pi-extension specifics (easy to get wrong)\n" },
  { id: "A5", kind: "a", sec: "pi-extension specifics" },
  { id: "H6", kind: "h", marker: "\n## Testing expectations\n" },
  { id: "A6", kind: "a", sec: "Testing expectations" },
  { id: "H7", kind: "h", marker: "\n## Releasing\n" },
  { id: "A7", kind: "a", sec: "Releasing" },
];
// ---- locate (offsets)
function once(m) {
  const i = SRC.indexOf(m);
  if (i < 0) throw new Error(`marker missing: ${m}`);
  if (SRC.indexOf(m, i + 1) >= 0) throw new Error(`marker not unique: ${m}`);
  return i;
}
for (const x of E) {
  if (x.kind === "h") {
    const i = once(x.marker) + 1; // skip the leading \n (it belongs to the previous block)
    x.hs = i;
    x.he = i + x.marker.length - 1;
  } else if (x.marker) x.start = once(x.marker) + (x.marker.startsWith("\n") ? 1 : 0);
}
// a/d blocks without marker start where the previous heading ends; A0 at 0
for (let i = 0; i < E.length; i++) {
  const x = E[i];
  if (x.kind !== "h" && x.start === undefined) x.start = x.at ?? E[i - 1].he;
}
// end offsets: next entry start (heading entries: heading start) / EOF
const blocks = [];
for (let i = 0; i < E.length; i++) {
  const x = E[i];
  if (x.kind === "h") continue;
  const nx = E[i + 1];
  const end = nx ? (nx.kind === "h" ? nx.hs : nx.start) : SRC.length;
  blocks.push({ ...x, end, text: SRC.slice(x.start, end) });
}
// ---- coverage
function coverage() {
  const spans = [
    ...blocks.map((b) => [b.start, b.end, b.id]),
    ...E.filter((x) => x.kind === "h").map((h) => [h.hs, h.he, h.id]),
  ];
  spans.sort((a, b) => a[0] - b[0]);
  let pos = 0,
    overlaps = 0,
    gaps = 0;
  for (const [s, en, id] of spans) {
    if (s < pos) {
      overlaps++;
      console.log(`OVERLAP ${id} ${s}<${pos}`);
    } else if (s > pos) {
      gaps++;
      console.log(`GAP ${pos}..${s} before ${id}`);
    }
    pos = Math.max(pos, en);
  }
  if (pos < SRC.length) {
    gaps++;
    console.log(`GAP tail ${pos}..${SRC.length}`);
  }
  return { overlaps, gaps, spans: spans.length };
}
// ---- normalisation
const mechanical = (b) => {
  let t = b.text.replace(/^\s+/, ""),
    n = 0;
  if (t.startsWith("- ")) t = t.slice(2);
  for (const [o, nw] of MOVES) {
    const parts = t.split(o);
    n += parts.length - 1;
    t = parts.join(nw);
  }
  return { t, n };
};
const mechanicalKeep = (b) => {
  let t = b.text.replace(/^\n+/, "").replace(/\n+$/, "");
  for (const [o, nw] of MOVES) t = t.split(o).join(nw);
  return t;
};
const ws = (s) => s.replace(/\s+/g, " ").trim();
const dedent = (t) => t.replace(/^ {1,2}/gm, "");

if (mode === "parts") {
  // JSON {id: text-with-moved-paths} of the blocks that stay in AGENTS.md (helper for hand-assembling the new file)
  const out = {};
  for (const b of blocks)
    if (b.kind === "a") out[b.id] = b.text.replace(/^\s+/, "").split("\n").length ? mechanicalKeep(b) : "";
  console.log(JSON.stringify(out));
  process.exit(0);
}
if (mode === "build") {
  const byFile = new Map();
  for (const b of blocks)
    if (b.kind === "d") {
      const { t } = mechanical(b);
      if (!byFile.has(b.file)) byFile.set(b.file, []);
      byFile.get(b.file).push(`## ${b.title}\n\n${dedent(t).trim()}\n`);
    }
  for (const [file, secs] of byFile) {
    const abs = join(ROOT, file);
    mkdirSync(dirname(abs), { recursive: true });
    const body = secs.join("\n");
    if (existsSync(abs)) {
      // append mode (feishu-bot, external-agent): keep the user-facing README, add a pointer + the dev section
      let cur = readFileSync(abs, "utf8");
      if (!cur.includes("## 开发者要点")) writeFileSync(abs, cur.replace(/\n+$/, "\n") + "\n" + body);
    } else writeFileSync(abs, `@@HEADER@@\n\n${body}`);
    console.log("wrote", file, secs.length);
  }
  process.exit(0);
}

// ---- check
let fail = 0;
const cov = coverage();
console.log(
  `coverage: ${blocks.length} blocks + ${E.filter((x) => x.kind === "h").length} headings, overlaps=${cov.overlaps}, gaps=${cov.gaps}`,
);
fail += cov.overlaps + cov.gaps;
const newAgents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const sectionOf = (text, title, level = 2) => {
  const lines = text.split("\n");
  const re = new RegExp(`^#{1,${level}} `);
  const i = lines.findIndex((l) => l === `${"#".repeat(level)} ${title}`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !(re.test(lines[j]) && !lines[j].startsWith("#".repeat(level + 1)))) j++;
  return lines.slice(i + 1, j).join("\n");
};
const agentsSec = (name) => {
  if (name === "head") return newAgents.slice(0, newAgents.indexOf("\n## What this is"));
  const s = sectionOf(newAgents, name);
  if (s === null) {
    const l = newAgents.split("\n").find((x) => x.startsWith(`## ${name}`));
    return l ? sectionOf(newAgents, l.slice(3)) : null;
  }
  return s;
};
let totalRepl = 0;
const missing = [],
  exc = [];
for (const b of blocks) {
  const { t, n } = mechanical(b);
  totalRepl += n;
  let target;
  if (b.kind === "a") target = agentsSec(b.sec);
  else {
    const f = join(ROOT, b.file);
    target = existsSync(f) ? sectionOf(readFileSync(f, "utf8"), b.title) : null;
  }
  const hay = target === null ? null : ws(target);
  const needle = ws(t);
  if (hay === null || !hay.includes(needle)) {
    // locate first divergence for the report (E2 hunting)
    let d = -1;
    if (hay !== null) {
      d = 0;
      while (d < needle.length && hay.includes(needle.slice(0, d + 1))) d++;
    }
    missing.push(b.id);
    console.log(
      `MISSING ${b.id} (${b.kind === "a" ? "AGENTS.md#" + b.sec : b.file + "#" + b.title})${hay === null ? " target section absent" : ` diverges at char ${d}: «${needle.slice(Math.max(0, d - 40), d + 40)}»`}`,
    );
  } else if (n) exc.push(`${b.id}:${n}`);
}
fail += missing.length;
console.log(`blocks checked: ${blocks.length}, missing: ${missing.length}`);
console.log(`E1 path replacements (block:count): ${exc.join(" ") || "none"} (total ${totalRepl})`);
console.log(fail ? "CHECK FAILED" : "CHECK OK: 0 missing / 0 overlap / full coverage");
process.exit(fail ? 1 : 0);
