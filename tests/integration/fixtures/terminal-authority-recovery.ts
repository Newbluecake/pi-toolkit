/** Private test child. Never discover a user HOME or load a live hub. */
import { createLocalAuthority, localProcess, processNamespaces } from "../../../src/web-hub/protocol/terminal-local.js";
import { startHub } from "../../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { config } from "../../web-hub/hub/helpers.js";
import type { RecoveryStage } from "../../../src/web-hub/hub/terminal/authority-recovery.js";
const [mode, path, stage] = process.argv.slice(2);
if (!path || !path.startsWith(process.env.TMPDIR! + "/")) throw new Error("private-path-required");
if (mode === "seed") {
  const names: string[] = [];
  for (let i = 0; i < (stage === "single" ? 1 : 2); i++) {
    const a = await createLocalAuthority(
      path,
      {
        process: localProcess(process.pid),
        namespaces: processNamespaces(process.pid),
        agentNonce: "seed-agent",
        sessionId: "seed-session",
        epoch: "seed-epoch",
        ownerInstance: "seed-owner",
        domain: "plain",
        main: true,
        active: true,
      },
      () => true,
    );
    names.push(a.recordId);
  }
  process.stdout.write(JSON.stringify(names));
} else if (mode === "hub") {
  const result = await startHub(config({ home: path, control: true, privacy: true }), createHttpFrontend, {
    terminalAuthorityRecoveryTestDeps: {
      async stage(event) {
        if (event.stage === (stage as RecoveryStage)) {
          process.send?.({ type: "barrier", ...event });
          await new Promise<void>((resolve) => process.once("message", () => resolve()));
        }
      },
    },
  });
  if (!("exists" in result)) {
    process.send?.({ type: "ready", port: result.httpPort });
    process.once("message", () => {
      void result.close("test").then(() => process.exit(0));
    });
  }
} else throw new Error("test-mode");
