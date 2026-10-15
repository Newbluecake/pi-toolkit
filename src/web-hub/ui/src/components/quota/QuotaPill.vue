<!--
  Top-bar subscription-quota pill (quota-web plan §3/D1/D6/D7 + the 2026-10 multi-group
  requirements). Self-contained: owns its own `open`/anchor state (same pattern as `TopBar.vue`'s
  gear + `SettingsOverlay`), so `TopBar.vue` only ever mounts this one component. Renders nothing
  (`v-if="display"`) when `quota` is absent or carries no windowed providers — the caller
  (`TopBar.vue`) additionally never mounts this component at all in that case (a `v-for` over a
  0/1-item list, NOT a `v-if`, so the "off" state leaves literally zero extra DOM nodes — see
  `TopBar.vue`'s own comment for why a plain `v-if` cannot achieve that in Vue's compiled output).

  Display modes (2026-10-08 user rulings, `logic/quota.js`'s `pillDisplay`):
  - available (≥1 group at level<3): ONLY the available groups render, each with BOTH its
    windows (5h first, then 7d — each window's own pct) plus its D6 reset annex; exhausted
    groups are hidden from the pill's face but stay in aria/title (discoverable via hover/SR).
  - exhausted (ALL groups level 3): every group renders as `⚠ Label · 7d {clock} 重置` (clock
    from the group's weekResetAt; omitted when unknown) — "什么订阅可用" collapsed into "什么时候
    恢复".
  The GLM pair (`zai-coding-cn`+`zai`) ALWAYS merges into one "GLM" group when both are present
  (`glmPair`, 2026-10-14 ruling — values per scope = worst-of the two sides; an intl-only
  snapshot labels "GLM" too); an
  exhausted group never loses its label — ⚠ is only ever a prefix. The pill's own `data-level`
  is the max level among the SHOWN groups (border/background semantics).

  Phone compact chip (≤480px, user-approved plan B): instead of every group's full text the
  pill collapses to a single `{pct}%` number — the single most-constrained (provider, window)
  pair across the WHOLE snapshot, i.e. `@logic/quota.js`'s existing `pillView` (the D6 "worst of
  everything" selector QuotaCard's own headline number already uses; a NEW metric was
  deliberately avoided). The segment keeps its own severity dot/colour
  (`.q-seg[data-level]`); tapping still opens the same `QuotaCard`. The aria label/title stay
  the FULL per-group sentence regardless of width — only the visible text shrinks.

  P7w: droid billing-API auth failures (HTTP 401/402/403, `QuotaWire.problems`) render as one
  `.q-seg.q-problem` chip each after the groups (no template comment there: dev-mode comments
  would break the legacy HTML golden's byte parity).

  `nowTick` is the one local timer this package owns: every absolute timestamp (`resetAt`) is
  re-formatted from scratch each tick (D2 — the agent never re-pushes purposefully for a clock
  edge), at a 60s cadence (reset times are never shown to the minute of the *next* minute, so a
  shorter cadence buys nothing). Passed down to `QuotaCard` so both surfaces repaint in lockstep
  off one timer instead of two independently-phased ones.

  Width tiers + hover peek (2026-10-15, user: 「quota 在 topbar 的宽度不能一直增长，如果项目过多，
  可以转换成悬浮展示的形式」): the desktop/tablet face has THREE monotonically shrinking tiers —
  `full` (exactly the text below), `compact` (`GLM 7d 35%` — label + most-constrained window + pct)
  and `names` (`GLM` — label only, state carried by the label's colour, see quota.css). Every tier's
  natural width is measured on a `visibility:hidden` measurer that renders all three faces
  independently of the tier currently shown (rendered only after the first real `ResizeObserver`
  delivery — happy-dom's RO never fires, so the byte-parity goldens stay intact); the available
  width is the flex bar's grant (anchor + topbar-spacer width, invariant under tier switches),
  capped by the pill's own CSS max-width. A tier drops the moment it overflows and expands only
  with 8px hysteresis slack. On `(hover:hover) and (pointer:fine)` devices, hovering the pill
  ~150ms opens the same `QuotaCard` in a non-pinned "peek" state (no focus steal) that closes
  ~200ms after the pointer leaves BOTH pill and card; a click still pins exactly as before.
  aria-label/title always carry the full per-group sentence in every tier. The phone band
  (≤480px) NEVER renders `data-face` (R7: the chip keeps the pre-tier look byte-for-byte;
  `face` is simply ignored there — `evaluateFace` early-returns on phone — and re-evaluated by
  the RO when the viewport leaves the phone band).
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { fmtCents, fmtResetAt, pillDisplay, pillGroups, pillView, scopeLabel } from "@logic/quota.js";
import type { QuotaWire } from "@protocol/messages.js";
import QuotaCard from "./QuotaCard.vue";
import "../../styles/quota.css";

/** Mirrors `pillGroups`/`pillDisplay`'s JSDoc return shapes (`logic/quota.js` — the module is
 *  JS, so the contract is re-declared here for vue-tsc; keys are always present, *At may be
 *  undefined). */
interface PillWindow {
  scope: "5h" | "week" | "month";
  level: 0 | 1 | 2 | 3;
  usedPct: number;
}

interface PillGroup {
  ids: string[];
  labelId: string;
  level: 0 | 1 | 2 | 3;
  scope: "5h" | "week" | "month";
  usedPct: number;
  windows: PillWindow[];
  weekResetAt: number | undefined;
  /** Exhausted-mode clock source (week for non-droid; longest exhausted window for droid-*). */
  exhaustScope: "5h" | "week" | "month";
  exhaustResetAt: number | undefined;
  extra?: { cents: number };
  resetScope: "5h" | "week" | "month" | undefined;
  resetAt: number | undefined;
  available: boolean;
  stale: boolean;
}

interface PillProblem {
  family: "droid";
  status: number;
}

interface PillDisplay {
  mode: "available" | "exhausted";
  groups: PillGroup[];
  problems?: PillProblem[];
}

/** The pill's face tier (2026-10-15 width tiers): `full` = today's text; `compact` = label +
 *  most-constrained window + pct; `names` = label only (colour carries state). */
type Face = "full" | "compact" | "names";
/** Fullest first — natural widths are monotonically non-increasing down this list (each tier's
 *  text is a strict prefix-extension of the next), which the tier scan in `evaluateFace` relies
 *  on when it takes the FIRST tier that fits as "the fullest that fits". */
const FACE_TIERS = ["full", "compact", "names"] as const;
/** Expansion hysteresis (px): a tier drops the moment it overflows, but the face only grows
 *  back when the fuller tier fits with this much slack — the dead zone stops boundary
 *  oscillation from resize rounding / scrollbar appear-disappear / font metric jitter. */
const FACE_HYST_PX = 8;

/** Mirrors `pillView`'s JSDoc return shape (same re-declaration discipline as `PillGroup` above). */
interface PillViewResult {
  level: 0 | 1 | 2 | 3;
  providerId: string;
  scope: "5h" | "week" | "month";
  usedPct: number;
  resetScope: "5h" | "week" | "month" | undefined;
  resetAt: number | undefined;
}

const props = defineProps<{ quota: QuotaWire | undefined }>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 767px)").matches;
const phone = useMedia(window, "(max-width: 480px)").matches;
/** Hover-capable pointer (desktop): gates the hover-peek popover — phones/tablets never
 *  auto-open on hover (their "hover" is a long-press emulation at best). */
const hoverFine = useMedia(window, "(hover: hover) and (pointer: fine)").matches;

/** The face tier currently shown. Only ever moved by `evaluateFace` (measurement-driven);
 *  starts at `full` so a measurement-less environment (happy-dom, print) renders exactly the
 *  pre-feature face — that is what keeps the byte-parity goldens meaningful. */
const face = ref<Face>("full");

const nowTick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now();
  }, 60_000);
  // Observe everything whose size encodes the available width: the anchor itself (window
  // resize at the extremes), the top bar (window resize) and the spacer (sibling content
  // changes — e.g. the load pill mounting — eat slack without moving the bar's own width).
  // The first delivery flips `canMeasure`, which renders the measurer; every later delivery
  // just re-runs the (idempotent) evaluation.
  const anchor = btnEl.value?.parentElement ?? null;
  if (anchor === null || typeof ResizeObserver !== "function") return;
  ro = new ResizeObserver(() => {
    canMeasure.value = true;
    void evaluateFace();
  });
  ro.observe(anchor); // the pill's granted width while the bar is fully packed (spacer 0)
  const bar = anchor.parentElement;
  if (bar !== null) ro.observe(bar); // window resize
  const spacer = topbarSpacer(anchor);
  if (spacer !== null) ro.observe(spacer); // sibling content changes eat slack without moving the bar
});
onUnmounted(() => {
  ro?.disconnect();
  if (hoverIn !== undefined) clearTimeout(hoverIn);
  if (hoverOut !== undefined) clearTimeout(hoverOut);
  if (timer !== undefined) clearInterval(timer);
});

