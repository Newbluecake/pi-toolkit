// J1 (jev-plan §4 J1): every copy block compared VERBATIM against
// jev-arch §5.3 (status/notify), §6.1.6 (inject), §6.2.4 (echo), §9.4
// (/mem jev report). Gate copy was removed with the gate feature (2026-11).

import { describe, expect, it } from "vitest";
import {
  formatInjectMarker,
  formatInjectMarkerParts,
  formatInjectMessage,
  formatJevReport,
  formatNotify,
  formatStatusLine,
  formatWriteEcho,
} from "../../../src/memory/jev/format.js";
import type { JevReportView } from "../../../src/memory/jev/contracts.js";

describe("inject message & marker (§6.1.6 / §5.3)", () => {
  it("first line is verbatim, layer-parameterized", () => {
    expect(formatInjectMessage("U", []).split("\n")[0]).toBe(
      "[memory · U jev] 以下是与当前请求相关的项目记忆条目（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。",
    );
    expect(formatInjectMessage("A", []).split("\n")[0]).toContain("memory · A jev");
    // memory-predict plan §5.3: P has its own header, NOT the generic U template.
    expect(formatInjectMessage("P", []).split("\n")[0]).toBe(
      "[memory · P jev] 以下是根据当前任务状态预测本轮可能用到的项目记忆（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。",
    );
  });

  it("S state-constraint items carry the （发版进行中） note (plan §3.4)", () => {
    const msg = formatInjectMessage("P", [
      { anchor: "core › Release #1", body: "发版前确认 CI 是绿的", releaseInProgress: true },
      { anchor: "core › Dispatch #1", body: "派发子 agent 前先确认范围" },
    ]);
    expect(msg).toContain("core › Release #1（发版进行中）\n发版前确认 CI 是绿的");
    expect(msg).toContain("core › Dispatch #1\n派发子 agent 前先确认范围");
  });

  it("items render anchor+body with the expired/modified notes", () => {
    const msg = formatInjectMessage("U", [
      { anchor: "core.md › 发版 #1", body: "默认 patch。", expired: true },
      { anchor: "pitfalls-git.md #2", body: "走代理。", modified: true },
    ]);
    expect(msg).toContain("core.md › 发版 #1（已到期，待用户确认）\n默认 patch。");
    expect(msg).toContain("pitfalls-git.md #2（已修改）\n走代理。");
  });

  it("marker matches the arch examples, incl. ·partial", () => {
    expect(formatInjectMarker("U", [{ anchor: "pitfalls-git › #3", p: 0.81 }])).toBe(
      "── mem U: pitfalls-git › #3 (0.81) ──",
    );
    expect(formatInjectMarker("A", [{ anchor: "pitfalls-git › #3" }], { partial: true })).toBe(
      "── mem A·partial: pitfalls-git › #3 ──",
    );
  });

  it("parts marker joins one segment per layer with │ (plan §5.3, C-J16 gate)", () => {
    expect(
      formatInjectMarkerParts([
        { layer: "P", items: [{ anchor: "core.md › 发版 #1" }] },
        { layer: "U", items: [{ anchor: "pitfalls-git › #3", p: 0.81 }] },
      ]),
    ).toBe("── mem P: core.md › 发版 #1 │ U: pitfalls-git › #3 (0.81) ──");
    // ·partial attaches per part, not to the whole marker.
    expect(
      formatInjectMarkerParts([
        { layer: "U", items: [{ anchor: "a #1" }], partial: true },
        { layer: "B", items: [{ anchor: "b #2" }] },
      ]),
    ).toBe("── mem U·partial: a #1 │ B: b #2 ──");
    expect(formatInjectMarkerParts([])).toBe("── mem  ──");
  });
});

