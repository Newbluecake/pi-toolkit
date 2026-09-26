/**
 * Shared `HubPaths` fixture for tests outside `tests/web-hub/protocol/`
 * (plan §1.3.4: `tests/web-hub/http/helpers.ts` and `tests/web-hub/agent/
 * helpers.ts` used to construct a bare six-field object literal; both now
 * delegate here so the `socketDir` / `policies` additions live in one place).
 */
import { STATE_DIR_POLICY, type HubPaths } from "../../../src/web-hub/protocol/paths.js";

export function testHubPaths(stateDir: string): HubPaths {
  return {
    stateDir,
    socketPath: `${stateDir}/hub.sock`,
    socketDir: stateDir,
    hubJson: `${stateDir}/hub.json`,
    tokenFile: `${stateDir}/token`,
    logFile: `${stateDir}/hub.log`,
    startLock: `${stateDir}/start.lock`,
    dbFile: `${stateDir}/hub.db`,
    policies: { stateDir: STATE_DIR_POLICY, socketDir: STATE_DIR_POLICY },
  };
}
