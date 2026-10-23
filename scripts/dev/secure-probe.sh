#!/usr/bin/env bash
# P0 probe for docs/dev/data-encryption/plan.md: measures the gocryptfs behaviours the
# `pi-secure` launcher depends on (§1 / §2.1 / §2.2 / §2.5 / §6 C1-C3).
# Everything happens inside a private 0700 mktemp dir with a TEST-ONLY fake password; every
# command is wrapped in timeout; the EXIT trap always unmounts and removes the scratch dir.
# Exit: 0 all checks pass · 1 some check failed · 3 prerequisites missing (skip).
set -u

for b in gocryptfs fusermount3 flock script timeout; do
  command -v "$b" >/dev/null 2>&1 || { echo "SKIP: $b not found"; exit 3; }
done
[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ] || { echo "SKIP: /dev/fuse unusable"; exit 3; }

FAKE_PW="TESTPASS-fake-not-a-secret"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/secure-probe.XXXXXX")"
chmod 700 "$ROOT"
FAILS=0
MNT="$ROOT/mnt"

cleanup() {
  cd / || true
  timeout 10 fusermount3 -u "$MNT" >/dev/null 2>&1 || true
  # lazy fallback only for mounts that really sit inside ROOT
  while read -r _ _ _ _ mp _; do
    case "$mp" in "$ROOT"/*) timeout 10 fusermount3 -uz "$mp" >/dev/null 2>&1 || true ;; esac
  done </proc/self/mountinfo
  chmod -R u+rwx "$ROOT" 2>/dev/null || true
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { # name, cond-exit-status
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}
eq() { [ "$2" = "$3" ]; check "$1 (got '$2', want '$3')" $?; }
mounted() { grep -qs " $1 " /proc/self/mountinfo; }
sentinels() { rm -rf -- "$MNT"; mkdir -p "$MNT"; : >"$MNT/work"; : >"$MNT/state"; chmod 400 "$MNT/work" "$MNT/state"; }
umount_safe() { timeout 10 fusermount3 -u "$MNT" >/dev/null 2>&1; }

# drive a command through a pty: $1 = timeout s, $2.. = lines typed (after 1s each), rest after "--"
tty_run() {
  local t="$1"; shift
  local lines=()
  while [ "$1" != "--" ]; do lines+=("$1"); shift; done
  shift
  ( sleep 1; for l in "${lines[@]}"; do printf '%s\r' "$l"; sleep 1; done; sleep 1 ) |
    timeout "$t" script -qefc "$*" /dev/null
}

echo "== gocryptfs: $(gocryptfs -version 2>&1 | head -1)"
printf '%s\n' "$FAKE_PW" >"$ROOT/pf"
touch "$ROOT/mount.lock"

# ---- C1: -init and mount read the password from the TTY ---------------------------------
mkdir "$ROOT/c-tty"
OUT="$(tty_run 20 "$FAKE_PW" "$FAKE_PW" -- gocryptfs -init -- "$ROOT/c-tty" 2>&1 | tr -d '\r')"
RC=${PIPESTATUS[0]}
echo "$OUT" | grep -q "Password:" ; check "C1 init prompts Password:" $?
echo "$OUT" | grep -q "Repeat:" ; check "C1 init prompts Repeat:" $?
# master key printed as 8 groups of 8 hex digits (wrapped over two lines, dim escape codes around)
KEY="$(echo "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | sed -n '/master key is/,/If the gocryptfs.conf/p' | grep -Eo '[0-9a-f]{8}(-|$)' | tr -d '\n-' )"
[ "${#KEY}" -eq 64 ]; check "C1 init prints a 64-hex master key (after 'Your master key is:')" $?
echo "$OUT" | grep -q "created successfully"; check "C1 init reports success" $?
[ -f "$ROOT/c-tty/gocryptfs.conf" ]; check "C1 gocryptfs.conf written" $?
unset KEY

# init with -q via TTY: master-key banner is SUPPRESSED (production init must NOT pass -q)
mkdir "$ROOT/c-q"
OUTQ="$(tty_run 20 "$FAKE_PW" "$FAKE_PW" -- gocryptfs -init -q -- "$ROOT/c-q" 2>&1 | tr -d '\r')"
echo "$OUTQ" | grep -q "master key"; [ $? -ne 0 ]; check "C1 init -q hides the master key banner (so production init must not use -q)" $?
[ -f "$ROOT/c-q/gocryptfs.conf" ]; check "C1 init -q still creates the filesystem" $?

# init via -passfile (test only): no key banner needed, exit 0
mkdir "$ROOT/c-pf"
timeout 20 gocryptfs -init -q -passfile "$ROOT/pf" -- "$ROOT/c-pf" >/dev/null 2>&1
eq "C1 init -passfile -q exit" "$?" 0
OUTQ="$(timeout 20 gocryptfs -init -passfile "$ROOT/pf" -- "$ROOT/c-pf" 2>&1)"; RC=$?
[ "$RC" -ne 0 ]; check "C1 init on existing cipherdir fails (exit $RC)" $?

# mount via TTY, with flock -o
sentinels
OUT="$(tty_run 30 "$FAKE_PW" -- flock -o -w 10 "$ROOT/mount.lock" gocryptfs -nonempty -- "$ROOT/c-tty" "$MNT" 2>&1 | tr -d '\r')"
mounted "$MNT"; check "C1 mount via TTY prompt mounts" $?
echo "$OUT" | grep -q "Password:"; check "C1 mount prompts Password:" $?
flock -n "$ROOT/mount.lock" true; check "C1 flock -o: lock is free after mount (daemon did not inherit)" $?
umount_safe
sentinels
OUT="$(tty_run 30 "$FAKE_PW" -- gocryptfs -q -nonempty -- "$ROOT/c-tty" "$MNT" 2>&1 | tr -d '\r')"
echo "$OUT" | grep -q "Password:"; check "C1 mount -q via TTY still prompts Password:" $?
echo "$OUT" | grep -q "mounted and ready"; [ $? -ne 0 ]; check "C1 mount -q suppresses the 'mounted and ready' banner" $?
mounted "$MNT"; check "C1 mount -q via TTY mounts" $?
# mountinfo fstype / source
LINE="$(grep " $MNT " /proc/self/mountinfo)"
FSTYPE="$(echo "$LINE" | sed 's/.* - //' | awk '{print $1}')"
SRC="$(echo "$LINE" | sed 's/.* - //' | awk '{print $2}')"
eq "C1 mountinfo fstype" "$FSTYPE" "fuse.gocryptfs"
eq "C1 mountinfo source is cipherdir" "$SRC" "$ROOT/c-tty"
mkdir -p "$MNT/work/p" && echo hi >"$MNT/work/p/f"; check "C1 write inside mount" $?
umount_safe; check "C1 fusermount3 -u" $?
mounted "$MNT" ; [ $? -ne 0 ]; check "C1 unmounted after -u" $?

# ---- C2: sentinels + -nonempty ------------------------------------------------------------
sentinels
timeout 20 gocryptfs -nonempty -q -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
eq "C2 -nonempty mounts over sentinel dir" "$?" 0
[ -d "$MNT/work" ] || mkdir "$MNT/work"
[ -d "$MNT/work" ]; check "C2 inside mount work/ is a directory (sentinel hidden)" $?
umount_safe
[ -f "$MNT/work" ] && [ ! -s "$MNT/work" ]; check "C2 after umount work is the 0-byte sentinel again" $?
ERR="$(mkdir -p "$MNT/state/x" 2>&1)"; RC=$?
[ "$RC" -ne 0 ] && echo "$ERR" | grep -q "Not a directory"; check "C2 mkdir -p mnt/state/x -> ENOTDIR (rc=$RC)" $?
( echo x >"$MNT/work/y" ) 2>/dev/null; [ $? -ne 0 ]; check "C2 write mnt/work/y fails when unmounted" $?
# without -nonempty
sentinels
OUT="$(timeout 20 gocryptfs -q -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" 2>&1)"; RC=$?
eq "C2 no -nonempty on non-empty dir: exit (10 expected)" "$RC" 10
mounted "$MNT"; [ $? -ne 0 ]; check "C2 no mount happened without -nonempty" $?

# ---- wrong password exit codes --------------------------------------------------------------
sentinels
printf '%s\n' "wrong-fake" >"$ROOT/bad"
timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/bad" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
eq "C1 wrong password via -passfile: exit" "$?" 12
tty_run 20 "wrong-fake" -- gocryptfs -nonempty -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
eq "C1 wrong password via TTY (script -e propagates): exit" "$?" 12
mounted "$MNT"; [ $? -ne 0 ]; check "C1 wrong password leaves nothing mounted" $?

# ---- C3: umount needs no extra write permission; cwd inside => EBUSY ------------------------
sentinels
timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
mkdir -p "$MNT/work"
ERR="$(cd "$MNT/work" && timeout 10 fusermount3 -u "$MNT" 2>&1)"; RC=$?
[ "$RC" -ne 0 ] && echo "$ERR" | grep -qi "busy"; check "C3 cwd inside mount: umount EBUSY (rc=$RC)" $?
mounted "$MNT"; check "C3 still mounted after EBUSY" $?
umount_safe; eq "C3 umount after leaving: exit" "$?" 0
# mount root read-only for the user (0500): unmount still works
timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
chmod 500 "$MNT" 2>/dev/null
umount_safe; eq "C3 umount of 0500 mount root needs no write permission: exit" "$?" 0
chmod 700 "$MNT"
# mounting onto a 0500 mountpoint dir is refused (fusermount needs write on mountpoint)
chmod 500 "$MNT"
OUT="$(timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" 2>&1)"; RC=$?
[ "$RC" -ne 0 ]; check "C3 mount on non-writable mountpoint fails (rc=$RC)" $?
umount_safe >/dev/null 2>&1
chmod 700 "$MNT"

# ---- misc: -q output, -fg, -extpass, flock without -o ----------------------------------------
sentinels
OUT="$(timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" 2>&1)"
[ -z "$OUT" ]; check "misc -q mount prints nothing" $?
umount_safe
OUT="$(timeout 20 gocryptfs -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" 2>&1)"
echo "$OUT" | grep -q "Filesystem mounted and ready"; check "misc non-quiet prints 'Filesystem mounted and ready'" $?
umount_safe
timeout 20 gocryptfs -q -nonempty -extpass "cat $ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
eq "misc -extpass mount: exit" "$?" 0
umount_safe
flock -w 5 "$ROOT/mount.lock" gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
flock -n "$ROOT/mount.lock" true; [ $? -ne 0 ]; check "misc flock WITHOUT -o: daemon keeps the lock (-o is required)" $?
umount_safe
# daemonisation: default mode returns while a daemon keeps serving
timeout 20 gocryptfs -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1
pgrep -f "gocryptfs .*-fg .*$ROOT/c-pf" >/dev/null; check "misc default mode daemonises (-fg re-exec child alive)" $?
# stale mount: daemon killed -> ENOTCONN, fusermount3 -u still clears it
PIDS="$(pgrep -f "gocryptfs .*-fg .*$ROOT/c-pf")"
for p in $PIDS; do kill -KILL "$p" 2>/dev/null; done
sleep 0.5
ERR="$(ls "$MNT" 2>&1)"; echo "$ERR" | grep -qi "not connected"; check "misc killed daemon -> ENOTCONN" $?
umount_safe; eq "misc stale mount cleared by fusermount3 -u" "$?" 0
# -fg: stays in foreground until unmounted
timeout 15 gocryptfs -fg -q -nonempty -passfile "$ROOT/pf" -- "$ROOT/c-pf" "$MNT" >/dev/null 2>&1 &
FGPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do mounted "$MNT" && break; sleep 0.3; done
mounted "$MNT"; check "misc -fg mounts" $?
kill -0 "$FGPID" 2>/dev/null; check "misc -fg process stays in foreground" $?
umount_safe
wait "$FGPID"; eq "misc -fg exits 0 after umount" "$?" 0

echo "== done: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
