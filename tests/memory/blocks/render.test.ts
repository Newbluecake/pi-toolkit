// #36 P3 (arch r5 §3.3.3) — the blocks render contract + the g1–g10
// blocks-golden (B tier, generate-once: PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1
// writes each file only when it does NOT exist yet; an existing file is
// NEVER overwritten — a mismatch is a behaviour change to be reported).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import {
  INDEX_MAX_BYTES,
  parseResidentSection,
  renderBlocks,
  renderResidentSection,
  residentBlocksOf,
  residentEntryText,
  residentLines,
  residentMeteredBytes,
  residentRenderKey,
} from "../../../src/memory/blocks/render.js";
import type { BlockSpec } from "./helpers.js";
import { writeBlocksDir } from "./helpers.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import type { EntryTags, JevIndexV1 } from "../../../src/memory/jev/contracts.js";

const TODAY = "2026-11-06";
const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureDir(specs: readonly BlockSpec[], extra?: { strays?: readonly string[] }): string {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-blocks-render-"));
  tmpRoots.push(tmp);
  const memDir = join(tmp, "mem");
  writeBlocksDir(memDir, specs, extra);
  return memDir;
}

function tagsFor(body: string, tags: readonly [string, number][]): [string, EntryTags] {
  const record: Record<string, { p: number; rev: number }> = {};
  for (const [tag, p] of tags) record[tag] = { p, rev: 1 };
  return [
    entryHash(body),
    {
      file: "quota.md",
      type: "rule",
      typeP: 0.9,
      importance: 2,
      tags: record,
      guard: 1,
      temporal: "permanent",
      userLike: 0,
      model: "opencode/jev-1.13",
      at: "2026-11-01T00:00:00.000Z",
      taxonomyRev: "r1",
    },
  ];
}

function indexFor(bodies: readonly [string, readonly [string, number]][]): JevIndexV1 {
  return { v: 1, entries: Object.fromEntries(bodies.map(([body, tags]) => tagsFor(body, tags))) };
}

// ── a normal 3-global / 17-topic corpus shared by the golden cases ──

function normalCorpus(): { specs: BlockSpec[]; jevIndex: JevIndexV1 } {
  const specs: BlockSpec[] = [
    {
      id: "general.001",
      authority: "user",
      scope: "global",
      updated: "2026-11-02T00:00:00.000Z",
      body: "- 该用户拍板的事（方案、范围取舍）主动用 ask_user 提出，不等用户提醒（2026-11-02 用户令）。",
    },
    {
      id: "general.002",
      authority: "user",
      scope: "global",
      updated: "2026-11-05T00:00:00.000Z",
      body: "- 验收选 deepseek 系时优先 deepseek/deepseek-flash，不默认 v4-pro（2026-11-05 用户令）。",
    },
    {
      id: "general.003",
      authority: "user",
      scope: "global",
      updated: "2026-11-01T00:00:00.000Z",
      body: "- 主会话只负责调度，不亲自执行具体任务（2026-11-03 用户令）。",
    },
    { id: "general.010", authority: "user", scope: "topic", body: "- 决策记录：发版默认 patch（2026-11-05）。" },
    { id: "general.011", authority: "user", scope: "topic", body: "- 决策记录：验收用异源 verifier（2026-11-05）。" },
  ];
  const tagBodies: [string, readonly [string, number]][] = [];
  const topics = [
    "quota",
    "pitfalls-git",
    "pitfalls-runtime",
    "pitfalls-subagent",
    "cache-ttl",
    "fabric-xs",
    "webhub-restore",
    "webhub-ui",
    "schedule",
    "topic-switch",
    "memory-predict",
    "live-acceptance",
    "multi-agent",
    "ui-preview",
    "concurrency",
    "git-parallel",
    "landed-notes",
  ];
  let seq = 0;
  for (const topic of topics) {
    const body = `- ${topic} note ${String(seq).padStart(2, "0")} — keep the invariant intact when editing.`;
    specs.push({ id: `${topic}.001`, body });
    tagBodies.push([
      body,
      [
        ["git-commit", 0.8],
        [topic.slice(0, 12), 0.7],
      ] as readonly [string, number][],
    ]);
    seq += 1;
  }
  return { specs, jevIndex: indexFor(tagBodies) };
}