/** What the pill's FACE shows (available-only / exhausted week-resets). */
const display = computed((): PillDisplay | null => pillDisplay(props.quota) as PillDisplay | null);
/** ALL groups — the aria/title source: hidden exhausted groups stay discoverable (2026-10-08). */
const allGroups = computed((): PillGroup[] => pillGroups(props.quota) as PillGroup[]);

/** The pill's own level = max among the SHOWN groups — keeps the whole-pill border/background
 *  ladder (exhausted-only mode is always 3 by construction). */
const pillLevel = computed(() => {
  const groups = display.value?.groups ?? [];
  // P7w: an auth problem raises the pill to at least level 2.
  return Math.max(0, ...groups.map((g) => g.level), problems.value.length > 0 ? 2 : 0);
});
const problems = computed((): PillProblem[] => display.value?.problems ?? []);

const btnEl = ref<HTMLButtonElement | null>(null);

/* --------------------------------------------------------- popover: pinned + hover peek */

/** Click-pinned open (today's only open state). */
const pinned = ref(false);
/** Hover "peek" open (hover-capable pointers only): same `QuotaCard`, but non-pinned — closes
 *  ~200ms after the pointer leaves BOTH the pill and the card, never steals focus (`QuotaCard`
 *  `peek` prop), and a click on top of it simply pins it. */
