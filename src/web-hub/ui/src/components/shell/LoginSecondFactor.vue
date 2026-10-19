<!-- P0 G stub; deliberately not mounted. -->
<script setup lang="ts">
import type { Lan2faChallenge, LanFactorBody } from "@protocol/lan-2fa.js";
defineProps<{ challenge: Lan2faChallenge; busy: boolean; attemptsLeft?: number; lockedUntil?: number; now: number }>();
defineEmits<{ submit: [body: LanFactorBody]; cancel: []; wait: [] }>();
</script>
<template><template v-if="false"></template></template>
