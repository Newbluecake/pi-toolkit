/** F8 attachment adapter. Inbound staging is private, size-known uploads use ONE principal.
 * Outbound NEVER opens a raw candidate: the preview admitter must supply its verified fd. */
import { randomBytes } from "node:crypto";
import { open, readdir, unlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { FEISHU_CAPS, FEISHU_FILE_LIMITS, FEISHU_RECEIVED_BODY_MAX_BYTES } from "../../protocol/feishu.js";
import {
  formatAttachmentBlock,
  formatAttachmentSize,
  sanitizeUploadName,
  UPLOAD_FILE_MAX_BYTES,
  type AttachmentItem,
} from "../../protocol/upload.js";
import { createReqDeadline } from "../req-deadline.js";
import type { FsAdmitter } from "../preview/admit.js";
import type { UploadStore, PinToken, CommitResult } from "../uploads.js";
import { ensurePrivateDir, realFeishuFs } from "./credentials.js";
import type { FeishuApi } from "./api.js";
import type { FeishuIdentityContext } from "./admission.js";
import type { FeishuMessage } from "./inbound.js";
import type { FeishuSessionView } from "./sessions.js";
import type { RequestPayload } from "./state.js";
import { systemFeishuClock, type FeishuClock } from "./http.js";
import { bounded, object, feishuKey } from "./runtime.js";
import type { OutboxMessage } from "./outbox.js";

export type FeishuUploadPort = Pick<
  UploadStore,
  "begin" | "chunk" | "commit" | "abort" | "pinForPrompt" | "settlePins" | "flushReferences"
>;
export interface FeishuFilesDeps {
  dir: string;
  api: Pick<FeishuApi, "downloadResource" | "uploadImage" | "uploadFile">;
  uploads?: FeishuUploadPort;
  preview?: FsAdmitter;
  clock?: FeishuClock;
  inbound: boolean;
  maxInboundMiB: number;
  outbound: "auto" | "buttons" | "off";
  resolve(message: FeishuMessage): FeishuSessionView | undefined;
}
interface Resource {
  key: string;
  type: "image" | "file";
  name: string;
}
export function feishuResources(message: FeishuMessage): Resource[] {
  const result: Resource[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || result.length >= 20) return;
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 100)) visit(v, depth + 1);
      return;
    }
    const r = object(value);
    if (!r) return;
    const image = r["image_key"],
      file = r["file_key"];
    // A media tag's image_key is just the video cover thumbnail (Feishu docs) — never fetch it.
    if (typeof image === "string" && r["tag"] !== "media")
      result.push({ key: image, type: "image", name: "image.png" });
    if (typeof file === "string" && result.length < 20)
      result.push({
        key: file,
        type: "file",
        name: typeof r["file_name"] === "string" ? r["file_name"] : "attachment.bin",
      });
    for (const [key, v] of Object.entries(r).slice(0, 100))
      if (key !== "image_key" && key !== "file_key") visit(v, depth + 1);
  };
  visit(message.content, 0);
  return result.filter((r, i, all) => all.findIndex((x) => x.key === r.key) === i);
}
export function feishuFileCandidates(text: string): string[] {
  const found: string[] = [];
  const add = (path: string) => {
    if (
      (path.startsWith("/") || path.startsWith("~/")) &&
      path.split("/").filter(Boolean).length >= 2 &&
      path.length <= 4_096 &&
      !/[\p{Cc}\p{Cf}]/u.test(path) &&
      !found.includes(path) &&
      found.length < 8
    )
      found.push(path);
  };
  for (const m of text.slice(0, 1_000_000).matchAll(/`([^`\n]+)`|(?:^|\s)((?:~\/|\/)[^\s<>`"']+)/g))
    add((m[1] ?? m[2] ?? "").replace(/[),;。]+$/, ""));
  return found;
}
/** Explicit extension → MIME map for inbound attachments. Never content-sniffed; unknown extensions
 * stay "unknown type". Every value satisfies protocol/upload.ts's normalizeMime RFC-token grammar. */
