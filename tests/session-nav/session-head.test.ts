// web-resume plan §4 P1: the bounded head/tail reader (header/marker/name in head and tail,
// first-user loose extraction, oversized line, too-long header) plus its fd contract.

import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_HEAD_LIMITS,
  readSessionHeadFd,
  SUBAGENT_CHILD_MARKER_TYPE,
  type HeadResult,
} from "../../src/session-nav/session-head.js";
import { childMarkerLine, dropLayout, headerLine, makeLayout, nameLine, userLine, type Layout } from "./helpers.js";

let layout: Layout;
let seq = 0;

beforeEach(async () => {
  layout = await makeLayout();
});
afterEach(async () => {
  await dropLayout(layout);
});

async function withTempFile(content: string, fn: (fd: number, size: number) => void | Promise<void>): Promise<void> {
  seq += 1;
  const path = join(layout.sessionDir, `head-${seq}.jsonl`);
  await writeFile(path, content, "utf8");
  const handle = await open(path, "r");
  try {
    await fn(handle.fd, Buffer.byteLength(content, "utf8"));
  } finally {
    await handle.close();
  }
}

function expectOk(result: HeadResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.invalid}`);
  return result.head;
}

describe("readSessionHeadFd — full parse", () => {
  test("header, line-2 child marker, session_info name and first user message", async () => {
    const content =
      [headerLine("sess-1", "/project"), childMarkerLine(), userLine("你好世界"), nameLine("改名")].join("\n") + "\n";
    await withTempFile(content, (fd, size) => {
      const head = expectOk(readSessionHeadFd(fd, size));
      expect(head.id).toBe("sess-1");
      expect(head.cwd).toBe("/project");
      expect(head.child).toBe(true);
      expect(head.firstMessage).toBe("你好世界");
      expect(head.name).toBe("改名");
      expect(head.forked).toBe(false);
    });
  });

  test("parentSession ⇒ forked (a fork is NOT a child)", async () => {
    const forked = JSON.stringify({
      type: "session",
      id: "sess-fork",
      timestamp: "2026-10-16T00:00:00.000Z",
      cwd: "/project",
      parentSession: "/somewhere/parent.jsonl",
    });
    await withTempFile(`${forked}\n${userLine("hi")}\n`, (fd, size) => {
      const head = expectOk(readSessionHeadFd(fd, size));
      expect(head.forked).toBe(true);
      expect(head.child).toBe(false);
    });
  });

  test("string message content is accepted for firstMessage", async () => {
    const line = JSON.stringify({ type: "message", message: { role: "user", content: "plain text" } });
    await withTempFile(`${headerLine("s")}\n${line}\n`, (fd, size) => {
      expect(expectOk(readSessionHeadFd(fd, size)).firstMessage).toBe("plain text");
    });
  });

  test("assistant messages do not become firstMessage; later user messages are ignored", async () => {
    const assistant = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "nope" }] },
    });
    await withTempFile(
      `${headerLine("s")}\n${assistant}\n${userLine("first")}\n${userLine("second")}\n`,
      (fd, size) => {
        expect(expectOk(readSessionHeadFd(fd, size)).firstMessage).toBe("first");
      },
    );
  });
});

describe("readSessionHeadFd — tail window", () => {
  test("the last session_info name in the tail wins over an earlier head name", async () => {
    // > 64 KiB head window: filler pushes the rename into the tail window.
    const filler = JSON.stringify({ type: "custom", customType: "t:f", data: "y".repeat(1024) }) + "\n";
    const headPart = `${headerLine("s")}\n${nameLine("旧名")}\n` + filler.repeat(80);
    const tailPart = `${nameLine("新名")}\n`;
    const content = headPart + tailPart;
    expect(Buffer.byteLength(content)).toBeGreaterThan(DEFAULT_HEAD_LIMITS.headBytes);
    await withTempFile(content, (fd, size) => {
      const head = expectOk(readSessionHeadFd(fd, size));
      expect(head.name).toBe("新名");
      expect(head.firstMessage).toBeUndefined();
    });
  });

  test("a child marker only reachable in the tail window is detected", async () => {
    const filler = JSON.stringify({ type: "custom", customType: "t:f", data: "y".repeat(1024) }) + "\n";
    const content = `${headerLine("s")}\n` + filler.repeat(80) + `${childMarkerLine()}\n`;
    await withTempFile(content, (fd, size) => {
      expect(expectOk(readSessionHeadFd(fd, size)).child).toBe(true);
    });
  });

  test("tail lines never contribute firstMessage", async () => {
    const filler = JSON.stringify({ type: "custom", customType: "t:f", data: "y".repeat(1024) }) + "\n";
    const content = `${headerLine("s")}\n` + filler.repeat(80) + `${userLine("late")}\n`;
    await withTempFile(content, (fd, size) => {
      expect(expectOk(readSessionHeadFd(fd, size)).firstMessage).toBeUndefined();
    });
  });
});

describe("readSessionHeadFd — loose extraction and oversized lines", () => {
  test("a first-user line larger than the remaining window is loose-extracted", async () => {
    const long = "z".repeat(900);
    const content = `${headerLine("s")}\n${userLine(long)}\n`;
    const limits = { headBytes: 256, tailBytes: 128, headerLineBytes: 4096 };
    await withTempFile(content, (fd, size) => {
      const head = expectOk(readSessionHeadFd(fd, size, limits));
      expect(head.firstMessage).toContain("zzzz");
      expect(head.firstMessage!.length).toBeGreaterThan(0);
    });
  });

  test("a user line larger than the default 64 KiB head window is loose-extracted", async () => {
    const long = "q".repeat(100 * 1024);
    const content = `${headerLine("s")}\n${userLine(long)}\n`;
    await withTempFile(content, (fd, size) => {
      const head = expectOk(readSessionHeadFd(fd, size));
      expect(head.firstMessage!.startsWith("qqqq")).toBe(true);
    });
  });

  test("an oversized header line (>4 KiB without newline) ⇒ too-long-header", async () => {
    const content = `{"type":"session","id":"s","cwd":"/p","junk":"${"k".repeat(5000)}\n${userLine("x")}\n`;
    await withTempFile(content, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "too-long-header" });
    });
  });

  test("a header line >4 KiB terminated inside the window ⇒ too-long-header", async () => {
    const content = `{"pad":"${"k".repeat(5000)}"}\n${userLine("x")}\n`;
    await withTempFile(content, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "too-long-header" });
    });
  });
});

