import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  createFeishuFiles,
  feishuImage,
  feishuFileCandidates,
  type FeishuUploadPort,
} from "../../../../src/web-hub/hub/feishu/files.js";
import { createFeishuHttp } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";
import { createTokenManager } from "../../../../src/web-hub/hub/feishu/token.js";
import { createFakeFeishu } from "../../../fixtures/feishu/fake-http.js";
import { normalizedMessage, messageEnvelope } from "../../../fixtures/feishu/f6.js";
import { f8Rig, eventually, sentContent } from "../../../fixtures/feishu/f8.js";
import { createFsAdmitter, denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import type { BeginParams } from "../../../../src/web-hub/hub/uploads.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function uploads() {
  const pending = new Map<string, { input: BeginParams; bytes: Buffer }>(),
    committed = new Map<string, Buffer>(),
    principals: string[] = [],
    settled: string[] = [];
  const port: FeishuUploadPort = {
    begin: vi.fn(async (input) => {
      principals.push(input.principal);
      pending.set(input.id, { input, bytes: Buffer.alloc(0) });
      return { id: input.id, received: 0, maxBytes: 30 * 1024 * 1024 };
    }),
    chunk: vi.fn(async (input) => {
      const r = pending.get(input.id)!;
      expect(input.principal).toBe(r.input.principal);
      principals.push(input.principal);
      expect(input.offset).toBe(r.bytes.length);
      r.bytes = Buffer.concat([r.bytes, input.bytes]);
      return { received: r.bytes.length };
    }),
    commit: vi.fn(async (input) => {
      const r = pending.get(input.id)!;
      expect(input.principal).toBe(r.input.principal);
      principals.push(input.principal);
      expect(r.bytes.length).toBe(r.input.size);
      committed.set(input.id, r.bytes);
      pending.delete(input.id);
      return { id: input.id, path: `/uploads/${input.id}.bin`, size: r.bytes.length, mime: null };
    }),
    abort: vi.fn(async (input) => {
      principals.push(input.principal);
      pending.delete(input.id);
    }),
    pinForPrompt: vi.fn((input) => {
      principals.push(input.principal);
      return { ok: true, token: { ids: [...committed.keys()] } };
    }),
    settlePins: vi.fn((_token, outcome) => {
      settled.push(outcome);
    }),
    flushReferences: vi.fn(async () => "ok"),
  };
  return { port, pending, committed, principals, settled };
}
async function standalone(overrides: { maxInboundMiB?: number; outbound?: "auto" | "buttons" | "off" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "feishu-files-"));
  const fake = createFakeFeishu(),
    http = createFeishuHttp({ apiBase: "https://open.feishu.cn", fetch: fake.fetch }),
    token = createTokenManager({ http, credentials: () => ({ appId: fake.appId, appSecret: fake.appSecret, gen: 7 }) }),
    api = createFeishuApi({ http, token });
  const storage = uploads();
  const preview = createFsAdmitter({
    denyCtx: denyCtxOf(homedir(), join(homedir(), ".pi/agent")),
    tracker: createPreviewIoTracker(),
    now: Date.now,
    log: { info() {}, warn() {}, error() {} },
  });
  const files = createFeishuFiles({
    dir,
    api,
    uploads: storage.port,
    preview,
    inbound: true,
    outbound: "auto",
    maxInboundMiB: 30,
    resolve: () => ({ sessionId: "session", agentKey: "agent", cwd: dir, mode: "tui", live: true, state: "idle" }),
    ...overrides,
  });
  cleanup.push(async () => {
    files.dispose();
    token.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { files, api, fake, dir, ...storage };
}
describe("F8 files", () => {
  it("streams unknown-length inbound image into private staging then uploads known bytes under one principal", async () => {
    const r = await standalone();
    r.fake.resources.set("image", { bytes: png, contentLength: false });
    const m = normalizedMessage("image", "look");
    m.messageType = "image";
    m.content = { image_key: "image" };
    const payload = await r.files.prepare(m, m.text, { installGen: 7, tenantKey: "tenant", senderOpenId: "ou_owner" });
    expect(payload.body).toContain("[web-hub attachments]");
    expect(payload.uploadIds).toHaveLength(1);
    expect([...r.committed.values()][0]).toEqual(png);
    expect(new Set(r.principals)).toEqual(new Set(["feishu:7:ou_owner"]));
    expect(await readdir(join(r.dir, "staging"))).toEqual([]);
    r.files.settle(m.messageId, "referenced");
    expect(r.settled).toEqual(["referenced"]);
  });
  it("long inbound text becomes an exact txt attachment, never truncated", async () => {
    const r = await standalone();
    const text = "中".repeat(10_000);
    const m = normalizedMessage("long", text);
    const payload = await r.files.prepare(m, text, { installGen: 7, tenantKey: "tenant", senderOpenId: "ou_owner" });
    expect(Buffer.byteLength(payload.body)).toBeLessThanOrEqual(16_384);
    expect([...r.committed.values()][0]!.toString()).toBe(text);
  });
  it("download failure and size cap are explicit, staging cleaned, no upload/pin", async () => {
    const r = await standalone({ maxInboundMiB: 1 });
    r.fake.resources.set("big", { bytes: Buffer.alloc(1_048_577), contentLength: true });
    const m = normalizedMessage("big");
    m.content = { file_key: "big", file_name: "../../x" };
    const payload = await r.files.prepare(m, "", { installGen: 7, tenantKey: "tenant", senderOpenId: "ou_owner" });
    expect(payload.body).toContain("失败");
    expect(payload.uploadIds).toEqual([]);
    expect(r.port.begin).not.toHaveBeenCalled();
    expect(await readdir(join(r.dir, "staging"))).toEqual([]);
  });
  it("partial store error aborts under same principal and releases pins", async () => {
    const r = await standalone();
    r.fake.resources.set("file", { bytes: png });
    vi.mocked(r.port.chunk).mockRejectedValueOnce(new Error("failed"));
    const m = normalizedMessage("partial");
    m.content = { file_key: "file" };
    const payload = await r.files.prepare(m, "", { installGen: 7, tenantKey: "tenant", senderOpenId: "ou_owner" });
    expect(payload.uploadIds).toEqual([]);
    expect(r.port.abort).toHaveBeenCalledWith(
      expect.objectContaining({ principal: "feishu:7:ou_owner" }),
      expect.anything(),
    );
    expect(r.pending.size).toBe(0);
  });
  it("R-16 matrix: p2p attributed cwd images only; canonical symlink outside cwd never auto-sends", async () => {
    const r = await standalone(),
      outside = await mkdtemp(join(tmpdir(), "feishu-outside-"));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(r.dir, "image.png"), png);
    await writeFile(join(outside, "image.png"), png);
    await symlink(join(outside, "image.png"), join(r.dir, "link.png"));
    const c = new AbortController(),
      own = await r.files.read(join(r.dir, "image.png"), c.signal),
      linked = await r.files.read(join(r.dir, "link.png"), c.signal);
    expect(own).toBeDefined();
    expect(linked).toBeDefined();
    expect(await r.files.autoEligible(own!, r.dir, true, true)).toBe(true);
    expect(await r.files.autoEligible(own!, r.dir, false, true)).toBe(false);
    expect(await r.files.autoEligible(own!, r.dir, true, false)).toBe(false);
    expect(await r.files.autoEligible(linked!, r.dir, true, true)).toBe(false);
    const msg = await r.files.upload(own!, c.signal);
    expect(msg?.msgType).toBe("image");
    expect(r.fake.callsTo("POST", /images$/)[0]!.form!.file!.size).toBe(png.length);
  });
  it("denylisted explicit file refuses even when it is readable", async () => {
    const r = await standalone();
    await writeFile(join(r.dir, ".env"), "secret");
    expect(await r.files.read(join(r.dir, ".env"), new AbortController().signal)).toBeUndefined();
    expect(r.fake.callsTo("POST", /files$/)).toHaveLength(0);
  });
  it("candidates are bounded/deduped; file sniffing is by magic not extension", () => {
    expect(feishuFileCandidates("`/repo/a.png` /repo/a.png ~/repo/b.png /x")).toEqual(["/repo/a.png", "~/repo/b.png"]);
    expect(feishuFileCandidates(Array.from({ length: 20 }, (_, i) => `/repo/f${i}`).join(" "))).toHaveLength(8);
    expect(feishuImage(Buffer.from("not image.png"))).toBe(false);
    expect(feishuImage(png)).toBe(true);
  });
  it("in-process attachment inbound/outbound integrates upload pinning, prompt block and outbox", async () => {
    const storage = uploads();
    const preview = createFsAdmitter({
      denyCtx: denyCtxOf(homedir(), join(homedir(), ".pi/agent")),
      tracker: createPreviewIoTracker(),
      now: Date.now,
      log: { info() {}, warn() {}, error() {} },
    });
    const r = await f8Rig({ uploads: storage.port, preview });
    cleanup.push(() => r.close());
    await r.ready();
    await r.bind();
    r.fake.resources.set("resource", { bytes: png });
    const m = messageEnvelope("attachment", "look");
    m.event.message.message_type = "image";
    m.event.message.content = JSON.stringify({ image_key: "resource" });
    r.send(m);
    await eventually(() => expect(r.request).toHaveBeenCalled());
    const frame = r.request.mock.calls[0]![0];
    if (frame.cmd.op !== "prompt") throw new Error("not prompt");
    expect(frame.cmd.text).toContain("[web-hub attachments]");
    expect([...storage.committed.values()][0]).toEqual(png);
    const path = join(r.stateDir, "reply.png");
    await writeFile(path, png);
    r.finish(frame.cmd.text, `see \`${path}\``);
    await eventually(() => expect(r.fake.sent.some((s) => s.body["msg_type"] === "image")).toBe(true));
    expect(storage.settled).toContain("referenced");
    expect(storage.principals.every((p) => p === `feishu:${r.service.snapshot().gen}:ou_owner`)).toBe(true);
  });
});
