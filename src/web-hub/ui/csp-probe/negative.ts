/**
 * Negative-control entry (vue-plan.md v2.1 §4.4.1, §5.2 — P0). No Vue, no CSP-sensitive
 * behavior of its own — just a readiness flag so `scripts/web-hub/csp-probe.ts` knows the page
 * (and its deliberately-forbidden inline `style=` attribute) finished loading.
 */
(window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ = true;
