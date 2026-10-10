#!/usr/bin/env bash
#
# scripts/release/release.sh — pi-toolkit one-shot release script
#
# Single-branch flow (pi-toolkit only ever releases from `master`; there is
# no dev/main split here — see docs/dev or AGENTS.md "发版与部署" if that
# ever changes):
#
#   sync version -> generate CHANGELOG section -> pre-release checks ->
#   commit "chore(release): ..." -> annotated tag -> push master + tag ->
#   scripts/release/package.sh <version> -> gh release create
#
# Usage:
#   scripts/release/release.sh <version> [flags]
#
# Flags:
#   --dry-run       Full dry run: prints everything it would do, writes no
#                   files, runs no git/gh mutations, and skips the pre-release
#                   checks (run them with a real release or by hand).
#   --changelog     Only sync the version fields and generate/merge the
#                   CHANGELOG.md section; does not commit/tag/push/publish.
#   --skip-tests    Skip the pre-release check suite (format/typecheck/test/
#                   build/build:web). Emergency use only — normal releases
#                   must not use this.
#   --skip-push     Commit + tag locally but do not push, package or publish.
#   --skip-publish  Push master + tag but skip scripts/release/package.sh and
#                   `gh release create`.
#
# What it does:
#   1. Preflight — must be on `master`, working tree clean (dry-run: warn
#      instead of abort), local master up to date with origin/master (no
#      unpulled commits), target tag must not already exist.
#   2. Prints a suggested semver bump level (see rule below) and WARNs
#      (non-blocking) if the version you passed differs.
#   3. Syncs package.json + package-lock.json `.version` (and the lockfile's
#      root package entry) to the target version.
#   4. Generates the `## [x.y.z] - YYYY-MM-DD` CHANGELOG.md section from
#      `git log <latest-tag>..HEAD`, grouped by Conventional Commit type.
#      If `## [Unreleased]` already has hand-written content, that content is
#      merged to the top of each matching section (never dropped), and
#      `[Unreleased]` is left empty afterwards. Updates/adds the compare-link
#      refs at the bottom of the file.
#   5. (--changelog stops here.)
#   6. Runs the pre-release check suite: format:check, typecheck, test,
#      build, build:web + check:web. Build steps are run with
#      NODE_ENV=production pinned (mirrors package.sh — vitest sets
#      NODE_ENV=test, which changes the Vue SFC compiler's output and would
#      make the UI bundle miss its own gzip budget).
#   7. Commits `chore(release): bump version to vX.Y.Z` (exact paths only,
#      never `git add -A`), creates an annotated tag whose message is the
#      version's CHANGELOG section, and verifies the tag is an ancestor of
#      `master`.
#   8. Pushes `master` and the tag (unless --skip-push).
#   9. Runs scripts/release/package.sh <version> and `gh release create`
#      (unless --skip-push or --skip-publish).
#
# Version bump rule (computed, printed, never auto-applied):
#   - BREAKING CHANGE (subject `!:` or a `BREAKING CHANGE:` footer anywhere
#     in <latest-tag>..HEAD) -> major
#   - feat commits accumulated since the latest existing `vX.Y.0` tag (patch
#     tags do not reset the count) >= 50 -> minor
#   - everything else (fix/refactor/perf/chore/docs/test/ci as the bulk) ->
#     patch (the default — when unsure, patch)

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERR]${NC} $*" >&2; }
die()   { err "$*"; exit 1; }

# ─── Argument parsing ────────────────────────────────────────────────────────
VERSION=""
DRY_RUN=0
CHANGELOG_ONLY=0
SKIP_TESTS=0
SKIP_PUSH=0
SKIP_PUBLISH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=1 ;;
    --changelog)    CHANGELOG_ONLY=1 ;;
    --skip-tests)   SKIP_TESTS=1 ;;
    --skip-push)    SKIP_PUSH=1 ;;
    --skip-publish) SKIP_PUBLISH=1 ;;
    -h|--help)
      grep -E '^# ?' "$0" | sed 's/^# \{0,1\}//' | sed -n '1,70p'
      exit 0
      ;;
    v*) VERSION="${1#v}" ;;
    [0-9]*) VERSION="$1" ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ -n "$VERSION" ]] || die "Missing version. Usage: $0 <version> [flags]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]] \
  || die "Invalid version format: $VERSION (expected X.Y.Z or X.Y.Z-rc.1)"

