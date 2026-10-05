// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, nextTick, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import {
  CONTROL_ENV,
  CONTROL_VIEW,
  HUB_CTX,
  type ControlEnv,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { Attachment, ControlHandle, HubHandle, UploadsHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` + `control/AttachmentTray.vue` upload wiring (web-hub-upload plan
 * §3.2/§4, package U5 — `docs/dev/web-hub-upload/plan.md`):
 *
 * - **三路径一致 (#12)**: the same deny conditions (uploading / failed / command+attachment /
 *   >48 KiB / sending / deny command / read-only) refuse Enter, Alt+Enter AND the button;
 *   under allow conditions all three emit the identical gate-composed text (Enter/click with
 *   the current deliver, Alt+Enter as followUp).
 * - the three entries (paste / drag&drop / attach button), tray interactions (remove →
 *   `uploads.remove`, retry → `uploads.retry`), the permanent plaintext warning, and §3.2's
 *   post-send tray clear via `discard` — NEVER `remove` (which would abort-delete the hub
 *   files the just-sent prompt references).
 */

const AGENT = "agent-a";
const READY_PATH = "/home/u/.pi/agent/web-hub/uploads/s-3f2a/id0001/shot.png";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false); // fine pointer by default; the coarse test re-stubs
});

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
});

function readyAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    name: "shot.png",
    size: 182 * 1024,
    mime: "image/png",
    state: "ready",
    path: READY_PATH,
    uploadedBytes: 182 * 1024,
    ...over,
  };
}

/** Controllable fake of U4b's `UploadsHandle` — tray refs the test can flip directly. */
function fakeUploads() {
  const trays = new Map<string, Ref<Attachment[]>>();
  let seq = 0;
  const calls = {
    add: [] as Array<{ key: string; files: unknown[] }>,
    remove: [] as Array<{ key: string; id: string }>,
    retry: [] as Array<{ key: string; id: string }>,
    discard: [] as Array<{ key: string; ids: readonly string[] | undefined }>,
  };
  function trayRef(key: string): Ref<Attachment[]> {
    let r = trays.get(key);
    if (r === undefined) {
      r = ref<Attachment[]>([]);
      trays.set(key, r);
    }
    return r;
  }
  const handle: UploadsHandle = {
    tray: (k) => trayRef(k),
    add(key, files) {
      calls.add.push({ key, files: [...files] });
      const items: Attachment[] = files.map((f) => {
        const o = f as { name?: unknown; size?: unknown; type?: unknown };
        return {
          id: `att-${++seq}`,
          name: typeof o?.name === "string" ? o.name : "",
          size: typeof o?.size === "number" ? o.size : 0,
          mime: typeof o?.type === "string" && o.type !== "" ? o.type : null,
          state: "queued",
        };
      });
      const r = trayRef(key);
      r.value = [...r.value, ...items];
      return { added: items.map((x) => x.id), rejected: [] };
    },
    remove(key, id) {
      calls.remove.push({ key, id });
      const r = trayRef(key);
      r.value = r.value.filter((x) => x.id !== id);
    },
    retry(key, id) {
      calls.retry.push({ key, id });
    },
    discard(key, ids) {
      calls.discard.push({ key, ids });
      const r = trayRef(key);
      r.value = ids === undefined ? [] : r.value.filter((x) => !ids.includes(x.id));
    },
    failGone() {},
    dispose() {},
  };
  return {
    handle,
    calls,
    setTray(key: string, items: Attachment[]): void {
      trayRef(key).value = items;
    },
  };
}

function fakeControl(uploads: UploadsHandle): ControlHandle {
  const drafts = new Map<string, string>();
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop as ControlHandle["abort"],
    steerSub: noop as ControlHandle["steerSub"],
    stopSub: noop as ControlHandle["stopSub"],
    answerDialog: noop as ControlHandle["answerDialog"],
    cancelDialog: noop as ControlHandle["cancelDialog"],
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k) => drafts.get(k) ?? "",
    setDraft: (k, t) => void drafts.set(k, t),
    uploads,
  };
}

const COMMANDS = [
  { name: "session", kind: "builtin", description: "Show session info", policy: "allow", output: "captured" },
  { name: "quit", kind: "builtin", description: "Exit pi", policy: "deny" },
];

interface MountOpts {
  enabled?: boolean;
  busy?: boolean;
  tray?: Attachment[];
  sending?: boolean;
  commandsEnabled?: boolean;
  plaintext?: boolean;
  hubCaps?: readonly string[];
  card?: Record<string, unknown>;
  withUploads?: boolean;
}

function mountComposer(opts: MountOpts = {}) {
  const uploads = fakeUploads();
  if (opts.tray !== undefined) uploads.setTray(AGENT, opts.tray);
  const control = fakeControl(uploads.handle);
  const view: ControlView = {
    agentKey: AGENT,
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(
      () =>
        ({
          key: AGENT,
          card: opts.card ?? { upload: true },
          pendingCtl: [],
        }) as unknown as ControlView["agent"] extends ComputedRef<infer A> ? A : never,
    ),
    busy: computed(() => opts.busy ?? false),
    commands: computed(() => COMMANDS),
    commandsEnabled: computed(() => opts.commandsEnabled ?? false),
    sending: computed(() => opts.sending ?? false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  const env: ControlEnv = {
    authMode: "token",
    plaintext: opts.plaintext ?? false,
    dialogDrafts: new Map(),
    noticeExpanded: ref(false),
  };
  const hubHandle = {
    state: ref({ hub: { caps: opts.hubCaps ?? ["cmd.v1", "upload.v1"] } }),
    control,
    dispatch: () => {},
  } as unknown as HubHandle;
  const wrapper = mount(Composer, {
    props: { enabled: opts.enabled ?? true, busy: opts.busy ?? false },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: AGENT, control, enabled: true },
        [CONTROL_ENV as symbol]: env,
        [HUB_CTX as symbol]: hubHandle,
      },
    },
  });
  mounted.push(wrapper);
  return { w: wrapper, uploads, view, control };
}

async function typeText(w: ReturnType<typeof mount>, text: string): Promise<void> {
  await w.find("textarea").setValue(text);
}

/** Manually-dispatched paste/drag events — `trigger()` can't attach clipboardData/dataTransfer. */
function dispatchWith(el: Element, type: string, prop: "clipboardData" | "dataTransfer", dt: unknown): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(ev, prop, { value: dt });
  el.dispatchEvent(ev);
  return ev;
}

function fileDt(
  files: File[],
  opts: { withText?: boolean; entries?: Array<{ isDirectory: boolean; name: string }> } = {},
): unknown {
  const items: unknown[] = files.map((f, i) => {
    const entry = opts.entries?.[i];
    return {
      kind: "file",
      type: f.type,
      getAsFile: () => f,
      ...(entry !== undefined ? { webkitGetAsEntry: () => entry } : {}),
    };
  });
  if (opts.withText === true) items.push({ kind: "string", type: "text/plain" });
  return {
    items,
    files,
    types: opts.withText === true ? ["Files", "text/plain"] : ["Files"],
  };
}

function makeFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

// ---------------------------------------------------------------------------
// §3.2 三路径一致 (#12)
// ---------------------------------------------------------------------------

describe("sendGate 三路径一致 (#12) — deny conditions refuse Enter, Alt+Enter AND the button", () => {
  const denyScenarios: Array<{ name: string; opts: MountOpts; text: string }> = [
    {
      name: "uploading attachment",
      opts: { tray: [readyAttachment({ state: "uploading", uploadedBytes: 100 })] },
      text: "hi",
    },
    {
      name: "failed attachment",
      opts: { tray: [readyAttachment({ state: "failed", error: "E_NETWORK", retryable: true })] },
      text: "hi",
    },
    {
      name: "command mode + ready attachment",
      opts: { tray: [readyAttachment()], commandsEnabled: true },
      text: "/session",
    },
    { name: "composed text over 48 KiB", opts: {}, text: "x".repeat(49 * 1024) },
    { name: "sending in flight", opts: { sending: true }, text: "hi" },
    { name: "deny command", opts: { commandsEnabled: true }, text: "/quit" },
    { name: "read-only (enabled=false)", opts: { enabled: false }, text: "hi" },
  ];

  for (const s of denyScenarios) {
    it(`deny: ${s.name}`, async () => {
      const { w } = mountComposer(s.opts);
      await typeText(w, s.text);
      await w.find("textarea").trigger("keydown", { key: "Enter" });
      await w.find("textarea").trigger("keydown", { key: "Enter", altKey: true });
      await w.find("[data-send]").trigger("click");
      expect(w.emitted("send")).toBeUndefined();
      expect(w.find("[data-send]").attributes("disabled")).toBeDefined();
    });
  }

  it("allow: all three paths emit the identical composed text; Enter/click steer, Alt+Enter followUp", async () => {
    const mounts = [
      mountComposer({ tray: [readyAttachment()] }),
      mountComposer({ tray: [readyAttachment()] }),
      mountComposer({ tray: [readyAttachment()] }),
    ];
    for (const m of mounts) await typeText(m.w, "hello");

    await mounts[0]!.w.find("textarea").trigger("keydown", { key: "Enter" });
    await mounts[1]!.w.find("[data-send]").trigger("click");
    await mounts[2]!.w.find("textarea").trigger("keydown", { key: "Enter", altKey: true });

    const e1 = mounts[0]!.w.emitted("send")!;
    const e2 = mounts[1]!.w.emitted("send")!;
    const e3 = mounts[2]!.w.emitted("send")!;
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect(e3).toHaveLength(1);
    expect(e1[0]![0]).toBe(e2[0]![0]);
    expect(e2[0]![0]).toBe(e3[0]![0]);
    expect(e1[0]![1]).toBe("steer");
    expect(e2[0]![1]).toBe("steer");
    expect(e3[0]![1]).toBe("followUp");
    // §3.1: body + blank line + the fixed-English attachment block carrying the hub path.
    const sent = String(e1[0]![0]);
    expect(sent.startsWith("hello\n\n[web-hub attachments]")).toBe(true);
    expect(sent).toContain(READY_PATH);
  });

  it("Enter 在 sending 时不发 (§3.2 有意行为变化 — the keyboard now matches the button)", async () => {
    const { w } = mountComposer({ sending: true, busy: true });
    await typeText(w, "steer this");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toBeUndefined();
  });

  it('coarse pointer: Enter sends with a ready attachment (enterkeyhint="send" promise)', async () => {
    stubMatchMedia(true);
    const { w } = mountComposer({ tray: [readyAttachment()] });
    await typeText(w, "mobile text");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toHaveLength(1);
  });
});

describe("sendGate 放行细节", () => {
  it("// 前缀 + 附件可发 (parseSlash escape ⇒ not command-routed)", async () => {
    const { w } = mountComposer({ tray: [readyAttachment()], commandsEnabled: true });
    await typeText(w, "//session");
    expect(w.find(".cmd-badge").exists()).toBe(false);
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    const sent = String(w.emitted("send")![0]![0]);
    expect(sent.startsWith("//session\n\n[web-hub attachments]")).toBe(true);
  });

  it("空正文 + ready 附件可发 (block-only prompt)", async () => {
    const { w } = mountComposer({ tray: [readyAttachment()] });
    await w.find("[data-send]").trigger("click");
    const sent = String(w.emitted("send")![0]![0]);
    expect(sent.startsWith("[web-hub attachments]")).toBe(true);
    expect(sent).toContain(READY_PATH);
  });

  it("command mode + attachment shows the §3.2 gate hint", async () => {
    const { w } = mountComposer({ tray: [readyAttachment()], commandsEnabled: true });
    await typeText(w, "/session");
    const hint = w.find(".composer-hint");
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("Attachments can only be sent with a normal message");
  });

  it("发送后清托盘走 discard（绝不 remove/abort）且文本框清空", async () => {
    const { w, uploads } = mountComposer({ tray: [readyAttachment()] });
    await typeText(w, "with attachment");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(uploads.calls.discard).toEqual([{ key: AGENT, ids: undefined }]);
    expect(uploads.calls.remove).toHaveLength(0);
    await nextTick();
    expect(w.find(".attachment-tray").exists()).toBe(false);
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §4.1 三入口
// ---------------------------------------------------------------------------

describe("paste entry (§4.1)", () => {
  it("粘贴图片（无文本）⇒ 拦截为附件，nameless blob 改名 pasted-*", async () => {
    const { w, uploads } = mountComposer({});
    const file = makeFile("", 4, "image/png");
    const ev = dispatchWith(w.find("textarea").element, "paste", "clipboardData", fileDt([file]));
    expect(ev.defaultPrevented).toBe(true);
    expect(uploads.calls.add).toHaveLength(1);
    const added = uploads.calls.add[0]!.files[0] as { name: string };
    expect(added.name.startsWith("pasted-")).toBe(true);
    expect(added.name.endsWith(".png")).toBe(true);
    await nextTick();
    expect(w.find(".attachment-tray").exists()).toBe(true);
  });

  it("文件+文本粘贴 ⇒ 文本照常进 textarea（不 preventDefault），文件作附件", async () => {
    const { w, uploads } = mountComposer({});
    const file = makeFile("report.xlsx", 8, "application/vnd.ms-excel");
    const ev = dispatchWith(w.find("textarea").element, "paste", "clipboardData", fileDt([file], { withText: true }));
    expect(ev.defaultPrevented).toBe(false);
    expect(uploads.calls.add).toHaveLength(1);
  });

  it("纯文本粘贴 ⇒ 不干预", async () => {
    const { w, uploads } = mountComposer({});
    const ev = dispatchWith(w.find("textarea").element, "paste", "clipboardData", {
      items: [{ kind: "string", type: "text/plain" }],
      files: [],
      types: ["text/plain"],
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(uploads.calls.add).toHaveLength(0);
  });

  it("上传不可用（hub 无 upload.v1）⇒ 粘贴不拦截", async () => {
    const { w, uploads } = mountComposer({ hubCaps: ["cmd.v1"] });
    const file = makeFile("a.png", 4, "image/png");
    const ev = dispatchWith(w.find("textarea").element, "paste", "clipboardData", fileDt([file]));
    expect(ev.defaultPrevented).toBe(false);
    expect(uploads.calls.add).toHaveLength(0);
  });
});

describe("drag & drop entry (§4.1)", () => {
  it("dragenter/over 显示遮罩，dragleave 计数归零后隐藏", async () => {
    const { w } = mountComposer({});
    const root = w.find(".composer").element;
    dispatchWith(root, "dragenter", "dataTransfer", { types: ["Files"], items: [], files: [] });
    dispatchWith(root, "dragover", "dataTransfer", { types: ["Files"], items: [], files: [] });
    await nextTick();
    expect(w.find(".drop-overlay").exists()).toBe(true);
    dispatchWith(root, "dragleave", "dataTransfer", { types: ["Files"], items: [], files: [] });
    await nextTick();
    expect(w.find(".drop-overlay").exists()).toBe(false);
  });

  it("drop 文件 ⇒ 进托盘", async () => {
    const { w, uploads } = mountComposer({});
    const file = makeFile("dropped.bin", 16, "application/octet-stream");
    const ev = dispatchWith(w.find(".composer").element, "drop", "dataTransfer", fileDt([file]));
    expect(ev.defaultPrevented).toBe(true);
    expect(uploads.calls.add).toHaveLength(1);
    await nextTick();
    expect(w.find(".tray-name").text()).toBe("dropped.bin");
  });

  it("拖入目录 ⇒ 拒收提示，不进托盘", async () => {
    const { w, uploads } = mountComposer({});
    const file = makeFile("pics", 0, "");
    dispatchWith(
      w.find(".composer").element,
      "drop",
      "dataTransfer",
      fileDt([file], { entries: [{ isDirectory: true, name: "pics" }] }),
    );
    await nextTick();
    expect(uploads.calls.add).toHaveLength(0);
    expect(w.find(".composer-hint").text()).toContain("Folders cannot be attached");
    expect(w.find(".attachment-tray").exists()).toBe(false);
  });

  it("文本拖拽（无 Files type）⇒ 不显示遮罩", async () => {
    const { w } = mountComposer({});
    dispatchWith(w.find(".composer").element, "dragenter", "dataTransfer", {
      types: ["text/plain"],
      items: [],
      files: [],
    });
    await nextTick();
    expect(w.find(".drop-overlay").exists()).toBe(false);
  });
});

describe("attach button entry (§4.1/§4.4)", () => {
  it("点击回形针触发隐藏 file input；选择文件进托盘并重置 input", async () => {
    const { w, uploads } = mountComposer({});
    const input = w.find("input[type=file]").element as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    await w.find("[data-attach]").trigger("click");
    expect(clickSpy).toHaveBeenCalled();
    const file = makeFile("picked.pdf", 32, "application/pdf");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(uploads.calls.add).toHaveLength(1);
    expect((uploads.calls.add[0]!.files[0] as { name: string }).name).toBe("picked.pdf");
    expect(input.value).toBe("");
  });

  it("上传不可用时按钮禁用", async () => {
    const { w } = mountComposer({ hubCaps: ["cmd.v1"] });
    expect(w.find("[data-attach]").attributes("disabled")).toBeDefined();
  });

  it("LAN password 模式需要 card.uploadLan（§5.1）", async () => {
    const env: ControlEnv = {
      authMode: "password",
      plaintext: true,
      dialogDrafts: new Map(),
      noticeExpanded: ref(false),
    };
    const uploads = fakeUploads();
    const control = fakeControl(uploads.handle);
    const view: ControlView = {
      agentKey: AGENT,
      control,
      enabled: computed(() => true),
      readonlyReason: computed(() => null),
      agent: computed(() => ({ key: AGENT, card: { upload: true }, pendingCtl: [] }) as never),
      busy: computed(() => false),
      commands: computed(() => []),
      commandsEnabled: computed(() => false),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    };
    const hubHandle = {
      state: ref({ hub: { caps: ["cmd.v1", "upload.v1"] } }),
      control,
      dispatch: () => {},
    } as unknown as HubHandle;
    const w = mount(Composer, {
      props: { enabled: true, busy: false },
      global: {
        provide: {
          [CONTROL_VIEW as symbol]: view,
          [CONTROL_CTX as symbol]: { agentKey: AGENT, control, enabled: true },
          [CONTROL_ENV as symbol]: env,
          [HUB_CTX as symbol]: hubHandle,
        },
      },
    });
    mounted.push(w);
    // card.upload but no uploadLan ⇒ the LAN entry stays disabled
    expect(w.find("[data-attach]").attributes("disabled")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §4.2 托盘
// ---------------------------------------------------------------------------

describe("AttachmentTray (§4.2)", () => {
  it("uploading 附件显示 progressbar（aria-valuenow）", async () => {
    const { w } = mountComposer({
      tray: [readyAttachment({ state: "uploading", uploadedBytes: 91 * 1024 })],
    });
    const bar = w.find("[role=progressbar]");
    expect(bar.exists()).toBe(true);
    expect(bar.attributes("aria-valuenow")).toBe("50");
  });

  it("failed 附件显示 err 映射与重试按钮；点击重试调 uploads.retry", async () => {
    const { w, uploads } = mountComposer({
      tray: [readyAttachment({ state: "failed", error: "E_UPLOAD_TOO_LARGE", retryable: true })],
    });
    expect(w.find(".tray-error").text()).toBe("File exceeds the hub size limit");
    await w.find(".tray-retry").trigger("click");
    expect(uploads.calls.retry).toEqual([{ key: AGENT, id: "att-1" }]);
  });

  it("未映射错误码回落 errUnknown 并带上原码", async () => {
    const { w } = mountComposer({
      tray: [readyAttachment({ state: "failed", error: "E_RATE", retryable: true })],
    });
    expect(w.find(".tray-error").text()).toContain("Too many upload requests");
  });

  it("移除 ready 附件 ⇒ 调 uploads.remove（abort 端点由 useUploads 负责）", async () => {
    const { w, uploads } = mountComposer({ tray: [readyAttachment()] });
    await w.find(".tray-remove").trigger("click");
    expect(uploads.calls.remove).toEqual([{ key: AGENT, id: "att-1" }]);
    await nextTick();
    expect(w.find(".attachment-tray").exists()).toBe(false);
  });

  it("removing 状态不再提供移除按钮", async () => {
    const { w } = mountComposer({ tray: [readyAttachment({ state: "removing" })] });
    expect(w.find(".tray-remove").exists()).toBe(false);
  });

  it("plaintext ⇒ 托盘非空时常驻警告且无关闭按钮；非 plaintext 无警告", async () => {
    const plain = mountComposer({ tray: [readyAttachment()], plaintext: true });
    const warning = plain.w.find(".tray-plain-warning");
    expect(warning.exists()).toBe(true);
    expect(warning.text()).toContain("Plain HTTP");
    expect(warning.find("button").exists()).toBe(false);

    const secure = mountComposer({ tray: [readyAttachment()], plaintext: false });
    expect(secure.w.find(".tray-plain-warning").exists()).toBe(false);
  });

  it("queued → ready 状态迁移经 aria-live 播报", async () => {
    const { w, uploads } = mountComposer({
      tray: [readyAttachment({ state: "uploading", uploadedBytes: 0 })],
    });
    uploads.setTray(AGENT, [readyAttachment()]);
    await nextTick();
    expect(w.find(".attachment-tray [role=status]").text()).toContain("shot.png");
  });

  it("role=list / role=listitem / item aria-label", () => {
    const { w } = mountComposer({ tray: [readyAttachment()] });
    expect(w.find("[role=list]").exists()).toBe(true);
    const item = w.find("[role=listitem]");
    expect(item.attributes("aria-label")).toContain("shot.png");
    expect(item.attributes("aria-label")).toContain("ready");
  });
});