const peek = ref(false);
const open = computed(() => pinned.value || peek.value);

let hoverIn: ReturnType<typeof setTimeout> | undefined;
let hoverOut: ReturnType<typeof setTimeout> | undefined;

function onToggle(): void {
  pinned.value = !pinned.value;
  peek.value = false;
}
function onClose(): void {
  pinned.value = false;
  peek.value = false;
}

/** Cancel any pending peek-close (pointer re-entered pill or card). */
function stopPeekClose(): void {
  if (hoverOut !== undefined) {
    clearTimeout(hoverOut);
    hoverOut = undefined;
  }
}

/** ~150ms hover before opening (a pointer merely transiting the bar must not flash the card).
 *  Also bound to the CARD's mouseenter (attrs fallthrough): when the card is open, `open` is
 *  true so this only cancels a pending close — exactly the card's enter semantics. */
function onPillEnter(): void {
  stopPeekClose();
  if (!hoverFine.value || phone.value || open.value) return;
  hoverIn = setTimeout(() => {
    hoverIn = undefined;
    peek.value = true;
  }, 150);
}

/** ~200ms close grace: covers the pill→card traversal gap; cancelled by re-entering either. */
function schedulePeekClose(): void {
  stopPeekClose();
  hoverOut = setTimeout(() => {
    hoverOut = undefined;
    peek.value = false;
  }, 200);
}

/** Leaving the pill OR the card (the card's mouseleave binds this too — clearing a pending
 *  open there is a harmless no-op): close the peek unless a click pinned it. */
