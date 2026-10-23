<!--
  DirPicker — the 「选择目录新建…」 modal dialog (web-hub-spawn plan SP12 / arch §9.1, plan
  §3.2; 2026-10 redesigned from an inline sidebar panel to a Teleport'd dialog — user 拍板:
  新建会话可以占满页面,不需要担心遮挡其他会话). Renders the `useNewSession` (SP11) flow
  phases and forwards every user intent to that orchestrator — no wire calls, no verdicts of
  its own (spawn-dirbrowse/-dirmkdir, 2026-10 user 拍板: the optional first-prompt textarea is
  GONE — the flow layer's `fp:*` mechanism stays for flows that carry one; and the cwd field
  gains an in-dialog directory BROWSER riding the existing read-only `GET /api/preview?dir=1`
  listing endpoint, plus a 「新建文件夹」 inline form riding the NEW `POST /api/headless/mkdir`
  — created-dirs plan r2 §4: a successful mkdir SELECTS the created folder (fills the cwd
  input + closes the panel) with a persistent ack line, guarded by an operation generation
  so a late answer never overwrites a newer choice):

  - `idle` — the form: cwd input (prefilled with the selected agent's cwd or `~`) + the 「浏览」
    toggle (only when the hub declares `preview.dir.v1` AND the preview transport exists), the
    `GET /api/headless/dirs` recent list, and the collapsible browse panel (current path +
    「上一级」 + 「新建文件夹」 on top, subdir-only listing, 「选择此目录」 at the bottom).
  - `submitting` — form disabled, status line.
  - `confirming` — replaced by SpawnConfirm (409 `E_CONFIRM_REQUIRED`, arch §6.3).
  - `awaiting` / `unknown` — the 202 accepted ⇒ the dialog CLOSES immediately (2026-10-13 用户
    拍板 ②: 等待状态在侧边会话列表看 — SpawnRow carries the record, incl. the `fp:*` chips,
    from here). The status lines below stay only for a picker opened while a SHARED flow is
    already awaiting (the flow is a singleton on `hub.spawn.newSession`).
  - `failed` — the §3.2 error taxonomy line (`classifySpawnError` kind → `spawn.err*`), inputs
    restored from `flow.input` (失败保留输入; `refilled:"picker"` returns the retained body the
    same way), Retry resubmits under a NEW id via `newSession.retry()`.
  - `done` — a success line and a `done` emit so the parent can close the panel.

  Dialog shell mirrors `control/PickerSheet.vue`'s contract: Teleport'd to `<body>`, scrim
  `@click.self` closes (same as cancel — a pending `confirming` flow IS cancelled), Escape
  closes, focus enters on open (`focusSubmit` ⇒ 「启动」, otherwise the cwd input), Tab cycles
  inside, focus returns to the opener and the body scroll lock is released on close. Rendered
  only while the parent holds it open; closing mid-`awaiting` never cancels the flow
  (SpawnRow keeps showing progress) — Escape only resolves a pending `confirming` first.
  Keydown is handled BOTH at the scrim (content keydowns bubbling up) and at document level
  (capture) while open: a phase switch can drop the focused element (disabled submit /
  SpawnConfirm swap), and without the document listener focus sits on `<body>` where Escape
  and the Tab trap no longer reach the dialog (a11y fix — `ownsDocumentKeydown` keeps Escape
  closing only the topmost overlay).

  The picker deliberately has NO model field (2026-10-12 user 拍板): a new session simply
  runs with the hub-wide default model (`prefs.defaultModel` ?? pi default, applied hub-side
  when the POST omits `model`); the settings page's default-model card is untouched.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import type { DirEntryWire } from "@protocol/spawn.js";
import { isValidMkdirName } from "@protocol/spawn.js";
import { PREVIEW_IMAGE_MAX_PIXELS, type PreviewDirListing } from "@protocol/preview.js";
import { PREVIEW_DIR_HUB_CAP } from "@protocol/version.js";
import { childPreviewPath, parentPreviewPath } from "../../logic/preview.js";
import { MODAL_OVERLAY_ROOTS } from "../../logic/overlayRoots.js";
import { HUB_CTX } from "../control/controlContext.js";
import type { NewSessionInput } from "../../types.js";
import SpawnConfirm from "./SpawnConfirm.vue";
import "../../styles/spawn.css";

const props = defineProps<{
  /** Selected agent's cwd, or `~` — the initial value of the directory input. */
  readonly prefillCwd?: string | undefined;
  /** Opened from the NewSessionMenu main button ⇒ focus 「启动」 so it's click-click-spawn. */
  readonly focusSubmit?: boolean;
  /** LAN plaintext HTTP — forwarded to SpawnConfirm's warning. */
  readonly plaintext?: boolean;
}>();
const emit = defineEmits<{
  /** User dismissed the panel (cancel button / Escape). In-flight flows keep running. */
  close: [];
  /** The flow reached `done` (session live, first prompt settled) — the parent may close. */
  done: [];
}>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const newSession = computed(() => hub?.spawn?.newSession ?? null);
const flow = computed(() => newSession.value?.flow.value ?? ({ phase: "idle" } as const));

// ---------------------------------------------------------------------------
// hub caps (the browse toggle's `preview.dir.v1` gate; the picker itself sends no `model`
// field — 2026-10-12 拍板, the hub's default model applies)
// ---------------------------------------------------------------------------
const hubCaps = computed<unknown>(() => {
  const h = hub?.state.value.hub;
  return h !== null && h !== undefined && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
});

// ---------------------------------------------------------------------------
// form state (local; restored from flow.input on failure — plan §3.2 保留输入)
// ---------------------------------------------------------------------------
const cwd = ref(props.prefillCwd ?? "~");

/** Restore the failed flow's input exactly once per reqId (a later edit is never clobbered). */
let restoredReqId: string | null = null;
watch(flow, (f) => {
  if (f.phase === "failed" && f.input !== undefined && f.reqId !== undefined && f.reqId !== restoredReqId) {
    restoredReqId = f.reqId;
    cwd.value = f.input.cwd;
  }
  if (f.phase === "idle") restoredReqId = null;
  // 2026-10-13 用户拍板 ②: 202 accepted ⇒ 立即关对话框 — the sidebar's SpawnRow carries the
  // starting/awaiting/failed state from here (the useNewSession phase machine itself is
  // unchanged; a failure BEFORE the 202 still lands in this dialog's `failed` phase).
  if (f.phase === "awaiting") {
    emit("close");
    return;
  }
  if (f.phase === "done") emit("done");
});

// ---------------------------------------------------------------------------
// recent directories (GET /api/headless/dirs — additive, errors degrade to a note)
// ---------------------------------------------------------------------------
const recent = ref<readonly DirEntryWire[]>([]);
const recentPartial = ref(false);
const recentFailed = ref(false);

onMounted(async () => {
  returnFocus = document.activeElement;
  // Shared ref-counted lock (useScrollLock.ts) — composes with other overlays' locks.
  releaseScrollLock = acquireBodyScrollLock();
  document.addEventListener("keydown", onDocumentKeydown, true);
  await nextTick();
  if (props.focusSubmit === true) {
    submitBtn.value?.focus();
  } else {
    (cwdInput.value ?? panelEl.value)?.focus();
  }
  const spawn = hub?.spawn;
  if (spawn === undefined) return;
  try {
    const r = await spawn.dirs();
    if (r.ok) {
      recent.value = r.recent;
      recentPartial.value = r.partial === true;
    } else {
      recentFailed.value = true;
    }
  } catch {
    recentFailed.value = true;
  }
});

function pickRecent(dir: DirEntryWire): void {
  cwd.value = dir.cwd;
}

// ---------------------------------------------------------------------------
// 目录浏览器 (spawn-dirbrowse + spawn-dirmkdir, 2026-10 user 拍板) — an in-dialog browse
// panel, NOT a new modal. READS ride the existing read-only `GET /api/preview?path=…&dir=1`
// listing endpoint through `hub.preview.fetch` (the preview transport — same helper family
// the preview overlay uses; `&dir=1` opt-in, `X-PWH: 1` and the header contract all live in
// the logic clients); the one WRITE (「新建文件夹」) rides the NEW `POST /api/headless/mkdir`
// through `hub.spawn.mkdir`. The 「浏览」 toggle renders only when the hub declares
// `preview.dir.v1` AND the transport exists.
//
// The preview endpoint requires a LIVE session's `agentKey`/`sessionId` pair (the hub's step
// ③/⑤) — browsing absolute paths is global (dir-plan U4), so ANY online agent's session
// satisfies it; with none online the panel degrades to its unsupported error line.
// ---------------------------------------------------------------------------
const browseCap = computed(() => {
  const caps = hubCaps.value;
  return Array.isArray(caps) && caps.includes(PREVIEW_DIR_HUB_CAP) && hub?.preview !== undefined;
});

interface BrowseSession {
  readonly agentKey: string;
  readonly sessionId: string;
}

/** Any online agent's live session pair — the preview endpoint's ③/⑤ gate needs one, and
 *  global (U4) admission makes ANY of them equally valid for browsing absolute paths. */
const browseSession = computed<BrowseSession | null>(() => {
  const agents = hub?.state.value.agents;
  if (agents === undefined || agents === null) return null;
  for (const [agentKey, agent] of agents) {
    if (agent.down) continue;
    const session = agent.session;
    if (session !== undefined && typeof session.sessionId === "string" && session.sessionId !== "") {
      return { agentKey, sessionId: session.sessionId };
    }
  }
  return null;
});

type BrowsePhase = "loading" | "ready" | "error";
const browseOpen = ref(false);
const browsePath = ref("~");
const browsePhase = ref<BrowsePhase>("loading");
const browseListing = ref<PreviewDirListing | null>(null);
const browseErrorKey = ref<string | null>(null);
/** Supersede guard: only the LATEST load may write state (a slow parent answer landing after
 *  a drill-down must never clobber the child's listing). */
let browseSeq = 0;
let browseAbort: AbortController | null = null;

/** Subdirectories only — files/symlinks/`other` never render (the picker chooses a DIR). */
const browseDirs = computed(() => (browseListing.value?.entries ?? []).filter((e) => e.type === "dir"));
/** 「上一级」 target (`parentPreviewPath` — `null` at the one-segment floor, button greys). */
const browseParent = computed(() => parentPreviewPath(browsePath.value));

/** Non-200 / transport-local error → its `spawn.browseErr*` i18n key (the §3.2-taxonomy
 *  sibling for browsing — prose lines, same style as the picker's other error rows). */
function classifyBrowseError(out: { readonly error: string }): string {
  switch (out.error) {
    case "E_PREVIEW_DENIED":
      return "spawn.browseErrDenied";
    case "E_NOT_FOUND":
      return "spawn.browseErrNotFound";
    case "E_BAD_REQUEST":
      return "spawn.browseErrBadPath";
    case "E_PREVIEW_UNSUPPORTED":
      return "spawn.browseErrUnsupported";
    case "E_RATE":
    case "E_BUSY":
      return "spawn.browseErrBusy";
    default:
      return "spawn.browseErrNetwork";
  }
}

/** spawn-browse-follow: follow-mode load — with a listing already on screen the panel keeps
 *  showing it for the WHOLE fetch (anti-jitter, 2026-10-13 用户报告: 输路径每敲一个字母弹窗抖一下 —
 *  blanking up to 240px of rows for a one-line loading status re-centers the dialog twice per
 *  debounced fetch); a small bar spinner marks the in-flight follow, only a SUCCESS swaps
 *  path+listing, and a failure leaves the panel where it was with the light hint line. */
async function browseLoad(path: string, opts?: { follow?: boolean }): Promise<void> {
  const follow = opts?.follow === true;
  const preview = hub?.preview;
  const sess = browseSession.value;
  const prevPath = browsePath.value;
  const prevListing = browseListing.value;
  const keepContent = follow && prevListing !== null && preview !== undefined && sess !== null;
  if (!keepContent) {
    browsePath.value = path;
    browseListing.value = null;
    if (follow) followHint.value = false; // legacy blank-load: clear at start
  }
  browseErrorKey.value = null;
  if (preview === undefined || sess === null) {
    browsePhase.value = "error";
    browseErrorKey.value = "spawn.browseErrUnsupported";
    return;
  }
  const seq = ++browseSeq;
  browseAbort?.abort();
  const ac = new AbortController();
  browseAbort = ac;
  if (keepContent) {
    followBusy.value = true;
  } else {
    followBusy.value = false;
    browsePhase.value = "loading";
  }
  const out = await preview.fetch(
    { agentKey: sess.agentKey, sessionId: sess.sessionId, path, dir: true },
    { signal: ac.signal, maxPixels: PREVIEW_IMAGE_MAX_PIXELS },
  );
  if (seq !== browseSeq) return; // superseded by a newer navigation — drop the late answer
  followBusy.value = false;
  if (out.ok && out.kind === "dir") {
    browsePath.value = path; // keepContent: the panel moves only NOW — zero mid-flight shift
    browseListing.value = out.listing;
    browsePhase.value = "ready";
    followHint.value = false; // 成功才清提示（在途/失败期间保持，防逐字闪烁）
    return;
  }
  if (out.ok) {
    // a hub answering a file/text kind to a dir=1 ask is out of contract — keepContent stays put
    if (keepContent) {
      followHint.value = true;
      return;
    }
    browsePhase.value = "error";
    browseErrorKey.value = "spawn.browseErrUnsupported";
    return;
  }
  if (out.error === "E_ABORT") return; // our own supersede/close abort — stay silent
  if (follow) {
    // 跟随失败: 面板停在原地（路径/列表保持）+ 一行轻提示，不抢焦点不刷屏
    browsePath.value = prevPath;
    browseListing.value = prevListing;
    browsePhase.value = "ready";
    followHint.value = true;
    return;
  }
  browsePhase.value = "error";
  browseErrorKey.value = classifyBrowseError(out);
}

// --- 输入联动 (spawn-browse-follow, 2026-10-12 用户拍板: 「文件浏览器打开的情况下,路径输入
// 可以实时影响文件浏览器」): while the panel is open, editing the cwd input re-navigates the
// panel after a ~300ms debounce. A valid directory ⇒ the panel jumps; anything else (missing /
// not-a-dir / denied) ⇒ the panel stays put with one light hint line. The watcher never fires
// for programmatic writes with the panel closed (「选择此目录」 writes AFTER browseClose, so
// there is no loop); with the panel OPEN a recent-dir click intentionally follows too.
// ---------------------------------------------------------------------------
const followHint = ref(false);
/** Anti-jitter in-flight marker (spinner in the browse bar) — see browseLoad's keepContent path. */
const followBusy = ref(false);
let followTimer: ReturnType<typeof setTimeout> | null = null;

watch(cwd, () => {
  // created-dirs r2 §4: the mkdir ack clears as soon as the cwd diverges from the created path
  if (mkdirAck.value !== null && cwd.value !== mkdirAck.value.path) mkdirAck.value = null;
  if (!browseOpen.value) return; // panel closed ⇒ no follow (also the anti-loop guard)
  if (followTimer !== null) clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    followTimer = null;
    if (!browseOpen.value) return;
    const path = cwd.value.trim();
    if (path === "") return; // nothing to do
    if (path === browsePath.value) {
      followHint.value = false; // 输入与面板重新一致 ⇒ 提示失去意义
      return;
    }
    if (/[\0\r\n]/.test(path)) return; // 非法字符不发请求
    void browseLoad(path, { follow: true });
  }, 300);
});

