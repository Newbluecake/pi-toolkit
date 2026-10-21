<!--
  web-hub-html-preview plan v2 §5 (package P2): the RENDERED half of an HTML-entry preview.

  Mounted by `PreviewText.vue` (lazy, via `defineAsyncComponent` — it rides the dialog's text
  phase, which the Host already remounts per `view.path`) ONLY when the hub caps carry
  `preview.html.v1` AND the transport exposes `htmlCap`. Everything security-relevant is
  bound to the P0 frozen protocol constant — never re-typed here:

  - the iframe is `<iframe :sandbox="PV_SANDBOX" referrerpolicy="no-referrer" credentialless
    allow="" :src="cap.url">` — the SAME token string the hub's `Content-Security-Policy:
    sandbox` header carries (§1: two layers, dialog and header), never `allow-same-origin`,
    never `srcdoc`/`v-html`;
  - "open in new tab" is a plain anchor to the hub's script-free `/pvw/<cap>` wrapper
    (§3.2/D3) with `target="_blank" rel="noopener noreferrer"` — the tab is equally sandboxed.

  Mint lifecycle: `minting → ready | error`. On mount (and on 「重新加载」) it calls
  `transport.htmlCap({agentKey, sessionId, path})` — ONE capability per call, never deduped.
  A mint failure is EMITTED (`mint-error`) so PreviewText can switch to the source view with
  a one-line reason (403 `dir-too-broad`/`upload` ⇒ the prose note; 429/503 ⇒ the retry
  affordance); this component's own error view is the standalone fallback for when it stays
  mounted (component-level tests / a parent that ignores the emit).

  TTL UX (§R1-8, fixed): `idleMs` elapsed since mint ⇒ the non-blocking 「可能需刷新」 hint
  (+ the same 「重新加载」 button); `hardRemainingMs` elapsed ⇒ the 「链接已过期」 banner +
  「重新加载」 (re-mint + `:key` bump). The RUNNING IFRAME IS NEVER UNLOADED AUTOMATICALLY —
  timers only flip hint flags; the src attribute changes exclusively when the user acts.
  `@load` hides the spinner; > 10 s without it ⇒ 「仍在加载…」. A standing note explains the
  sandbox boundary. Deliberately NO `window` `message` listener exists in this component
  (T-U1 pins it): the framed page is untrusted and nothing it postMessages is ever read.

  Eviction ledger (preview-windows plan §8.2, W3): the hub's per-login 8-cap FIFO can evict
  THIS cap silently (other windows' mints in the same tab — or other tabs). When the host
  provides `PREVIEW_HTML_LEDGER` (PreviewHost's provide), every successful mint is recorded
  and a later mint that displaces THIS token flips a `role="status"` 「可能已被挤掉」 notice;
  absent ⇒ byte-identical pre-W3 behavior. The 「重新加载」 button in the toolbar is STANDING
  (§8.2-3): re-minting mints a fresh token, which clears the notice. `maybeStale` keeps only
  its hint text; the `expired` banner keeps its own button.
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { PV_SANDBOX } from "@protocol/preview-html.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { HUB_CTX } from "../control/controlContext.js";
import { PREVIEW_HTML_LEDGER } from "./previewHtmlLedger.js";

const props = defineProps<{
  readonly agentKey: string;
  readonly sessionId: string;
  /** The FULL request path of the HTML entry (the same string the mint body carries). */
  readonly path: string;
}>();
const emit = defineEmits<{
  (e: "mint-error", err: { readonly status: number; readonly error: string; readonly reason?: string }): void;
}>();

const hub = inject(HUB_CTX, null);
const ledger = inject(PREVIEW_HTML_LEDGER, null);
const { t } = useI18n();

type Cap = {
  readonly url: string;
  readonly openUrl: string;
  readonly idleMs: number;
  readonly hardRemainingMs: number;
};

const phase = ref<"minting" | "ready" | "error">("minting");
const cap = ref<Cap | null>(null);
const mintErr = ref<{ status: number; error: string; reason?: string } | null>(null);
const frameKey = ref(0);
const loaded = ref(false);
const slow = ref(false);
const maybeStale = ref(false);
const expired = ref(false);
const busy = ref(false);

let controller: AbortController | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let hardTimer: ReturnType<typeof setTimeout> | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

const frameTitle = computed(() => {
  const p = props.path;
  const slash = p.lastIndexOf("/");
  return slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
});

/** §8.2: the tab-local FIFO simulation flags this cap's token as displaced. Reactive via the
 *  wrapper's version ref — a later mint elsewhere flips this without any local timer. */
const evictedHint = computed(() => {
  const c = cap.value;
  return ledger !== null && c !== null && ledger.isEvicted(c.url);
});

/** §5: mint errors the UI should offer a retry for (the same table as the dialog's error phase). */
const retryable = computed(() => {
  const e = mintErr.value;
  if (e === null) return false;
  return e.status === 429 || e.status >= 500 || e.error === "E_NETWORK" || e.error === "E_DEADLINE";
});

function clearTtlTimers(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  if (hardTimer !== null) clearTimeout(hardTimer);
  idleTimer = hardTimer = null;
}

function clearSlowTimer(): void {
  if (slowTimer !== null) clearTimeout(slowTimer);
  slowTimer = null;
}

/** Arm the §R1-8 TTL flags from the mint answer (measured from RESPONSE arrival — the hint is
 *  deliberately approximate: 「可能需刷新」, never a claim the cap is already dead). */
function armTtl(c: Cap): void {
  clearTtlTimers();
  maybeStale.value = false;
  expired.value = false;
  idleTimer = setTimeout(
    () => {
      idleTimer = null;
      maybeStale.value = true;
    },
    Math.max(0, c.idleMs),
  );
  hardTimer = setTimeout(
    () => {
      hardTimer = null;
      expired.value = true;
    },
    Math.max(0, c.hardRemainingMs),
  );
}

async function mint(): Promise<void> {
  const method = hub?.preview?.htmlCap;
  if (busy.value) return;
  if (method === undefined) {
    // Defensive only — PreviewText gates on the method's presence; a standalone/fake mount
    // without one surfaces the standard unsupported error instead of an eternal spinner.
    mintErr.value = { status: 0, error: "E_UNSUPPORTED" };
    phase.value = "error";
    emit("mint-error", mintErr.value);
    return;
  }
  busy.value = true;
  const mySeq = ++seq;
  controller?.abort();
  controller = typeof AbortController === "function" ? new AbortController() : null;
  phase.value = "minting";
  cap.value = null;
  loaded.value = false;
  slow.value = false;
  clearTtlTimers();
  clearSlowTimer();
  try {
    const out = await method(
      { agentKey: props.agentKey, sessionId: props.sessionId, path: props.path },
      { signal: controller?.signal ?? ({ aborted: false } as AbortSignal) },
    );
    if (mySeq !== seq) return; // a later mint/reload superseded this answer
    if (out.ok) {
      cap.value = { url: out.url, openUrl: out.openUrl, idleMs: out.idleMs, hardRemainingMs: out.hardRemainingMs };
      ledger?.minted(out.url); // the cap URL is the token — unique per mint
      frameKey.value++; // force a FRESH iframe element for the new cap's url
      phase.value = "ready";
      armTtl(cap.value);
      // > 10 s without `@load` ⇒ 「仍在加载…」 (the spinner stays until load either way).
      slowTimer = setTimeout(() => {
        slow.value = true;
      }, 10_000);
      return;
    }
    const err = { status: out.status, error: out.error, ...(out.reason !== undefined ? { reason: out.reason } : {}) };
    mintErr.value = err;
    phase.value = "error";
    emit("mint-error", err);
  } catch {
    // A throwing fake/transport defect degrades to the same error view — never a crash.
    if (mySeq !== seq) return;
    mintErr.value = { status: 0, error: "E_NETWORK" };
    phase.value = "error";
    emit("mint-error", mintErr.value);
  } finally {
    if (mySeq === seq) busy.value = false;
  }
}

function onLoad(): void {
  loaded.value = true;
  slow.value = false;
  clearSlowTimer();
}

onMounted(() => void mint());
onBeforeUnmount(() => {
  seq++; // invalidate any in-flight mint's state writes
  controller?.abort();
  if (cap.value !== null) ledger?.unmounted(cap.value.url); // §8.2: slot still occupies
  clearTtlTimers();
  clearSlowTimer();
});
</script>

<template>
  <div class="preview-html">
    <template v-if="phase === 'ready' && cap !== null">
      <div class="preview-html-bar">
        <a :href="cap.openUrl" target="_blank" rel="noopener noreferrer" class="preview-html-open" translate="no">{{
          t("preview.htmlOpenTab")
        }}</a>
        <span v-if="maybeStale && !expired" class="preview-html-stale" role="status">{{
          t("preview.htmlMaybeStale")
        }}</span>
        <!-- §8.2-3: STANDING reload — the eviction notice's deterministic recovery entry. -->
        <button type="button" class="preview-toggle-btn preview-html-reload" :disabled="busy" @click="mint">
          {{ t("preview.htmlReload") }}
        </button>
      </div>
      <p v-if="evictedHint" class="preview-html-note" role="status">{{ t("preview.htmlMaybeEvicted") }}</p>
      <p v-if="expired" class="preview-html-expired" role="alert">
        <span>{{ t("preview.htmlExpired") }}</span>
        <button type="button" class="preview-toggle-btn preview-html-reload" :disabled="busy" @click="mint">
          {{ t("preview.htmlReload") }}
        </button>
      </p>
      <div class="preview-html-stage">
        <iframe
          :key="frameKey"
          class="preview-html-frame"
          :sandbox="PV_SANDBOX"
          referrerpolicy="no-referrer"
          credentialless
          allow=""
          :src="cap.url"
          :title="frameTitle"
          @load="onLoad"
        ></iframe>
        <div v-if="!loaded" class="preview-html-loading" role="status">
          <AppIcon name="loader" class="preview-spinner" />
          <span>{{ slow ? t("preview.htmlLoadingSlow") : t("preview.loading") }}</span>
        </div>
      </div>
      <p class="preview-html-note" role="note">{{ t("preview.htmlNote") }}</p>
    </template>
    <div v-else-if="phase === 'minting'" class="preview-loading" role="status">
      <AppIcon name="loader" class="preview-spinner" />
      <span>{{ t("preview.loading") }}</span>
    </div>
    <div v-else class="preview-html-error">
      <p class="preview-md-note" role="note">{{ t("preview.htmlMintFailed", { code: mintErr?.error ?? "?" }) }}</p>
      <button v-if="retryable" type="button" class="preview-toggle-btn" @click="mint">
        {{ t("preview.retry") }}
      </button>
    </div>
  </div>
</template>