function onPillLeave(): void {
  if (hoverIn !== undefined) {
    clearTimeout(hoverIn);
    hoverIn = undefined;
  }
  if (!pinned.value && peek.value) schedulePeekClose();
}
function providerLabel(id: string): string {
  const key = `quota.provider.${id}`;
  const label = t(key);
  // Unknown provider id (a future wire peer): t() falls back to the raw key — degrade to the
  // bare id instead, never "quota.provider.xxx" (verifier 2026-10).
  return label === key ? id : label;
}

function clockOf(at: number | undefined): string | undefined {
  return at === undefined ? undefined : fmtResetAt(at, nowTick.value);
}

/** One group's reset annex ("· {clock} reset"), or "" when no reset annex applies (D6). */
function resetAnnex(g: PillGroup): string {
  const clock = clockOf(g.resetAt);
  return clock === undefined ? "" : ` · ${t("quota.resetSuffix", { clock })}`;
}

/** Available mode: `GLM 5h 17% · 7d 43% · {clock} reset` (both windows, 5h first — each
 *  window's own pct; D6 annex at the end). Exhausted mode: `⚠ Kimi · 7d {clock} reset` (clock
 *  from the week window, omitted when unknown). This is the FULL tier — byte-identical to the
 *  pre-2026-10-15 face. */
function fullText(g: PillGroup): string {
  const label = providerLabel(g.labelId);
  const exhausted = display.value?.mode === "exhausted";
  if (exhausted) {
    const clock = clockOf(g.exhaustResetAt);
    const scope = scopeLabel(g.exhaustScope);
    if (mobile.value) return clock === undefined ? `⚠ ${label}` : `⚠ ${label} ${clock}`;
    return clock === undefined ? `⚠ ${label} · ${scope}` : `⚠ ${label} · ${scope} ${t("quota.resetSuffix", { clock })}`;
  }
  if (mobile.value) {
    // `GLM 17%/43%` — pct-only, 5h/7d order; a single-window provider shows just its one pct.
    return `${label} ${g.windows.map((w) => `${w.usedPct}%`).join("/")}`;
  }
  const windows = g.windows.map((w) => `${scopeLabel(w.scope)} ${w.usedPct}%`).join(" · ");
  // 2026-10-12: a frozen (stale) wire is visibly marked — gray dot via [data-stale] + a
  // trailing compact English `·stale` token (AGENTS.md marker policy), so an idle process's
  // old snapshot can never again look fully live on the pill face.
  const staleSuffix = g.stale ? " ·stale" : "";
  const extra = g.extra === undefined ? undefined : fmtCents(g.extra.cents);
  const extraSuffix = extra === undefined ? "" : ` · extra ${extra}`;
  return `${label} ${windows}${resetAnnex(g)}${extraSuffix}${staleSuffix}`;
}

/** Scope preference on an exact usedPct tie in `mostConstrained`: the LONGER window wins
 *  (month > week > 5h — a tied longer window is the binding constraint, user spec 2026-10-15). */
const SCOPE_RANK: Record<PillWindow["scope"], number> = { month: 3, week: 2, "5h": 1 };

/** The compact tier's "most-constrained window": max `usedPct` (NOT the headline window — that
 *  ranks level first); exact ties prefer the longer window via `SCOPE_RANK`. */
function mostConstrained(g: PillGroup): PillWindow | undefined {
  let best: PillWindow | undefined;
  for (const w of g.windows) {
    if (
      best === undefined ||
      w.usedPct > best.usedPct ||
      (w.usedPct === best.usedPct && SCOPE_RANK[w.scope] > SCOPE_RANK[best.scope])
    ) {
      best = w;
    }
  }
  return best;
}

/** One group's face text in a given tier: full = today's text; compact = `GLM 7d 35%`
 *  (⚠-prefixed for exhausted groups, clock dropped); names = `GLM` / `⚠ Kimi` — in compact and
 *  names the subscription state rides on the label's COLOUR (quota.css `[data-face]` ladder),
 *  and the `·stale`/extra annexes are dropped (the stale gray carries the frozen-wire signal). */
