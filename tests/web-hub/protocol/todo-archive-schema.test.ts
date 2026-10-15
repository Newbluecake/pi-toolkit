/**
 * todo-archive plan v2.1 §3 (D5, Blocker #1 处置)：`TodoWire` 增加了 `completedHidden` / `archived`
 * 两个可选字段——append-only。`LEGACY_TODO_WIRE_SCHEMA` 是改动前 `TodoWireSchema` 的逐字副本
 * （一个尚未升级的 hub 实际用来解码的 schema），钉住：
 *  1. 未门控的新字段 wire 会被旧 schema 拒 ⇒ `todo.archive.v1` cap 门必要（否则 status 帧 /
 *     snapshot_reply 被 `Value.Check` 静默丢弃，web 卡片冻结，plan §4 升级窗口）；
 *  2. 旧形状 wire（agent 对无 cap hub 的输出）在新旧两个 schema 下结果相同；
 *  3. 真实 `decodeAgentFrame` 的两条路径（status 帧、snapshot_reply.status）× 三种字段组合
 *     （completedHidden / archived / 两者）都能解码，负数与非整数被拒。
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { TodoWireSchema, decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { TODO_ARCHIVE_HUB_CAP, TODO_ARCHIVE_HUB_CAPS } from "../../../src/web-hub/protocol/version.js";
import { LEGACY_TODO_WIRE_SCHEMA } from "./legacy-todo-schema.js";

const todoTask = (id: number, status: "pending" | "in_progress" | "completed" = "pending") => ({
  id,
  subject: `task ${id}`,
  status,
  blockedBy: [],
});

const legacyWire = () => ({
  tasks: [todoTask(1, "in_progress"), todoTask(2), todoTask(3, "completed")],
  total: 8,
  counts: { open: 1, inProgress: 1, completed: 6, blocked: 0 },
  omitted: 5,
  updatedAt: 1_728_000_000_000,
});

const archivedWire = () => ({
  ...legacyWire(),
  completedHidden: 3,
  archived: 7,
});

function baseStatus(): Record<string, unknown> {
  return {
    leafId: "abc123",
    busy: true,
    pending: false,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    costUsd: 0.12,
    subagentCostUsd: 0.01,
  };
}

describe("todo.archive.v1 cap constant", () => {
  it("is the frozen name", () => {
    expect(TODO_ARCHIVE_HUB_CAP).toBe("todo.archive.v1");
    expect([...TODO_ARCHIVE_HUB_CAPS]).toEqual(["todo.archive.v1"]);
  });
});

describe("legacy (pre-todo-archive) schema vs new schema", () => {
  it("1. an ungated wire with either new field is REJECTED by the legacy schema (the cap gate is necessary)", () => {
    expect(Value.Check(LEGACY_TODO_WIRE_SCHEMA, archivedWire())).toBe(false);
    const hiddenOnly = { ...legacyWire(), completedHidden: 1 };
    expect(Value.Check(LEGACY_TODO_WIRE_SCHEMA, hiddenOnly)).toBe(false);
    const archivedOnly = { ...legacyWire(), archived: 2 };
    expect(Value.Check(LEGACY_TODO_WIRE_SCHEMA, archivedOnly)).toBe(false);
  });

  it("2. a legacy-shaped wire (what archiveFields:false emits) passes the legacy schema AND the new one", () => {
    expect(Value.Check(LEGACY_TODO_WIRE_SCHEMA, legacyWire())).toBe(true);
    expect(Value.Check(TodoWireSchema, legacyWire())).toBe(true);
  });

  it("3. the new schema accepts completedHidden / archived, alone and together", () => {
    expect(Value.Check(TodoWireSchema, archivedWire())).toBe(true);
    expect(Value.Check(TodoWireSchema, { ...legacyWire(), completedHidden: 3 })).toBe(true);
    expect(Value.Check(TodoWireSchema, { ...legacyWire(), archived: 7 })).toBe(true);
  });

  it("4. a legacy-shaped wire decodes to the same value under the legacy and new schema", () => {
    const wire = legacyWire();
    const legacyDecoded = Value.Clean(LEGACY_TODO_WIRE_SCHEMA, structuredClone(wire));
    const newDecoded = Value.Clean(TodoWireSchema, structuredClone(wire));
    expect(newDecoded).toEqual(legacyDecoded);
    expect(newDecoded).toEqual(wire);
  });

  it("new schema bounds: zero values are legal (the projection omits them, the schema tolerates them)", () => {
    expect(Value.Check(TodoWireSchema, { ...legacyWire(), completedHidden: 0, archived: 0 })).toBe(true);
  });
});

describe("real decodeAgentFrame — status frame path", () => {
  it("decodes completedHidden / archived / both through the status frame", () => {
    for (const todo of [{ ...legacyWire(), completedHidden: 3 }, { ...legacyWire(), archived: 7 }, archivedWire()]) {
      const frame = decodeAgentFrame({ t: "status", ...baseStatus(), todo });
      expect((frame as { todo?: unknown } | undefined)?.todo).toEqual(todo);
    }
  });

  it("rejects negative / non-integer values (frame silently dropped, not clamped)", () => {
    expect(
      decodeAgentFrame({ t: "status", ...baseStatus(), todo: { ...legacyWire(), completedHidden: -1 } }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...baseStatus(), todo: { ...legacyWire(), archived: -3 } })).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "status", ...baseStatus(), todo: { ...legacyWire(), completedHidden: 1.5 } }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "status", ...baseStatus(), todo: { ...legacyWire(), archived: Number.NaN } }),
    ).toBeUndefined();
  });
});

describe("real decodeAgentFrame — snapshot_reply.status path", () => {
  const reply = (todo: unknown) => ({
    t: "snapshot_reply",
    rid: "r1",
    seq: 7,
    leafId: "leaf1",
    recent: [],
    prompts: [],
    status: { leafId: "leaf1", busy: false, pending: false, todo },
    fleet: [],
  });

  it("decodes completedHidden / archived / both through snapshot_reply.status", () => {
    for (const todo of [{ ...legacyWire(), completedHidden: 3 }, { ...legacyWire(), archived: 7 }, archivedWire()]) {
      const frame = decodeAgentFrame(reply(todo));
      expect((frame as { status?: { todo?: unknown } } | undefined)?.status?.todo).toEqual(todo);
    }
  });

  it("rejects negative / non-integer values", () => {
    expect(decodeAgentFrame(reply({ ...legacyWire(), completedHidden: -1 }))).toBeUndefined();
    expect(decodeAgentFrame(reply({ ...legacyWire(), archived: 2.5 }))).toBeUndefined();
  });
});