TAG="v$VERSION"
TODAY=$(date +%Y-%m-%d)

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

info "Project root: $PROJECT_ROOT"
info "Target version: $TAG"
info "Today: $TODAY"
[[ $DRY_RUN -eq 1 ]] && warn "DRY-RUN mode: no files written, no git/gh mutations"

# ─── Step 1: preflight ───────────────────────────────────────────────────────
info "[1/9] Preflight checks"

CURRENT_BRANCH=$(git branch --show-current)
[[ "$CURRENT_BRANCH" == "master" ]] \
  || die "Must release from 'master' (currently on '$CURRENT_BRANCH')"
ok "On master"

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    warn "Working tree is dirty, dry-run continues anyway (real run would abort):"
    git status --short
  else
    git status --short
    die "Working tree is dirty — commit or stash first"
  fi
else
  ok "Working tree clean"
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists"
fi
ok "Tag $TAG does not exist yet"

# Make sure local master isn't behind origin/master. A missing remote-tracking
# ref (e.g. a throwaway test fixture with no remote) is a WARN, not an abort,
# so --dry-run stays usable without network access.
if git rev-parse --verify -q origin/master >/dev/null; then
  if [[ $DRY_RUN -eq 0 ]]; then
    git fetch origin master --quiet || warn "git fetch origin master failed, using last-known origin/master"
  fi
  BEHIND=$(git rev-list --count HEAD..origin/master 2>/dev/null || echo 0)
  if [[ "$BEHIND" -gt 0 ]]; then
    die "master is $BEHIND commit(s) behind origin/master — run 'git pull --ff-only' first"
  fi
  ok "master is up to date with origin/master (or ahead)"
else
  warn "No origin/master remote-tracking ref found, skipping up-to-date check"
fi

# ─── Step 2: bump level suggestion ───────────────────────────────────────────
info "[2/9] Suggested bump level"

LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE=""
[[ -n "$LATEST_TAG" ]] && RANGE="${LATEST_TAG}..HEAD"

if [[ -n "$LATEST_TAG" ]]; then
  LOG_SUBJ=$(git log $RANGE --no-merges --format='%s' 2>/dev/null || true)
  BREAKING_SUBJ=$(printf '%s\n' "$LOG_SUBJ" | grep -cE '^[a-zA-Z]+(\([^)]*\))?!:' || true)
  BREAKING_BODY=$(git log $RANGE --no-merges --format='%b' 2>/dev/null | grep -c '^BREAKING CHANGE:' || true)

  # feat accumulation window: from the latest existing vX.Y.0 tag to HEAD.
  # Patch tags (vX.Y.1+) never reset this count.
  FEAT_BASE=$(git tag | grep -E '^v[0-9]+\.[0-9]+\.0$' | sort -V | tail -1 || true)
  FEAT_RANGE="${FEAT_BASE:-$LATEST_TAG}..HEAD"
  FEAT_COUNT=$(git log "$FEAT_RANGE" --no-merges --format='%s' 2>/dev/null | grep -cE '^feat(\(|!?:)' || true)

  if [[ ${BREAKING_SUBJ:-0} -gt 0 || ${BREAKING_BODY:-0} -gt 0 ]]; then
    SUGGESTED_LEVEL="major"
    SUGGEST_WHY="BREAKING CHANGE detected (subject $BREAKING_SUBJ, body footer $BREAKING_BODY)"
  elif [[ ${FEAT_COUNT:-0} -ge 50 ]]; then
    SUGGESTED_LEVEL="minor"
    SUGGEST_WHY="$FEAT_COUNT feat commits accumulated (>=50, range ${FEAT_BASE:-$LATEST_TAG}..HEAD)"
  else
    SUGGESTED_LEVEL="patch"
    SUGGEST_WHY="fix/refactor/perf/chore/docs-dominated, $FEAT_COUNT feat commits (<50, range ${FEAT_BASE:-$LATEST_TAG}..HEAD)"
  fi

  CUR_VER="${LATEST_TAG#v}"
  IFS=. read -r curM curm curp <<< "${CUR_VER%%-*}"
  case "$SUGGESTED_LEVEL" in
    major) SUGGESTED_VER="$((curM + 1)).0.0" ;;
    minor) SUGGESTED_VER="$curM.$((curm + 1)).0" ;;
    patch) SUGGESTED_VER="$curM.$curm.$((curp + 1))" ;;
  esac

  IFS=. read -r newM newm newp <<< "${VERSION%%-*}"
  ACTUAL_LEVEL="patch"
  [[ $newM -gt $curM ]] && ACTUAL_LEVEL="major"
  [[ $newM -eq $curM && $newm -gt $curm ]] && ACTUAL_LEVEL="minor"

  info "Last tag: $LATEST_TAG · suggested bump: $SUGGESTED_LEVEL -> v$SUGGESTED_VER ($SUGGEST_WHY)"
  if [[ "$ACTUAL_LEVEL" != "$SUGGESTED_LEVEL" ]]; then
    warn "Given version $TAG is a $ACTUAL_LEVEL bump, suggested is $SUGGESTED_LEVEL (v$SUGGESTED_VER)"
    warn "Rule: BREAKING CHANGE -> major; feat >=50 since last vX.Y.0 -> minor; else -> patch. Ignore if this is intentional."
  fi
