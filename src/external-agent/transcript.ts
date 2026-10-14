/**
 * 外部会话 transcript（external-agent plan §4.6，格式冻结）：与 pi 条目同形的 jsonl，头行类型为 "external_session"。
 * 同步 IO、O_NOFOLLOW、目录 0700 / 文件 0600；写失败降级（failed()=true）而不影响 run；单文件 32MiB 上限后
 * 只追加一条截断 custom。pi-free，provider 无关。
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type {
  OpenTranscript,
  ReadTranscriptHeader,
  TranscriptEntry,
  TranscriptHeader,
  TranscriptWriter,
} from "./types.js";

export const TRANSCRIPT_TOOL_ARGS_MAX_BYTES = 8 * 1024;
export const TRANSCRIPT_TOOL_RESULT_MAX_BYTES = 16 * 1024;
export const TRANSCRIPT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const TRANSCRIPT_TRUNCATED_CUSTOM_TYPE = "subagent:external-truncated";
const HEADER_READ_MAX_BYTES = 64 * 1024;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function cutBytes(s: string, max: number): { text: string; cut: number } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, cut: 0 };
  let end = max;
  while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) end--;
  return { text: buf.toString("utf8", 0, end), cut: buf.length - end };
}

function truncText(s: string, max: number): string {
  const r = cutBytes(s, max);
  return r.cut === 0 ? s : `${r.text}…[truncated ${r.cut} bytes]`;
}

/** 深拷贝并按规格截断工具参数（8KiB）/ 工具结果（16KiB）。 */
function sanitizeMessage(message: unknown): unknown {
  const m = JSON.parse(JSON.stringify(message)) as Record<string, unknown> | null;
  if (m === null || typeof m !== "object") return m;
  const content = m.content;
  if (!Array.isArray(content)) return m;
  if (m.role === "toolResult") {
    for (const part of content) {
      const p = part as Record<string, unknown> | null;
      if (p !== null && typeof p === "object" && typeof p.text === "string")
        p.text = truncText(p.text, TRANSCRIPT_TOOL_RESULT_MAX_BYTES);
    }
  } else if (m.role === "assistant") {
    for (const part of content) {
      const p = part as Record<string, unknown> | null;
      if (p === null || typeof p !== "object" || p.type !== "toolCall") continue;
      const json = JSON.stringify(p.arguments ?? {});
      if (Buffer.byteLength(json) > TRANSCRIPT_TOOL_ARGS_MAX_BYTES)
        p.arguments = { truncated: truncText(json, TRANSCRIPT_TOOL_ARGS_MAX_BYTES) };
    }
  }
  return m;
}

function parseHeader(line: string): TranscriptHeader | undefined {
  let h: unknown;
  try {
    h = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (h === null || typeof h !== "object") return undefined;
  const r = h as Record<string, unknown>;
  if (r.type !== "external_session" || r.version !== 1) return undefined;
  for (const k of ["provider", "sessionId", "cwd", "modelId", "createdAt", "roleName", "runId"] as const)
    if (typeof r[k] !== "string") return undefined;
  return r as unknown as TranscriptHeader;
}

/** 有界同步读首行（≤64KiB，O_NOFOLLOW + 普通文件）；任何异常 ⇒ undefined。 */
export const readTranscriptHeader: ReadTranscriptHeader = (path) => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(HEADER_READ_MAX_BYTES);
    const n = readSync(fd, buf, 0, HEADER_READ_MAX_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0 && n >= HEADER_READ_MAX_BYTES) return undefined;
    return parseHeader(buf.toString("utf8", 0, nl < 0 ? n : nl));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
};

export const openTranscript: OpenTranscript = (o) => {
  const maxBytes = o.maxFileBytes ?? TRANSCRIPT_MAX_FILE_BYTES;
  const entries: TranscriptEntry[] = [];
  let leaf: string | undefined;
  let fd: number | undefined;
  let failed = false;
  let stopped = false; // 超限后停止写正文
  let size = 0;

  const fail = (): void => {
    failed = true;
    closeFd();
  };
  function closeFd(): void {
    if (fd === undefined) return;
    const f = fd;
    fd = undefined;
    try {
      closeSync(f);
    } catch {
      /* ignore */
    }
  }
  const writeLine = (obj: unknown): boolean => {
    if (fd === undefined || failed) return false;
    try {
      const line = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
      writeSync(fd, line, 0, line.length);
      size += line.length;
      return true;
    } catch {
      fail();
      return false;
    }
  };

  try {
    if (o.resume) {
      const rfd = openSync(o.path, constants.O_RDONLY | O_NOFOLLOW);
      try {
        const st = fstatSync(rfd);
        if (!st.isFile()) throw new Error("not a regular file");
        size = st.size;
        if (size > 2 * maxBytes) throw new Error("transcript too large to resume");
        const buf = Buffer.alloc(size);
        let off = 0;
        while (off < size) {
          const n = readSync(rfd, buf, off, size - off, off);
          if (n <= 0) break;
          off += n;
        }
        for (const line of buf.toString("utf8", 0, off).split("\n")) {
          if (line.length === 0) continue;
          try {
            const e = JSON.parse(line) as TranscriptEntry;
            if (e !== null && typeof e === "object" && (e.type === "message" || e.type === "custom") && e.id) {
              entries.push(e);
              leaf = e.id;
              if (e.type === "custom" && e.customType === TRANSCRIPT_TRUNCATED_CUSTOM_TYPE) stopped = true;
            }
          } catch {
            /* skip torn line */
          }
        }
      } finally {
        closeSync(rfd);
      }
      if (size >= maxBytes) stopped = true;
      fd = openSync(o.path, constants.O_WRONLY | constants.O_APPEND | O_NOFOLLOW);
    } else {
      mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
      fd = openSync(o.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW, 0o600);
      if (o.header !== undefined) writeLine(o.header);
    }
  } catch {
    fail();
  }

  const writer: TranscriptWriter = {
    path: o.path,
    append(entry) {
      if (stopped) return undefined;
      let record: TranscriptEntry;
      try {
        record = {
          type: entry.type,
          id: randomBytes(8).toString("hex"),
          parentId: leaf ?? null,
          timestamp: new Date().toISOString(),
          ...(entry.type === "message"
            ? { message: sanitizeMessage(entry.message) }
            : { customType: entry.customType, data: JSON.parse(JSON.stringify(entry.data ?? null)) as unknown }),
        };
      } catch {
        return undefined; // 不可序列化：丢弃该条
      }
      const approx = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (!failed && size + approx > maxBytes) {
        stopped = true;
        const marker: TranscriptEntry = {
          type: "custom",
          id: randomBytes(8).toString("hex"),
          parentId: leaf ?? null,
          timestamp: new Date().toISOString(),
          customType: TRANSCRIPT_TRUNCATED_CUSTOM_TYPE,
          data: { maxFileBytes: maxBytes },
        };
        writeLine(marker);
        entries.push(marker);
        leaf = marker.id;
        return undefined;
      }
      writeLine(record);
      entries.push(record);
      leaf = record.id;
      return record.id;
    },
    leafId: () => leaf,
    branch: () => entries.slice(),
    failed: () => failed,
    close: () => closeFd(),
  };
  return writer;
};