function faceText(tier: Face, g: PillGroup): string {
  if (tier === "full") return fullText(g);
  const label = providerLabel(g.labelId);
  const mark = display.value?.mode === "exhausted" ? `⚠ ${label}` : label;
  if (tier === "names") return mark;
  const w = mostConstrained(g);
  return w === undefined ? mark : `${mark} ${scopeLabel(w.scope)} ${w.usedPct}%`;
}

/** The LIVE face's group text (the measurer below calls `faceText(tier, g)` per tier instead). */
function segText(g: PillGroup): string {
  return faceText(face.value, g);
}

/** One group's aria sentence (existing `pillAriaBase`/`pillAriaReset` templates, one per group
 *  — headline window + D6 annex; applies to hidden exhausted groups too). */
function groupAria(g: PillGroup): string {
  const provider = providerLabel(g.labelId);
  const scope = scopeLabel(g.scope);
  if (g.resetAt !== undefined) {
    const clock = fmtResetAt(g.resetAt, nowTick.value);
    if (clock !== undefined) return t("quota.pillAriaReset", { provider, scope, pct: g.usedPct, clock });
  }
  return t("quota.pillAriaBase", { provider, scope, pct: g.usedPct });
}

/** Wire-level stale for the phone compact chip: any stale provider grays the dot (the chip
 *  shows a whole-snapshot worst number, so per-group granularity doesn't exist there). */
const anyStale = computed(() => (props.quota?.providers ?? []).some((p) => p.stale === true));

function problemText(tier: Face, p: PillProblem): string {
  // Brand token "Droid" (i18n parity with provider labels); the compact/names tiers drop it —
  // `auth 402` — since space is exactly what ran out there.
  return tier === "full" ? `Droid auth ${p.status}` : `auth ${p.status}`;
}

const ariaLabel = computed(() =>
  [...allGroups.value.map(groupAria), ...problems.value.map((p) => t("quota.problemAria", { status: p.status }))].join(
    "; ",
  ),
);

/** Phone compact chip (≤480px): the single most-constrained (provider, window) pair across
 *  the WHOLE snapshot — `pillView`'s existing D6 "worst of everything" selector, not a new
 *  metric. `null` only when `display` is already falsy (the pill isn't mounted at all in that
 *  case), so the `?? 0`/`?? 0` fallbacks below are defensive, never actually exercised. */
const compact = computed((): PillViewResult | null => pillView(props.quota) as PillViewResult | null);
const compactLevel = computed(() => Math.max(compact.value?.level ?? 0, problems.value.length > 0 ? 2 : 0));
/** Only problems (no windowed group) ⇒ the chip reads `auth 402` instead of a bogus `0%`. */
const compactText = computed(() =>
  compact.value === null && problems.value[0] !== undefined
    ? `auth ${problems.value[0].status}`
    : `${compact.value?.usedPct ?? 0}%`,
);

/* ------------------------------------------------------------- width-tier measurement */

/** Renders the measurer (below) only after the first real `ResizeObserver` delivery. Real
 *  browsers fire RO on `observe()` with the live size; happy-dom's RO NEVER fires (verified
 *  2026-10-15), so layout-less test environments — including the two byte-parity goldens —
 *  never see the measurer in the DOM and the face stays `full`. */
const canMeasure = ref(false);

/** The top bar's flexible spacer (`shell.css` `.topbar-spacer { flex: 1 }`): its live width is
 *  exactly the bar's slack, which is why anchor+spacer is a tier-independent estimator of the
 *  width the bar can grant the pill — switching tiers only moves width between the pill and
 *  the spacer, never changes the sum. `null` outside the top bar (bare unit-test mounts) or
 *  in a future layout without a spacer — then the anchor width alone stands. */
