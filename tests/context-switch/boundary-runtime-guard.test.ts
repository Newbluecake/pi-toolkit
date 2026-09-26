/**
 * child-context-switch plan §3.1 条件 2 / §6 task 4：namespace-import 运行时防御 + V6
 * cannot-continue 的依赖 mock 用例。这些场景不能和 `boundary.test.ts` 共用同一个模块实例
 * （其余测试需要真实的 pi `SessionManager`/`convertToLlm` 正常工作），所以放单独文件，用
 * `vi.doMock` + `vi.resetModules()` 逐个 case 重新装配 `@earendil-works/pi-coding-agent`
 * 的命名空间对象，模拟"某个导出缺失/被替换"的运行时。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshBoundaryModule() {
  vi.resetModules();
  return import("../../src/context-switch/boundary.js");
}

function minimalInput(overrides: Record<string, unknown> = {}) {
  return {
    header: { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp/x" },
    branch: [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-switch", name: "switch_context", arguments: {} }],
          api: "chat",
          provider: "test",
          model: "m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "toolCalls",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call-switch",
          toolName: "switch_context",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      },
    ],
    cwd: "/tmp/x",
    turn: {
      messageEntryId: "m1",
      toolResultEntryIds: ["m2"],
      toolResults: [
        {
          role: "toolResult" as const,
          toolCallId: "call-switch",
          toolName: "switch_context",
          content: [{ type: "text" as const, text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      priorDrafts: [],
    },
    staged: { toolCallId: "call-switch", core: "core text ".repeat(20), keepRecent: false, seq: 1, nonce: "n" },
    keepRecentTokens: 50,
    facts: {},
    tokensBefore: 1000,
    ...overrides,
  };
}

describe("buildChildSwitchDrafts runtime guard (namespace import degrade, plan §3.1 condition 2)", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
  });

  it("missing SessionManager.inMemory (0.86-shaped export) rejects with preview-invalid, never throws", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, SessionManager: {} };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    expect(() => buildChildSwitchDrafts(minimalInput() as never)).not.toThrow();
    expect(buildChildSwitchDrafts(minimalInput() as never)).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("missing findCutPoint rejects with preview-invalid even for a keep_recent:true request (would otherwise crash inside V5)", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, findCutPoint: undefined };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    const input = minimalInput({
      staged: { toolCallId: "call-switch", core: "x".repeat(200), keepRecent: true, seq: 1, nonce: "n" },
    });
    expect(() => buildChildSwitchDrafts(input as never)).not.toThrow();
    expect(buildChildSwitchDrafts(input as never)).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("missing convertToLlm rejects with preview-invalid, never throws", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, convertToLlm: undefined };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    expect(buildChildSwitchDrafts(minimalInput() as never)).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("missing estimateTokens rejects with preview-invalid, never throws", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, estimateTokens: undefined };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    expect(buildChildSwitchDrafts(minimalInput() as never)).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("missing sessionEntryToContextMessages rejects with preview-invalid, never throws", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, sessionEntryToContextMessages: undefined };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    expect(buildChildSwitchDrafts(minimalInput() as never)).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("importing boundary.ts itself never throws when the pi module namespace is missing every export (module-load safety)", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({}));
    await expect(freshBoundaryModule()).resolves.toBeDefined();
  });
});

describe("buildChildSwitchDrafts V6 cannot-continue via dependency mock (plan §6 task 4)", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
  });

  it("convertToLlm mocked to end on an assistant message forces canContinue=false: rejected, no entries, no continue ever requested", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        // Real SessionManager.inMemory / buildSessionProjection still run; only the final
        // canContinue computation is forced to false by faking convertToLlm's output shape.
        convertToLlm: () => [
          { role: "user", content: "hi", timestamp: 1 },
          { role: "assistant", content: [], timestamp: 2 },
        ],
      };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    const result = buildChildSwitchDrafts(minimalInput() as never);
    expect(result).toEqual({ ok: false, reason: "cannot-continue" });
    // No draft is ever handed back on this path, and this package never produces a `continue` field.
    expect("entries" in result).toBe(false);
    expect("continue" in result).toBe(false);
  });

  it("convertToLlm mocked to return only a system message forces canContinue=false (no non-system context)", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        convertToLlm: () => [{ role: "system", content: "sys", timestamp: 1 }],
      };
    });
    const { buildChildSwitchDrafts } = await freshBoundaryModule();
    const result = buildChildSwitchDrafts(minimalInput() as never);
    expect(result).toEqual({ ok: false, reason: "cannot-continue" });
  });
});
