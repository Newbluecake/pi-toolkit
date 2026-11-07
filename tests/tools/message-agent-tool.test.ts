import { describe, expect, it, vi } from "vitest";
import {
  createMessageAgentTool,
  MessageAgentParams,
  messageAgentKindHint,
} from "../../src/tools/message-agent-tool.js";
import type { FabricRecord, NodeRef } from "../../src/core/message.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter } from "../../src/fabric/router.js";

const generation = () => 3;
const LEGACY_KIND: string = "finding"; // #34 legacy input
const params = { to: "r_PARENT01", kind: "report" as const, text: "status" };

describe("tools/message-agent", () => {
  it("passes the host-owned sender and generation to the router", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "admitted" as const, key: "k", seq: 1 }));
    const tool = createMessageAgentTool({ router: { admit } as never, from: "r_CHILD001", generation });

    const result = await tool.execute("call", params);

    expect(admit).toHaveBeenCalledWith("r_CHILD001", {
      ...params,
      generation: 3,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("routes @label through mention and returns structured details", async () => {
    const send = vi.fn(async () => ({ ok: false as const, status: "unknown_label" as const, label: "builder" }));
    const admit = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    const result = await tool.execute("call", { to: "@builder", kind: "report", text: "status" });
    expect(send).toHaveBeenCalledWith("builder", "report", "status");
    expect(admit).not.toHaveBeenCalled();
    expect(result.details).toEqual({ ok: false, status: "unknown_label", label: "builder" });
  });

  it("keeps bare run ids and root on the original admission path", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 }));
    const send = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    await tool.execute("call", { to: "root", kind: "report", text: "status" });
    await tool.execute("call", { to: "r_PARENT01", kind: "report", text: "status" });
    expect(send).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("documents root versus @label addressing in the to schema", () => {
    const description = (MessageAgentParams.properties.to as { description: string }).description;
    expect(description).toContain('"root" for the root session');
    expect(description).toContain("@label for a registered top-level agent");
  });

  it("surfaces a synchronous router rejection as a failed tool call", async () => {
    const tool = createMessageAgentTool({
      router: {
        admit: () => {
          throw new Error("message not authorized");
        },
      } as never,
      from: "r_CHILD001",
      generation,
    });
    await expect(tool.execute("call", params)).rejects.toThrow("message not authorized");
  });

  it("still rejects with the router text when the sender is not running (no kind guidance appended)", async () => {
    const tool = createMessageAgentTool({
      router: {
        admit: () => {
          throw new Error("sender is not running");
        },
      } as never,
      from: "r_CHILD001",
      generation,
    });
    await expect(tool.execute("call", params)).rejects.toThrow("sender is not running");
  });
});

/** Real in-memory fabric (engine+tree+router), so the authorization shapes below are the shipped ones, not mocks. */
function makeFabric(edges: readonly (readonly [NodeRef, NodeRef])[]) {
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store: new MemoryOutboxStore<FabricRecord>(),
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  for (const [parent, child] of edges) tree.append(parent, child);
  const nodes = new Set<NodeRef>(edges.flat());
  for (const node of nodes) if (node !== "root") tree.markRunning(node);
  const router = new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    {
      maxPerRun: 2,
      reportQuota: 2,
      directiveQuota: 2,
      deadLetterQuota: 1,
      maxChars: 100,
      progressTtlMs: 100,
      reconcileTtlMs: 100,
      rootInboxCap: 4,
      progressChannel: "display" as const,
    },
    () => 1,
  );
  return router;
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the tool call to fail");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("tools/message-agent kind guidance (#33)", () => {
  it("documents the four kind semantics in the tool description", () => {
    const tool = createMessageAgentTool({ router: {} as never, from: "r_CHILD001", generation });
    const description = tool.description;
    expect(description).toContain('"report" is injected into the target');
    expect(description).toContain('"progress" only renders in the TUI display');
    expect(description).toContain('"directive" may only be sent by a parent to its own child run');
    expect(description).toContain('the "result" channel');
  });

  it("passes a direct child's report to root through the real router", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([["root", "r_ABCD0001"]]),
      from: "r_ABCD0001",
      generation,
    });
    const result = await tool.execute("call", { to: "root", kind: "report", text: "question?" });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("rejects directive→root and appends self-correction guidance after the router text", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([["root", "r_ABCD0001"]]),
      from: "r_ABCD0001",
      generation,
    });
    const message = await errorMessage(tool.execute("call", { to: "root", kind: "directive", text: "do x" }));
    expect(message.startsWith("message not authorized")).toBe(true);
    expect(message).toContain('kind "directive" may only be sent by a parent');
    expect(message).toContain('use kind:"report" instead');
    expect(message).toContain("the model never sees it");
  });

  it("rejects a grandchild's report→root and points at the direct parent / result channel", async () => {
    const tool = createMessageAgentTool({
      router: makeFabric([
        ["root", "r_M1DD9E01"],
        ["r_M1DD9E01", "r_9RAND922"],
      ]),
      from: "r_9RAND922",
      generation,
    });
    const message = await errorMessage(tool.execute("call", { to: "root", kind: "report", text: "question?" }));
    expect(message.startsWith("message not authorized")).toBe(true);
    expect(message).toContain("direct parent");
    expect(message).toContain('the "result" channel');
    // The very same grandchild CAN reach its direct parent — that is the correction the hint suggests.
    const up = await tool.execute("call", { to: "r_M1DD9E01", kind: "report", text: "question?" });
    expect(up.details).toMatchObject({ ok: true });
  });

  it("hints at the mention route limits for @label denials", () => {
    const hint = messageAgentKindHint({ to: "@builder", kind: "directive" });
    expect(hint).toContain("can_message: mention");
    expect(hint).toContain('kind "directive" is parent-to-child only');
  });

  it("lists the sender's effective can_message set in the report/progress hint", () => {
    const hint = messageAgentKindHint({ to: "root", kind: "report" });
    expect(hint).toContain("(parent; default: direct parent only)");
  });
  it("#34 T-U3: execute rejects a pre-#34 kind before router/mention, listing the valid kinds", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 }));
    const send = vi.fn(async () => ({
      ok: true as const,
      status: "resumed" as const,
      label: "l",
      runId: "r_RUNRUN01",
    }));
    for (const to of ["root", "@lbl"]) {
      const tool = createMessageAgentTool({
        router: { admit } as never,
        mention: { send } as never,
        from: "r_CHILD001",
        generation,
      });
      const message = await errorMessage(tool.execute("call", { to, kind: LEGACY_KIND as never, text: "x" }));
      expect(message.startsWith(`message_agent: unknown kind "${LEGACY_KIND}"`)).toBe(true);
      expect(message).not.toContain("message not authorized");
      for (const kind of ['"report"', '"progress"', '"directive"']) expect(message).toContain(kind);
    }
    expect(admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // The guard precedes the wake handling too: a wake-on tool answers the same way before any wake logic.
    const wakeTool = createMessageAgentTool({
      router: { admit } as never,
      from: "r_CHILD001",
      generation,
      wakeOn: true,
    });
    const wakeMessage = await errorMessage(
      wakeTool.execute("call", { to: "root", kind: LEGACY_KIND as never, text: "x", wake: true } as never),
    );
    expect(wakeMessage.startsWith(`message_agent: unknown kind "${LEGACY_KIND}"`)).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
});
