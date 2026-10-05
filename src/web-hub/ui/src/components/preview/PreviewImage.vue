<!--
  Image phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5). Only a
  `data:` URL ever reaches `<img src>` — D1: CSP is not relaxed, so a host bug passing a
  `blob:`/remote URL renders NOTHING rather than smuggling a request past the policy (the
  `usePreview` state machine already verified the `data:<mime>;base64,` prefix; this is the
  component-level backstop). Toggles between fit-to-window and actual size; dims/size render
  as a plain meta line. No `createObjectURL` anywhere (source-scan banned, HP8).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { PreviewDims } from "@protocol/preview.js";
import { useI18n } from "../../composables/useI18n.js";

const props = defineProps<{
  readonly dataUrl: string;
  readonly dims: PreviewDims;
  readonly sizeLabel?: string | undefined;
  readonly alt?: string | undefined;
}>();
const { t } = useI18n();

/** D1 backstop: only `data:image/` sources render (see the header comment). */
const safe = computed(() => props.dataUrl.startsWith("data:image/"));
const fit = ref(true);
</script>

<template>
  <div v-if="safe" class="preview-image">
    <div class="preview-image-toolbar">
      <span class="preview-meta" translate="no"
        >{{ dims.w }} × {{ dims.h
        }}<template v-if="sizeLabel !== undefined && sizeLabel !== ''"> · {{ sizeLabel }}</template></span
      >
      <button class="btn btn-ghost preview-image-toggle" type="button" @click="fit = !fit">
        {{ fit ? t("preview.actualSize") : t("preview.fit") }}
      </button>
    </div>
    <div class="preview-image-body" :class="{ actual: !fit }">
      <img :src="dataUrl" :alt="alt ?? ''" :class="{ fit }" />
    </div>
  </div>
</template>
