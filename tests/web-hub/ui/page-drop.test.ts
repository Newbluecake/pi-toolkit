// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageDropZone from "../../../src/web-hub/ui/src/components/control/PageDropZone.vue";
import {
  CONTROL_ENV,
  HUB_CTX,
  type ControlEnv,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { Attachment, HubHandle, Route, UploadsHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/PageDropZone.vue` — the page-wide file drop zone (2026-10 user ruling
 * 「拖拽上传不限于 Composer 输入框，整个页面都是拖放区」). Pins the contract:
 *
 * - a Files drag over ANY page position shows the full-page overlay when the current route
 *   names a session whose uploads are available (same `uploadAvailability` gate as the
 *   composer entries), and the drop feeds that session's tray via the shared pipeline —
 *   EXACTLY once (the composer owns no drag handlers anymore; in-composer drops bubble to
 *   the window listeners).
 * - Files drops are ALWAYS preventDefault'd (anti-navigation), even with no selected
 *   session (silent) or an uploads-unavailable session (toast `upload.dropUnavailable`).
 * - text/link drags are never touched; directory drops reject with `upload.hintDirectory`;
 *   dragleave is counter-guarded against child-element flicker; Esc resets a stuck overlay.
 */

const AGENT = "agent-a";
const AGENT_ROUTE: Route = { name: "agent", key: AGENT };

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

function makeFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
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

/** Dispatch a drag-event-shaped Event with a `dataTransfer` payload (window or element —
 * both reach the component's window listeners). */
function dispatchDrop(target: Window | Element, type: string, dt: unknown): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  target.dispatchEvent(ev);
  return ev;
}

interface MountOpts {
  route?: Route;
  hubCaps?: readonly string[];
  card?: Record<string, unknown> | null;
  withUploads?: boolean;
}

function mountZone(opts: MountOpts = {}) {
  const addCalls: Array<{ key: string; files: unknown[] }> = [];
  const uploads: UploadsHandle = {
    tray: () => ref<Attachment[]>([]) as Ref<Attachment[]>,
    add(key, files) {
      addCalls.push({ key, files: [...files] });
      return { added: [], rejected: [] };
    },
    remove: () => {},
    retry: () => {},
    discard: () => {},
    failGone: () => {},
    source: () => undefined,
    dispose: () => {},
  };
  const agents = new Map<string, unknown>();
  if (opts.card !== null) agents.set(AGENT, { card: opts.card ?? { upload: true } });
  const hub = {
    state: ref({
      hub: { caps: opts.hubCaps ?? ["cmd.v1", "upload.v1"] },
      agents,
    }),
    control: opts.withUploads === false ? {} : { uploads },
  } as unknown as HubHandle;
  const env: ControlEnv = {
    authMode: "token",
    plaintext: false,
    dialogDrafts: new Map(),
    noticeExpanded: ref(false),
  };
  const w = mount(PageDropZone, {
    props: { route: opts.route ?? AGENT_ROUTE },
    global: {
      provide: {
        [HUB_CTX as symbol]: hub,
        [CONTROL_ENV as symbol]: env,
      },
    },
  });
  mounted.push(w);
  return { w, addCalls };
}

describe("PageDropZone — page-wide drop (2026-10 「整个页面都是拖放区」)", () => {
  it("页面任意处 dragenter(Files) ⇒ 整页遮罩；dragleave 归零后隐藏", async () => {
    const { w } = mountZone({});
    const dt = { types: ["Files"], items: [], files: [] };
    dispatchDrop(window, "dragenter", dt);
    dispatchDrop(window, "dragover", dt);
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(true);
    expect(w.find(".page-drop-overlay").text()).toBe("Drop files to attach them");
    dispatchDrop(window, "dragleave", dt);
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
  });

  it("drop 文件 ⇒ 进当前会话托盘，preventDefault，且仅入管线一次（含从子元素冒泡）", async () => {
    const { w, addCalls } = mountZone({});
    const file = makeFile("dropped.bin", 16, "application/octet-stream");
    // A child element stands in for the composer/任意页面位置 — the event bubbles to the
    // window listeners, which are the ONLY handlers (single-processing proof).
    const child = document.createElement("div");
    document.body.appendChild(child);
    const ev = dispatchDrop(child, "drop", fileDt([file]));
    expect(ev.defaultPrevented).toBe(true);
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.key).toBe(AGENT);
    expect((addCalls[0]!.files[0] as { name: string }).name).toBe("dropped.bin");
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
  });

  it("无选中会话（list 路由）⇒ 无遮罩；drop 仍 preventDefault 防导航，静默无 toast", async () => {
    const { w, addCalls } = mountZone({ route: { name: "list" } });
    const dt = fileDt([makeFile("a.bin", 8, "application/octet-stream")]);
    dispatchDrop(window, "dragenter", dt);
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
    const ev = dispatchDrop(window, "drop", dt);
    expect(ev.defaultPrevented).toBe(true);
    expect(addCalls).toHaveLength(0);
    expect(w.find(".page-drop-toast").exists()).toBe(false);
  });

  it("会话不支持附件（hub 无 upload.v1）⇒ 无遮罩；drop preventDefault + 轻提示", async () => {
    const { w, addCalls } = mountZone({ hubCaps: ["cmd.v1"] });
    const dt = fileDt([makeFile("a.bin", 8, "application/octet-stream")]);
    dispatchDrop(window, "dragenter", dt);
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
    const ev = dispatchDrop(window, "drop", dt);
    expect(ev.defaultPrevented).toBe(true);
    expect(addCalls).toHaveLength(0);
    await nextTick();
    expect(w.find(".page-drop-toast").text()).toContain("can't take attachments");
  });

  it("无 uploads driver ⇒ 同不可用（toast，防导航）", async () => {
    const { w, addCalls } = mountZone({ withUploads: false });
    const ev = dispatchDrop(window, "drop", fileDt([makeFile("a.bin", 8, "application/octet-stream")]));
    expect(ev.defaultPrevented).toBe(true);
    expect(addCalls).toHaveLength(0);
    await nextTick();
    expect(w.find(".page-drop-toast").text()).toContain("can't take attachments");
  });

  it("文本拖拽（无 Files type）⇒ 无遮罩，drop 不拦截（原生文本拖放不受影响）", async () => {
    const { w, addCalls } = mountZone({});
    dispatchDrop(window, "dragenter", { types: ["text/plain"], items: [], files: [] });
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
    const ev = dispatchDrop(window, "drop", { types: ["text/plain"], items: [], files: [] });
    expect(ev.defaultPrevented).toBe(false);
    expect(addCalls).toHaveLength(0);
  });

  it("拖入目录 ⇒ 拒收 toast，不进托盘", async () => {
    const { w, addCalls } = mountZone({});
    const dir = makeFile("pics", 0, "");
    dispatchDrop(window, "drop", fileDt([dir], { entries: [{ isDirectory: true, name: "pics" }] }));
    await nextTick();
    expect(addCalls).toHaveLength(0);
    expect(w.find(".page-drop-toast").text()).toContain("Folders cannot be attached");
  });

  it("dragleave 计数器防闪烁：子元素间移动不消隐遮罩", async () => {
    const { w } = mountZone({});
    const dt = { types: ["Files"], items: [], files: [] };
    const child = document.createElement("div");
    document.body.appendChild(child);
    dispatchDrop(window, "dragenter", dt); // enter window: depth 1
    dispatchDrop(child, "dragenter", dt); // enter a child (bubbles): depth 2
    dispatchDrop(child, "dragleave", dt); // back out of the child: depth 1
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(true);
    dispatchDrop(window, "dragleave", dt); // leaving the window: depth 0
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
  });

  it("Esc 重置卡住的拖拽态", async () => {
    const { w } = mountZone({});
    dispatchDrop(window, "dragenter", { types: ["Files"], items: [], files: [] });
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(w.find(".page-drop-overlay").exists()).toBe(false);
  });

  it("drop 后焦点回 composer textarea（存在时）", async () => {
    const { addCalls } = mountZone({});
    const wrap = document.createElement("div");
    wrap.className = "composer";
    const textarea = document.createElement("textarea");
    wrap.appendChild(textarea);
    document.body.appendChild(wrap);
    const focusSpy = vi.spyOn(textarea, "focus");
    dispatchDrop(window, "drop", fileDt([makeFile("f.bin", 4, "application/octet-stream")]));
    expect(addCalls).toHaveLength(1);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});