function browseToggle(): void {
  if (browseOpen.value) {
    browseClose();
    return;
  }
  mkdirSeq += 1; // a fresh browsing session supersedes any in-flight mkdir
  browseOpen.value = true;
  followHint.value = false;
  mkdirCancel();
  // the cwd input's CURRENT value is the starting point ("" falls back to `~` — the hub
  // expands a bare `~` / `~/…` against its own home, `hub/preview/tilde.ts`)
  const start = cwd.value.trim();
  void browseLoad(start === "" ? "~" : start);
}

function browseClose(): void {
  mkdirSeq += 1; // created-dirs r2 §4 (#9): a closed panel is never re-opened by a late mkdir
  browseOpen.value = false;
  followHint.value = false;
  followBusy.value = false;
  if (followTimer !== null) {
    clearTimeout(followTimer);
    followTimer = null;
  }
  browseSeq += 1; // any in-flight load's answer is now stale
  browseAbort?.abort();
  browseAbort = null;
  mkdirCancel();
}

function browseInto(name: string): void {
  const child = childPreviewPath(browsePath.value, name);
  if (child === null) return; // a name that can't join stays inert (defensive — protocol already shape-checks)
  mkdirSeq += 1; // navigation supersedes an in-flight mkdir's select-intent
  followHint.value = false;
  void browseLoad(child);
}

