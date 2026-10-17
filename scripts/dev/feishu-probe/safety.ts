import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { missingScopes, ProbeError } from "./errors.ts";

export const probeDir = join(homedir(), ".pi", "agent", "feishu-probe");
export type Brand = "feishu" | "lark";
export interface Credentials {
  v: 1;
  brand: Brand;
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  createdAt: string;
  gen: string;
}
export function hashId(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 16);
}
// Only protocol-machine strings survive. Unrecognized strings are length-only,
// including API error messages (which can echo credentials or user content).
const machineKeys = new Set([
  "phase",
  "operation",
  "method",
  "emoji_type",
  "consoleSwitch",
  "type",
  "event_type",
  "chat_type",
  "message_type",
  "sender_type",
  "schema",
  "payload_encoding",
  "payload_type",
  "unit",
  "status",
  "error",
  "host",
  "protocol",
  "brand",
  "app_id",
  "appId",
  "step",
  "connection",
  "mode",
  "reason",
  "check",
  "source",
]);
export function redact(value: unknown, key = "", secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (/secret|token|authorization|device.?code|cookie|verification_uri|qrurl/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (secrets.some((s) => s.length > 0 && value.includes(s))) return "[redacted]";
    if (
      /open_?id|union_?id|user_?id|tenant_?key|chat_?id|message_?id|event_?id|thread_?id|trace_?id|device_?id/i.test(
        key,
      ) ||
      /^(ou_|on_|oc_)/.test(value)
    )
      return hashId(value);
    if (/url|uri/i.test(key) || /^wss?:/i.test(value)) return "[redacted-url]";
    if (key === "scopes" && missingScopes(value, secrets).includes(value)) return value;
    if (machineKeys.has(key) && /^[a-zA-Z0-9_.: /-]{0,160}$/.test(value)) return value;
    return { length: value.length, bytes: Buffer.byteLength(value) };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 128).map((v) => redact(v, key, secrets, depth + 1));
  if (value && typeof value === "object") {
    // Keys from JSON are never echoed unchecked (card values/content can use user text as keys).
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 128)) {
      const safeKey = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(k) ? k : hashId(k);
      Object.defineProperty(out, safeKey, { value: redact(v, k, secrets, depth + 1), enumerable: true });
    }
    return out;
  }
  return null;
}
export function apiBase(brand: Brand): string {
  return brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}
export function accountsBase(brand: Brand): string {
  return brand === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
}
export function allowedUrl(input: string, kind: "api" | "accounts" | "ws" | "display"): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProbeError("protocol", "destination-refused");
  }
  if (url.username || url.password || url.hash || (url.port && url.port !== "443"))
    throw new ProbeError("protocol", "destination-refused");
  const ok =
    kind === "ws"
      ? url.protocol === "wss:" && [".feishu.cn", ".larksuite.com"].some((s) => url.hostname.endsWith(s))
      : kind === "display"
        ? url.protocol === "https:" && [".feishu.cn", ".larksuite.com"].some((s) => url.hostname.endsWith(s))
        : url.protocol === "https:" &&
          (kind === "api"
            ? ["open.feishu.cn", "open.larksuite.com"].includes(url.hostname)
            : ["accounts.feishu.cn", "accounts.larksuite.com"].includes(url.hostname));
  if (!ok) throw new ProbeError("protocol", "destination-refused");
  return url;
}
export async function privateDir(dir = probeDir): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new ProbeError("credential", "directory-symlink");
  if (!st.isDirectory()) throw new ProbeError("credential", "directory-not-directory");
  if (st.uid !== process.getuid?.()) throw new ProbeError("credential", "directory-owner");
  if (st.mode & 0o077) throw new ProbeError("credential", "directory-mode");
}
export async function readCredentials(dir = probeDir): Promise<Credentials> {
  await privateDir(dir);
  const path = join(dir, "credentials.json");
  const validate = (st: Stats) => {
    if (st.isSymbolicLink()) throw new ProbeError("credential", "file-symlink");
    if (!st.isFile()) throw new ProbeError("credential", "file-not-regular");
    if (st.uid !== process.getuid?.()) throw new ProbeError("credential", "file-owner");
    if (st.mode & 0o077) throw new ProbeError("credential", "file-mode");
    if (st.size > 4096) throw new ProbeError("credential", "file-size");
  };
  const before = await lstat(path);
  validate(before);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    validate(st);
    if (st.dev !== before.dev || st.ino !== before.ino) throw new ProbeError("credential", "file-identity-changed");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new ProbeError("credential", "file-size");
    let c: Credentials;
    try {
      c = JSON.parse(buffer.subarray(0, bytesRead).toString()) as Credentials;
    } catch {
      throw new ProbeError("credential", "file-json");
    }
    if (
      !c ||
      c.v !== 1 ||
      !["feishu", "lark"].includes(c.brand) ||
      !/^cli_[\w-]+$/.test(c.appId) ||
      typeof c.appSecret !== "string" ||
      !c.appSecret ||
      c.appSecret.length > 512 ||
      !/^ou_[\w-]+$/.test(c.ownerOpenId) ||
      typeof c.createdAt !== "string" ||
      typeof c.gen !== "string"
    )
      throw new ProbeError("credential", "file-schema");
    return c;
  } finally {
    await file.close();
  }
}
export async function writePrivate(
  name: string,
  value: unknown,
  dir = probeDir,
  signal?: AbortSignal,
): Promise<string> {
  await privateDir(dir);
  if (!/^[\w.-]+\.json$/.test(name)) throw new Error("unsafe-filename");
  const target = join(dir, name),
    temp = join(dir, ".tmp-" + randomBytes(12).toString("hex"));
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close();
    if (signal?.aborted) throw new Error("interrupted");
    await rename(temp, target);
  } catch (e) {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw e;
  }
  return target;
}
