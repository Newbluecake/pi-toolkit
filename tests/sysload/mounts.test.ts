import { describe, expect, it } from "vitest";
import { findMount, resolveMount, resolveMounts } from "../../src/sysload/mounts.js";
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
  it("resolveMount keeps the Linux default and accepts a host fstype set (darwin seam, §2.3)", () => {
    const mounts = parseMountinfo(text);
    expect(resolveMount("/home/user/x", mounts).skipped).toBeUndefined();
    expect(resolveMount("/home/x", mounts).skipped).toBe("remote");
    // apfs is NOT added to LOCAL_FILESYSTEMS (no Linux semantic drift): the host set is the only
    // way a darwin fstype classifies local.
    const darwinMounts = parseMountinfo("1 0 0:1 / / rw - apfs /dev/disk1s1 rw");
    expect(resolveMount("/x", darwinMounts).skipped).toBe("remote");
    expect(resolveMount("/x", darwinMounts, new Set(["apfs", "hfs"])).skipped).toBeUndefined();
    expect(resolveMount("/x", darwinMounts, new Set(["apfs"])).mount?.mountPoint).toBe("/");
    expect(resolveMount("/x", darwinMounts, new Set()).skipped).toBe("remote");
  });
});