describe("resident line format + parseResidentSection round-trip", () => {
  test("rendered ids parse back exactly; multi-line and `- `-prefixed bodies survive", () => {
    const memDir = fixtureDir([
      { id: "general.001", authority: "user", scope: "global", body: "- always run the gate\nsecond line\nthird line" },
      { id: "general.002", authority: "user", scope: "global", body: "- plain body" },
      { id: "quota.001", body: "- agent note stays out" },
    ]);
    const corpus = readCorpus(join(memDir, "blocks"));
    const result = renderBlocks(corpus, { slug: "proj", isChild: false, residentBytes: 2048, today: TODAY });
    const ids = [...parseResidentSection(result.text).keys()];
    expect(ids).toEqual(["general.001", "general.002"]);
    // multi-line body: first line rides the `- [id] ` prefix, rest indented 2
    expect(result.text).toContain("- [general.001] always run the gate\n  second line\n  third line");
    expect(result.text).toContain("- [general.002] plain body");
    // agent blocks never render in the resident section
    expect(result.text).not.toContain("[quota.001]");
  });

  test("renderKey covers the expiry note — note change flips the key", () => {
    const body = "- ask before release";
    const fresh = { id: "general.001", authority: "user" as const, scope: "global" as const, body };
    const memDir = fixtureDir([{ ...fresh, expires: "2026-11-05" }]);
    const corpus = readCorpus(join(memDir, "blocks"));
    const result = renderBlocks(corpus, { slug: "proj", isChild: false, residentBytes: 2048, today: TODAY });
    expect(result.text).toContain("- [general.001] ask before release（已到期，待用户确认）");
    const keyWithNote = residentRenderKey(corpus.blocks[0]!, TODAY);
    const keyWithoutNote = residentRenderKey(
      { ...corpus.blocks[0]!, meta: { ...corpus.blocks[0]!.meta, expires: undefined } },
      TODAY,
    );
    expect(keyWithNote).not.toBe(keyWithoutNote);
    // residentEntryText strips the prefix/indent for R notices
    expect(residentEntryText(corpus.blocks[0]!, TODAY)).toBe("ask before release（已到期，待用户确认）");
  });

  test("parseResidentSection isolates the section (index/body noise ignored)", () => {
    const text = [
      "## Memory (proj) — 1 topic(s) · 2 block(s)",
      "",
      "### User rules (always on)",
      "- [general.001] first",
      "  continued",
      "- resident: 2.6k/2.0k over budget — consolidate (/mem review)",
      "",
      "Topics (relevant blocks are injected automatically; read one with memory view <topic>):",
      "- quota — tags: a · 1 blocks",
    ].join("\n");
    const parsed = parseResidentSection(text);
    expect([...parsed.keys()]).toEqual(["general.001"]);
    // a stray `- [` inside body continuation lines still splits correctly
    const multi = "### User rules (always on)\n- [a.001] x\n- [a.002] y";
    expect([...parseResidentSection(multi).keys()]).toEqual(["a.001", "a.002"]);
  });

  test("renderResidentSection omits everything for an empty set; marker line only when over budget", () => {
    expect(renderResidentSection([], { today: TODAY, residentBytes: 100, mainSessionBytes: 0 }).text).toBe("");
    const b = {
      meta: {
        kind: "block",
        authority: "user",
        scope: "global",
        status: "active",
        created: "",
        updated: "",
        version: 1,
      },
      body: "x",
    } as never;
    const over = renderResidentSection([b], { today: TODAY, residentBytes: 4, mainSessionBytes: 100 });
    expect(over.overBudget).toBe(true);
    expect(over.text).toContain("- resident: 0.1k/0.0k over budget — consolidate (/mem review)");
    const within = renderResidentSection([b], { today: TODAY, residentBytes: 4096, mainSessionBytes: 100 });
    expect(within.overBudget).toBe(false);
    expect(within.text).not.toContain("over budget");
  });
});

