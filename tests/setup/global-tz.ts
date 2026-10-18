/**
 * Vitest globalSetup: pin the process timezone for the whole suite.
 *
 * Several goldens/fixtures (e.g. the TopBar version-chip `MM-DD HH:mm` local time) were captured on
 * a developer machine in Asia/Shanghai; CI runners are UTC. Product code intentionally renders
 * local time, so the suite — not the product — is made deterministic. Runs in the main process
 * before workers fork, so every worker inherits it. Test-only; never import from src/**.
 */
export default function setup(): void {
  process.env.TZ = "Asia/Shanghai";
}