function browseUp(): void {
  const parent = browseParent.value;
  if (parent === null) return;
  mkdirSeq += 1; // same supersede rule as browseInto
  followHint.value = false;
  void browseLoad(parent);
}

/** 「选择此目录」 — write the browsed path into the cwd input and collapse the panel. */
function browseChoose(): void {
  cwd.value = browsePath.value;
  browseClose();
}

// --- 「新建文件夹」 (spawn-dirmkdir + created-dirs plan r2 §4): inline form in the panel
// header. A successful create SELECTS the new folder — fills the cwd input, closes the
// browse panel (one click from 启动; intent in a _spawn_ picker is "start there", and the
// close-first order keeps the follow watcher silent) — and shows a persistent role=status
// ack under the cwd input (`mkdirAck*`; the plaintext-LAN `!known` variant warns that
// spawning there may be refused). The operation generation below (r1 #9) guarantees a LATE
// answer never overwrites a newer cwd/choice and never re-opens a closed panel: it only
// announces 「已新建文件夹：{path}」.
const mkdirOpen = ref(false);
const mkdirName = ref("");
const mkdirBusy = ref(false);
const mkdirErrorKey = ref<string | null>(null);
/** The persistent mkdir success ack under the cwd input (`spawn.mkdirAck*` + {path}). */
const mkdirAck = ref<{ readonly key: string; readonly path: string } | null>(null);
/** Operation generation (created-dirs r1 #9): bumped on every mkdirConfirm start,
 *  mkdirCancel, browseClose, browseInto/Up/Toggle — an answer whose captured seq no longer
 *  matches is stale. */
