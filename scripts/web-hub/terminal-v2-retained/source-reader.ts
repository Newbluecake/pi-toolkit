/** Fixed O7239 terminal source enumeration, never a clean/drain assertion. Every
 * journal row and receipt incurs debt even when its old proof says reaped. Archives
 * contain authority records ONLY, not resource rows; incomplete archives refuse. */
import { parse, exactKeys } from "../terminal-v2-maintenance/files.js";
import { canonicalLegacyIdentity, type CapturedLegacyResource } from "./mapping.js";
import {
  parseOldJournal,
  parseOldMarker,
  parseOldAuthority,
  parseOldReceipt,
  parseOldArchiveManifest,
  OLD_RETAINED_SOURCE,
  type OldProcessIdentity,
  type OldAuthority,
  type OldJournal,
} from "./old-schema.js";
import type { TerminalSourceSnapshot } from "./snapshot.js";
const ROOT = "terminal-v1",
  JOURNAL = "terminal-resource-fence-v1.json",
  ARCHIVE = ".terminal-authority-archive-v1";
const tokenFile = /^[A-Za-z0-9_-]{32,64}\.json$/;
function fail(code: string, path: string): never {
  throw new Error(`${code}:${path}`);
}
export interface RetainedSourceInventory {
  source: typeof OLD_RETAINED_SOURCE;
  storeId: string;
  journalRevision: number;
  resources: CapturedLegacyResource[];
  producers: Array<{ recordKey: string; process: OldProcessIdentity }>;
  authorities: OldAuthority[];
  opaqueFiles: string[];
}
export function readRetainedSource(snapshot: TerminalSourceSnapshot): RetainedSourceInventory {
  snapshot.verify();
  const consumed = new Set<string>(),
    directories = new Map(snapshot.manifest.directories.map((d) => [d.path, d]));
  const read = (path: string, max = 2097152): unknown => {
    const f = snapshot.files.get(path);
    if (!f) return fail("E_SOURCE_MISSING", path);
    if (f.bytes.length > max || (f.entry.metadata.mode & 0o777) !== 0o600) fail("E_SOURCE_AUTHORITATIVE_FILE", path);
    consumed.add(path);
    return parse(f.bytes);
  };
  const children = (path: string) => {
    const d = directories.get(path);
    if (!d) return fail("E_SOURCE_MISSING_DIRECTORY", path);
    return d.members;
  };
  const store = parseOldMarker(read(`${ROOT}/initialized`, 1024));
  if (parseOldMarker(read(".terminal-initialized-v1", 1024)).storeId !== store.storeId)
    fail("E_SOURCE_STORE_MISMATCH", ".terminal-initialized-v1");
  const journal = parseOldJournal(read(`${ROOT}/${JOURNAL}`));
  children(ROOT);
  children(`${ROOT}/authority`);
  children(`${ROOT}/receipts`);
  if (snapshot.files.has(JOURNAL)) {
    const flat = parseOldJournal(read(JOURNAL));
    if (JSON.stringify(flat) !== JSON.stringify(journal)) fail("E_SOURCE_FLAT_CONFLICT", JOURNAL);
  }
  const resources: CapturedLegacyResource[] = [],
    producers: RetainedSourceInventory["producers"] = [];
  const authorities: OldAuthority[] = [],
    reservations = new Map<string, { identity: string; process: string }>();
  const resource = (identity: CapturedLegacyResource["identity"], process: OldProcessIdentity, recordKey: string) => {
    const facts = { identity: canonicalLegacyIdentity(identity), process: JSON.stringify(process) };
    const prior = reservations.get(identity.reservationId);
    if (prior && (prior.identity !== facts.identity || prior.process !== facts.process))
      fail("E_SOURCE_RESOURCE_CONFLICT", recordKey);
    if (process.uid !== processUid()) fail("E_SOURCE_PRODUCER_UID", recordKey);
    reservations.set(identity.reservationId, facts);
    const bootId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(process.bootId)
      ? process.bootId
      : undefined;
    resources.push({ identity, recordKey, sessionVerified: true, ...(bootId === undefined ? {} : { bootId }) });
    producers.push({ recordKey, process });
  };
  const addJournal = (j: OldJournal, path: string) => {
    j.resources.forEach((r, i) => resource(r.entry.identity, r.entry.agentProcessIdentity, `${path}#resources/${i}`));
  };
  addJournal(journal, `${ROOT}/${JOURNAL}`);
  if (snapshot.files.has(JOURNAL)) addJournal(parseOldJournal(read(JOURNAL)), JOURNAL);
  const authority = (path: string, expectedName: string) => {
    const a = parseOldAuthority(read(path, 131072));
    if (
      `${a.recordId}.json` !== expectedName ||
      a.storeId !== store.storeId ||
      a.process.uid !== processUid() ||
      !a.main ||
      a.domain !== "plain" ||
      !a.active
    )
      fail("E_SOURCE_AUTHORITY", path);
    producers.push({ recordKey: path, process: a.process });
    authorities.push(a);
    return a;
  };
  for (const child of children(`${ROOT}/authority`)) {
    const path = `${ROOT}/authority/${child.name}`;
    if (child.type !== "file" || !tokenFile.test(child.name)) fail("E_SOURCE_RANGE_UNKNOWN", path);
    authority(path, child.name);
  }
  for (const child of children(`${ROOT}/receipts`)) {
    const path = `${ROOT}/receipts/${child.name}`;
    if (child.type !== "file" || !tokenFile.test(child.name)) fail("E_SOURCE_RANGE_UNKNOWN", path);
    const r = parseOldReceipt(read(path, 131072));
    if (r.storeId !== store.storeId || `${r.recordId}.json` !== child.name) fail("E_SOURCE_RECEIPT", path);
    resource(r.identity, r.agentProcessIdentity, `${path}#identity`);
  }
  if (snapshot.manifest.selected.includes(ARCHIVE)) {
    const transactions = children(ARCHIVE);
    if (transactions.length > 64) fail("E_SOURCE_CAPACITY", ARCHIVE);
    for (const tx of transactions) {
      const path = `${ARCHIVE}/${tx.name}`;
      if (tx.type !== "directory" || !/^[A-Za-z0-9_-]{32,64}$/.test(tx.name)) fail("E_SOURCE_RANGE_UNKNOWN", path);
      const members = children(path);
      if (
        members
          .map((m) => m.name)
          .sort()
          .join(",") !== ["complete.json", "manifest.json", "retired", "snapshots"].sort().join(",")
      )
        fail("E_SOURCE_ARCHIVE_INCOMPLETE", path);
      const manifest = parseOldArchiveManifest(read(`${path}/manifest.json`));
      const complete = read(`${path}/complete.json`, 1024);
      if (
        !exactKeys(complete, ["v", "kind"]) ||
        complete.v !== 1 ||
        complete.kind !== "authority-retirement-only" ||
        manifest.storeId !== store.storeId ||
        manifest.transaction !== tx.name ||
        new Set(manifest.candidates.map((c) => c.name)).size !== manifest.candidates.length
      )
        fail("E_SOURCE_ARCHIVE", path);
      const expected = manifest.candidates.map((c) => c.name).sort();
      for (const area of ["snapshots", "retired"]) {
        const list = children(`${path}/${area}`);
        if (JSON.stringify(list.map((m) => m.name).sort()) !== JSON.stringify(expected)) fail("E_SOURCE_ARCHIVE", path);
        for (const candidate of manifest.candidates) {
          const filePath = `${path}/${area}/${candidate.name}`,
            f = snapshot.files.get(filePath);
          const a = authority(filePath, candidate.name);
          if (
            !f ||
            f.entry.sha256 !== candidate.fingerprint.hash ||
            f.entry.metadata.size !== candidate.fingerprint.size ||
            JSON.stringify(a.process) !== JSON.stringify(candidate.process)
          )
            fail("E_SOURCE_ARCHIVE", filePath);
          if (
            area === "retired" &&
            (f.entry.metadata.dev !== candidate.fingerprint.dev ||
              f.entry.metadata.ino !== candidate.fingerprint.ino ||
              f.entry.metadata.mtimeMs !== candidate.fingerprint.mtimeMs)
          )
            fail("E_SOURCE_ARCHIVE", filePath);
        }
      }
      producers.push({ recordKey: `${path}/manifest.json#currentBoot`, process: manifest.currentBoot });
    }
  }
  snapshot.verify();
  return {
    source: OLD_RETAINED_SOURCE,
    storeId: store.storeId,
    journalRevision: journal.revision,
    resources,
    producers,
    authorities,
    opaqueFiles: [...snapshot.files.keys()].filter((p) => !consumed.has(p)).sort(),
  };
}
const processUid = () => process.getuid?.();
