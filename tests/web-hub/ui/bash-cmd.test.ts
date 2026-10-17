/** Pure command de-shelling for the fleet bash rows (variant C). */
import { describe, expect, it } from "vitest";
import { cwdLabel, deshellCmd } from "../../../src/web-hub/ui/src/logic/bashCmd.js";

const same = (c: string) => expect(deshellCmd(c)).toEqual({ cmd: c });

describe("deshellCmd", () => {
  it("leaves plain commands alone", () => {
    same("npm run build");
    same("sleep 150 && echo done");
    same("");
  });

  it("strips cd && / cd ; into a cwd label", () => {
    expect(deshellCmd("cd /home/u/ai/pi-toolkit && npm test")).toEqual({
      cmd: "npm test",
      cwd: "…/ai/pi-toolkit",
      cwdFull: "/home/u/ai/pi-toolkit",
    });
    expect(deshellCmd('cd "/tmp/x"; ls -la').cmd).toBe("ls -la");
    expect(deshellCmd("cd ~/proj && ls").cwd).toBe("~/proj");
  });

  it("strips timeout with options into a timeout label", () => {
    expect(deshellCmd("timeout 600 npx vitest run")).toEqual({ cmd: "npx vitest run", timeout: "timeout 600" });
    expect(deshellCmd("timeout -s KILL -k 5 30s make -j4  all").cmd).toBe("make -j4  all");
    expect(deshellCmd("timeout --foreground 2m foo").timeout).toBe("timeout 2m");
  });

  it("combines cd + timeout + sh -c unwrap", () => {
    expect(deshellCmd("cd /a/b/c && timeout 1800 sh -c 'npm run x && npm run y'")).toEqual({
      cmd: "npm run x && npm run y",
      cwd: "…/b/c",
      cwdFull: "/a/b/c",
      timeout: "timeout 1800",
    });
    expect(deshellCmd('bash -lc "echo hi"').cmd).toBe("echo hi");
    expect(deshellCmd("bash -c 'echo \"q\"'").cmd).toBe('echo "q"');
  });

  it("handles the (timeout N sh -c '…') > log shape", () => {
    expect(
      deshellCmd("(timeout 1800 sh -c 'npm run build:web && npm run check:web') > /tmp/g.log 2>&1; echo EXIT=$?"),
    ).toEqual({
      cmd: "(npm run build:web && npm run check:web) > /tmp/g.log 2>&1; echo EXIT=$?",
      timeout: "timeout 1800",
    });
  });

  it("is conservative on ambiguity", () => {
    same("sh -c 'echo it'\\''s'");
    same('bash -c "echo $HOME"');
    same("sh -c 'a' && b");
    same("cd /x && sh -c 'unbalanced");
    same("timeout 5 cat <<EOF\nhi\nEOF");
    same("cd /x &&\nls");
    same("cd $HOME && ls");
    same("timeout 5");
    same("cd /x && ");
    same("timeout abc ls");
    // a second cd would make the cwd label lie about where the command runs
    same("cd a; cd b && x");
    same("cd /a && cd /b && x");
    same("timeout 5 cd /a && cd /b && x");
  });
});

describe("cwdLabel", () => {
  it("abbreviates to the last two segments", () => {
    expect(cwdLabel("/home/u/ai/pi-toolkit/")).toBe("…/ai/pi-toolkit");
    expect(cwdLabel("/tmp/x")).toBe("/tmp/x");
    expect(cwdLabel("/")).toBe("/");
  });
});
