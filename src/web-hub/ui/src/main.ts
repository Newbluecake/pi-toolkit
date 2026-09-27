/**
 * Vue SPA entry point (vue-plan.md v2.1 §1.1, §5.2 — P0 frozen). Deliberately minimal: token
 * design + design-system CSS load before the app mounts, everything else lives in `App.vue`.
 */
import { createApp } from "vue";
import App from "./App.vue";
import "./styles/tokens.css";

createApp(App).mount("#root");
