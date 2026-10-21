/**
 * web-hub-preview-windows plan r2 §10.2 (W2): the PreviewHost/PreviewWindow test DOUBLE —
 * a full `PreviewWindowsHandle` built from explicitly given per-window handles (评审 #14:
 * with the legacy single-window face deleted from production code, rendering tests — the
 * phases, copy/download, chunked and html suites in preview-host.test.ts — drive the
 * production WINDOW component through this fake instead).
 *
 * `fakeWindowHandle()` builds one minimal `PreviewMachine` (a writable view ref + vi.fn()
 * methods + the nav/tree members the window renders from);
 * `fakeWindowsFace()` assembles the frozen §4.3 face (windows/order/activeId refs +
 * spy openWindow/closeWindow/focusWindow/closeAll + the root handle bridge).
 *
 * The PRODUCTION path (real `usePreviewWindows` over a stub transport) is exercised by the
 * rig in preview-host.test.ts's dir suite and by preview-windows{,-phone}.test.ts.
 */
import { computed, ref, shallowRef, type Ref, type ShallowRef } from "vue";
import { vi } from "vitest";
import type {
  PreviewDirPhase,
  PreviewMachine,
  PreviewNavRef,
  PreviewViewDir,
} from "../../../../src/web-hub/ui/src/composables/usePreview.js";
import type {
  PreviewWindow,
  PreviewWindowsHandle,
} from "../../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { PreviewPathScope, PreviewView } from "../../../../src/web-hub/ui/src/types.js";
import { createPreviewTree } from "../../../../src/web-hub/ui/src/composables/usePreviewTree.js";

/** One fake window machine: a writable view + spy methods. `open`/`navigate`/`close` also
 *  WRITE the view (loading/closed) so the host's render reacts like the real machine. */
export interface FakeWindow {
  readonly handle: PreviewMachine;
  readonly view: Ref<PreviewViewDir>;
  readonly openSpy: ReturnType<typeof vi.fn>;
  readonly navigateSpy: ReturnType<typeof vi.fn>;
  readonly closeSpy: ReturnType<typeof vi.fn>;
  readonly backSpy: ReturnType<typeof vi.fn>;
  readonly upSpy: ReturnType<typeof vi.fn>;
  readonly retrySpy: ReturnType<typeof vi.fn>;
}

export function fakeWindowHandle(
  id: number,
  initial: PreviewViewDir,
  scope: PreviewPathScope | null = null,
): FakeWindow {
  const view = ref<PreviewViewDir>(initial);
  const openSpy = vi.fn((r: PreviewNavRef) => {
    view.value = { phase: "loading", path: r.path };
  });
  const navigateSpy = vi.fn((r: PreviewNavRef) => {
    view.value = { phase: "loading", path: r.path };
  });
  const closeSpy = vi.fn(() => {
    view.value = { phase: "closed" };
  });
  const backSpy = vi.fn();
  const upSpy = vi.fn();
  const retrySpy = vi.fn();
  const stackDepth = ref(0);
  const navEpoch = ref(0);
  const handle = {
    view,
    scope: ref(scope),
    open: openSpy,
    close: closeSpy,
    retry: retrySpy,
    dispose: vi.fn(),
    navigate: navigateSpy,
    back: backSpy,
    up: upSpy,
    loadMore: vi.fn(),
    reopen: vi.fn(),
    stackDepth,
    tree: createPreviewTree(() => Promise.resolve({ ok: false, error: "E_X", status: 0 })),
    navEpoch,
    adopt: vi.fn((v: PreviewDirPhase) => {
      view.value = v;
      navEpoch.value += 1;
    }),
  } as unknown as PreviewMachine;
  return { handle, view, openSpy, navigateSpy, closeSpy, backSpy, upSpy, retrySpy };
}

/** The assembled frozen face. The refs are directly writable so tests can append windows,
 *  reorder, arm focusRequest/limitNotice, and drive closeAll like the real manager would. */
export interface FakeWindowsFace extends PreviewWindowsHandle {
  readonly windowsRef: ShallowRef<readonly PreviewWindow[]>;
  readonly orderRef: Ref<readonly number[]>;
  readonly focusRequestRef: Ref<{ id: number; seq: number } | null>;
  readonly limitNoticeRef: Ref<{ id: number; seq: number } | null>;
  readonly openWindowSpy: ReturnType<typeof vi.fn>;
  readonly closeWindowSpy: ReturnType<typeof vi.fn>;
  readonly focusWindowSpy: ReturnType<typeof vi.fn>;
  readonly closeAllSpy: ReturnType<typeof vi.fn>;
  addWindow(w: FakeWindow): void;
}

export function fakeWindowsFace(initial: FakeWindow[] = [], scope: PreviewPathScope | null = null): FakeWindowsFace {
  const windowsRef = shallowRef<readonly PreviewWindow[]>(initial.map((w) => ({ id: -1, handle: w.handle })));
  let nextId = 1;
  const ids = new Map<FakeWindow, number>();
  for (const w of initial) ids.set(w, nextId++);
  windowsRef.value = initial.map((w) => ({ id: ids.get(w)!, handle: w.handle }));
  const orderRef = ref<readonly number[]>(initial.map((w) => ids.get(w)!));
  const activeId = computed(() => (orderRef.value.length === 0 ? null : orderRef.value[orderRef.value.length - 1]!));
  const focusRequestRef = ref<{ id: number; seq: number } | null>(null);
  const limitNoticeRef = ref<{ id: number; seq: number } | null>(null);
  const openWindowSpy = vi.fn();
  const closeWindowSpy = vi.fn((id: number) => {
    windowsRef.value = windowsRef.value.filter((w) => w.id !== id);
    orderRef.value = orderRef.value.filter((x) => x !== id);
  });
  const focusWindowSpy = vi.fn((id: number, opts?: { moveFocus?: boolean }) => {
    orderRef.value = [...orderRef.value.filter((x) => x !== id), id];
    if (opts?.moveFocus === true) focusRequestRef.value = { id, seq: (focusRequestRef.value?.seq ?? 0) + 1 };
  });
  // like the real manager: closeAll closes EVERY window's machine, then empties the refs.
  const closeAllSpy = vi.fn(() => {
    for (const w of windowsRef.value) (w.handle as { close?: () => void }).close?.();
    windowsRef.value = [];
    orderRef.value = [];
  });
  const rootView = computed<PreviewView>(() => {
    const a = activeId.value;
    const w = windowsRef.value.find((x) => x.id === a);
    return w === undefined ? { phase: "closed" } : (w.handle.view.value as PreviewView);
  });
  const face: FakeWindowsFace = {
    view: rootView,
    scope: ref(scope),
    open: (r: PreviewNavRef) => openWindowSpy(r, null),
    close: closeAllSpy,
    retry: vi.fn(),
    dispose: vi.fn(),
    windows: windowsRef,
    order: orderRef,
    activeId,
    focusRequest: focusRequestRef,
    limitNotice: limitNoticeRef,
    openWindow: openWindowSpy as unknown as FakeWindowsFace["openWindow"],
    closeWindow: closeWindowSpy,
    focusWindow: focusWindowSpy,
    closeAll: closeAllSpy,
    windowsRef,
    orderRef,
    focusRequestRef,
    limitNoticeRef,
    openWindowSpy,
    closeWindowSpy,
    focusWindowSpy,
    closeAllSpy,
    addWindow(w: FakeWindow): void {
      const id = nextId++;
      ids.set(w, id);
      windowsRef.value = [...windowsRef.value, { id, handle: w.handle }];
      orderRef.value = [...orderRef.value, id];
    },
  };
  return face;
}