function topbarSpacer(anchor: HTMLElement): HTMLElement | null {
  // descendant query is safe: the only `.topbar-spacer` in the tree is the bar's own flex item
  return anchor.parentElement?.querySelector(".topbar-spacer") ?? null;
}

/** The pill's own CSS max-width (`min(50vw, 560px)`, quota.css), resolved to px by forcing the
 *  real pill to an absurd width for one synchronous, never-painted layout pass and reading
 *  what the cap clamped it to. The inline style is restored byte-exactly afterwards
 *  (`removeAttribute` when there was none) so even a mid-measure HTML capture cannot observe
 *  the probe. */
function cssCapPx(pill: HTMLElement): number {
  const saved = pill.style.cssText; // restore via cssText (never setAttribute("style"…) — source-scan ban)
  pill.style.cssText = "min-width:0;flex:0 0 auto;width:999999px";
  const cap = pill.offsetWidth;
  pill.style.cssText = saved;
  return cap;
}

/** The hidden measurer: ONE CLONE of the live pill per tier, appended imperatively (NOT via
 *  template nodes — even a false `v-if` leaves a `<!--v-if-->` anchor and comments DO land in
 *  the DOM under the dev/test renderer, and the byte-parity goldens pin this component's DOM
 *  byte-for-byte). Each clone keeps the live face's exact classes/markup (padding, border,
 *  font, the L3 semibold via `.q-seg[data-level]`), so its width is faithful; only the
 *  `.q-seg-text` contents are rewritten per tier. `visibility:hidden` (quota.css `.q-measure`)
 *  keeps the engine computing layout while nothing is visible and `pointer-events:none` keeps
 *  it out of hit-testing; absolutely positioned inside `.q-anchor` so measuring never moves
 *  the thing being measured. Rebuilt when any text-bearing input changes (wire, band, clocks).
 *  `null` while `display` is falsy (never — evaluateFace is not called then). */
let measureHost: HTMLElement | null = null;
let measureSig = "";

function ensureMeasurer(pill: HTMLElement): HTMLElement | null {
  const groups = display.value?.groups ?? [];
  const sig = [
    display.value?.mode ?? "",
    groups
      .map((g) => `${g.labelId}:${g.stale ? 1 : 0}:${g.windows.map((w) => `${w.scope}${w.usedPct}`).join("/")}`)
      .join("|"),
    problems.value.map((p) => p.status).join("|"),
    nowTick.value,
    mobile.value ? "m" : "d",
  ].join("#");
  if (measureHost !== null && measureSig === sig) return measureHost;
  measureHost?.remove();
  const host = document.createElement("span");
  host.className = "q-measure";
  host.setAttribute("aria-hidden", "true");
  for (const tier of FACE_TIERS) {
    const clone = pill.cloneNode(true) as HTMLElement;
    clone.classList.add("q-measure-t");
    // Verifier R1/R2 fix: the clone must render in ITS OWN tier's CSS — the live pill it was
    // cloned from carries the CURRENT face's data-face (or none in full), so without this
    // overwrite the compact/names clones measure at regular weight while the real face
    // renders semibold (quota.css `[data-face]`), underestimating by ~20px per face and
    // causing compact to ellipsize at the boundary instead of dropping to names.
    clone.setAttribute("data-face", tier);
    const segs = clone.querySelectorAll(".q-seg-text");
    let n = 0;
    for (const g of groups) {
      const el = segs[n++];
      if (el !== undefined) el.textContent = faceText(tier, g);
    }
    for (const p of problems.value) {
      const el = segs[n++];
      if (el !== undefined) el.textContent = problemText(tier, p);
    }
    host.appendChild(clone);
  }
  anchorOf(pill).appendChild(host);
  measureHost = host;
  measureSig = sig;
  return host;
}

function anchorOf(pill: HTMLElement): HTMLElement {
  return pill.parentElement ?? pill;
}