const FEISHU_MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};
export function feishuMimeForName(name: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,16})$/.exec(name);
  return match ? FEISHU_MIME_BY_EXT[match[1]!.toLowerCase()] : undefined;
}
export function feishuImage(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  return (
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString()) ||
    (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
  );
}
export function createFeishuFiles(deps: FeishuFilesDeps) {
  const clock = deps.clock ?? systemFeishuClock;
  const staging = join(deps.dir, "staging");
  const active = new Set<AbortController>();
  const pins = new Map<string, { token: PinToken; at: number }[]>();
  let reserved = 0,
    disposed = false;
  // Physical IO reservations survive a deadline: a hung fs op cannot free a slot and starve libuv.
  const ioJobs = new Set<Promise<unknown>>();
  async function io<T>(lazy: () => Promise<T>, budget: number, late?: (value: T) => void): Promise<T> {
    if (disposed || ioJobs.size >= 2 || budget <= 0) throw new Error("files-io-busy");
    let timedOut = false;
    const raw = Promise.resolve().then(lazy);
    ioJobs.add(raw);
    void raw.then(
      (value) => {
        ioJobs.delete(raw);
        if (timedOut) late?.(value);
      },
      () => {
        ioJobs.delete(raw);
      },
    );
    try {
      return await bounded(raw, budget, clock);
    } catch {
      timedOut = true;
      throw new Error("files-io-failed");
    }
  }
  const lateHandle = (fh: Awaited<ReturnType<typeof open>>) => {
    void fh.close().catch(() => {});
  };
  const principal = (identity: FeishuIdentityContext) => `feishu:${identity.installGen}:${identity.senderOpenId}`;
  const cap = Math.min(UPLOAD_FILE_MAX_BYTES, deps.maxInboundMiB * 1024 * 1024, 30 * 1024 * 1024);
  function settle(messageId: string, outcome: "referenced" | "released") {
    for (const p of pins.get(messageId) ?? []) deps.uploads?.settlePins(p.token, outcome);
    pins.delete(messageId);
  }
  async function store(
    bytesPath: string,
    size: number,
    name: string,
    identity: FeishuIdentityContext,
    view: FeishuSessionView,
    signal: AbortSignal,
    deadline: number,
  ): Promise<CommitResult> {
    const uploads = deps.uploads;
    if (!uploads) throw new Error("uploads-off");
    const p = principal(identity),
      id = randomBytes(16).toString("hex"),
      mime = feishuMimeForName(name);
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await bounded(
        uploads.begin(
          {
            principal: p,
            agentKey: view.agentKey,
            sessionId: view.sessionId,
            id,
            name: sanitizeUploadName(name),
            size,
            ...(mime !== undefined ? { mime } : {}),
          },
          { at: deadline },
        ),
        Math.max(0, deadline - clock.now()),
        clock,
      );
      fh = await io(
        () => open(bytesPath, constants.O_RDONLY | constants.O_NOFOLLOW),
        Math.max(0, deadline - clock.now()),
        lateHandle,
      );
      let offset = 0;
      while (offset < size) {
        if (disposed || signal.aborted) throw new Error("aborted");
        const buffer = Buffer.alloc(Math.min(256 * 1024, size - offset));
        const { bytesRead } = await io(
          () => fh!.read(buffer, 0, buffer.length, offset),
          Math.max(0, deadline - clock.now()),
        );
        if (!bytesRead) throw new Error("short-read");
        await bounded(
          uploads.chunk({ principal: p, id, offset, bytes: buffer.subarray(0, bytesRead) }, { at: deadline }),
          Math.max(0, deadline - clock.now()),
          clock,
        );
        offset += bytesRead;
      }
      if (disposed || signal.aborted) throw new Error("aborted");
      return await bounded(
        uploads.commit({ principal: p, id }, { at: deadline }),
        Math.max(0, deadline - clock.now()),
        clock,
      );
    } catch {
      try {
        await bounded(uploads.abort({ principal: p, id }, { at: clock.now() + 1_000 }), 1_000, clock);
      } catch {
        /* partial poisoned by store */
      }
      throw new Error("upload-failed");
    } finally {
      if (fh) await bounded(fh.close(), 1_000, clock).catch(() => {});
    }
  }
  async function stage(
    resource: Resource | { text: string; name: string },
    message: FeishuMessage,
    identity: FeishuIdentityContext,
    view: FeishuSessionView,
  ): Promise<CommitResult> {
    if (disposed || active.size >= 4 || reserved + cap > FEISHU_CAPS.stagingBytes) throw new Error("files-busy");
    const controller = new AbortController();
    active.add(controller);
    reserved += cap;
    const path = join(staging, `${randomBytes(16).toString("hex")}.part`);
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    const deadline = clock.now() + 30_000;
    try {
      if (!(await io(() => ensurePrivateDir(realFeishuFs, staging), 1_000)).ok) throw new Error("staging-unsafe");
      fh = await io(
        () => open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600),
        1_000,
        lateHandle,
      );
      let size = 0;
      const sink = async (bytes: Uint8Array) => {
        if (disposed || controller.signal.aborted || size + bytes.length > cap) throw new Error("file-cap");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await io(
            () => fh!.write(bytes, offset, bytes.length - offset, size),
            Math.max(0, deadline - clock.now()),
          );
          if (!bytesWritten) throw new Error("short-write");
          size += bytesWritten;
          offset += bytesWritten;
        }
      };
      if ("text" in resource) await sink(Buffer.from(resource.text));
      else {
        const result = await bounded(
          deps.api.downloadResource({
            messageId: message.messageId,
            fileKey: resource.key,
            type: resource.type,
            maxBytes: cap,
            sink,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
          30_000,
          clock,
        );
        if (!result.ok) throw new Error("download-failed");
      }
      await io(() => fh!.sync(), Math.max(0, deadline - clock.now()));
      await bounded(fh.close(), 1_000, clock);
      fh = undefined;
      return await store(path, size, resource.name, identity, view, controller.signal, deadline);
    } finally {
      controller.abort();
      if (fh) await bounded(fh.close(), 1_000, clock).catch(() => {});
      await bounded(unlink(path), 1_000, clock).catch(() => {});
      active.delete(controller);
      reserved -= cap;
    }
  }
  return {
    async sweep() {
      // A private, generated-only directory. Never recursively delete an attacker-selected name.
      try {
        if (!(await io(() => ensurePrivateDir(realFeishuFs, staging), 1_000)).ok) return;
        for (const name of (await io(() => readdir(staging), 1_000)).slice(0, 256))
          if (/^[a-f0-9]{32}\.part$/.test(name)) await io(() => unlink(join(staging, name)), 1_000).catch(() => {});
      } catch {
        /* unavailable staging refuses later inbound files */
      }
    },
    async prepare(message: FeishuMessage, text: string, identity: FeishuIdentityContext): Promise<RequestPayload> {
      const resources = feishuResources(message),
        view = deps.resolve(message);
      const items: AttachmentItem[] = [],
        ids: string[] = [],
        errors: string[] = [];
      const source: Array<Resource | { text: string; name: string }> = [...resources];
      let body = text;
      if (Buffer.byteLength(body) > FEISHU_RECEIVED_BODY_MAX_BYTES) {
        source.push({ text: body, name: "message.txt" });
        body = "用户发送了长文本，见附件。";
      }
      for (const resource of source.slice(0, 20)) {
        if (!deps.inbound || !deps.uploads || !view) {
          errors.push("附件不可用");
          continue;
        }
        try {
          const file = await stage(resource, message, identity, view);
          const item = { path: file.path, mime: file.mime, sizeLabel: formatAttachmentSize(file.size) };
          const block = formatAttachmentBlock([item]);
          if (!block) throw new Error("attachment-invalid");
          const pin = deps.uploads.pinForPrompt({ principal: principal(identity), text: block });
          if (!pin.ok || disposed) {
            if (pin.ok) deps.uploads.settlePins(pin.token, "released");
            throw new Error("pin-failed");
          }
          const list = pins.get(message.messageId) ?? [];
          list.push({ token: pin.token, at: clock.now() });
          pins.set(message.messageId, list);
          ids.push(file.id);
          items.push(item);
        } catch {
          errors.push("附件下载/保存失败（大小限制或暂时不可用）");
        }
      }
      const block = formatAttachmentBlock(items);
      body = [body, block, ...errors].filter(Boolean).join("\n\n");
      // Attachment paths can consume the remaining 16KiB. Refuse, never silently truncate payload.
      if (Buffer.byteLength(body) > FEISHU_RECEIVED_BODY_MAX_BYTES) {
        settle(message.messageId, "released");
        return { body: "附件信息过长，请分开发送。", messageIds: [message.messageId], uploadIds: [] };
      }
      return { body: body || "请查看附件。", messageIds: [message.messageId], uploadIds: ids };
    },
    settle,
    expirePins() {
      for (const [id, list] of pins) if (list.every((p) => clock.now() - p.at > 60_000)) settle(id, "released");
    },
    async read(path: string, signal: AbortSignal, budgetMs = 1_500) {
      if (disposed || !deps.preview || deps.outbound === "off") return undefined;
      const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
      if (!isAbsolute(expanded)) return undefined;
      const deadline = createReqDeadline(clock.now, budgetMs);
      const result = await bounded(deps.preview.admit({ path: expanded }, deadline, signal), budgetMs, clock).catch(
        () => undefined,
      );
      if (!result?.ok || result.dir || result.size > FEISHU_FILE_LIMITS.outboundUploadMaxBytes) {
        if (result?.ok) await bounded(result.fh.close(), 1_000, clock).catch(() => {});
        return undefined;
      }
      try {
        const bytes = Buffer.alloc(result.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await io(
            () => result.fh.read(bytes, offset, bytes.length - offset, offset),
            deadline.remaining(),
          );
          if (!bytesRead || signal.aborted || disposed) return undefined;
          offset += bytesRead;
        }
        return {
          bytes,
          realpath: result.realpath,
          name: sanitizeUploadName(basename(result.realpath)),
          image: feishuImage(bytes),
        };
      } finally {
        await bounded(result.fh.close(), 1_000, clock).catch(() => {});
      }
    },
    async upload(
      file: { bytes: Uint8Array; name: string; image: boolean },
      signal: AbortSignal,
    ): Promise<OutboxMessage | undefined> {
      if (disposed || deps.outbound === "off" || file.bytes.length > FEISHU_FILE_LIMITS.outboundUploadMaxBytes)
        return undefined;
      if (file.image) {
        const r = await bounded(
          deps.api.uploadImage({ bytes: file.bytes, fileName: file.name, signal }),
          30_000,
          clock,
        );
        return r.ok ? { msgType: "image", content: JSON.stringify({ image_key: r.data.imageKey }) } : undefined;
      }
      const r = await bounded(deps.api.uploadFile({ bytes: file.bytes, fileName: file.name, signal }), 30_000, clock);
      return r.ok ? { msgType: "file", content: JSON.stringify({ file_key: r.data.fileKey }) } : undefined;
    },
    async autoEligible(
      file: { image: boolean; bytes: Uint8Array; realpath: string },
      cwd: string,
      p2p: boolean,
      attributed: boolean,
    ): Promise<boolean> {
      if (deps.outbound !== "auto" || !p2p || !attributed || !file.image || file.bytes.length > 10 * 1024 * 1024)
        return false;
      const root = await io(() => realpath(cwd), 1_500).catch(() => undefined);
      if (!root) return false;
      const rel = relative(root, file.realpath);
      return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    },
    dispose() {
      disposed = true;
      for (const c of active) c.abort();
      for (const id of pins.keys()) settle(id, "released");
    },
    get stagingBytes() {
      return reserved;
    },
  };
}
export type FeishuFiles = ReturnType<typeof createFeishuFiles>;
