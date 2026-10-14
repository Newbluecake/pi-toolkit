import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { externalSessionPath } from "../../src/external-agent/paths.js";
import {
  TRANSCRIPT_TOOL_ARGS_MAX_BYTES,
  TRANSCRIPT_TOOL_RESULT_MAX_BYTES,
  TRANSCRIPT_TRUNCATED_CUSTOM_TYPE,
  openTranscript,
  readTranscriptHeader,
} from "../../src/external-agent/transcript.js";
import type { TranscriptHeader } from "../../src/external-agent/types.js";
import { projectSessionEntry } from "../../src/web-hub/protocol/keys.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ptk-transcript-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const header = (cwd: string): TranscriptHeader => ({
  type: "external_session",
  version: 1,
  provider: "droid",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd,
  modelId: "gpt-6-luna",
  createdAt: "2026-10-14T00:00:00.000Z",
  roleName: "general",
  runId: "run-1",
});
const sessionPath = () => externalSessionPath(dir, "droid", "11111111-2222-3333-4444-555555555555");
const lines = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("transcript", () => {
  it("writes header + chained entries; header cwd realpath round-trips; perms 0600/0700", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    const a = w.append({ type: "message", message: userMsg("hi") });
    const b = w.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "yo" }], model: "droid/gpt-6-luna" },
    });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(w.leafId()).toBe(b);
    w.close();
    w.close(); // idempotent
    const ls = lines(p);
    expect(ls[0]).toMatchObject({ type: "external_session", version: 1, cwd: dir });
    expect(ls[1]).toMatchObject({ type: "message", id: a, parentId: null });
    expect(ls[2]).toMatchObject({ type: "message", id: b, parentId: a });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(p, "..")).mode & 0o777).toBe(0o700);
    expect(readTranscriptHeader(p)).toEqual(header(dir));
    expect(w.failed()).toBe(false);
    expect(w.branch().map((e) => e.id)).toEqual([a, b]);
  });

  it("entries project through the real web-hub projectSessionEntry; header and unknown are ignored", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    w.append({ type: "message", message: userMsg("hello") });
    w.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "Execute", arguments: { command: "ls" } }],
      },
    });
    w.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "Execute",
        content: [{ type: "text", text: "a b" }],
        isError: false,
      },
    });
    w.append({ type: "custom", customType: "subagent:external-resume", data: { runId: "r2", modelId: "m" } });
    w.close();
    const projected = lines(p).map((l) => projectSessionEntry(l));
    expect(projected[0]).toBeUndefined(); // header
    expect(projected.slice(1).map((e) => e?.type)).toEqual(["message", "message", "message", "custom"]);
    expect(projected[1]).toMatchObject({ parentId: null });
    expect(projected[4]).toMatchObject({ customType: "subagent:external-resume", display: false });
  });

  it("truncates tool args (8KiB) and tool results (16KiB) with a marker; does not mutate the input", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    const bigArgs = { blob: "A".repeat(20_000) };
    const msg = { role: "assistant", content: [{ type: "toolCall", id: "c", name: "Edit", arguments: bigArgs }] };
    w.append({ type: "message", message: msg });
    w.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c",
        toolName: "Edit",
        content: [{ type: "text", text: "é".repeat(20_000) }],
        isError: false,
      },
    });
    w.close();
    expect(bigArgs.blob.length).toBe(20_000);
    expect(msg.content[0]?.arguments).toBe(bigArgs);
    const ls = lines(p);
    const args = (
      (ls[1]?.message as { content: Array<{ arguments: { truncated: string } }> }).content[0] as {
        arguments: { truncated: string };
      }
    ).arguments.truncated;
    expect(args).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(Buffer.byteLength(args)).toBeLessThan(TRANSCRIPT_TOOL_ARGS_MAX_BYTES + 64);
    const res = ((ls[2]?.message as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
    expect(res).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(Buffer.byteLength(res)).toBeLessThan(TRANSCRIPT_TOOL_RESULT_MAX_BYTES + 64);
    expect(res).not.toContain("\uFFFD");
  });

  it("small tool args/results are untouched", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    w.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "R", arguments: { a: 1 } }] },
    });
    w.close();
    const m = lines(p)[1]?.message as { content: Array<{ arguments: unknown }> };
    expect(m.content[0]?.arguments).toEqual({ a: 1 });
  });

  it("file size cap: exactly one truncation marker custom, then bodies stop; resume stays usable", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false, maxFileBytes: 1500 });
    const ids: Array<string | undefined> = [];
    for (let i = 0; i < 20; i++) ids.push(w.append({ type: "message", message: userMsg("x".repeat(200)) }));
    w.close();
    const ls = lines(p);
    const markers = ls.filter((l) => l.customType === TRANSCRIPT_TRUNCATED_CUSTOM_TYPE);
    expect(markers).toHaveLength(1);
    expect(ls[ls.length - 1]).toMatchObject({ customType: TRANSCRIPT_TRUNCATED_CUSTOM_TYPE });
    expect(statSync(p).size).toBeLessThan(1500 + 300);
    expect(ids.filter((x) => x !== undefined).length).toBeLessThan(20);
    // resume of a capped file: header readable, no further body written
    const r = openTranscript({ path: p, resume: true, maxFileBytes: 1500 });
    expect(r.append({ type: "message", message: userMsg("more") })).toBeUndefined();
    r.close();
    expect(lines(p).length).toBe(ls.length);
  });

  it("resume continues from the file's leaf and loads the branch", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    w.append({ type: "message", message: userMsg("one") });
    const last = w.append({ type: "message", message: userMsg("two") });
    w.close();
    const r = openTranscript({ path: p, resume: true });
    expect(r.leafId()).toBe(last);
    expect(r.branch()).toHaveLength(2);
    const marker = r.append({ type: "custom", customType: "subagent:external-resume", data: { runId: "r2" } });
    const next = r.append({ type: "message", message: userMsg("three") });
    r.close();
    const ls = lines(p);
    expect(ls).toHaveLength(5); // header + 2 + marker + 3
    expect(ls[3]).toMatchObject({ id: marker, parentId: last });
    expect(ls[4]).toMatchObject({ id: next, parentId: marker });
    expect(ls.filter((l) => l.type === "external_session")).toHaveLength(1);
  });

  it("write failure degrades: failed()=true, append never throws, memory chain continues", () => {
    const p = sessionPath();
    const w = openTranscript({ path: p, header: header(dir), resume: false });
    w.close();
    // path whose parent is a regular file ⇒ mkdir fails ⇒ degraded, no throw
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const w2 = openTranscript({ path: join(blocker, "sub", "s.jsonl"), header: header(dir), resume: false });
    expect(w2.failed()).toBe(true);
    const id = w2.append({ type: "message", message: userMsg("still tracked in memory") });
    expect(id).toBeDefined();
    expect(w2.leafId()).toBe(id);
    expect(w2.branch()).toHaveLength(1);
    w2.close();
  });

  it.skipIf(!existsSync("/dev/full"))(
    "real write error (ENOSPC via /dev/full) ⇒ failed(), no throw, memory chain continues",
    () => {
      const w = openTranscript({ path: "/dev/full", header: header(dir), resume: false });
      expect(w.failed()).toBe(true); // header write hit ENOSPC
      let id: string | undefined;
      expect(() => {
        id = w.append({ type: "message", message: userMsg("late") });
      }).not.toThrow();
      expect(id).toBeDefined();
      expect(w.leafId()).toBe(id);
      w.close();
    },
  );

  it("resume of a missing file ⇒ failed() (no throw); symlink target is refused (O_NOFOLLOW)", () => {
    const missing = openTranscript({ path: join(dir, "nope.jsonl"), resume: true });
    expect(missing.failed()).toBe(true);
    const real = join(dir, "real.jsonl");
    writeFileSync(real, JSON.stringify(header(dir)) + "\n");
    const link = join(dir, "link.jsonl");
    symlinkSync(real, link);
    const viaLink = openTranscript({ path: link, resume: true });
    expect(viaLink.failed()).toBe(true);
    expect(readTranscriptHeader(link)).toBeUndefined();
    expect(readTranscriptHeader(real)).toEqual(header(dir));
  });

  it("readTranscriptHeader: bad shapes / non-header / oversized first line ⇒ undefined", () => {
    const write = (name: string, content: string) => {
      const f = join(dir, name);
      writeFileSync(f, content);
      return f;
    };
    expect(readTranscriptHeader(write("a", '{"type":"session"}\n'))).toBeUndefined();
    expect(readTranscriptHeader(write("b", "not json\n"))).toBeUndefined();
    expect(readTranscriptHeader(write("c", JSON.stringify({ ...header(dir), version: 2 }) + "\n"))).toBeUndefined();
    expect(readTranscriptHeader(write("d", JSON.stringify({ ...header(dir), cwd: 3 }) + "\n"))).toBeUndefined();
    expect(readTranscriptHeader(write("e", "x".repeat(70_000)))).toBeUndefined();
    expect(readTranscriptHeader(join(dir, "missing"))).toBeUndefined();
    expect(readTranscriptHeader(dir)).toBeUndefined(); // directory
    chmodSync(write("f", "{}"), 0o600);
  });
});