let mkdirSeq = 0;

function mkdirStart(): void {
  mkdirOpen.value = true;
  mkdirName.value = "";
  mkdirErrorKey.value = null;
}

function mkdirCancel(): void {
  mkdirSeq += 1; // any in-flight mkdir's answer is now stale
  mkdirOpen.value = false;
  mkdirName.value = "";
  mkdirBusy.value = false;
  mkdirErrorKey.value = null;
}

/** mkdir wire error → its `spawn.mkdirErr*` key (名称非法/已存在/权限/只读/超时/网络). */
function classifyMkdirError(out: { readonly error: string; readonly reason?: string }): string {
  if (out.error === "E_BAD_REQUEST") return "spawn.mkdirErrName";
  if (out.error === "E_CONFLICT")
    return out.reason === "not-directory" ? "spawn.mkdirErrNotDir" : "spawn.mkdirErrExists";
  if (out.error === "E_DENIED")
    return out.reason === "readonly" ? "spawn.mkdirErrReadonly" : "spawn.mkdirErrPermission";
  if (out.error === "E_NOT_FOUND") return "spawn.mkdirErrNoParent";
  if (out.error === "E_DEADLINE") return "spawn.mkdirErrTimeout";
  if (out.error === "E_RATE" || out.error === "E_BUSY") return "spawn.browseErrBusy";
  return "spawn.mkdirErrNetwork";
}