describe("write echo (§6.2.4) — verbatim main block + conditional lines", () => {
  const base = {
    kind: "tagged" as const,
    anchor: { file: "pitfalls-git.md", ordinal: 3, lineStart: 12, lineEnd: 14 },
    type: "pitfall" as const,
    typeP: 0.91,
    importance: 2 as const,
    tags: [
      { id: "git-push", p: 0.88 },
      { id: "network", p: 0.83 },
    ],
    guard: 0.12,
    temporal: "permanent" as const,
    authority: "agent" as const,
  };

  it("main block matches the arch example byte-for-byte", () => {
    expect(
      formatWriteEcho({
        ...base,
        similar: { anchor: "core.md L5", relation: "complementary", p: 0.72 },
      }),
    ).toBe(
      [
        "section: pitfalls-git.md #3 (L12-14)",
        "jev: pitfall 0.91 · important · tags git-push 0.88, network 0.83 · guard 0.12 · permanent",
        "similar: core.md L5 (complementary 0.72)",
      ].join("\n"),
    );
  });

  it("conditional lines in table order", () => {
    const out = formatWriteEcho({
      ...base,
      guard: 0.82,
      userLike: 0.86,
      temporal: "dated",
      conflict: { anchor: "core.md L3", userRule: true, relation: "conflict", p: 0.84 },
    });
    const lines = out.split("\n");
    expect(lines[2]).toBe("jev: looks like a user order (0.86) — if the user said it, append <!-- mem user -->");
    expect(lines[3]).toBe('jev: looks temporary — add expires=YYYY-MM-DD or until="…"');
    expect(lines[4]).toBe(
      "conflict: core.md L3 (user rule, conflict 0.84) — 用户令只有用户能作废：在回复里向用户提议具体改法",
    );
    // The guard>=0.7 gate-advice line was removed with the gate feature;
    // the guard p itself stays in the jev: judgment line.
    expect(out).not.toContain("guards a risky action");
  });

  it("non-user conflict variant and quiet conditionals", () => {
    const out = formatWriteEcho({
      ...base,
      userLike: 0.5,
      authority: "user",
      temporal: "permanent",
      hasExpiry: true,
      guard: 0.3,
      conflict: { anchor: "core.md L3", userRule: false, relation: "supersedes", p: 0.8 },
    });
    expect(out.split("\n")[2]).toBe(
      "conflict: core.md L3 (agent entry, supersedes 0.80) — consider merging into it or deleting the older entry in place",
    );
    expect(out).not.toContain("looks like a user order");
    expect(out).not.toContain("looks temporary");
    expect(out).not.toContain("guards a risky action");
  });

  it("not-tagged variants: partial long form, off short form", () => {
    expect(formatWriteEcho({ kind: "not-tagged", reason: "partial: 451", long: true })).toBe(
      "jev: not tagged (partial: 451) — fast path will not see this entry until tagged; inline tags=+… works now",
    );
    expect(
      formatWriteEcho({
        kind: "not-tagged",
        anchor: { file: "a.md", ordinal: 1, lineStart: 3, lineEnd: 3 },
        reason: "off: pi-api",
        long: false,
      }),
    ).toBe("section: a.md #1 (L3-3)\njev: not tagged (off: pi-api)");
  });

  it("not-tagged detail (2026-11-04 fix): `reason — detail`; absent/empty detail keeps the old bytes", () => {
    expect(
      formatWriteEcho({
        kind: "not-tagged",
        reason: "all-failed",
        long: false,
        detail: "opencode/jev-1.13-free: timeout after 3000ms",
      }),
    ).toBe("jev: not tagged (all-failed — opencode/jev-1.13-free: timeout after 3000ms)");
    // empty string ≙ absent (no stray " — ")
    expect(formatWriteEcho({ kind: "not-tagged", reason: "all-failed", long: false, detail: "" })).toBe(
      "jev: not tagged (all-failed)",
    );
    // long form composes the same way
    expect(formatWriteEcho({ kind: "not-tagged", reason: "partial: 451", long: true, detail: "x" })).toBe(
      "jev: not tagged (partial: 451 — x) — fast path will not see this entry until tagged; inline tags=+… works now",
    );
  });
});