else
  warn "No prior tag found, skipping bump suggestion (CHANGELOG will cover full history)"
fi

# ─── Step 3: sync version fields ─────────────────────────────────────────────
info "[3/9] Sync version fields"

PKG_FILES=(package.json package-lock.json)
for f in "${PKG_FILES[@]}"; do
  [[ -f "$f" ]] || die "$f not found"
  cur=$(jq -r '.version // "(none)"' "$f")
  printf "  %-20s  %s -> %s\n" "$f" "$cur" "$VERSION"
done

if [[ $DRY_RUN -eq 0 ]]; then
  tmp="package.json.bump.tmp"
  jq --indent 2 --arg v "$VERSION" '.version = $v' package.json > "$tmp"
  mv "$tmp" package.json

  tmp="package-lock.json.bump.tmp"
  jq --indent 2 --arg v "$VERSION" '.version = $v | .packages[""].version = $v' package-lock.json > "$tmp"
  mv "$tmp" package-lock.json
  ok "Version fields synced to $VERSION"
fi

# ─── Step 4: CHANGELOG generation ────────────────────────────────────────────
info "[4/9] Generate CHANGELOG.md section"

[[ -f CHANGELOG.md ]] || die "CHANGELOG.md not found"

if grep -qE "^## \[${VERSION//./\\.}\]" CHANGELOG.md; then
  warn "CHANGELOG.md already contains a [$VERSION] section, skipping generation (delete it by hand to regenerate)"
  SKIP_CHANGELOG=1
else
  SKIP_CHANGELOG=0
fi

REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
GH_SLUG=""
if [[ "$REMOTE_URL" =~ github.com[:/]([^/]+)/([^/.]+) ]]; then
  GH_SLUG="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
fi

declare -A SECTION_CONTENT
SECTION_ORDER=()

record_section() {
  local title="$1" line="$2"
  if [[ -z "${SECTION_CONTENT[$title]+x}" ]]; then
    SECTION_CONTENT[$title]=""
    SECTION_ORDER+=("$title")
  fi
  SECTION_CONTENT[$title]+="$line"$'\n'
}

format_entry() {
  # Conventional-commit subject -> "- **scope**: subject (`sha`)" / "- subject (`sha`)"
  local sha="$1" subject="$2"
  local scope rest
  local scoped_re='^[a-zA-Z]+\(([^)]*)\)!?:[[:space:]]*(.*)$'
  local plain_re='^[a-zA-Z]+!?:[[:space:]]*(.*)$'
  if [[ "$subject" =~ $scoped_re ]]; then
    scope="${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[2]}"
    printf -- '- **%s**: %s (`%s`)' "$scope" "$rest" "$sha"
  elif [[ "$subject" =~ $plain_re ]]; then
    rest="${BASH_REMATCH[1]}"
    printf -- '- %s (`%s`)' "$rest" "$sha"
  else
    printf -- '- %s (`%s`)' "$subject" "$sha"
  fi
}