async function mkdirConfirm(): Promise<void> {
  const sp = hub?.spawn;
  const mkdir = sp?.mkdir;
  if (mkdir === undefined || mkdirBusy.value) return;
  const name = mkdirName.value;
  // local precheck first — the protocol's shared rule; the hub re-validates authoritatively
  if (!isValidMkdirName(name)) {
    mkdirErrorKey.value = "spawn.mkdirErrName";
    return;
  }
  mkdirBusy.value = true;
  mkdirErrorKey.value = null;
  // created-dirs r2 §4 (#9): capture the operation generation + the intent snapshot — a
  // late answer may only act when nothing moved underneath it.
  const seq = ++mkdirSeq;
  const cwdAtStart = cwd.value;
  const pathAtStart = browsePath.value;
  const out = await mkdir(pathAtStart, name);
  mkdirBusy.value = false;
  if (!out.ok) {
    if (seq !== mkdirSeq) return; // a stale operation's error is dropped entirely
    mkdirErrorKey.value = classifyMkdirError(out);
    return;
  }
  if (seq === mkdirSeq && browseOpen.value && cwd.value === cwdAtStart && browsePath.value === pathAtStart) {
    // fresh ⇒ select: fill the cwd input with the created path + close the panel (the
    // 「选择此目录」 path), then ack. `browseClose` bumps the seq — the request has settled.
    cwd.value = out.path;
    browseClose();
    mkdirAck.value =
      out.known !== true && props.plaintext === true
        ? { key: "spawn.mkdirAckUnregistered", path: out.path }
        : { key: "spawn.mkdirAckSelected", path: out.path };
    return;
  }
  // stale/late success: announce the creation only — never overwrite a newer cwd, never
  // re-open a closed panel.
  mkdirAck.value = { key: "spawn.mkdirAckCreated", path: out.path };
}

// ---------------------------------------------------------------------------
// dialog shell (Teleport'd — see header comment; the PickerSheet contract)
// ---------------------------------------------------------------------------
const panelEl = ref<HTMLElement | null>(null);
const scrimEl = ref<HTMLElement | null>(null);
const cwdInput = ref<HTMLInputElement | null>(null);
let returnFocus: Element | null = null;
let releaseScrollLock: (() => void) | null = null;