describe("readSessionHeadFd — invalid headers", () => {
  test("empty file ⇒ no-header", async () => {
    await withTempFile("", (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "no-header" });
    });
  });

  test("garbage line 1 ⇒ bad-header", async () => {
    await withTempFile("not json\n", (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "bad-header" });
    });
  });

  test("id not matching RESTORE_SESSION_ID_RE ⇒ bad-header", async () => {
    await withTempFile(`${headerLine("bad/id!")}\n`, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "bad-header" });
    });
  });

  test("relative cwd ⇒ bad-header", async () => {
    await withTempFile(`${headerLine("s", "relative/path")}\n`, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "bad-header" });
    });
  });

  test("non-session type on line 1 ⇒ bad-header", async () => {
    await withTempFile(`${userLine("x")}\n`, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "bad-header" });
    });
  });

  test("a marker line as line 1 does not parse as a header (marker must come after)", async () => {
    await withTempFile(`${childMarkerLine()}\n`, (fd, size) => {
      expect(readSessionHeadFd(fd, size)).toEqual({ ok: false, invalid: "bad-header" });
    });
  });
});

describe("readSessionHeadFd — fd contract", () => {
  test("does not close the caller's fd", async () => {
    const content = `${headerLine("s")}\n${userLine("x")}\n`;
    await withTempFile(content, (fd, size) => {
      expectOk(readSessionHeadFd(fd, size));
      // A second full read on the same fd still works ⇒ the fd is intact (closed by the
      // test's own FileHandle in the finally above, not by the reader).
      const again = expectOk(readSessionHeadFd(fd, size));
      expect(again.id).toBe("s");
    });
  });

  test("other custom types are not mistaken for the child marker", async () => {
    const other = JSON.stringify({ type: "custom", customType: "subagent:run", data: {} });
    await withTempFile(`${headerLine("s")}\n${other}\n`, (fd, size) => {
      expect(expectOk(readSessionHeadFd(fd, size)).child).toBe(false);
    });
  });

  test("marker literal is subagent:child", () => {
    expect(SUBAGENT_CHILD_MARKER_TYPE).toBe("subagent:child");
  });
});
