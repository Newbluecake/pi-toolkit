<!--
  Recursive inline-node renderer for a `parseMarkdown()` AST (ui-design.md §3.10/§13,
  vue-plan.md v2.1 §3.10/§5.2 — P4). Every branch renders through Vue's own template
  interpolation/element creation — no `v-html`, no raw HTML ever touches the DOM. `link` only
  renders an `<a>` because `parseMarkdown` already rejected any non-`isSafeHref` target at parse
  time (the inline text form `[text](javascript:…)` survives *as literal text*, produced by the
  parser itself — this component never re-checks `isSafeHref`).

  PV6 (web-hub-preview plan v3 §4.6): `text` nodes render through `PathText` (path-ref scan)
  and `code` nodes through `PathText`'s code mode (`code.md-code[.path-ref]` — the exact same
  element when nothing matches, so every no-preview scenario stays DOM-identical). Inside a
  `link` the anchor itself is the interactive element, so its children render with `noRefs`
  (链接文本中不出现 `.path-ref` — PV6 验收); the flag also propagates through strong/em/del.

  web-hub-proxy plan v2 §8 (X2): a link whose href is a loopback / private-LAN `http://` URL
  (`isProxyableHref`) gets a plain-primary-click interception that opens it through the hub
  proxy instead — ONLY when the hub advertises the proxy cap (`useProxyOpen().scope`); without
  a scope the anchor is attribute- and handler-identical to today's. Modified clicks
  (ctrl/meta/shift/alt, middle button) keep the browser's native behaviour. A failure leaves the
  link as-is and shows its prose reason in an inline status note after it.
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { resolveMdLinkTarget } from "@logic/mdLinkPath.js";
import { isProxyableHref, normalizeProxyHref } from "@logic/proxy.js";
import { useI18n } from "../../composables/useI18n.js";
import { useProxyOpen } from "../../composables/useProxyOpen.js";
import PathText from "../preview/PathText.vue";
import { PATH_REFERENCES_SUSPENDED, PREVIEW_BASE_DIR, PREVIEW_CTX } from "../preview/previewContext.js";
import { PROXY_PREVIEW_CTX } from "../proxy/proxyPreviewContext.js";
import type { Inline } from "./markdown-types.js";
import "../../styles/proxy.css";

const props = defineProps<{
  readonly nodes: readonly Inline[];
  /** Force plain rendering for this subtree (link text — the anchor owns the interaction). */
  readonly noRefs?: boolean | undefined;
}>();

const { t } = useI18n();
const previewCtx = inject(PREVIEW_CTX, null);
const previewBase = inject(PREVIEW_BASE_DIR, null);
/** §4.6 流式抑制 — the same TxAssistant streaming flag PathText consumes: a still-streaming
 * message renders link text only; links become clickable once it settles. */
const suspended = inject(PATH_REFERENCES_SUSPENDED, null);

/** `[t](../x.md)` ⇒ resolved request path (file preview: the file's dir; transcript: scope.cwd),
 * or `null` ⇒ text only. `props.noRefs` and the streaming suspension also mute it. */
function pathLinkOf(target: string): { path: string; dir: boolean } | null {
  if (props.noRefs === true || suspended?.value === true) return null;
  const scope = previewCtx?.handle.scope.value ?? null;
  return resolveMdLinkTarget(target, previewBase?.value ?? null, scope);
}
function openPathLink(r: { path: string; dir: boolean }): void {
  previewCtx?.handle.open(r.dir ? { path: r.path, dir: true } : { path: r.path });
}
function onPathLinkKeydown(ev: KeyboardEvent, r: { path: string; dir: boolean }): void {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openPathLink(r);
  }
}
const proxy = useProxyOpen();
/** LP3 (link-preview §4.3): the App-level in-page preview — absent ⇒ the X2 new-tab flow. */
const proxyPreview = inject(PROXY_PREVIEW_CTX, null);
const hasProxy = computed(() => proxy.scope.value !== null);
const note = ref<{ href: string; key: string | null; url: string | null } | null>(null);
const noteList = computed(() => (note.value === null ? [] : [note.value]));
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function clearNote(): void {
  if (noteTimer !== undefined) clearTimeout(noteTimer);
  noteTimer = undefined;
  note.value = null;
}
onBeforeUnmount(() => {
  clearNote();
  proxy.clear();
});

function proxyLink(href: string): boolean {
  return hasProxy.value && isProxyableHref(href);
}

function onLinkClick(ev: MouseEvent, href: string): void {
  if (!proxyLink(href)) return;
  // Modified clicks (ctrl/meta/shift/alt, middle button) keep the browser's native behaviour.
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
  // §4.2: the anchor `href` attribute stays original; the hub POST uses the normalized form.
  const normalized = normalizeProxyHref(href);
  if (normalized === null) return;
  ev.preventDefault();
  // §4.1 tier 3: with the frame cap a plain click opens the in-page dialog (no window.open
  // on this path, so popup blockers don't apply).
  const frame = proxyPreview?.handle ?? null;
  if (frame !== null && frame.scope.value !== null) {
    frame.open(normalized);
    return;
  }
  clearNote();
  // synchronous part of `open` = window.open inside this click handler
  void proxy.open(normalized).then(() => {
    const key = proxy.errorKey.value;
    const url = proxy.fallbackUrl.value;
    if (key === null && url === null) return;
    note.value = { href, key, url };
    noteTimer = setTimeout(clearNote, 8000);
  });
}
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <PathText v-if="n.type === 'text'" :text="n.text" :no-refs="noRefs" />
    <PathText v-else-if="n.type === 'code'" :text="n.text" code :no-refs="noRefs" />
    <strong v-else-if="n.type === 'strong'"><MdInline :nodes="n.children" :no-refs="noRefs" /></strong>
    <em v-else-if="n.type === 'em'"><MdInline :nodes="n.children" :no-refs="noRefs" /></em>
    <del v-else-if="n.type === 'del'"><MdInline :nodes="n.children" :no-refs="noRefs" /></del>
    <a
      v-else-if="n.type === 'link'"
      :href="n.href"
      v-bind="proxyLink(n.href) ? { class: 'proxy-ref', title: t('proxy.refTitle') } : {}"
      rel="noopener noreferrer nofollow"
      target="_blank"
      @click="onLinkClick($event, n.href)"
      ><MdInline :nodes="n.children" :no-refs="true"
    /></a>
    <template v-else-if="n.type === 'pathlink'">
      <span
        v-if="pathLinkOf(n.target) !== null"
        class="path-ref"
        role="button"
        tabindex="0"
        @click="openPathLink(pathLinkOf(n.target)!)"
        @keydown="onPathLinkKeydown($event, pathLinkOf(n.target)!)"
        ><MdInline :nodes="n.children" :no-refs="true"
      /></span>
      <MdInline v-else :nodes="n.children" :no-refs="true" />
    </template>
    <MdInline v-else-if="n.type === 'textlink'" :nodes="n.children" :no-refs="true" />
  </template>
  <span v-for="x in noteList" :key="'proxy-note'" class="proxy-ref-note" role="status"
    ><template v-if="x.key !== null"
      >{{ t(x.key) }}
      <!-- D9: a hub refusal always offers the original link as a native anchor (never an
           automatic navigation). -->
      <a :href="x.href" target="_blank" rel="noopener noreferrer">{{ t("proxy.preview.openOriginal") }} ↗</a></template
    ><template v-else-if="x.url !== null"
      >{{ t("proxy.blockedNote") }}
      <a :href="x.url" target="_blank" rel="noopener noreferrer">{{ t("proxy.blockedLink") }}</a></template
    ></span
  >
</template>
