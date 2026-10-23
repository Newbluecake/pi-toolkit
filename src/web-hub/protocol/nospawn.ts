/**
 * private-plan §4.1-5 (Q2, 拍板 2026-10-23): the fact cap an agent appends to `hello.caps`
 * while its pi process runs inside a private mount namespace (`pi-secure run --private`).
 *
 * Meaning: "this agent must never spawn or replace the hub" — NOT a feature capability. The
 * agent side appends it in `capsExtra` BEFORE the `control === false` early return (every
 * configuration advertises it); the hub side reads it via `registry.getCaps(agentKey)` in
 * `onVersion` (caps are registered before the version observer fires) and skips
 * `supersede.observe` for such agents, exactly like managed agents — a replacement hub could
 * only be spawned from inside the ns, which `spawnHub` refuses (R25 covers an old hub that
 * does not know the cap).
 *
 * Lives in its own module (not `version.ts`) because package A's surface is frozen: this is an
 * additive, private-plan-owned constant shared by exactly two consumers.
 */
export const AGENT_NOSPAWN_CAP = "agent.nospawn.v1";
