/** Strict porcelain-v2 -z parser. Paths are opaque (spaces/newlines are not separators). */
export interface GitStatusFacts {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  unmerged: number;
  paths: string[];
}

export function parsePorcelainV2Z(stdout: string): GitStatusFacts {
  const facts: GitStatusFacts = {
    branch: "",
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    unmerged: 0,
    paths: [],
  };
  if (!stdout.endsWith("\0")) throw new Error("unterminated porcelain record");
  const records = stdout.slice(0, -1).split("\0");
  const headers = new Set<string>();
  const mode = "[0-7]{6}";
  const oid = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
  const ordinary = new RegExp(
    `^([.MADRCUT]{2}) (?:N\\.\\.\\.|S[.C][.M][.U]) ${mode} ${mode} ${mode} ${oid} ${oid} (.+)$`,
    "s",
  );
  const rename = new RegExp(
    `^([.MADRCUT]{2}) (?:N\\.\\.\\.|S[.C][.M][.U]) ${mode} ${mode} ${mode} ${oid} ${oid} [RC][0-9]{1,3} (.+)$`,
    "s",
  );
  const unmerged = new RegExp(
    `^[ADU]{2} (?:N\\.\\.\\.|S[.C][.M][.U]) ${mode} ${mode} ${mode} ${mode} ${oid} ${oid} ${oid} (.+)$`,
    "s",
  );
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# ")) {
      const match = /^# (branch\.[a-z]+) (.+)$/s.exec(record);
      if (!match || headers.has(match[1]!)) throw new Error("invalid header");
      const key = match[1]!;
      const value = match[2]!;
      headers.add(key);
      switch (key) {
        case "branch.head":
          facts.branch = value;
          break;
        case "branch.oid":
          if (value !== "(initial)" && !new RegExp(`^${oid}$`).test(value)) throw new Error("invalid oid");
          break;
        case "branch.upstream":
          facts.upstream = value;
          break;
        case "branch.ab": {
          const ab = /^\+(\d+) -(\d+)$/.exec(value);
          if (!ab) throw new Error("invalid ahead/behind");
          facts.ahead = Number(ab[1]);
          facts.behind = Number(ab[2]);
          if (!Number.isSafeInteger(facts.ahead) || !Number.isSafeInteger(facts.behind))
            throw new Error("invalid counts");
          break;
        }
        default:
          throw new Error("unknown header");
      }
      continue;
    }
    const kind = record.slice(0, 2);
    const body = record.slice(2);
    if (kind === "? " || kind === "! ") {
      if (!body) throw new Error("empty path");
      if (kind === "? ") {
        facts.untracked++;
        facts.paths.push(body);
      }
      continue;
    }
    if (kind === "u ") {
      const match = unmerged.exec(body);
      if (!match) throw new Error("invalid unmerged record");
      facts.unmerged++;
      facts.paths.push(match[1]!);
      continue;
    }
    const match = kind === "1 " ? ordinary.exec(body) : kind === "2 " ? rename.exec(body) : null;
    if (!match) throw new Error("invalid tracked record");
    const xy = match[1]!;
    if (xy[0] !== ".") facts.staged++;
    if (xy[1] !== ".") facts.modified++;
    facts.paths.push(match[2]!);
    if (kind === "2 ") {
      const original = records[++i];
      if (!original) throw new Error("missing rename source");
      facts.paths.push(original);
    }
  }
  if (!facts.branch || !headers.has("branch.oid")) throw new Error("missing branch headers");
  return facts;
}
