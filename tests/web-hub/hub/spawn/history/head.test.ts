/**
 * web-hub session-history plan §4.5.1 (`head.ts`): incremental header/kind/title-source parser,
 * plus `checkSessionHeader` (shared with `restore-plan.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkSessionHeader,
  createHeadParser,
  type HeadResult,
} from "../../../../../src/web-hub/hub/spawn/history/head.js";

function feedAll(lines: string[], chunkSize = 1 << 20): HeadResult {
  const parser = createHeadParser();
  const text = lines.map((l) => `${l}\n`).join("");
  const buf = Buffer.from(text, "utf8");
  let pos = 0;
  while (pos < buf.length) {
    const end = Math.min(pos + chunkSize, buf.length);
    if (parser.push(buf.subarray(pos, end)) === "done") break;
    pos = end;
  }
  return parser.finish();
}

const HEADER = JSON.stringify({ type: "session", id: "sess-aaaa1", cwd: "/w/p", timestamp: "2026-01-01T00:00:00Z" });
const USER_MSG = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "hello world" }] },
});
const ASSISTANT_MSG = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200000) }] },
});

describe("createHeadParser — header validity", () => {
  it("valid header + user message ⇒ ok, complete, firstMessage", () => {
    const r = feedAll([HEADER, USER_MSG]);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.id).toBe("sess-aaaa1");
    expect(r.cwd).toBe("/w/p");
    expect(r.idValid).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.firstMessage).toBe("hello world");
  });

  it("empty input / incomplete first line ⇒ no-header", () => {
    const parser = createHeadParser();
    parser.push(Buffer.from('{"type":"session"', "utf8")); // no trailing \n ever
    const r = parser.finish();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no-header");
  });

  it("header line without a newline within 4 KiB ⇒ too-long-header", () => {
    const parser = createHeadParser();
    const giant = `{"type":"session","id":"${"a".repeat(5000)}"`; // > 4096 bytes, no \n
    const r1 = parser.push(Buffer.from(giant, "utf8"));
    expect(r1).toBe("done");
    const r = parser.finish();
    expect(r.error).toBe("too-long-header");
  });

  it("not JSON / not object / type mismatch / missing id / bad cwd / missing timestamp ⇒ bad-header", () => {
    const cases = [
      "not json at all",
      "[1,2,3]",
      JSON.stringify({ type: "other", id: "x", cwd: "/a", timestamp: "t" }),
      JSON.stringify({ type: "session", cwd: "/a", timestamp: "t" }),
      JSON.stringify({ type: "session", id: "x", cwd: "relative/path", timestamp: "t" }),
      JSON.stringify({ type: "session", id: "x", cwd: "/a" }),
    ];
    for (const line of cases) {
      const r = feedAll([line]);
      expect(r.ok, line).toBe(false);
      expect(r.error, line).toBe("bad-header");
    }
  });

  it("parentSession present ⇒ forked:true", () => {
    const h = JSON.stringify({ type: "session", id: "s1", cwd: "/w", timestamp: "t", parentSession: "/snap" });
    const r = feedAll([h]);
    expect(r.forked).toBe(true);
  });

  it("idValid reflects RESTORE_SESSION_ID_RE", () => {
    const bad = JSON.stringify({ type: "session", id: "-bad", cwd: "/w", timestamp: "t" });
    expect(feedAll([bad]).idValid).toBe(false);
  });
});

describe("createHeadParser — kind detection", () => {
  it("subagent:child marker ⇒ sub (overrides everything else)", () => {
    const marker = JSON.stringify({ type: "custom", customType: "subagent:child" });
    const main = JSON.stringify({ type: "custom", customType: "pi-hud-session-start" });
    const r = feedAll([HEADER, marker, main]);
    expect(r.kind).toBe("sub");
  });

  it("subagent:prompt-sections WITH pi_subagent_types ⇒ main", () => {
    const line = `{"type":"custom","customType":"subagent:prompt-sections","pi_subagent_types":{}}`;
    const r = feedAll([HEADER, line]);
    expect(r.kind).toBe("main");
  });

  it("subagent:prompt-sections WITHOUT pi_subagent_types ⇒ sub (heuristic)", () => {
    const line = `{"type":"custom","customType":"subagent:prompt-sections","other":1}`;
    const r = feedAll([HEADER, line]);
    expect(r.kind).toBe("sub");
  });

  it("an ESCAPED pi_subagent_types inside a string value never counts as the unescaped signal", () => {
    const line = `{"type":"custom","customType":"subagent:prompt-sections","note":"mentions \\"pi_subagent_types\\": nope"}`;
    const r = feedAll([HEADER, line]);
    expect(r.kind).toBe("sub");
  });

  it("pi-hud-session-start / subagent:web-origin ⇒ main", () => {
    for (const ct of ["pi-hud-session-start", "subagent:web-origin"]) {
      const line = JSON.stringify({ type: "custom", customType: ct });
      expect(feedAll([HEADER, line]).kind).toBe("main");
    }
  });

  it("no signals at all ⇒ unknown", () => {
    expect(feedAll([HEADER]).kind).toBe("unknown");
  });

  it("main signal beats a sub-heuristic signal seen earlier", () => {
    const heuristic = `{"type":"custom","customType":"subagent:prompt-sections"}`;
    const main = JSON.stringify({ type: "custom", customType: "subagent:web-origin" });
    expect(feedAll([HEADER, heuristic, main]).kind).toBe("main");
  });
});

describe("createHeadParser — session_info / message handling", () => {
  it("session_info.name: the LAST one wins", () => {
    const n1 = JSON.stringify({ type: "session_info", name: "first" });
    const n2 = JSON.stringify({ type: "session_info", name: "second" });
    const r = feedAll([HEADER, n1, n2]);
    expect(r.name).toBe("second");
  });

  it("system and assistant message lines are skipped without ever being JSON.parsed (never counted as firstMessage)", () => {
    const system = JSON.stringify({ type: "message", message: { role: "system", content: "ignore me" } });
    const r = feedAll([HEADER, system, ASSISTANT_MSG, USER_MSG]);
    expect(r.complete).toBe(true);
    expect(r.firstMessage).toBe("hello world");
  });

  it("stops reading (push returns 'done') once the first user message line completes", () => {
    const parser = createHeadParser();
    expect(parser.push(Buffer.from(`${HEADER}\n`, "utf8"))).toBe("more");
    expect(parser.push(Buffer.from(`${USER_MSG}\n`, "utf8"))).toBe("done");
  });

  it("a truncated first-user-message line (window cut mid-message) ⇒ loose extraction, complete:false", () => {
    const fullMsg = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "partial content visible" }] },
    });
    // cut the line BEFORE its trailing "}\n" — simulate a read-window truncation
    const truncated = fullMsg.slice(0, fullMsg.length - 3);
    const parser = createHeadParser();
    parser.push(Buffer.from(`${HEADER}\n`, "utf8"));
    parser.push(Buffer.from(truncated, "utf8")); // no trailing \n — never "done"
    const finished = parser.finish();
    expect(finished.complete).toBe(false);
    expect(finished.firstMessage).toContain("partial content visible");
  });

  it("a truncated line with plain string content also extracts via the content fallback", () => {
    const fullMsg = `{"type":"message","message":{"role":"user","content":"plain string content`;
    const full = `${fullMsg}"}}`; // ...content"}}
    const truncated = full.slice(0, full.length - 2); // drop the trailing "}}" but KEEP the closing quote
    const parser = createHeadParser();
    parser.push(Buffer.from(`${HEADER}\n`, "utf8"));
    parser.push(Buffer.from(truncated, "utf8"));
    const finished = parser.finish();
    expect(finished.complete).toBe(false);
    expect(finished.firstMessage).toBe("plain string content");
  });
});

describe("createHeadParser — chunk-boundary independence (property-ish)", () => {
  it("splitting the same input into 1, 3, or 1-byte-at-a-time chunks yields the identical result", () => {
    const lines = [
      HEADER,
      `{"type":"custom","customType":"subagent:prompt-sections","pi_subagent_types":{}}`,
      JSON.stringify({ type: "session_info", name: "Title" }),
      USER_MSG,
    ];
    const whole = feedAll(lines, 1 << 20);
    const byThree = feedAll(lines, 3);
    const byOne = feedAll(lines, 1);
    expect(byThree).toEqual(whole);
    expect(byOne).toEqual(whole);
  });
});

describe("checkSessionHeader", () => {
  const expect_ = { id: "sess-1", cwd: "/w/p" };
  it("valid header ⇒ ok", () => {
    expect(checkSessionHeader(`${HEADER}\n{}`, { id: "sess-aaaa1", cwd: "/w/p" })).toEqual({ ok: true });
  });
  it("not JSON / not object / type mismatch / id mismatch / cwd mismatch — exact detail strings", () => {
    expect(checkSessionHeader("not json", expect_)).toEqual({ ok: false, detail: "header is not JSON" });
    expect(checkSessionHeader("[1,2]", expect_)).toEqual({ ok: false, detail: "header is not an object" });
    expect(checkSessionHeader(JSON.stringify({ type: "other", id: "sess-1", cwd: "/w/p" }), expect_)).toEqual({
      ok: false,
      detail: "header type mismatch",
    });
    expect(checkSessionHeader(JSON.stringify({ type: "session", id: "sess-2", cwd: "/w/p" }), expect_)).toEqual({
      ok: false,
      detail: "header id mismatch",
    });
    expect(checkSessionHeader(JSON.stringify({ type: "session", id: "sess-1", cwd: "/elsewhere" }), expect_)).toEqual({
      ok: false,
      detail: "header cwd mismatch",
    });
  });
});

describe("createHeadParser — never JSON.parses a line it doesn't need (perf anchor)", () => {
  it("a 200 KiB assistant message line is never handed to JSON.parse", () => {
    const spy = vi.spyOn(JSON, "parse");
    spy.mockClear();
    const r = feedAll([HEADER, ASSISTANT_MSG, USER_MSG]);
    const parsedLargeStrings = spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].length > 1000);
    spy.mockRestore();
    expect(parsedLargeStrings).toHaveLength(0);
    expect(r.complete).toBe(true);
    expect(r.firstMessage).toBe("hello world");
  });
});
