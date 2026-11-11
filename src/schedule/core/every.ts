/** Pure interval primitives; compatibility export for consumers preferring a dedicated module. */
export { parseEvery, nextEvery, everyCount } from "./cron.js";
export { EVERY_MIN_MS, EVERY_MAX_MS, EVERY_GRACE_MS, MAX_EPOCH_MS, isEpoch, isEveryWhen } from "./spec.js";
