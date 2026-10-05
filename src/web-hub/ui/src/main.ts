/**
 * Vue SPA entry point (vue-plan.md v2.1 §1.1, §5.2 — P0 frozen). Deliberately minimal: token
 * design + design-system CSS load before the app mounts, everything else lives in `App.vue`.
 */
import { createApp } from "vue";
import App from "./App.vue";
import { detectLang } from "./composables/useI18n.js";
import "./styles/tokens.css";

// 2026-10-05 field report: the static `lang="en"` made mobile Edge/Chrome offer its translation
// bar on every visit (the UI is actually Chinese for zh users). Point `lang` at the detected UI
// language before mount so the browser never misdetects the page's language.
document.documentElement.lang = detectLang(navigator.languages) === "zh" ? "zh-CN" : "en";

createApp(App).mount("#root");
