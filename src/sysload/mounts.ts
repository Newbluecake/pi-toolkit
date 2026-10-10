import { parseMountinfo, type MountInfoRecord } from "./procfs.js";

export const LOCAL_FILESYSTEMS = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "f2fs",
  "zfs",
  "bcachefs",
  "overlay",
  "tmpfs",
  "vfat",
  "exfat",
  "ntfs3",
]);

export interface ResolvedMount {
  readonly path: string;
  readonly mount?: MountInfoRecord;
  readonly skipped?: "remote";
}

const normalizePath = (path: string): string => {
  if (path === "") return "/";
  const value = path.startsWith("/") ? path : `/${path}`;
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
};

export function pathIsWithinMount(path: string, mountPoint: string): boolean {
  const p = normalizePath(path);
  const m = normalizePath(mountPoint);
  return m === "/" || p === m || p.startsWith(`${m}/`);
}

export function findMount(path: string, mounts: readonly MountInfoRecord[]): MountInfoRecord | undefined {
  return mounts
    .filter((mount) => pathIsWithinMount(path, mount.mountPoint))
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length || a.mountId - b.mountId)[0];
}

/** Resolves paths lexically against mountinfo; it deliberately does not call realpath. */
export function resolveMounts(paths: readonly string[], mountinfoText: string): readonly ResolvedMount[] {
  const mounts = parseMountinfo(mountinfoText);
  return paths.map((path) => {
    const mount = findMount(path, mounts);
    if (mount === undefined) return { path } as ResolvedMount;
    return LOCAL_FILESYSTEMS.has(mount.fstype) ? { path, mount } : { path, mount, skipped: "remote" };
  });
}

export function resolveMount(path: string, mounts: readonly MountInfoRecord[]): ResolvedMount {
  const mount = findMount(path, mounts);
  if (mount === undefined) return { path };
  return LOCAL_FILESYSTEMS.has(mount.fstype) ? { path, mount } : { path, mount, skipped: "remote" };
}