onUnmounted(() => {
  document.removeEventListener("keydown", onDocumentKeydown, true);
  // an in-flight browse/mkdir fetch outlives nothing — abort with the dialog
  browseSeq += 1;
  browseAbort?.abort();
  browseAbort = null;
  if (followTimer !== null) {
    clearTimeout(followTimer);
    followTimer = null;
  }
  // Close and unmount are one path (the parent renders the dialog only while open), so this
  // covers both — the scroll lock release is idempotent and focus returns to the opener.
  releaseScrollLock?.();
  releaseScrollLock = null;
  const target = returnFocus;
  returnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
});

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(ev: KeyboardEvent): void {
  const panel = panelEl.value;
  if (panel === null) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    ev.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = active === null || !panel.contains(active);
  if (ev.shiftKey && (outside || active === first)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (outside || active === last)) {
    ev.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------
// submit / retry / cancel — straight onto the SP11 orchestrator
// ---------------------------------------------------------------------------
const busyPhase = computed(() => {
  const p = flow.value.phase;
  return p === "submitting" || p === "awaiting" || p === "unknown" || p === "confirming";
});
const submitDisabled = computed(() => newSession.value === null || busyPhase.value || cwd.value.trim() === "");

const submitBtn = ref<HTMLButtonElement | null>(null);

function onSubmit(): void {
  const ns = newSession.value;
  if (ns === null || submitDisabled.value) return;
  mkdirAck.value = null; // a submit consumes/dismisses the mkdir ack
  // 2026-10-12 拍板: no `model` field — the hub applies its default-model preference.
  const input: NewSessionInput = {
    cwd: cwd.value.trim(),
  };
  void ns.submit(input);
}

// --- failure presentation (§3.2 taxonomy; `spawn`/`first-prompt` are the flow-local kinds) ---
const ERR_KEYS: Record<string, string> = {
  dir: "spawn.errDir",
  denied: "spawn.errDenied",
  limit: "spawn.errLimit",
  rate: "spawn.errRate",
  launcher: "spawn.errLauncher",
  "launcher-changed": "spawn.errLauncherChanged",
  deadline: "spawn.errDeadline",
  network: "spawn.errNetwork",
  spawn: "spawn.errSpawn",
  "first-prompt": "spawn.errFirstPrompt",
  confirm: "spawn.errNetwork",
  // (the picker no longer sends `model` — 2026-10-12 拍板 — so the "model" failure kind is
  // unreachable here and has no entry; classifySpawnError keeps it for other callers)
};
const HINT_KEYS: Record<string, string> = {
  "register-timeout-hello": "spawn.hintRegisterTimeoutHello",
  "register-timeout-session": "spawn.hintRegisterTimeoutSession",
  "control-off": "spawn.hintControlOff",
  "newer-plugin": "spawn.hintNewerPlugin",
  "cwd-mismatch": "spawn.hintCwdMismatch",
  "protocol-error": "spawn.hintProtocolError",
  "launcher-changed": "spawn.hintLauncherChanged",
  "model-rejected": "spawn.hintModelRejected", // F2/D5: pi refused the model at boot
};

/** created-dirs plan r2 §4: the LAN-only `E_DIR` `detail` values → their cause-specific
 *  copy (unknown values fall through to the generic `spawn.errDir`). */
const ERR_DIR_DETAIL_KEYS: Record<string, string> = {
  "plaintext-lan": "spawn.errDirPlaintextLan",
  "lan-known": "spawn.errDirLanKnown",
  "outside-roots": "spawn.errDirOutsideRoots",
};

const failure = computed(() => {
  const f = flow.value;
  return f.phase === "failed" ? f : null;
});
const failureText = computed(() => {
  const f = failure.value;
  if (f === null) return null;
  // created-dirs r2 §4: a LAN E_DIR carries its cause (`detail`) — render the specific line;
  // loopback / a pre-feature hub / an unknown value fall back to the generic errDir.
  if (f.kind === "dir" && f.detail !== undefined) {
    const detailKey = ERR_DIR_DETAIL_KEYS[f.detail];
    if (detailKey !== undefined) return t(detailKey);
  }
  const key = ERR_KEYS[f.kind] ?? "spawn.errNetwork";
  return t(key);
});
const failureDetail = computed(() => {
  const f = failure.value;
  if (f === null) return null;
  if (f.hint !== undefined) {
    const key = HINT_KEYS[f.hint];
    if (key !== undefined) return t(key);
  }
  return f.message ?? f.code ?? null;
});
const failureRetryAfter = computed(() => {
  const f = failure.value;
  return f !== null && typeof f.retryAfterS === "number" ? f.retryAfterS : null;
});

function onRetry(): void {
  void newSession.value?.retry();
}

function onCancelOrClose(): void {
  const f = flow.value;
  if (f.phase === "confirming") newSession.value?.cancel();
  mkdirAck.value = null; // closing dismisses the mkdir ack
  emit("close");
}

/** Scrim keydown: Escape closes (content keydowns bubble up); Tab cycles inside the dialog. */
function onScrimKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    onCancelOrClose();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}

// ---------------------------------------------------------------------------
// document-level keydown (a11y fix, verifier finding on the modal redesign): the scrim
// handler above only sees keydowns that BUBBLE through it — i.e. only while focus is inside
// the dialog. A phase switch that disables the submit button or swaps the form for
// SpawnConfirm drops the focused element, focus falls to `<body>`, and from then on Escape
// no longer closed the dialog and Tab escaped into the background page. While open, the
// dialog therefore also listens at document level (capture), covering exactly the
// focus-fell-out case; content-originated keydowns keep taking the bubbling scrim path, so
// inner `stopPropagation` semantics are unchanged.
// ---------------------------------------------------------------------------

/** Topmost decision per the shared logic/overlayRoots.ts selector (preview-windows §5.2):
 *  Escape/Tab belong to this dialog only while it is the TOPMOST MODAL overlay — teleported
 *  overlays append to `<body>` in mount order, so the last one in document order is on top.
 *  The desktop modeless preview windows (`.is-modeless`) deliberately stay OUT of it. */
function ownsDocumentKeydown(ev: KeyboardEvent): boolean {
  const panel = panelEl.value;
  if (panel === null) return false;
  // Focus inside our dialog ⇒ the keydown bubbles to the scrim's own handler (see above).
  if (ev.target instanceof Node && panel.contains(ev.target)) return false;
  const roots = Array.from(document.querySelectorAll(MODAL_OVERLAY_ROOTS));
  for (const root of roots) {
    if (root !== scrimEl.value && ev.target instanceof Node && root.contains(ev.target)) return false;
  }
  const last = roots[roots.length - 1];
  return last === undefined || last === scrimEl.value;
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" && ev.key !== "Tab") return;
  if (!ownsDocumentKeydown(ev)) return;
  if (ev.key === "Escape") {
    ev.stopPropagation();
    onCancelOrClose();
    return;
  }
  trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="newSession" ref="scrimEl" class="spawn-scrim" @click.self="onCancelOrClose" @keydown="onScrimKeydown">
      <section
        ref="panelEl"
        class="spawn-picker"
        role="dialog"
        aria-modal="true"
        :aria-label="t('spawn.pickerAria')"
        tabindex="-1"
      >
        <template v-if="flow.phase === 'confirming'">
          <SpawnConfirm
            :resolved-cwd="flow.resolvedCwd"
            :reason="flow.reason"
            :plaintext="plaintext === true"
            @confirm="newSession.confirm()"
            @cancel="newSession.cancel()"
          />
        </template>

        <template v-else>
          <h3 class="spawn-picker-title">{{ t("spawn.pickerTitle") }}</h3>

          <div class="spawn-field">
            <label class="spawn-field-label" for="spawn-cwd">{{ t("spawn.pickerCwdLabel") }}</label>
            <div class="spawn-cwd-row">
              <input
                id="spawn-cwd"
                ref="cwdInput"
                v-model="cwd"
                class="input spawn-cwd-input"
                type="text"
                name="spawn-cwd"
                :placeholder="t('spawn.pickerCwdPlaceholder')"
                autocomplete="off"
                spellcheck="false"
                :disabled="busyPhase"
              />
              <button
                v-if="browseCap"
                class="btn btn-ghost spawn-browse-toggle"
                type="button"
                :disabled="busyPhase"
                :aria-expanded="browseOpen"
                @click="browseToggle"
              >
                <AppIcon name="folder" class="icon-sm" />{{ t("spawn.pickerBrowse") }}
              </button>
            </div>
            <!-- created-dirs r2 §4: persistent mkdir success ack (selected / created-only /
                 unregistered-on-plaintext-LAN); clears when the cwd diverges, on submit/close -->
            <p v-if="mkdirAck !== null" class="spawn-picker-status spawn-mkdir-ack" role="status">
              {{ t(mkdirAck.key, { path: mkdirAck.path }) }}
            </p>
          </div>

          <div v-if="browseOpen" class="spawn-browse" :aria-label="t('spawn.pickerBrowse')">
            <div class="spawn-browse-bar">
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="browseParent === null || browsePhase === 'loading'"
                @click="browseUp"
              >
                <AppIcon name="arrow-up" class="icon-sm" />{{ t("spawn.browseUp") }}
              </button>
              <span class="spawn-browse-path" :title="browsePath" translate="no">{{ browsePath }}</span>
              <!-- 常驻槽位 + visibility 切换：spinner 出现/消失不引起任何布局位移 -->
              <span
                class="spawn-browse-follow-busy"
                :class="{ 'is-active': followBusy }"
                role="status"
                :aria-label="t('spawn.browseLoading')"
              >
                <AppIcon name="loader" class="icon-sm spin" />
              </span>
              <button
                v-if="!mkdirOpen"
                class="btn btn-ghost btn-xs spawn-mkdir-open"
                type="button"
                :disabled="browsePhase === 'loading' || mkdirBusy"
                @click="mkdirStart"
              >
                {{ t("spawn.mkdirNew") }}
              </button>
            </div>
            <form v-if="mkdirOpen" class="spawn-mkdir-form" @submit.prevent="mkdirConfirm">
              <input
                v-model="mkdirName"
                class="input spawn-mkdir-input"
                type="text"
                name="spawn-mkdir-name"
                :placeholder="t('spawn.mkdirPlaceholder')"
                autocomplete="off"
                spellcheck="false"
                :disabled="mkdirBusy"
              />
              <button class="btn btn-primary btn-xs" type="submit" :disabled="mkdirBusy || mkdirName === ''">
                {{ t("spawn.mkdirCreate") }}
              </button>
              <button class="btn btn-ghost btn-xs" type="button" :disabled="mkdirBusy" @click="mkdirCancel">
                {{ t("spawn.mkdirCancel") }}
              </button>
            </form>
            <p v-if="mkdirErrorKey" class="spawn-picker-error spawn-mkdir-error" role="alert">
              {{ t(mkdirErrorKey) }}
            </p>
            <p v-if="followHint" class="spawn-picker-note spawn-browse-follow-note" role="note">
              {{ t("spawn.browseFollowInvalid") }}
            </p>
            <p v-if="browsePhase === 'loading'" class="spawn-picker-status" role="status">
              <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.browseLoading") }}
            </p>
            <p v-else-if="browsePhase === 'error'" class="spawn-picker-error" role="alert">
              {{ t(browseErrorKey ?? "spawn.browseErrNetwork") }}
            </p>
            <template v-else>
              <p v-if="browseListing !== null && browseListing.truncated" class="spawn-picker-note">
                {{ t("spawn.browseTruncated", { n: browseListing.entries.length }) }}
              </p>
              <p v-if="browseDirs.length === 0" class="spawn-picker-note">{{ t("spawn.browseEmpty") }}</p>
              <ul v-else class="spawn-browse-list">
                <li v-for="entry in browseDirs" :key="entry.name">
                  <button
                    v-if="entry.lossy !== true"
                    class="spawn-browse-row"
                    type="button"
                    :title="entry.name"
                    @click="browseInto(entry.name)"
                  >
                    <AppIcon name="folder" class="icon-sm" />
                    <span class="spawn-browse-name"
                      ><bdi translate="no">{{ entry.name }}</bdi></span
                    >
                  </button>
                  <!-- A3: a lossy name (U+FFFD) renders inert — never a dead button -->
                  <div v-else class="spawn-browse-row is-inert" :title="entry.name">
                    <AppIcon name="folder" class="icon-sm" />
                    <span class="spawn-browse-name"
                      ><bdi translate="no">{{ entry.name }}</bdi></span
                    >
                  </div>
                </li>
              </ul>
            </template>
            <div class="spawn-browse-actions">
              <button
                class="btn btn-primary btn-xs spawn-browse-choose"
                type="button"
                :disabled="browsePhase === 'loading'"
                @click="browseChoose"
              >
                {{ t("spawn.browseSelect") }}
              </button>
            </div>
          </div>

          <div v-if="recent.length > 0" class="spawn-field">
            <span class="spawn-field-label">{{ t("spawn.pickerRecentLabel") }}</span>
            <div class="spawn-recent">
              <button
                v-for="dir in recent"
                :key="dir.cwd"
                class="spawn-recent-btn"
                :class="{ 'is-current': dir.cwd === cwd.trim() }"
                type="button"
                :title="dir.cwd"
                :disabled="busyPhase"
                @click="pickRecent(dir)"
              >
                <AppIcon name="folder" class="icon-sm" />
                <span class="spawn-recent-label">{{ dir.label }}</span>
                <span class="spawn-recent-path" translate="no">{{ dir.cwd }}</span>
              </button>
            </div>
            <p v-if="recentPartial" class="spawn-picker-note">{{ t("spawn.pickerRecentPartial") }}</p>
          </div>
          <p v-else-if="recentFailed" class="spawn-picker-note">{{ t("spawn.pickerRecentError") }}</p>

          <p v-if="flow.phase === 'submitting'" class="spawn-picker-status" role="status">
            <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.pickerSubmitting") }}
          </p>
          <p v-else-if="flow.phase === 'awaiting'" class="spawn-picker-status" role="status">
            <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.pickerAwaiting") }}
            <span v-if="flow.firstPrompt" class="chip chip-spawn" translate="no">{{
              flow.firstPrompt.state === "sending" ? t("spawn.fpSending") : t("spawn.fpPending")
            }}</span>
          </p>
          <p v-else-if="flow.phase === 'unknown'" class="spawn-picker-status" role="status">
            {{ t("spawn.pickerUnknown") }}
          </p>
          <p v-else-if="flow.phase === 'done'" class="spawn-picker-status" role="status">
            {{ t("spawn.pickerDone") }}
          </p>

          <div v-if="failureText" class="spawn-picker-error" role="alert">
            <p class="spawn-picker-note">{{ failureText }}</p>
            <p v-if="failureDetail" class="spawn-picker-note">{{ failureDetail }}</p>
            <p v-if="failureRetryAfter !== null" class="spawn-picker-note">
              {{ t("spawn.errRetryAfter", { n: failureRetryAfter }) }}
            </p>
          </div>

          <div class="spawn-picker-actions">
            <button v-if="failure" class="btn" type="button" @click="onRetry">{{ t("spawn.pickerRetry") }}</button>
            <button class="btn btn-ghost" type="button" @click="onCancelOrClose">
              {{ busyPhase ? t("spawn.pickerClose") : t("spawn.pickerCancel") }}
            </button>
            <button ref="submitBtn" class="btn btn-primary" type="button" :disabled="submitDisabled" @click="onSubmit">
              {{ t("spawn.pickerSubmit") }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
