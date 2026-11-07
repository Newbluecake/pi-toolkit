/**
 * 2026-10-28 user request (fleet bash 「(+N more)」): the hub's `/api/cmd` body parser for the
 * `archive_omitted` op — closed shape {kind} only (the cmdId lives in `id`), bash-only, junk
 * fields dropped. Same posture as the `archive`/`recall` cases above it in the switch.
 */
import { describe, expect, it } from "vitest";
import { parseCmdBody } from "../../../src/web-hub/hub/http-cmd.js";

const ID = "aaaaaaaaaaaaaaaa";
const base = { agentKey: "agent:1", id: ID, op: "archive_omitted" };

describe("parseCmdBody: op `archive_omitted`", () => {
  it("rebuilds exactly {op, kind} on the forwarded frame", () => {
    const parsed = parseCmdBody({ ...base, kind: "bash" });
    expect("cmd" in parsed).toBe(true);
    if (!("cmd" in parsed)) return;
    expect(parsed.agentKey).toBe("agent:1");
    expect(parsed.id).toBe(ID);
    expect(parsed.cmd).toEqual({ op: "archive_omitted", kind: "bash" });
    expect(parsed.queryOnly).toBeUndefined();
  });

  it("drops extra body fields instead of forwarding them (closed shape)", () => {
    const parsed = parseCmdBody({ ...base, kind: "bash", ids: ["b1", "b2"], target: "b1", changed: 3 });
    if (!("cmd" in parsed)) throw new Error("expected a parsed cmd");
    expect(parsed.cmd).toEqual({ op: "archive_omitted", kind: "bash" });
  });

  it("rejects other kinds (the op is bash-only)", () => {
    expect(parseCmdBody({ ...base, kind: "run" })).toMatchObject({ error: "E_BAD_REQUEST", message: "bad kind" });
    expect(parseCmdBody({ ...base })).toMatchObject({ error: "E_BAD_REQUEST", message: "bad kind" });
  });

  it("still requires a well-formed cmdId", () => {
    expect(parseCmdBody({ ...base, id: "short", kind: "bash" })).toMatchObject({
      error: "E_BAD_REQUEST",
      message: "bad id",
    });
  });

  it("threads queryOnly through (a retry re-executes, deduped agent-side)", () => {
    const parsed = parseCmdBody({ ...base, kind: "bash", queryOnly: true });
    if (!("cmd" in parsed)) throw new Error("expected a parsed cmd");
    expect(parsed.queryOnly).toBe(true);
  });
});
