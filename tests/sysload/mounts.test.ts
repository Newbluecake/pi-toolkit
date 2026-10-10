import { describe, expect, it } from "vitest";
import { findMount, resolveMounts } from "../../src/sysload/mounts.js";
import { parseMountinfo } from "../../src/sysload/procfs.js";

describe("sysload mounts", () => {
  const text = [
    "1 0 8:1 / / rw - ext4 /dev/root rw",
    "2 1 8:2 / /home rw - nfs server:/home rw",
    "3 1 8:3 / /home/user rw - ext4 /dev/user rw",
  ].join("\n");
  it("matches longest path component, not lexical prefixes", () => {
    const mounts = resolveMounts(["/home/user/file", "/homework/x"], text);
    expect(mounts[0]?.mount.mountPoint).toBe("/home/user");
    expect(mounts[1]?.mount.mountPoint).toBe("/");
  });
  it("marks non-local filesystems remote", () => {
    const mount = findMount("/home/x", parseMountinfo(text));
    expect(mount?.fstype).toBe("nfs");
    expect(resolveMounts(["/home/x"], text)[0]?.skipped).toBe("remote");
  });
});
