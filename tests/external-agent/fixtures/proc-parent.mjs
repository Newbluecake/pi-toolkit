// Test fixture: a "pi" parent that manages a child through the real process.ts (loaded via tsx).
// argv: <mode> <childFixture> <childMode>
import { createSpawnChild } from "../../../src/external-agent/process.ts";
import { systemClock } from "../../../src/core/clock.ts";

const [mode, childFixture, childMode] = process.argv.slice(2);
const spawnChild = createSpawnChild((t) => t);
const child = spawnChild({
  binary: process.execPath,
  args: [childFixture, childMode],
  cwd: process.cwd(),
  extraEnv: {},
  killGraceMs: 60_000,
  ownerWatchdog: mode === "watchdog",
  clock: systemClock,
});
let out = "";
child.onStdout((c) => {
  out += c.toString();
  process.stdout.write(c); // relay child stdout (incl. echo replies) to the test
});
console.log("pid:" + child.pid);
if (mode === "watchdog") {
  setTimeout(() => child.write("hello\n"), 300);
  setInterval(() => {}, 1000); // stay alive until the test SIGKILLs us
} else if (mode === "unref") {
  child.terminate("graceful"); // pending 60s grace timer must not keep this process alive
}
