<!--
  web-hub-version plan §5.2 (V2): the FIRST-SCREEN error component for VersionPanel's lazy
  chunk (mounted through `defineAsyncComponent`'s `errorComponent`). Two strictly separated
  cases (§R1 #11 / §8.9):

  - `stale` — the §4 matcher has PROVEN `tab-stale` from the live hub frame (no snapshot
    needed): the hub is already serving another bundle and this page's lazy chunks 404 because
    they no longer exist in the current manifest. Copy: 「页面版本已过期」 + a refresh button
    (a refresh is guaranteed to fetch the servable bundle).
  - otherwise — the chunk simply failed to load (offline, transient 404 before any redeploy
    was observed): 「面板加载失败」 + a retry button that re-mounts the async component via a
    key bump in `VersionHost`. It NEVER claims the page is outdated.

  Which branch renders is decided by the `stale` prop VersionHost passes down (async-component
  vnode props reach whichever of loading/error/resolved component renders). No polling, no
  timers — one static render per mount.
-->
<script setup lang="ts">
import { useI18n } from "../../composables/useI18n.js";

defineProps<{ stale?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
const { t } = useI18n();

function onRefresh(): void {
  window.location.reload();
}
</script>

<template>
  <div class="version-load-error" role="alert">
    <template v-if="stale">
      <p>{{ t("version.stalePage") }}</p>
      <button type="button" class="btn btn-ghost" @click="onRefresh">{{ t("version.refreshPage") }}</button>
    </template>
    <template v-else>
      <p>{{ t("version.loadFailed") }}</p>
      <button type="button" class="btn btn-ghost" @click="emit('retry')">{{ t("version.retry") }}</button>
    </template>
  </div>
</template>
