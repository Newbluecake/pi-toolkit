/** P2b conformance probe: real pi user-message identity through message_start/context.
 * Scripted provider only. pi clones raw user messages; unchanged snapshots correlate, altered/ambiguous ones fail closed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHumanGrantHost, createHumanGrantPort } from "../../src/fabric/xs/human-grant.js";
import { withSession, disposeHarnessDirs, assistantTextMsg, assistantToolCallMsg } from "./agent-session-harness.js";

afterEach(disposeHarnessDirs);
const TEXT = "Human asks the agent to send one request and expect a reply.";

describe("P2b host context identity / current pi public API", () => {
  it.each([false, true])("altered user projection=%s", async (copied) => {
    const port = createHumanGrantPort(),
      host = createHumanGrantHost(port, "conformance-host");
    const resolved: boolean[] = [];
    const observedUser: unknown[] = [],
      contextUsers: unknown[] = [];
    await withSession(
      {
        tools: ["GrantProbe"],
        scripted: [
          { toolCall: true, build: (model) => assistantToolCallMsg(model, "probe-call", "GrantProbe", {}) },
          { toolCall: false, build: (model) => assistantTextMsg(model, "done") },
        ],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("message_start", (event, ctx) => {
              if (event.message.role === "user") observedUser.push(event.message);
              host.message(event.message, ctx.sessionManager.getSessionId());
            });
            if (copied)
              pi.on("context", (event) => ({
                messages: event.messages.map((message) =>
                  message.role === "user"
                    ? { ...message, content: [{ type: "text" as const, text: "different content" }] }
                    : message,
                ),
              }));
            pi.on("context", (event, ctx) => {
              contextUsers.push(...event.messages.filter((message) => message.role === "user"));
              host.context(event, ctx.sessionManager.getSessionId());
            });
            pi.on("tool_call", (event, ctx) =>
              host.toolCall(
                event.toolCallId,
                event.toolName,
                ctx.sessionManager.getSessionId(),
                event.parentToolCallId,
              ),
            );
            pi.registerTool({
              name: "GrantProbe",
              label: "GrantProbe",
              description: "Internal conformance grant observation.",
              parameters: Type.Object({}),
              async execute(id) {
                const call = host.invocation(id, "GrantProbe");
                resolved.push(call !== undefined && port.resolve(call) !== undefined);
                return { content: [{ type: "text", text: "observed" }], details: {} };
              },
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        // The external RPC owner is modeled only at the input boundary; pi processing is real.
        host.input({ source: "rpc", text: TEXT }, session.sessionId);
        await session.prompt(TEXT);
        expect(observedUser).toHaveLength(1);
        expect(contextUsers.length).toBeGreaterThanOrEqual(1);
        // Current pi emitContext uses structuredClone even with no custom projection.
        expect(contextUsers.includes(observedUser[0])).toBe(false);
        expect(resolved).toEqual([!copied]);
        expect(modelRuntime.callCount()).toBe(2);
        expect(JSON.stringify(modelRuntime.requestMessages)).not.toContain("conformance-host");
        expect(JSON.stringify(modelRuntime.requestMessages)).not.toContain("grantId");
      },
    );
  });
});
