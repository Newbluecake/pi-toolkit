// outbound.ts unit tests (plan.md v3.2 §6.1 / §11.2 outbound 列表).

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildPredictOutbound,
  fitOutboundBudget,
  OUTBOUND_MAX_TOTAL_BYTES,
  sanitizeTagDesc,
  serializePredictOutbound,
} from "../../../../src/memory/jev/predict/outbound.js";
import type { PredictInput, ToolLite } from "../../../../src/memory/jev/predict/contracts.js";

function baseInput(overrides: Partial<PredictInput> = {}): PredictInput {
  return {
    prompt: "把改动提交并推送",
    todo: [],
    recentTools: [],
    git: { branch: "dev", dirty: true },
    bashJobs: [],
    activeSubagents: 1,
    session: "main",
    ...overrides,
  };
}

function guess(tags: readonly { tag: string; score: number }[] = [{ tag: "git-commit", score: 0.8 }]) {
  return { ruleGuess: tags };
}

// ───────────────────────────── 逐字段 allowlist ─────────────────────────────

describe("buildPredictOutbound allowlist", () => {
  it("emits exactly the §6.1 keys in order", () => {
    const dto = buildPredictOutbound(baseInput({ previousPrompt: "上一轮" }), guess());
    expect(Object.keys(JSON.parse(serializePredictOutbound(dto)))).toEqual([
      "v",
      "request",
      "previous_request",
      "todo",
      "recent_tools",
      "workspace",
      "rule_guess",
    ]);
    expect(dto.v).toBe(1);
  });

  it("drops todo ids and never carries input-only fields (session/carry/extras)", () => {
    const loose = {
      ...baseInput({
        todo: [{ id: 7, status: "in_progress", subject: "发版任务" } as PredictInput["todo"][number]],
        previousPrompt: "上一轮",
      }),
      carry: {
        tags: [{ tag: "x", score: 1, sources: ["U"], rules: [], evidence: { todoIds: [], jobShapes: [] } }],
        carries: 1,
      },
      memoryBody: "SENTINEL-MEMORY-BODY",
      assistantText: "SENTINEL-ASSISTANT-TEXT",
    } as PredictInput & Record<string, unknown>;
    const serialized = serializePredictOutbound(buildPredictOutbound(loose, guess()));
    const parsed = JSON.parse(serialized) as { todo: unknown[]; [k: string]: unknown };
    expect(Object.keys(parsed.todo[0] as object)).toEqual(["status", "subject"]);
    expect(serialized).not.toContain('"id"');
    for (const banned of ["carry", "session", "SENTINEL-MEMORY-BODY", "SENTINEL-ASSISTANT-TEXT"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("round-trips byte-identically through serialize (cache turnKey premise)", () => {
    const dto = buildPredictOutbound(baseInput({ previousPrompt: "上一轮" }), guess());
    const once = serializePredictOutbound(dto);
    const twice = serializePredictOutbound(JSON.parse(once) as Parameters<typeof serializePredictOutbound>[0]);
    expect(twice).toBe(once);
  });

  it("deterministic for identical input", () => {
    const a = serializePredictOutbound(buildPredictOutbound(baseInput(), guess()));
    const b = serializePredictOutbound(buildPredictOutbound(baseInput(), guess()));
    expect(a).toBe(b);
  });
});

// ───────────────────────────── sentinel 扫描 ─────────────────────────────

describe("sentinel scan (never-send list)", () => {
  const SENTINEL_PATH = "/home/bluecake/sentinel-path/记忆正文.md";
  const SENTINEL_URL = "https://sentinel.example/x?token=SENTINEL_TOKEN_123";
  const SENTINEL_DESC = "SENTINEL-TODO-DESCRIPTION";

  it("paths, args, URLs, descriptions never reach the wire", () => {
    const loose = {
      ...baseInput({
        prompt: "继续发版流程",
        previousPrompt: "上一轮",
        todo: [{ id: 1, status: "in_progress", subject: "发版任务", description: SENTINEL_DESC }],
        recentTools: [
          { tool: "bash", shape: `curl ${SENTINEL_URL}`, pathClass: "other" },
          { tool: "weird/tool", pathClass: "src" },
        ] as ToolLite[],
        git: { branch: `${SENTINEL_PATH}#branch`, dirty: true },
        bashJobs: [{ status: "running", command: `bash release.sh --note ${SENTINEL_PATH} && curl ${SENTINEL_URL}` }],
      }),
    } as PredictInput & Record<string, unknown>;
    const dto = buildPredictOutbound(loose, guess());
    const serialized = serializePredictOutbound(dto);
    for (const sentinel of [
      SENTINEL_PATH,
      SENTINEL_URL,
      "SENTINEL_TOKEN",
      SENTINEL_DESC,
      "记忆正文",
      "sentinel.example",
      "sentinel-path",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    // 命令只剩 shape，路径类只剩枚举。
    expect(dto.workspace.jobs[0]?.shape).toBe("curl");
    expect(dto.recent_tools[0]?.shape).toBeUndefined();
    expect(dto.recent_tools[1]?.tool).toBe("other");
    expect(dto.workspace.branch).toBe("other");
  });
});

// ───────────────────────────── 双限额（码点 + 字节） ─────────────────────────────

describe("dual caps (codepoints by redactForJev, bytes here)", () => {
  it("caps request at 1000 cps", () => {
    // 空格断开长字母数字 run，避免被 redact 的 BASE64_LONG_RE 整段掩掉。
    const dto = buildPredictOutbound(baseInput({ prompt: "a b ".repeat(600) }), guess());
    expect(dto.request.length).toBe(1000);
    expect(Buffer.byteLength(dto.request, "utf8")).toBe(1000);
  });

  it("caps request at 3000B without cutting a codepoint (4-byte emoji)", () => {
    const dto = buildPredictOutbound(baseInput({ prompt: "🚀".repeat(1200) }), guess());
    expect(Buffer.byteLength(dto.request, "utf8")).toBe(3000);
    expect(Array.from(dto.request).length).toBe(750); // 3000 / 4，无半个字符
    expect([...dto.request].every((c) => c === "🚀")).toBe(true);
  });

  it("caps previous_request at 300 cps / 900B", () => {
    const dto = buildPredictOutbound(baseInput({ previousPrompt: "🚀".repeat(400) }), guess());
    expect(Array.from(dto.previous_request ?? "").length).toBe(225);
    expect(Buffer.byteLength(dto.previous_request ?? "", "utf8")).toBe(900);
  });

  it("caps todo subject at 80 cps / 240B", () => {
    const dto = buildPredictOutbound(
      baseInput({ todo: [{ id: 1, status: "pending", subject: "😀".repeat(90) }] }),
      guess(),
    );
    expect(Array.from(dto.todo[0]?.subject ?? "").length).toBe(60);
    expect(Buffer.byteLength(dto.todo[0]?.subject ?? "", "utf8")).toBe(240);
  });

  it("runs the request through redactForJev (email masked)", () => {
    const dto = buildPredictOutbound(baseInput({ prompt: "联系 owner@sentinel.example 提交" }), guess());
    expect(dto.request).toContain("[EMAIL]");
    expect(dto.request).not.toContain("owner@sentinel.example");
  });
});

// ───────────────────────────── 6144B 总量与裁剪顺序 ─────────────────────────────

describe("total budget 6144B and trim order (§6.1)", () => {
  it("trims a maxed-out DTO in order: previous_request → recent_tools tail → todo tail → request", () => {
    const dto = buildPredictOutbound(
      baseInput({
        prompt: "汉".repeat(1000), // request = 3000B
        previousPrompt: "汉".repeat(300), // previous_request = 900B
        todo: Array.from({ length: 8 }, (_, i) => ({
          id: i,
          status: "in_progress" as const,
          subject: `任务${i}` + "汉".repeat(76),
        })),
        recentTools: Array.from({ length: 12 }, (_, i) => ({
          tool: i % 2 === 0 ? "bash" : "read",
          shape: i % 3 === 0 ? "git commit" : "npm install",
          pathClass: (["src", "tests", "fixtures", "docs"] as const)[i % 4],
        })),
        bashJobs: Array.from({ length: 5 }, () => ({ status: "running", command: "git push origin dev" })),
      }),
      guess(Array.from({ length: 6 }, (_, i) => ({ tag: `tag-${i}`, score: 0.9 }))),
    );
    const serialized = serializePredictOutbound(dto);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(OUTBOUND_MAX_TOTAL_BYTES);
    expect(dto.previous_request).toBeUndefined(); // 先删 previous_request
    expect(dto.recent_tools.length).toBeGreaterThan(0);
    expect(dto.recent_tools.length).toBeLessThan(12); // 再裁 recent_tools 尾部
    expect(dto.todo.length).toBe(8); // recent_tools 没裁完不动 todo
    expect(Buffer.byteLength(dto.request, "utf8")).toBe(3000); // request 最后才动
  });

  it("stage 1: budget that fits without previous_request drops only previous_request", () => {
    const padded = baseInput({
      previousPrompt: "上一轮",
      todo: ["甲", "乙", "丙"].map((s, i) => ({ id: i, status: "pending" as const, subject: `任务${s}` })),
      recentTools: ["git commit", "git push", "npm install"].map((shape) => ({ tool: "bash", shape })) as ToolLite[],
    });
    const withPrev = buildPredictOutbound(padded, guess());
    const withoutPrevBytes = Buffer.byteLength(
      serializePredictOutbound(buildPredictOutbound(baseInput({ ...padded, previousPrompt: undefined }), guess())),
      "utf8",
    );
    const fitted = fitOutboundBudget(withPrev, withoutPrevBytes);
    expect(fitted.previous_request).toBeUndefined();
    expect(fitted.recent_tools.length).toBe(3); // 还没轮到 recent_tools
    expect(fitted.todo.length).toBe(3);
    expect(fitted.request).toBe(withPrev.request);
  });

  it("stage 2: one byte less spills into recent_tools before todo", () => {
    const padded = baseInput({
      previousPrompt: "上一轮",
      todo: ["甲", "乙", "丙"].map((s, i) => ({ id: i, status: "pending" as const, subject: `任务${s}` })),
      recentTools: ["git commit", "git push", "npm install"].map((shape) => ({ tool: "bash", shape })) as ToolLite[],
    });
    const withPrev = buildPredictOutbound(padded, guess());
    const withoutPrevBytes = Buffer.byteLength(
      serializePredictOutbound(buildPredictOutbound(baseInput({ ...padded, previousPrompt: undefined }), guess())),
      "utf8",
    );
    const fitted = fitOutboundBudget(withPrev, withoutPrevBytes - 1);
    expect(fitted.previous_request).toBeUndefined();
    expect(fitted.recent_tools.length).toBe(2); // 只裁尾部一条
    expect(fitted.todo.length).toBe(3); // recent_tools 没裁完不动 todo
    expect(fitted.request).toBe(withPrev.request);
  });

  it("stage 3: todo is emptied only after recent_tools", () => {
    const padded = baseInput({
      previousPrompt: "上一轮",
      todo: ["甲", "乙", "丙"].map((s, i) => ({ id: i, status: "pending" as const, subject: `任务${s}` })),
      recentTools: ["git commit", "git push", "npm install"].map((shape) => ({ tool: "bash", shape })) as ToolLite[],
    });
    const dto = buildPredictOutbound(padded, guess());
    const floorBytes = Buffer.byteLength(
      serializePredictOutbound(
        buildPredictOutbound(baseInput({ ...padded, previousPrompt: undefined, todo: [], recentTools: [] }), guess()),
      ),
      "utf8",
    );
    const fitted = fitOutboundBudget(dto, floorBytes);
    expect(fitted.recent_tools.length).toBe(0);
    expect(fitted.todo.length).toBe(0);
    expect(fitted.request).toBe(dto.request);
  });

  it("stage 4: request itself is truncated last, never cutting a codepoint", () => {
    const mk = (prompt: string) =>
      buildPredictOutbound(
        baseInput({ prompt, git: undefined, todo: [], recentTools: [] }),
        guess([{ tag: "git-commit", score: 0.8 }]),
      );
    const floorBytes = Buffer.byteLength(serializePredictOutbound(mk("")), "utf8");
    const budget = floorBytes + 40; // 只给 request 留 ~13 个三字节字符
    const fitted = fitOutboundBudget(mk("汉".repeat(400)), budget);
    const serialized = JSON.stringify(fitted);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(budget);
    expect(JSON.parse(serialized)).toBeTruthy(); // 未产生非法 UTF-8/JSON
    expect(Array.from(fitted.request).every((c) => c === "汉")).toBe(true);
    expect(fitted.request.length).toBeGreaterThan(0);
    expect("汉".repeat(400).startsWith(fitted.request)).toBe(true);
  });
});

// ───────────────────────────── recent_tools 合并与净化 ─────────────────────────────

describe("recent_tools merge and sanitize", () => {
  it("merges by (tool, shape, path_class) triple, error sticks, n counted", () => {
    const dto = buildPredictOutbound(
      baseInput({
        recentTools: [
          { tool: "bash", shape: "git commit", pathClass: "src", isError: true },
          { tool: "bash", shape: "git commit", pathClass: "src" },
          { tool: "bash", shape: "git commit", pathClass: "tests" },
          { tool: "read", pathClass: "src" },
          { tool: "read", pathClass: "src", isError: true },
        ] as ToolLite[],
      }),
      guess(),
    );
    expect(dto.recent_tools).toEqual([
      { tool: "bash", shape: "git commit", path_class: "src", error: true, n: 2 },
      { tool: "bash", shape: "git commit", path_class: "tests" },
      { tool: "read", path_class: "src", error: true, n: 2 },
    ]);
  });

  it("keeps at most 12 entries (most recent)", () => {
    const tools = Array.from({ length: 14 }, (_, i) => ({ tool: `tool${i}` })) as ToolLite[];
    const dto = buildPredictOutbound(baseInput({ recentTools: tools }), guess());
    expect(dto.recent_tools.length).toBe(12);
    const names = dto.recent_tools.map((t) => t.tool);
    expect(names).not.toContain("tool0");
    expect(names).not.toContain("tool1");
    expect(names).toContain("tool13");
  });

  it("sanitizes tool names against ^[A-Za-z_][A-Za-z0-9_]{0,40}$", () => {
    const dto = buildPredictOutbound(
      baseInput({
        recentTools: [{ tool: "bash" }, { tool: "bad tool!" }, { tool: "x".repeat(42) }, { tool: "" }] as ToolLite[],
      }),
      guess(),
    );
    expect(dto.recent_tools).toEqual([
      { tool: "bash" },
      { tool: "other", n: 3 }, // 三个非法名同三元组，合并计数
    ]);
  });

  it("accepts only shapes the §6.1 table can produce; anything else is omitted", () => {
    const shapes = [
      "git commit", // 枚举内
      "git rebase", // 枚举内
      "git notacommand", // 枚举外 ⇒ 丢弃
      "curl https://x.example/a?b=1", // URL ⇒ 丢弃
      "bash -c rm -rf /", // >2 token ⇒ 丢弃
      "release.sh", // 脚本
      "other",
      "weird$.sh", // 非法脚本名 ⇒ 丢弃
      "npm i",
    ];
    const dto = buildPredictOutbound(
      baseInput({ recentTools: shapes.map((shape) => ({ tool: "bash", shape })) as ToolLite[] }),
      guess(),
    );
    // 同 tool 且 shape 丢失的项合并为一项（首现位置），其余逐项核对。
    expect(dto.recent_tools.map((t) => t.shape ?? "<omitted>")).toEqual([
      "git commit",
      "git rebase",
      "<omitted>", // git notacommand / curl URL / bash -c / weird$.sh 四项合并
      "release.sh",
      "other",
      "npm i",
    ]);
    expect(dto.recent_tools[2]).toEqual({ tool: "bash", n: 4 });
  });
});

// ───────────────────────────── workspace ─────────────────────────────

describe("workspace", () => {
  it("keeps a well-formed branch, maps malformed ones to other", () => {
    const ok = buildPredictOutbound(baseInput({ git: { branch: "feature/predict-p2.0-x" } }), guess());
    expect(ok.workspace.branch).toBe("feature/predict-p2.0-x");
    const bad = buildPredictOutbound(baseInput({ git: { branch: "main develop" } }), guess());
    expect(bad.workspace.branch).toBe("other");
    const cjk = buildPredictOutbound(baseInput({ git: { branch: "主干" } }), guess());
    expect(cjk.workspace.branch).toBe("other");
  });

  it("omits branch/dirty keys when git is absent", () => {
    const dto = buildPredictOutbound(baseInput({ git: undefined }), guess());
    expect(Object.keys(dto.workspace)).toEqual(["jobs", "subagents"]);
  });

  it("caps jobs at 5, normalizes status, never leaks command text", () => {
    const dto = buildPredictOutbound(
      baseInput({
        bashJobs: Array.from({ length: 6 }, (_, i) => ({
          status: i === 0 ? "weird" : "running",
          command: `git push --repo /home/bluecake/sentinel-repo-${i}`,
        })),
      }),
      guess(),
    );
    expect(dto.workspace.jobs.length).toBe(5);
    expect(dto.workspace.jobs[0]?.status).toBe("other");
    expect(dto.workspace.jobs.every((j) => j.shape === "git push")).toBe(true);
    expect(serializePredictOutbound(dto)).not.toContain("sentinel-repo");
  });

  it("clamps subagents into 0..99", () => {
    expect(buildPredictOutbound(baseInput({ activeSubagents: 150 }), guess()).workspace.subagents).toBe(99);
    expect(buildPredictOutbound(baseInput({ activeSubagents: -3 }), guess()).workspace.subagents).toBe(0);
  });
});

// ───────────────────────────── rule_guess ─────────────────────────────

describe("rule_guess", () => {
  it("caps at 6, validates tag ids, clamps and rounds scores to 1 decimal", () => {
    const dto = buildPredictOutbound(
      baseInput(),
      guess([
        { tag: "git-commit", score: 0.874 },
        { tag: "git-push", score: -0.5 },
        { tag: "release", score: 1.2 },
        { tag: "Bad_Tag", score: 0.9 },
        { tag: "UP", score: 0.9 },
        { tag: "ab", score: 0.55 },
        { tag: "tag-5", score: 0.5 },
        { tag: "tag-6", score: 0.5 },
      ]),
    );
    expect(dto.rule_guess).toEqual([
      { tag: "git-commit", score: 0.9 },
      { tag: "git-push", score: 0 },
      { tag: "release", score: 1 },
      { tag: "ab", score: 0.6 },
      { tag: "tag-5", score: 0.5 },
      { tag: "tag-6", score: 0.5 },
    ]);
  });
});

// ───────────────────────────── 用户 tag 描述（进 system） ─────────────────────────────

describe("sanitizeTagDesc", () => {
  it("masks secret-shaped spans (email, long hex)", () => {
    const out = sanitizeTagDesc("联系 owner@sentinel.example；指纹 0123456789abcdef0123456789abcdef");
    expect(out).toContain("[EMAIL]");
    expect(out).not.toContain("owner@sentinel.example");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("strips newlines", () => {
    expect(sanitizeTagDesc("行一\n行二\r\n行三")).toBe("行一 行二 行三");
    expect(sanitizeTagDesc("a\nb")).not.toContain("\n");
  });

  it("caps at 160 cps and 480B", () => {
    expect(Array.from(sanitizeTagDesc("好".repeat(200))).length).toBe(160);
    const emoji = sanitizeTagDesc("😀".repeat(200));
    expect(Array.from(emoji).length).toBe(120); // 480B / 4
    expect(Buffer.byteLength(emoji, "utf8")).toBe(480);
  });
});

// ───────────────────────────── 外来 DTO 再投影 ─────────────────────────────

describe("serializePredictOutbound re-projects foreign DTOs", () => {
  it("clips every field back into the allowlist and caps", () => {
    const foreign = {
      v: 2,
      request: "汉".repeat(5000),
      previous_request: "好".repeat(2000),
      todo: [
        { status: "weird", subject: "a" },
        { status: "pending", subject: "b", extra: "SENTINEL-EXTRA" },
      ],
      recent_tools: [{ tool: "bad tool!", shape: "curl https://x", path_class: "nope", n: -1, error: "yes" }],
      workspace: {
        branch: "bad branch!",
        dirty: "yes",
        jobs: [{ shape: "bad shape here", status: "weird" }],
        subagents: 999,
      },
      rule_guess: [
        { tag: "BAD", score: 5 },
        { tag: "ok-tag", score: 5 },
      ],
      secret_extra: "SENTINEL-FOREIGN-KEY",
    } as unknown as Parameters<typeof serializePredictOutbound>[0];
    const parsed = JSON.parse(serializePredictOutbound(foreign)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "v",
      "request",
      "previous_request",
      "todo",
      "recent_tools",
      "workspace",
      "rule_guess",
    ]);
    expect(parsed["v"]).toBe(1);
    expect((parsed["request"] as string).length).toBe(1000);
    expect((parsed["previous_request"] as string).length).toBe(300);
    expect(parsed["todo"]).toEqual([{ status: "pending", subject: "b" }]);
    expect(parsed["recent_tools"]).toEqual([{ tool: "other" }]);
    expect(parsed["workspace"]).toEqual({
      branch: "other",
      jobs: [{ shape: "other", status: "other" }],
      subagents: 99,
    });
    expect(parsed["rule_guess"]).toEqual([{ tag: "ok-tag", score: 1 }]);
    expect(JSON.stringify(parsed)).not.toContain("SENTINEL");
  });
});

// ───────────────────── P2 验收小项：原型键与 null/非对象元素防御 ─────────────────────

describe("P2 hostile-element defenses", () => {
  it("never throws on null/non-object recent_tools elements and degrades to other/skip", () => {
    const dto = buildPredictOutbound(
      baseInput({
        recentTools: [
          null,
          42,
          "bash",
          { tool: "__proto__", shape: "git push" },
          { tool: "constructor", pathClass: "src" },
          { tool: "bash", shape: "constructor" },
          { tool: "read", isError: true },
        ] as unknown as ToolLite[],
      }),
      guess(),
    );
    expect(dto.recent_tools).toEqual([
      { tool: "other", shape: "git push" }, // "__proto__" → other，shape 仍净化保留
      { tool: "other", path_class: "src" }, // "constructor" → other
      { tool: "bash" }, // shape "constructor" → 省略
      { tool: "read", error: true },
    ]);
  });

  it("never throws on null/non-object jobs elements (build and re-project paths)", () => {
    const built = buildPredictOutbound(
      baseInput({ bashJobs: [null, { status: "running", command: "git push" }, "junk"] as never }),
      guess(),
    );
    expect(built.workspace.jobs).toEqual([{ shape: "git push", status: "running" }]);
    const foreign = {
      v: 1,
      request: "x",
      todo: [],
      recent_tools: [],
      workspace: { jobs: [null, 7, { shape: "__proto__", status: "running" }], subagents: 1 },
      rule_guess: [],
    } as unknown as Parameters<typeof serializePredictOutbound>[0];
    const parsed = JSON.parse(serializePredictOutbound(foreign)) as { workspace: { jobs: unknown[] } };
    expect(parsed.workspace.jobs).toEqual([{ shape: "other", status: "running" }]);
  });

  it("never throws on null/non-object rule_guess and todo elements; drops proto tags", () => {
    const built = buildPredictOutbound(
      baseInput(),
      guess([
        null,
        3,
        { tag: "__proto__", score: 1 },
        { tag: "constructor", score: 1 },
        { tag: "ok-tag", score: 0.5 },
      ] as never),
    );
    expect(built.rule_guess).toEqual([{ tag: "ok-tag", score: 0.5 }]);
    const foreign = {
      v: 1,
      request: "x",
      todo: [null, "s", { status: "pending", subject: "ok" }],
      recent_tools: [],
      workspace: { jobs: [], subagents: 0 },
      rule_guess: [null, { tag: "prototype", score: 1 }],
    } as unknown as Parameters<typeof serializePredictOutbound>[0];
    const parsed = JSON.parse(serializePredictOutbound(foreign)) as { todo: unknown[]; rule_guess: unknown[] };
    expect(parsed.todo).toEqual([{ status: "pending", subject: "ok" }]);
    expect(parsed.rule_guess).toEqual([]);
  });
});

// ───────────────────── P2 验收小项：workspace.dirty=false 保留 ─────────────────────

describe("P2 workspace.dirty=false round-trip", () => {
  it("keeps dirty:false in the canonical projection and turnKey input", () => {
    const dto = buildPredictOutbound(baseInput({ git: { branch: "dev", dirty: false } }), guess());
    expect(dto.workspace.dirty).toBe(false);
    const once = serializePredictOutbound(dto);
    expect(once).toContain('"dirty":false');
    // round-trip 仍保留 false（此前 false 被丢掉，导致 turnKey 键差异）
    const twice = serializePredictOutbound(JSON.parse(once) as Parameters<typeof serializePredictOutbound>[0]);
    expect(twice).toBe(once);
  });

  it("omits dirty only when non-boolean/undefined", () => {
    const foreign = {
      v: 1,
      request: "x",
      todo: [],
      recent_tools: [],
      workspace: { dirty: "yes", jobs: [], subagents: 0 },
      rule_guess: [],
    } as unknown as Parameters<typeof serializePredictOutbound>[0];
    const parsed = JSON.parse(serializePredictOutbound(foreign)) as { workspace: Record<string, unknown> };
    expect("dirty" in parsed.workspace).toBe(false);
    const noGit = buildPredictOutbound(baseInput({ git: undefined }), guess());
    expect("dirty" in noGit.workspace).toBe(false);
  });
});
