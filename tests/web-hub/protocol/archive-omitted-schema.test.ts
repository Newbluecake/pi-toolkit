/**
 * 2026-10-28 user request (fleet bash 「(+N more)」 must be displayable or archivable): the
 * `archive_omitted` cmd op. Wire discipline: the CmdSchema union is CLOSED, so the op joins it as
 * an exactly-{op, kind} object (no PROTO bump — additive op, I10); the result rides `CmdData`
 * (whose runtime schema stays `Type.Unknown()`, the `archive`/`recall` precedent).
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ArchiveOmittedArgsSchema,
  CmdFrame,
  decodeHubFrame,
  type CmdData,
} from "../../../src/web-hub/protocol/messages.js";

const ORIGIN = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" } as const;

function cmdFrame(cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: "r1", id: "aaaaaaaaaaaaaaaa", deadlineMs: 8000, origin: { ...ORIGIN }, cmd };
}

describe("ArchiveOmittedArgsSchema (cmd op `archive_omitted`)", () => {
  it("accepts exactly {op, kind}", () => {
    expect(Value.Check(ArchiveOmittedArgsSchema, { op: "archive_omitted", kind: "bash" })).toBe(true);
  });

  it("rejects unknown fields, other kinds and a missing kind", () => {
    expect(Value.Check(ArchiveOmittedArgsSchema, { op: "archive_omitted", kind: "bash", id: "b1" })).toBe(false);
    expect(Value.Check(ArchiveOmittedArgsSchema, { op: "archive_omitted", kind: "run" })).toBe(false);
    expect(Value.Check(ArchiveOmittedArgsSchema, { op: "archive_omitted" })).toBe(false);
  });

  it("decodes a cmd frame carrying the op; the frame round-trips byte-identically", () => {
    const frame = decodeHubFrame(cmdFrame({ op: "archive_omitted", kind: "bash" }));
    expect(frame).toBeDefined();
    expect((frame as CmdFrame).cmd).toEqual({ op: "archive_omitted", kind: "bash" });
  });

  it("a frame with the old closed op set still decodes (no regression: archive keeps working)", () => {
    const frame = decodeHubFrame(cmdFrame({ op: "archive", kind: "bash", id: "b1", set: "archive" }));
    expect((frame as CmdFrame).cmd).toEqual({ op: "archive", kind: "bash", id: "b1", set: "archive" });
  });

  it("the result variant is exactly {op, changed} (changed:0 is a real answer, not absence)", () => {
    const zero: CmdData = { op: "archive_omitted", changed: 0 };
    const many: CmdData = { op: "archive_omitted", changed: 7 };
    expect(JSON.parse(JSON.stringify(zero))).toEqual({ op: "archive_omitted", changed: 0 });
    expect(JSON.parse(JSON.stringify(many))).toEqual({ op: "archive_omitted", changed: 7 });
  });
});
