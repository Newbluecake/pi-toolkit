<!--
  Application root — P0 placeholder (vue-plan.md v2.1 §1.1, §3.2, §5.2). This is the
  P0→P3 seam: P3 replaces the body of this file wholesale (reading `data-auth-mode`, wiring
  `useHub()`, picking `LoginView` / `TokenGate` / `DashboardView`) while every package that
  merely needs the app to *compile and mount* (P1, P2, P4, P5a) can rely on this shell as-is.
  Renders the icon sprite once (every other icon reference is `<use>` against it) plus an
  inert placeholder — no `<style>` block (SFC style blocks are banned repo-wide).
-->
<script setup lang="ts">
import IconSprite from "./icons/IconSprite.vue";
</script>

<template>
  <IconSprite />
  <main>
    <p>pi web-hub — UI under construction. See docs/dev/web-hub/vue-plan.md.</p>
  </main>
</template>