GENERATED_SECTION=""
STATS_LINE=""

if [[ $SKIP_CHANGELOG -eq 0 ]]; then
  [[ -n "$LATEST_TAG" ]] && info "  CHANGELOG range: $RANGE"

  declare -A EXCLUDE_SHA
  declare -A COUNTS
  CHORE_RELEASE_RE='^chore\(release\):'
  BREAKING_SUBJECT_RE='^[a-zA-Z]+(\([^)]*\))?!:'

  while IFS='|' read -r sha subject; do
    [[ -z "$sha" ]] && continue
    # Release-bump commits never belong in the next CHANGELOG section.
    [[ "$subject" =~ $CHORE_RELEASE_RE ]] && continue

    is_breaking=0
    if [[ "$subject" =~ $BREAKING_SUBJECT_RE ]]; then
      is_breaking=1
    elif git log -1 --format='%b' "$sha" 2>/dev/null | grep -q '^BREAKING CHANGE:'; then
      is_breaking=1
    fi

    if [[ $is_breaking -eq 1 ]]; then
      record_section "⚠️ Breaking Changes" "$(format_entry "$sha" "$subject")"
      EXCLUDE_SHA[$sha]=1
      COUNTS[breaking]=$(( ${COUNTS[breaking]:-0} + 1 ))
      continue
    fi
    [[ -n "${EXCLUDE_SHA[$sha]:-}" ]] && continue

    case "$subject" in
      feat*)
        record_section "Added" "$(format_entry "$sha" "$subject")"
        COUNTS[feat]=$(( ${COUNTS[feat]:-0} + 1 )) ;;
      fix*)
        record_section "Fixed" "$(format_entry "$sha" "$subject")"
        COUNTS[fix]=$(( ${COUNTS[fix]:-0} + 1 )) ;;
      perf*|refactor*)
        record_section "Changed" "$(format_entry "$sha" "$subject")"
        COUNTS[changed]=$(( ${COUNTS[changed]:-0} + 1 )) ;;
      docs*)
        record_section "Documentation" "$(format_entry "$sha" "$subject")"
        COUNTS[docs]=$(( ${COUNTS[docs]:-0} + 1 )) ;;
      test*)
        record_section "Tests" "$(format_entry "$sha" "$subject")"
        COUNTS[test]=$(( ${COUNTS[test]:-0} + 1 )) ;;
      chore*|ci*|build*|style*)
        record_section "Chores" "$(format_entry "$sha" "$subject")"
        COUNTS[chore]=$(( ${COUNTS[chore]:-0} + 1 )) ;;
      *)
        record_section "Chores" "$(format_entry "$sha" "$subject")"
        COUNTS[chore]=$(( ${COUNTS[chore]:-0} + 1 )) ;;
    esac
  done < <(git log $RANGE --no-merges --format='%h|%s' 2>/dev/null || true)

  KNOWN_ORDER=("⚠️ Breaking Changes" "Added" "Fixed" "Changed" "Documentation" "Tests" "Chores")
  for title in "${KNOWN_ORDER[@]}"; do
    [[ -n "${SECTION_CONTENT[$title]+x}" ]] || continue
    GENERATED_SECTION+="### $title"$'\n\n'
    GENERATED_SECTION+="${SECTION_CONTENT[$title]}"$'\n'
  done

  STATS_PARTS=()
  [[ ${COUNTS[feat]:-0}     -gt 0 ]] && STATS_PARTS+=("${COUNTS[feat]} feat")
  [[ ${COUNTS[fix]:-0}      -gt 0 ]] && STATS_PARTS+=("${COUNTS[fix]} fix")
  [[ ${COUNTS[changed]:-0}  -gt 0 ]] && STATS_PARTS+=("${COUNTS[changed]} refactor/perf")
  [[ ${COUNTS[docs]:-0}     -gt 0 ]] && STATS_PARTS+=("${COUNTS[docs]} docs")
  [[ ${COUNTS[test]:-0}     -gt 0 ]] && STATS_PARTS+=("${COUNTS[test]} test")
  [[ ${COUNTS[chore]:-0}    -gt 0 ]] && STATS_PARTS+=("${COUNTS[chore]} chore")
  [[ ${COUNTS[breaking]:-0} -gt 0 ]] && STATS_PARTS+=("${COUNTS[breaking]} breaking")
  if [[ ${#STATS_PARTS[@]} -gt 0 ]]; then
    STATS_LINE="Stats:"
    for part in "${STATS_PARTS[@]}"; do
      STATS_LINE+=" $part,"
    done
    STATS_LINE="${STATS_LINE%,}"
  fi

  if [[ -z "$GENERATED_SECTION" ]]; then
    warn "No commits found in $RANGE — generated section will be empty"
  fi

  # ── Merge with any hand-written [Unreleased] content ──
  UNRELEASED_BODY=$(awk '
    /^## \[Unreleased\]/ { found = 1; next }
    found && /^## \[/ { exit }
    found { print }
  ' CHANGELOG.md)
  UNRELEASED_TRIMMED=$(printf '%s' "$UNRELEASED_BODY" | sed '/^[[:space:]]*$/d')

  if [[ -n "$UNRELEASED_TRIMMED" ]]; then
    info "  Merging existing [Unreleased] content into the new section"
    tmp_existing="CHANGELOG.unreleased.tmp"
    tmp_generated="CHANGELOG.generated.tmp"
    printf '%s\n' "$UNRELEASED_BODY" > "$tmp_existing"
    printf '%s' "$GENERATED_SECTION" > "$tmp_generated"

    MERGED_BODY=$(awk '
      function remember(title) {
        if (!(title in seen)) { seen[title] = 1; order[n++] = title }
      }
      FNR == 1 { file++ }
      /^### / {
        cur = $0
        sub(/^### /, "", cur)
        remember(cur)
        next
      }
      {
        if (cur == "") { cur = "__preamble__"; remember(cur) }
        content[cur] = content[cur] $0 "\n"
      }
      END {
        for (i = 0; i < n; i++) {
          t = order[i]
          if (t == "__preamble__") { printf "%s", content[t]; continue }
          printf "### %s\n\n", t
          printf "%s", content[t]
          printf "\n"
        }
      }
    ' "$tmp_existing" "$tmp_generated")
    rm -f "$tmp_existing" "$tmp_generated"
    GENERATED_SECTION="$MERGED_BODY"
  fi

  # Squeeze accidental runs of blank lines left over from merging hand-written
  # [Unreleased] prose with the generated bullets — cosmetic only, this is a
  # draft meant for a human pass before the commit.
  GENERATED_SECTION=$(printf '%s\n' "$GENERATED_SECTION" | cat -s)

  NEW_SECTION="## [$VERSION] - $TODAY"$'\n\n'"$GENERATED_SECTION"
  [[ -n "$STATS_LINE" ]] && NEW_SECTION+=$'\n'"$STATS_LINE"$'\n'

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "── generated CHANGELOG section (dry-run, not written) ──────────────"
    echo "$NEW_SECTION"
    echo "─────────────────────────────────────────────────────────────────"
  else
    section_file="CHANGELOG.section.tmp"
    tmp_changelog="CHANGELOG.md.bump.tmp"
    printf '%s\n' "$NEW_SECTION" > "$section_file"
    awk -v sf="$section_file" '
      BEGIN { injected = 0; in_unreleased = 0 }
      /^## \[Unreleased\]/ && !injected {
        print
        print ""
        in_unreleased = 1
        while ((getline line < sf) > 0) print line
        close(sf)
        injected = 1
        next
      }
      in_unreleased && /^## \[/ { in_unreleased = 0 }
      in_unreleased { next }   # drop old Unreleased body, it has been merged above
      { print }
      END {
        if (!injected) {
          print "WARNING: no [Unreleased] anchor found, new section NOT injected" > "/dev/stderr"
        }
      }
    ' CHANGELOG.md > "$tmp_changelog"
    mv "$tmp_changelog" CHANGELOG.md
    rm -f "$section_file"

    # Update / add the compare-link refs at the bottom of the file.
    if [[ -n "$GH_SLUG" ]]; then
      BASE_URL="https://github.com/$GH_SLUG"
      if grep -qE '^\[Unreleased\]: ' CHANGELOG.md; then
        sed -i -E "s#^\[Unreleased\]: .*#[Unreleased]: ${BASE_URL}/compare/${TAG}...HEAD#" CHANGELOG.md
      else
        printf '\n[Unreleased]: %s/compare/%s...HEAD\n' "$BASE_URL" "$TAG" >> CHANGELOG.md
      fi
      if ! grep -qE "^\[$VERSION\]: " CHANGELOG.md; then
        PREV_REF="${LATEST_TAG:-$TAG}"
        LINK_LINE="[$VERSION]: ${BASE_URL}/compare/${PREV_REF}...${TAG}"
        tmp_changelog="CHANGELOG.md.link.tmp"
        awk -v line="$LINK_LINE" '
          /^\[Unreleased\]: / && !done { print; print line; done = 1; next }
          { print }
        ' CHANGELOG.md > "$tmp_changelog"
        mv "$tmp_changelog" CHANGELOG.md
      fi
    else
      warn "Could not resolve a github.com remote slug, compare-link refs left untouched"
    fi
    ok "CHANGELOG.md updated with the [$VERSION] section (please review before relying on it)"
  fi
fi

if [[ $CHANGELOG_ONLY -eq 1 ]]; then
  ok "--changelog mode done. package.json, package-lock.json and CHANGELOG.md are now modified, so a
    plain re-run would stop at the dirty-tree check: review the generated section, copy any wording
    you want to keep into the commit history or [Unreleased], restore those three files, then run
    the full release (it regenerates the same section)."
  exit 0
fi

# ─── Step 5: pre-release checks ──────────────────────────────────────────────
if [[ $SKIP_TESTS -eq 0 ]]; then
  info "[5/9] Pre-release checks"
  info "  -> npm run format:check"
  [[ $DRY_RUN -eq 0 ]] && npm run format:check
  info "  -> npm run typecheck"
  [[ $DRY_RUN -eq 0 ]] && npm run typecheck
  info "  -> npm test"
  [[ $DRY_RUN -eq 0 ]] && npm test
  info "  -> npm run build (NODE_ENV=production)"
  [[ $DRY_RUN -eq 0 ]] && NODE_ENV=production npm run build
  info "  -> npm run build:web (NODE_ENV=production) && npm run check:web"
  [[ $DRY_RUN -eq 0 ]] && { NODE_ENV=production npm run build:web && npm run check:web; }
  ok "Pre-release checks passed"
else
  warn "[5/9] Skipping pre-release checks (--skip-tests — emergency use only)"
fi

# ─── Step 6: commit + annotated tag ──────────────────────────────────────────
info "[6/9] Create release commit + tag"

if [[ "${SKIP_CHANGELOG:-0}" -eq 0 && -n "$GENERATED_SECTION" ]]; then
  # Reuse the in-memory section — works identically for --dry-run (nothing was
  # ever written to CHANGELOG.md) and for a real run (file and memory agree).
  CHANGELOG_BODY=$(printf '%s' "$GENERATED_SECTION" | sed '/^[[:space:]]*$/d')
  [[ -n "$STATS_LINE" ]] && CHANGELOG_BODY+=$'\n'"$STATS_LINE"
else
  # The [$VERSION] section already existed on disk (idempotent re-run) —
  # extract it instead of re-deriving it.
  CHANGELOG_BODY=$(awk -v ver="$VERSION" '
    flag && /^## \[/ { exit }
    flag { print }
    $0 ~ "^## \\[" ver "\\]" { flag = 1 }
  ' CHANGELOG.md | sed '/^[[:space:]]*$/d')
fi

COMMIT_MSG="chore(release): bump version to v$VERSION

### Changes in v$VERSION
$(echo "$CHANGELOG_BODY" | head -20)
"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "── commit message (dry-run) ─────────────────────────────────────"
  echo "$COMMIT_MSG"
  echo "── tag annotation (dry-run) ─────────────────────────────────────"
  echo "Release v$VERSION"
  echo
  echo "$CHANGELOG_BODY"
  echo "────────────────────────────────────────────────────────────────"
  warn "Skipping commit/tag (dry-run)"
else
  git add package.json package-lock.json CHANGELOG.md
  git commit -m "$COMMIT_MSG"
  git tag -a "$TAG" -m "Release v$VERSION

$CHANGELOG_BODY"
  ok "Commit + tag $TAG created"

  git merge-base --is-ancestor "$TAG" master \
    || die "Tag $TAG is not an ancestor of master (should be impossible — report this)"
  ok "Verified $TAG is an ancestor of master"
fi

# ─── Step 7: push ─────────────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  warn "[7/9] Dry-run — skipping push"
elif [[ $SKIP_PUSH -eq 1 ]]; then
  warn "[7/9] Skipped push (--skip-push). Commit + tag are local only. Manual next steps:
    git push origin master && git push origin $TAG
    scripts/release/package.sh $VERSION
    gh release create $TAG release/pi-toolkit-${VERSION}.zip release/pi-toolkit-${VERSION}.zip.sha256 release/pi-toolkit-web-ui-${VERSION}.zip release/pi-toolkit-web-ui-${VERSION}.zip.sha256 --title $TAG --notes-file release/CHANGELOG-${VERSION}.md"
else
  info "[7/9] Push $CURRENT_BRANCH and $TAG to origin"
  RESUME_PUBLISH="scripts/release/package.sh $VERSION
    gh release create $TAG release/pi-toolkit-${VERSION}.zip release/pi-toolkit-${VERSION}.zip.sha256 release/pi-toolkit-web-ui-${VERSION}.zip release/pi-toolkit-web-ui-${VERSION}.zip.sha256 --title $TAG --notes-file release/CHANGELOG-${VERSION}.md"
  git push origin "$CURRENT_BRANCH" || die "push of $CURRENT_BRANCH failed — commit + tag $TAG are local only. Resume with:
    git push origin $CURRENT_BRANCH && git push origin $TAG
    $RESUME_PUBLISH"
  git push origin "$TAG" || die "$CURRENT_BRANCH was pushed but tag push failed. Resume with:
    git push origin $TAG
    $RESUME_PUBLISH"
  ok "Pushed $CURRENT_BRANCH and $TAG"

  git merge-base --is-ancestor "$TAG" "origin/master" \
    || warn "Local check only — could not verify $TAG against origin/master (non-fatal)"

  # ─── Step 8: package + publish ──────────────────────────────────────────
  if [[ $SKIP_PUBLISH -eq 1 ]]; then
    warn "[8-9/9] Skipped packaging/publish (--skip-publish). Manual next steps:
    scripts/release/package.sh $VERSION
    gh release create $TAG release/pi-toolkit-${VERSION}.zip release/pi-toolkit-${VERSION}.zip.sha256 release/pi-toolkit-web-ui-${VERSION}.zip release/pi-toolkit-web-ui-${VERSION}.zip.sha256 --title $TAG --notes-file release/CHANGELOG-${VERSION}.md"
  else
    info "[8/9] scripts/release/package.sh $VERSION"
    scripts/release/package.sh "$VERSION" || die "packaging failed (branch + tag already pushed). Fix and resume with:
    $RESUME_PUBLISH"

    info "[9/9] gh release create $TAG"
    gh release create "$TAG" \
      "release/pi-toolkit-${VERSION}.zip" \
      "release/pi-toolkit-${VERSION}.zip.sha256" \
      "release/pi-toolkit-web-ui-${VERSION}.zip" \
      "release/pi-toolkit-web-ui-${VERSION}.zip.sha256" \
      --title "$TAG" \
      --notes-file "release/CHANGELOG-${VERSION}.md" \
      || die "gh release create failed (branch + tag pushed, assets built in release/). Resume with:
    gh release create $TAG release/pi-toolkit-${VERSION}.zip release/pi-toolkit-${VERSION}.zip.sha256 release/pi-toolkit-web-ui-${VERSION}.zip release/pi-toolkit-web-ui-${VERSION}.zip.sha256 --title $TAG --notes-file release/CHANGELOG-${VERSION}.md"
    ok "✅ Released $TAG"
  fi
fi