/** Re-evaluates the face tier: the fullest tier whose MEASURED natural width fits
 *  `min(bar grant, CSS cap)` wins (`names` when even it overflows — CSS ellipsis takes over);
 *  dropping happens at plain overflow, expanding only with `FACE_HYST_PX` slack (scan from
 *  just-fuller-than-current upwards). Idempotent, so the RO storm after a tier switch
 *  (anchor+spacer resize) settles immediately. */
async function evaluateFace(): Promise<void> {
  const pill = btnEl.value;
  const anchor = pill?.parentElement ?? null;
  if (!canMeasure.value || pill === null || anchor === null || phone.value) return;
  await nextTick(); // the live face's current render must be committed before cloning it
  const host = ensureMeasurer(pill);
  if (host === null) return;
  const avail = anchor.offsetWidth + (topbarSpacer(anchor)?.offsetWidth ?? 0);
  if (avail <= 0) return; // hidden / layout-less (defensive) — keep the current face
  const limit = Math.min(avail, cssCapPx(pill));
  const w = Array.from(host.children, (c) => (c as HTMLElement).offsetWidth); // FACE_TIERS order
  let want = w[0]! <= limit ? 0 : w[1]! <= limit ? 1 : 2; // fullest fitting; 2 (names) when none does
  const cur = FACE_TIERS.indexOf(face.value);
  if (want < cur) {
    // expanding: only into a fuller tier that fits WITH slack (hysteresis); otherwise stay
    let up = cur;
    for (let i = cur - 1; i >= 0; i--) {
      if (w[i]! + FACE_HYST_PX <= limit) {
        up = i;
        break;
      }
    }
    want = up;
  }
  if (want !== cur) face.value = FACE_TIERS[want]!;
}

let ro: ResizeObserver | undefined;

/** Quota text inputs re-run the evaluation: `display` (new wire) and `nowTick` (reset clocks
 *  change text length). Band flips (mobile/phone) always accompany a viewport resize, which the
 *  ResizeObserver above already re-evaluates on. */
watch([display, nowTick], () => void evaluateFace());
</script>

<template>
  <span v-if="display" class="q-anchor">
    <button
      ref="btnEl"
      type="button"
      class="q-pill"
      :data-level="pillLevel"
      :data-face="!phone && face !== 'full' ? face : undefined"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="quota-panel"
      :aria-label="ariaLabel"
      :title="ariaLabel"
      @click="onToggle"
      @mouseenter="onPillEnter"
      @mouseleave="onPillLeave"
    >
      <span v-if="phone" class="q-pill-text">
        <span class="q-seg q-seg-compact" :data-level="compactLevel" :data-stale="anyStale || undefined">
          <span class="q-dot" aria-hidden="true"></span>
          <span class="q-seg-text">{{ compactText }}</span>
        </span>
      </span>
      <span v-else class="q-pill-text">
        <template v-for="(g, i) in display.groups" :key="g.labelId">
          <!-- Thin separator between groups (the "·" glyph is the mobile form; desktop CSS clips
               it down to a 1px rule so it never reads like the reset annex's own " · "). -->
          <span v-if="i > 0" class="q-sep" aria-hidden="true"> · </span>
          <span class="q-seg" :data-level="g.level" :data-stale="g.stale || undefined">
            <span class="q-dot" aria-hidden="true"></span>
            <span class="q-seg-text">{{ segText(g) }}</span>
          </span>
        </template>
        <template v-for="(p, i) in problems" :key="`problem-${p.status}-${i}`">
          <span v-if="display.groups.length > 0 || i > 0" class="q-sep" aria-hidden="true"> · </span>
          <span class="q-seg q-problem" data-level="2">
            <span class="q-dot" aria-hidden="true"></span>
            <span class="q-seg-text">{{ problemText(face, p) }}</span>
          </span>
        </template>
      </span>
    </button>
    <QuotaCard
      v-if="open && quota"
      :quota="quota"
      :now="nowTick"
      :anchor-el="btnEl"
      :peek="peek"
      @close="onClose"
      @mouseenter="onPillEnter"
      @mouseleave="onPillLeave"
    />
  </span>
</template>
