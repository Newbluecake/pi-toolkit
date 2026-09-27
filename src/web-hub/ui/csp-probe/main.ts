/**
 * CSP probe entry (vue-plan.md v2.1 §4.4.1, §5.2 — P0). Mounts `Probe.vue` and flips a global
 * readiness flag `scripts/web-hub/csp-probe.ts` waits on (`waitForFunction`) instead of a fixed
 * sleep.
 */
import { createApp } from "vue";
import Probe from "./Probe.vue";
import "./probe.css";

createApp(Probe).mount("#root");
(window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ = true;
