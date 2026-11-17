/**
 * Native Node boundary. Load ONLY with node:module createRequire, never jiti.import.
 * jiti rewrites TS import(url) and strips file URL queries; Node keys ESM by the full URL.
 * No state/cache here: identical build URLs deliberately reuse Node's module namespace.
 */
module.exports = (url) => import(url);
