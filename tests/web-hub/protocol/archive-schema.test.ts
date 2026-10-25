/**
 * web-hub archive plan — wire schemas: the `archive` cmd op joins the CLOSED CmdSchema union;
 * `StatusInfo.archived` is an optional open slot (old hubs forward it verbatim — the frame
 * still validates WITHOUT the field declared, which is exactly how bash-jobs/quota ride it).
 */
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ArchiveArgsSchema,
  CmdFrame,
  StatusInfo,
  decodeAgentFrame,
  decodeHubFrame,
} from "../../../src/web-hub/protocol/messages.js";

type StatusFrame = { t: "status" } & StatusInfo;

const ORIGIN = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" } as const;

function cmdFrame(cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: "r1", id: "aaaaaaaaaaaaaaaa", deadlineMs: 8000, origin: { ...ORIGIN }, cmd };
}

describe("ArchiveArgsSchema (cmd op `archive`)", () => {
  it("accepts exactly {op, kind, id, set}", () => {
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "run", id: "r-1", set: "archive" })).toBe(true);
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "bash", id: "b1", set: "unarchive" })).toBe(true);
  });

  it("rejects unknown fields, bad kinds, empty ids and junk directions", () => {
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "run", id: "r", set: "archive", text: "x" })).toBe(
      false,
    );
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "workflow", id: "r", set: "archive" })).toBe(false);
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "run", id: "", set: "archive" })).toBe(false);
    expect(Value.Check(ArchiveArgsSchema, { op: "archive", kind: "run", id: "r", set: "delete" })).toBe(false);
  });
});

describe("decodeHubFrame/decodeAgentFrame: cmd + status paths", () => {
  it("decodes a cmd frame carrying the archive op", () => {
    const frame = decodeHubFrame(cmdFrame({ op: "archive", kind: "bash", id: "b1", set: "unarchive" }));
    expect(frame).toBeDefined();
    expect((frame as CmdFrame).cmd).toEqual({ op: "archive", kind: "bash", id: "b1", set: "unarchive" });
  });

  it("decodes a status frame with the archived slot (both kinds, auto badge)", () => {
    const status: StatusFrame = {
      t: "status",
      leafId: "l1",
      busy: false,
      pending: false,
      archived: {
        rev: 3,
        entries: [
          { kind: "run", id: "r-1", at: 123, auto: true },
          { kind: "bash", id: "b1", at: 124 },
        ],
      },
    };
    const frame = decodeAgentFrame(status);
    expect(frame).toBeDefined();
    expect((frame as StatusFrame).archived?.entries).toHaveLength(2);
  });

  it("still decodes a pre-feature status frame byte-identically (no archived field)", () => {
    const frame = decodeAgentFrame({ t: "status", leafId: "l1", busy: true, pending: false });
    expect(frame).toBeDefined();
    expect((frame as StatusFrame).archived).toBeUndefined();
  });

  it("rejects a malformed archived slot (bad kind / non-boolean auto)", () => {
    expect(
      decodeAgentFrame({
        t: "status",
        leafId: "l1",
        busy: false,
        pending: false,
        archived: { rev: 1, entries: [{ kind: "nope", id: "x", at: 1 }] },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({
        t: "status",
        leafId: "l1",
        busy: false,
        pending: false,
        archived: { rev: 1, entries: [{ kind: "run", id: "x", at: 1, auto: "yes" }] },
      }),
    ).toBeUndefined();
  });

  it("an OLD-hub simulation (schema without the archived field) still forwards the frame", () => {
    // This is the compat proof for the status slot: TypeBox objects without
    // additionalProperties:false tolerate unknown members, so a running old hub's
    // decode of a new frame with `archived` does not drop it.
    const oldHubStatus = Type.Object({
      t: Type.Literal("status"),
      leafId: Type.Union([Type.String(), Type.Null()]),
      busy: Type.Boolean(),
      pending: Type.Boolean(),
    });
    const withArchive = { t: "status", leafId: null, busy: false, pending: false, archived: { rev: 1, entries: [] } };
    expect(Value.Check(oldHubStatus, withArchive)).toBe(true);
  });
});