describe("status line (§5.3)", () => {
  const cov = { tagged: 142, total: 150, lastTaggedAt: "2026-10-29T18:55:00" };
  it.each([
    [{ kind: "off", reason: "secure" }, "jev: off (secure domain)"],
    [{ kind: "off", reason: "empty-list" }, "jev: off (empty classifier list)"],
    [{ kind: "off", reason: "pi-api" }, "jev: off (pi-api)"],
    [{ kind: "off", reason: "disabled" }, "jev: off (disabled)"],
    [{ kind: "off", reason: "legacy" }, "jev: off (legacy)"],
    [{ kind: "probing" }, "jev: probing · 142/150 tagged"],
  ])("%j → %s", (status, want) => {
    expect(formatStatusLine(status as never, cov)).toBe(want);
  });

  it("full", () => {
    expect(
      formatStatusLine({ kind: "full", model: "opencode/jev-1.13" }, { ...cov, usage: { costUsd: 0.0061, calls: 37 } }),
    ).toBe("jev: full · opencode/jev-1.13 · 142/150 tagged · 37 calls $0.006");
  });

  it("partial with retry time, and the inactive display form", () => {
    expect(
      formatStatusLine(
        { kind: "partial", reason: "451", retryAt: new Date("2026-10-30T12:05:00").getTime(), inactive: false },
        cov,
      ),
    ).toBe("jev: partial (451) · fast path 142/150 tagged (10-29) · retry 12:05 · /mem jev");
    expect(formatStatusLine({ kind: "partial", reason: "no auth", inactive: true }, { tagged: 0, total: 0 })).toBe(
      "jev: inactive (no classifier credentials)",
    );
  });
});

describe("notifications (§5.3 table) — verbatim", () => {
  it("first-full / degraded / recovered / startup-partial", () => {
    expect(formatNotify("first-full", { model: "opencode/jev-1.13" })).toBe(
      "jev on · opencode/jev-1.13 — 记忆召回、打标、整理已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭",
    );
    expect(formatNotify("degraded", { reason: "451", tagged: 142, total: 150 })).toBe(
      "jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（142/150）。/mem jev",
    );
    expect(formatNotify("recovered", { model: "opencode/jev-1.13" })).toBe("jev recovered · opencode/jev-1.13");
    expect(formatNotify("startup-partial", { reason: "451", tagged: 142, total: 150 })).toBe(
      "jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（142/150）。/mem jev（451 多为地区拦截，可设 memory.jev.proxy）",
    );
    expect(formatNotify("startup-partial", { reason: "budget", tagged: 0, total: 0 })).not.toContain("地区拦截");
  });
});

describe("/mem jev report (§9.4)", () => {
  const view: JevReportView = {
    status: "enabled · partial (classifier unavailable since 11:40) · next probe 12:40",
    models: [
      { id: "opencode/jev-1.13-free", note: "unavailable (451) until 12:40 — 451 多为地区拦截，可设 memory.jev.proxy" },
      { id: "opencode/jev-1.13", note: "unavailable (402 Insufficient funds) until 12:41" },
    ],
    stopped: ["recall U", "error recall E", "write tagging", "review run"],
    running: ["action fast path A", "re-inject after compaction B", "review list"],
    tags: { tagged: 142, total: 150, pending: 8, lastTaggedAt: "2026-10-29T18:55:00", taxonomyRev: "4f2a91c0" },
    usage: { calls: 37, costUsd: 0.0061, maxCostUsd: 0.5 },
    segment: { injectedByLayer: { U: 3, A: 1, E: 1 }, injectedTotal: 5 },
    review: { lastRunAt: "2026-10-28", open: 2 },
  };

  it("reproduces the arch §9.4 example layout", () => {
    expect(formatJevReport(view)).toBe(
      [
        "jev      enabled · partial (classifier unavailable since 11:40) · next probe 12:40",
        "models   1 opencode/jev-1.13-free   unavailable (451) until 12:40 — 451 多为地区拦截，可设 memory.jev.proxy",
        "         2 opencode/jev-1.13        unavailable (402 Insufficient funds) until 12:41",
        "stopped  recall U · error recall E · write tagging · review run",
        "running  action fast path A · re-inject after compaction B · review list",
        "tags     142/150 tagged · 8 pending (edited since last tagging) · last tagged 10-29 18:55 · taxonomy 4f2a91c0",
        "usage    37 calls · $0.0061 / $0.50 · per activation (/reload resets)",
        "segment  injected 5 (U3 A1 E1) · cap 5/30",
        "review   last 2026-10-28 · 2 open → /mem review",
      ].join("\n"),
    );
  });

  it("quiet variants: no models/pending/last-run rows degrade gracefully", () => {
    const out = formatJevReport({
      ...view,
      models: [],
      tags: { ...view.tags, pending: 0, lastTaggedAt: undefined },
      review: { open: 0 },
    });
    expect(out).not.toContain("models");
    expect(out).not.toContain("pending");
    expect(out).toContain("tags     142/150 tagged · taxonomy 4f2a91c0");
    expect(out).toContain("review   0 open → /mem review");
  });
});