describe("index rendering", () => {
  test("sections fallback when no tags; counts-only when neither (g5/g6 shapes)", () => {
    const memDir = fixtureDir([
      { id: "quota.001", section: "Dispatch", body: "- quota note one" },
      { id: "quota.002", section: "Dispatch", body: "- quota note two" },
      { id: "plain.001", body: "- no section no tags" },
    ]);
    const result = renderBlocks(readCorpus(join(memDir, "blocks")), {
      slug: "proj",
      isChild: false,
      residentBytes: 2048,
      today: TODAY,
    });
    expect(result.text).toContain("- quota — sections: Dispatch · 2 blocks");
    expect(result.text).toContain("- plain · 1 blocks");
    expect(result.text).not.toContain("tags:");
  });

  test("decisions and expired counts appear; archived-only topics collapse into +M archived", () => {
    const memDir = fixtureDir([
      { id: "general.001", authority: "user", scope: "topic", body: "- decision one" },
      { id: "general.002", authority: "user", scope: "topic", body: "- decision two" },
      { id: "quota.001", authority: "agent", expires: "2026-11-01", body: "- stale route" },
    ]);
    mkdirSync(join(memDir, "blocks", "archive"), { recursive: true });
    writeFileSync(
      join(memDir, "blocks", "archive", "gone.001.md"),
      '---\nkind: block\nstatus: archived\ncreated: ""\nupdated: ""\nversion: 1\n---\n\narchived body\n',
    );
    const result = renderBlocks(readCorpus(join(memDir, "blocks")), {
      slug: "proj",
      isChild: false,
      residentBytes: 2048,
      today: TODAY,
    });
    expect(result.text).toContain("- general · 2 blocks · 2 decisions");
    expect(result.text).toContain("- quota · 1 blocks · 1 expired");
    expect(result.text).toContain("(+1 archived)");
    expect(result.text).not.toContain("\n- gone ");
    expect(result.budgetStats.index.over).toBe(false);
    expect(result.budgetStats.index.omittedCount).toBe(0);
    // archived-only topics are a suffix detail, not whole-topic row overflow
    // (the signal is based exclusively on the `kept < ordered.length` gate).
    // archived topic not listed by name
  });

  test("index overflow degrades to the compact `- also:` tail (g7 shape)", () => {
    const specs: BlockSpec[] = [];
    for (let i = 0; i < 90; i++)
      specs.push({ id: `topic-${String(i).padStart(2, "0")}.001`, body: `- topic ${i} body` });
    const memDir = fixtureDir(specs);
    const result = renderBlocks(readCorpus(join(memDir, "blocks")), {
      slug: "proj",
      isChild: false,
      residentBytes: 2048,
      today: TODAY,
    });
    expect(Buffer.byteLength(result.text, "utf8")).toBeGreaterThan(INDEX_MAX_BYTES); // the WHOLE text is bigger…
    const indexPart = result.text.slice(result.text.indexOf("Topics ("));
    expect(Buffer.byteLength(indexPart, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES + 512);
    expect(result.budgetStats.index.over).toBe(true);
    expect(result.budgetStats.index.omittedCount).toBeGreaterThan(0);
    expect(result.budgetStats.index.limitBytes).toBe(INDEX_MAX_BYTES);
    // degradation is the buildTail rule: whole-name `- also:` when names fit,
    // the plain overflow line otherwise — both are the compact shape.
    expect(indexPart).toMatch(/^- also: .*\(\+\d+ more\)|^- … \+\d+ more/m);
  });
});

// ───────────────────────────── blocks-golden (g1–g10, generate-once) ─────────────────────────────

const GOLDEN_DIR = join(import.meta.dirname, "..", "..", "fixtures", "memory", "blocks-golden");
const UPDATE = process.env.PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN === "1";

interface GoldenCase {
  name: string;
  build: () => { text: string; note?: string };
}

const goldenCases: readonly GoldenCase[] = [
  {
    name: "g1-normal.txt",
    build: () => {
      const { specs, jevIndex } = normalCorpus();
      const memDir = fixtureDir(specs);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
          jevIndex,
        }).text,
      };
    },
  },
  {
    name: "g2-resident-over-budget.txt",
    build: () => {
      const specs: BlockSpec[] = [];
      for (let i = 1; i <= 9; i++)
        specs.push({
          id: `general.00${i}`,
          authority: "user",
          scope: "global",
          updated: `2026-11-0${i}T00:00:00.000Z`,
          body: `- 常设规则 ${i}：每轮都必须遵守的长规则，正文长度接近典型值（约一百字节）以满足预算测试需要。`,
        });
      const memDir = fixtureDir(specs);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 512,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g3-expiry.txt",
    build: () => {
      const memDir = fixtureDir([
        {
          id: "general.001",
          authority: "user",
          scope: "global",
          expires: "2026-11-05",
          body: "- 验收优先 deepseek-flash（2026-11-05 用户令）。",
        },
        { id: "general.002", authority: "user", scope: "global", body: "- 主会话只调度（2026-11-03 用户令）。" },
        {
          id: "quota.001",
          authority: "agent",
          expires: "2026-11-05",
          body: "- 到期 agent 条目：不再注入，计入 expired。",
        },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g4-child-audience.txt",
    build: () => {
      const memDir = fixtureDir([
        { id: "general.001", authority: "user", scope: "global", body: "- 全局规则：对所有会话生效。" },
        {
          id: "general.002",
          authority: "user",
          scope: "global",
          audience: "main",
          body: "- 主会话专属规则：子会话不可见。",
        },
        { id: "quota.001", body: "- quota note" },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: true,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g5-sections-summary.txt",
    build: () => {
      const memDir = fixtureDir([
        { id: "quota.001", section: "Dispatch", body: "- quota dispatch rule" },
        { id: "quota.002", section: "Dispatch", body: "- quota dispatch second" },
        { id: "quota.003", section: "Fallback", body: "- quota fallback rule" },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g6-counts-only.txt",
    build: () => {
      const memDir = fixtureDir([
        { id: "alpha.001", body: "- alpha plain" },
        { id: "beta.001", body: "- beta plain" },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g7-compact-overflow.txt",
    build: () => {
      const specs: BlockSpec[] = [];
      for (let i = 0; i < 90; i++)
        specs.push({
          id: `topic-${String(i).padStart(2, "0")}.001`,
          body: `- topic ${i} has a body of a normal length`,
        });
      const memDir = fixtureDir(specs);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g8-no-globals.txt",
    build: () => {
      const memDir = fixtureDir([
        { id: "quota.001", body: "- quota note" },
        { id: "general.001", authority: "user", scope: "topic", body: "- decision: use flash" },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
  {
    name: "g9-child-none.txt",
    // childProfile:"none" is the provider-level gate (memorySection returns ""
    // before any render): the golden pins that contract as the empty output.
    build: () => ({ text: "" }),
  },
  {
    name: "g10-superseded.txt",
    build: () => {
      const memDir = fixtureDir([
        { id: "general.001", authority: "user", scope: "global", body: "- 现行规则：验收优先 deepseek-flash。" },
        {
          id: "general.002",
          authority: "user",
          scope: "global",
          supersededBy: "general.001",
          status: "superseded",
          body: "- 旧规则：验收走 v4-pro。",
        },
      ]);
      return {
        text: renderBlocks(readCorpus(join(memDir, "blocks")), {
          slug: "proj",
          isChild: false,
          residentBytes: 2048,
          today: TODAY,
        }).text,
      };
    },
  },
];

describe("blocks-golden (g1–g10, generate-once)", () => {
  for (const testCase of goldenCases) {
    test(testCase.name, () => {
      const path = join(GOLDEN_DIR, testCase.name);
      const { text } = testCase.build();
      if (UPDATE) {
        if (existsSync(path))
          throw new Error(
            `PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1 but ${path} already exists — generate-once, never overwrite`,
          );
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, text, "utf8");
        return;
      }
      if (!existsSync(path)) throw new Error(`${path} missing — run once with PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1`);
      expect(text).toBe(readFileSync(path, "utf8"));
    });
  }
});

describe("index visibility (acceptance fix #2)", () => {
  test("main-only and private blocks never leak tags/sections into child or external renders", () => {
    const mainOnlyBody = "- main-only block body with a unique marker MAINONLYTAGSRC";
    const privateBody = "- private block body with a unique marker PRIVATETAGSRC";
    const memDir = fixtureDir([
      { id: "quota.001", body: "- shared visible block" },
      { id: "secret.001", section: "SecretSection", audience: "main", body: mainOnlyBody },
      { id: "hidden.001", section: "PrivateSection", private: true, body: privateBody },
    ]);
    const jevIndex = indexFor([
      [mainOnlyBody, [["mainonly-tag", 0.9]]],
      [privateBody, [["private-tag", 0.9]]],
      ["- shared visible block", [["shared-tag", 0.9]]],
    ]);
    for (const isChild of [true, false]) {
      // child render: the main-only AND the private block are invisible
      const child = renderBlocks(readCorpus(join(memDir, "blocks")), {
        slug: "proj",
        isChild: true,
        residentBytes: 2048,
        today: TODAY,
        jevIndex,
      });
      expect(child.text).not.toContain("mainonly-tag");
      expect(child.text).not.toContain("private-tag");
      expect(child.text).not.toContain("SecretSection");
      expect(child.text).not.toContain("PrivateSection");
      expect(child.text).toContain("shared-tag");
      // counts do not leak either: a topic whose only block is invisible is
      // not listed at all (never "· N blocks" carrying hidden facts)
      expect(child.text).not.toMatch(/^- secret /m);
      expect(child.text).not.toMatch(/^- hidden /m);
    }
    // main session: main-only IS visible (existing semantics), private never
    const main = renderBlocks(readCorpus(join(memDir, "blocks")), {
      slug: "proj",
      isChild: false,
      residentBytes: 2048,
      today: TODAY,
      jevIndex,
    });
    expect(main.text).toContain("mainonly-tag");
    expect(main.text).not.toContain("private-tag");
    expect(main.text).not.toContain("PrivateSection");
  });
});

describe("budget metering (arch §3.3.2)", () => {
  test("residentMeteredBytes = body + note + 2B per block; residentBlocksOf ordering", () => {
    const memDir = fixtureDir([
      { id: "b.002", authority: "user", scope: "global", updated: "2026-11-01T00:00:00.000Z", body: "- two" },
      { id: "a.001", authority: "user", scope: "global", updated: "2026-11-05T00:00:00.000Z", body: "- one" },
      {
        id: "c.003",
        authority: "user",
        scope: "global",
        expires: "2026-11-01",
        updated: "2026-11-05T00:00:00.000Z",
        body: "- three",
      },
      { id: "d.004", authority: "user", scope: "topic", body: "- decision" },
    ]);
    const blocks = readCorpus(join(memDir, "blocks")).blocks;
    const resident = residentBlocksOf(blocks, { isChild: false, today: TODAY });
    expect(resident.map((b) => b.id)).toEqual(["a.001", "b.002", "c.003"]); // unexpired first, updated desc, id asc
    expect(residentMeteredBytes(resident, TODAY)).toBe(
      // metering strips a leading "- " from the body (render prefix reuse)
      Buffer.byteLength("one", "utf8") +
        2 +
        Buffer.byteLength("two", "utf8") +
        2 +
        Buffer.byteLength("three", "utf8") +
        Buffer.byteLength("（已到期，待用户确认）", "utf8") +
        2,
    );
  });
});
