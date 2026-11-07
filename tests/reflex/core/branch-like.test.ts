/**
 * jev-reflex · #25 B0 (BA §4.1): `toBranchLike` moved VERBATIM from `wire.ts` into core. This pins
 * the move: the function must behave exactly like the pre-move original (frozen below as a
 * reference copy taken from the origin/dev wire.ts) across a corpus of branch-entry shapes.
 */
import { describe, expect, it } from "vitest";
import type { BranchEntryLike } from "../../../src/reflex/core/agreement.js";
import { toBranchLike } from "../../../src/reflex/core/branch-like.js";

/** REFERENCE: the original wire.ts implementation, copied byte-for-byte from origin/dev (r3 view). */
function toBranchLikeReference(entries: readonly unknown[]): BranchEntryLike[] {
  const out: BranchEntryLike[] = [];
  for (const raw of entries) {
    const e = raw as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (e === null || typeof e !== "object" || e.type !== "message" || e.message === undefined) {
      out.push({ role: "other" });
      continue;
    }
    const role = typeof e.message.role === "string" ? e.message.role : "other";
    const content = e.message.content;
    if (role === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((p: unknown) => {
                  const part = p as { type?: unknown; text?: unknown };
                  return part?.type === "text" && typeof part.text === "string" ? part.text : "";
                })
                .join("")
            : "";
      out.push({ role, text });
    } else if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = content
        .filter((p: unknown) => (p as { type?: unknown })?.type === "toolCall")
        .map((p: unknown) => {
          const c = p as { name?: unknown; arguments?: unknown };
          return { name: typeof c.name === "string" ? c.name : "", arguments: c.arguments };
        });
      out.push({ role, toolCalls });
    } else {
      out.push({ role });
    }
  }
  return out;
}

const CORPUS: readonly unknown[][] = [
  [],
  [null],
  [undefined],
  [42, "x"],
  [{ type: "custom", customType: "subagent:reflex-record" }],
  [{ type: "message" }],
  [{ type: "message", message: undefined }],
  [{ type: "message", message: { role: 7, content: "x" } }],
  [{ type: "message", message: { role: "user", content: "后台还有几个 job" } }],
  [{ type: "message", message: { role: "user", content: "" } }],
  [{ type: "message", message: { role: "user", content: [] } }],
  [
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image" },
          { type: "text", text: "b" },
          { type: "text", text: 5 },
          "junk",
        ],
      },
    },
  ],
  [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "bash_job", arguments: { action: "list" } },
          { type: "toolCall", name: 9, arguments: undefined },
        ],
      },
    },
  ],
  [{ type: "message", message: { role: "assistant", content: "plain string" } }],
  [{ type: "message", message: { role: "system", content: "sys" } }],
  [
    { type: "message", message: { role: "user", content: "q" } },
    { type: "custom", data: {} },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] } },
    { type: "message", message: { role: "user", content: "q2" } },
  ],
];

describe("core/branch-like toBranchLike (BA §4.1 verbatim move)", () => {
  it("behaves exactly like the pre-move wire.ts reference on every corpus shape", () => {
    for (const entries of CORPUS) {
      expect(toBranchLike(entries), JSON.stringify(entries)).toEqual(toBranchLikeReference(entries));
    }
  });

  it("maps user text, assistant tool calls and unknown shapes the way agreement.ts expects", () => {
    const out = toBranchLike(CORPUS[15]!);
    expect(out).toEqual([
      { role: "user", text: "q" },
      { role: "other" },
      { role: "assistant", toolCalls: [{ name: "read", arguments: {} }] },
      { role: "user", text: "q2" },
    ]);
    expect(toBranchLike([{ type: "message", message: { role: "user", content: "纯文本" } }])).toEqual([
      { role: "user", text: "纯文本" },
    ]);
  });

  it("returns a fresh array and never mutates the input", () => {
    const entries: unknown[] = [{ type: "message", message: { role: "user", content: "x" } }];
    const a = toBranchLike(entries);
    const b = toBranchLike(entries);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(entries).toEqual([{ type: "message", message: { role: "user", content: "x" } }]);
  });
});
