// Test fixture for process.ts. mode = argv[2]. Never prints env VALUES (names only).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "echo";

function spawnGrandchild() {
  // same process group (not detached) — must die with the group
  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return gc.pid;
}

switch (mode) {
  case "echo": {
    console.log("ready");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (line === "env") {
        console.log(
          "envkeys:" +
            Object.keys(process.env)
              .filter((k) => /PTK_/.test(k))
              .sort()
              .join(","),
        );
      } else if (line === "stderr") {
        process.stderr.write("boom api_key=SUPERSECRET123 token: abcdef\n");
        console.log("stderr-done");
      } else console.log("echo:" + line);
    });
    rl.on("close", () => process.exit(0));
    break;
  }
  case "grandchild": {
    console.log("gc:" + spawnGrandchild());
    process.stdin.resume();
    setInterval(() => {}, 1000);
    break;
  }
  case "grandchild-exit": {
    console.log("gc:" + spawnGrandchild());
    setTimeout(() => process.exit(0), 100);
    break;
  }
  case "ignore-term": {
    process.on("SIGTERM", () => {});
    console.log("gc:" + spawnGrandchild());
    process.stdin.resume();
    setInterval(() => {}, 1000);
    break;
  }
  case "exit-on-eof": {
    console.log("ready");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    break;
  }
  default:
    process.exit(2);
}
