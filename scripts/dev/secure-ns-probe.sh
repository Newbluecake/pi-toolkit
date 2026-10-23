#!/usr/bin/env bash
# secure-ns-probe.sh — 「私有挂载命名空间」可行性实测（pi-secure run --private 前置调研）
#
# 目标：gocryptfs 明文挂载只对 pi 进程树（含 bash/git/子 agent）可见；外部同用户进程
#       仍只能看到 <dir>/mnt 下的 0 字节 0400 哨兵。
# 方案链：外层 `unshare --user --map-root-user --mount --propagation private`（ns-root，
#       直接 FUSE 挂载，不经 setuid fusermount）→ 内层 `unshare --user --map-user=<uid>
#       --map-group=<gid>` 回到真实 uid 跑负载。
#
# 约束：只在 mktemp -d 私有目录建测试保险库（假口令 -passfile）；绝不碰真实保险库与
#       ~/.pi 配置；任何失败路径都必须清理；不改 src/。
#
# 用法：bash scripts/dev/secure-ns-probe.sh [--fast]
#   输出打到 stdout（建议 tee 留档）；--fast 跳过 `pi -p --no-session` 真机项。
#   退出码 0 = 全部阶段执行完毕（单项失败已在输出中记录，结论以输出为准）。

set -u
set -o pipefail

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
[ "$FAST" = 1 ] && export PI_TIMEOUT_S=1

PU=$(id -u); PG=$(id -g)
T=$(mktemp -d /tmp/secure-ns-probe.XXXXXX)
V=$T/vault            # 测试保险库：cipher/ + mnt/{work,state} 哨兵
R=$T/results          # 结果/中间产物（挂载外，探针可写）
PW=$T/pw
mkdir -p "$V/cipher" "$V/mnt" "$R"
chmod 700 "$V" "$V/cipher" "$V/mnt"

PIDS=()               # 需要收尾的 pid（<2 的一律跳过，防 kill 0 误杀全组）
PGIDS=()              # 需要收尾的进程组
LAST_PGID=0

cleanup() {
  local p
  for p in ${PIDS[*]:-}; do [ "$p" -ge 2 ] 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
  for p in ${PGIDS[*]:-}; do [ "$p" -ge 2 ] 2>/dev/null && { kill -TERM -- "-$p" 2>/dev/null; } done
  sleep 0.4
  for p in ${PGIDS[*]:-}; do [ "$p" -ge 2 ] 2>/dev/null && kill -KILL -- "-$p" 2>/dev/null; done
  fusermount3 -uz "$V/mnt" 2>/dev/null
  fusermount3 -uz "$T/vm" 2>/dev/null
  sleep 0.3
  rm -rf "$T" 2>/dev/null || echo "WARN: 无法清理 $T（请手动检查）"
}
trap cleanup EXIT INT TERM

sec() { echo; echo "================ [$1] $2 ================"; }
note() { echo "--- $*"; }

# ───────────────────────── P0 环境与工具 ─────────────────────────
sec P0 "环境与工具"
echo "kernel: $(uname -r)  os: $(. /etc/os-release; echo "$PRETTY_NAME")"
echo "unshare: $(unshare --version | head -1)  nsenter: $(nsenter --version 2>/dev/null | head -1)"
echo "gocryptfs: $(gocryptfs -version 2>&1 | head -1)"
echo "/dev/fuse: $(ls -l /dev/fuse 2>&1)"
echo "unprivileged_userns_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)"
echo "yama.ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null)"
echo "/proc 挂载选项（hidepid?）: $(findmnt -no OPTIONS /proc 2>/dev/null)"
echo "uid=$PU gid=$PG  pi=$(command -v pi || echo MISSING)  node=$(command -v node || echo MISSING) python3=$(command -v python3 || echo MISSING) strace=$(command -v strace || echo MISSING)"
echo "SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-<unset>}  tmux dir: $(ls -d /tmp/tmux-$PU 2>/dev/null || echo 无)"

# ───────────────────────── P1 嵌套 uid 映射 sanity ─────────────────────────
sec P1 "嵌套 uid 映射（外层 ns-root → 内层真实 uid）"
unshare --user --map-root-user --mount --propagation private bash -c '
  echo "outer id: $(id -u)/$(id -g)  uid_map: $(cat /proc/self/uid_map | tr -s " ")"
  unshare --user --map-user='"$PU"' --map-group='"$PG"' bash -c "
    echo \"inner id: \$(id)\"
    echo \"inner uid_map: \$(cat /proc/self/uid_map | tr -s \" \")  gid_map: \$(cat /proc/self/gid_map | tr -s \" \")\"
    echo \"inner CapEff: \$(grep CapEff /proc/self/status | cut -d: -f2)\"
  "
' 2>&1

# ───────────────────────── P2 测试保险库 init ─────────────────────────
sec P2 "初始化测试保险库（mktemp 目录 + 假口令）"
printf 'probe-fake-password-%s\n' "$RANDOM$RANDOM" > "$PW"; chmod 600 "$PW"
: > "$V/mnt/work";  chmod 0400 "$V/mnt/work"
: > "$V/mnt/state"; chmod 0400 "$V/mnt/state"
: > "$V/mount.lock"; chmod 600 "$V/mount.lock"
gocryptfs -init -q -passfile "$PW" -- "$V/cipher" 2>&1 | sed 's/^/init: /'
echo "init rc=$?  cipher 文件属主: $(ls -ln "$V/cipher" | tail -n +2 | awk '{print $3":"$4}' | sort -u | tr '\n' ' ')"

sentinel_state() { # 外部视角哨兵状态（$1=标签）
  echo "[$1] 外部 stat mnt/work = $(stat -c '%F %s字节 %a %u:%g' "$V/mnt/work" 2>&1)"
  echo "[$1] 外部 stat mnt/state = $(stat -c '%F %s字节 %a %u:%g' "$V/mnt/state" 2>&1)"
  echo "[$1] 外部 ls mnt = $(ls -A "$V/mnt" 2>&1 | tr '\n' ' ')"
}

# ───────────────────────── 内层脚本（真实 uid 负载） ─────────────────────────
cat > "$T/inner.sh" <<'EOF'
#!/usr/bin/env bash
# 在内层（映射回真实 uid）执行：身份/挂载可见性/属主 + 负载兼容性
set -u
echo "inner id: $(id)"
echo "inner uid_map: $(cat /proc/self/uid_map | tr -s ' ')  gid_map: $(cat /proc/self/gid_map | tr -s ' ')"
echo "inner 挂载可见: $(grep " $V/mnt " /proc/self/mountinfo | grep -c fuse.gocryptfs) 条"
mkdir -p "$V/mnt/work" "$V/mnt/state"; echo "inner mkdir work/state rc=$?"
REPO="$V/mnt/work/repo"
mkdir -p "$REPO" && cd "$REPO" || { echo "FATAL cd"; exit 9; }
SECRET="probe-secret-$(date +%s%N)"
echo "$SECRET" > secret.txt; echo "$SECRET" > "$R/secret.expected"
echo "inner 属主视角: secret.txt=$(stat -c '%u:%g %a' secret.txt) .git=$(stat -c '%u:%g' .git)"
echo "== git =="
git init -q . 2>&1 | head -2
git config user.email probe@local; git config user.name probe
git add -A 2>&1 | head -2; git commit -qm "probe commit" 2>&1 | head -3
echo "git rev-parse HEAD: $(git rev-parse HEAD 2>&1)"
git status --porcelain >/dev/null 2>&1; echo "git status rc=$?（0=无 dubious ownership 问题）"
echo "git 全局配置读取 rc=$(git config --global --list >/dev/null 2>&1; echo $?)"
echo "== node =="
node -e 'const fs=require("fs"),os=require("os");fs.writeFileSync(process.env.V+"/mnt/work/node.txt","node-was-here\n");console.log("node 读写:",JSON.stringify(fs.readFileSync(process.env.V+"/mnt/work/node.txt","utf8")),"homedir:",os.homedir(),"tmpdir:",os.tmpdir())' 2>&1
echo "== ssh =="
ssh-keygen -q -t ed25519 -N "" -f "$V/mnt/work/id_probe" >/dev/null 2>&1
echo "ssh-keygen 生成 rc=$? 属主 $(stat -c '%u:%g %a' "$V/mnt/work/id_probe" 2>&1)"
ssh-keygen -y -f "$V/mnt/work/id_probe" >/dev/null 2>"$R/sshkey.err"; echo "ssh-keygen -y（私钥属主检查）rc=$? err=$(head -c 160 "$R/sshkey.err" | tr '\n' ' ')"
ssh -G probe.invalid >"$R/sshG.out" 2>"$R/sshG.err"; echo "ssh -G（config 解析+属主检查）rc=$? err=$(head -c 120 "$R/sshG.err" | tr '\n' ' ')"
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK:-}" ]; then
  timeout 3 ssh-add -l >/dev/null 2>&1; echo "ssh-agent socket 可达: rc=$? (0=有钥匙,1=无钥匙)"
else
  echo "ssh-agent socket: 不存在或未设置"
fi
if [ -d "/tmp/tmux-$PU" ]; then
  timeout 3 tmux -S "/tmp/tmux-$PU/$(ls "/tmp/tmux-$PU" 2>/dev/null | head -1)" list-sessions >/dev/null 2>&1 \
    && echo "tmux 外部 unix socket 可达 rc=0" || echo "tmux socket dir 存在但 list-sessions rc=$?（无会话正常）"
else
  echo "tmux socket dir: 无"
fi
echo "== 子进程同挂载 ns =="
sleep 120 & SUB=$!; echo "$SUB" > "$R/sub.pid"
echo "父 ns=$(readlink /proc/self/ns/mnt)  子 ns=$(readlink /proc/$SUB/ns/mnt) 一致=$([ "$(readlink /proc/self/ns/mnt)" = "$(readlink /proc/$SUB/ns/mnt)" ] && echo yes || echo NO)"
echo "== pi =="
timeout 30 pi --version >"$R/piver.out" 2>&1; echo "pi --version rc=$? out=$(head -c 200 "$R/piver.out" | tr '\n' ' ')"
mkdir -p "$V/mnt/work/pi-test" && cd "$V/mnt/work/pi-test"
timeout "${PI_TIMEOUT_S:-75}" pi -p --no-session "Reply with exactly: OK" >"$R/pi.out" 2>&1; echo "pi -p --no-session rc=$?"
echo "pi 输出前 300 字节: $(head -c 300 "$R/pi.out" | tr '\n' ' ')"
echo "=== INNER WORKLOAD DONE ==="
EOF

# ns-root 直跑负载对照（任务项 1：副作用比较）
cat > "$T/rootload.sh" <<'EOF'
#!/usr/bin/env bash
set -u
echo "ns-root id: $(id)  whoami: $(whoami)"
mkdir -p "$V/mnt/work/rootrepo" && cd "$V/mnt/work/rootrepo" || exit 9
echo x > f.txt
echo "ns-root 属主视角: f.txt=$(stat -c '%u:%g %a' f.txt)（ns 内用户文件全显示为 0）"
git init -q . 2>&1 | head -2
git config user.email r@r; git config user.name r
git add f.txt >/dev/null 2>&1; git commit -qm rootcommit >/dev/null 2>&1
git status --porcelain >/dev/null 2>&1; echo "git status rc=$?  rev-parse=$(git rev-parse --short HEAD 2>&1)"
ssh-keygen -y -f "$V/mnt/work/id_probe" >/dev/null 2>&1; echo "ssh-keygen -y（内层uid建的钥匙）rc=$?"
[ -w /etc/passwd ] && echo "!! 可写 /etc/passwd" || echo "/etc/passwd 不可写（无真 root，kuid 仍是 $PU）"
touch "/tmp/nsroot-probe-$$"; echo "/tmp/nsroot-probe-$$" > "$R/rootfile"
echo "新建 /tmp 文件在 ns 内显示属主: $(stat -c '%u:%g' "/tmp/nsroot-probe-$$")"
node -e 'console.log("node homedir:",require("os").homedir(),"tmpdir:",require("os").tmpdir())' 2>&1
echo "=== ROOTLOAD DONE ==="
EOF

# 内层持有者脚本：为外部可见性测试保持 cwd/fd/挂载引用
cat > "$T/holder.sh" <<'EOF'
#!/usr/bin/env bash
set -u
cd "$V/mnt/work/repo" || { echo "FATAL: repo 不存在"; exit 9; }
exec 9<secret.txt
sleep 300 & echo $! > "$R/sleeper.pid"
R="$R" setsid python3 - "$V/mnt/work/repo" >"$R/dumper.out" 2>&1 <<'PY' &
import ctypes, os, sys, time
repo = sys.argv[1]
ctypes.CDLL(None).prctl(4, 0)   # PR_SET_DUMPABLE=0（缓解手段验证）
os.chdir(repo)
fd = os.open(os.path.join(repo, "secret.txt"), os.O_RDONLY)
open(os.environ["R"] + "/dumper.fd", "w").write(str(fd))
time.sleep(300)
PY
echo $! > "$R/dumper.pid"
echo "holder 就绪: sleeper=$(cat "$R/sleeper.pid") dumper=$(cat "$R/dumper.pid")"
wait
EOF

# ───────────────────────── 外层监督者（ns 内 ns-root） ─────────────────────────
cat > "$T/outer.sh" <<'EOF'
#!/usr/bin/env bash
# 在 外层 user+mount ns 内执行：直接挂载 gocryptfs（不经 fusermount），派发负载
set -u
echo "outer id: $(id)"
gocryptfs -fg -nonempty -passfile "$T/pw" -- "$V/cipher" "$V/mnt" 2>"$R/gocryptfs.log" &
GP=$!
echo "$GP" > "$R/gocryptfs.pid"; echo $$ > "$R/outer.pid"
readlink /proc/self/ns/mnt > "$R/ns-mnt.id"
ready=0
for i in $(seq 1 75); do
  grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs && { ready=1; break; }
  kill -0 "$GP" 2>/dev/null || break
  sleep 0.2
done
if [ "$ready" != 1 ]; then echo "MOUNT-FAILED"; head -5 "$R/gocryptfs.log"; exit 21; fi
echo "MOUNT-READY $(grep " $V/mnt " /proc/self/mountinfo)"
case "${PHASE:-workload}" in
  workload)
    unshare --user --map-user="$PU" --map-group="$PG" -- bash "$T/inner.sh" >"$R/inner.out" 2>&1
    echo "$?" > "$R/inner.rc"
    [ -s "$R/sub.pid" ] && kill -KILL "$(cat "$R/sub.pid")" 2>/dev/null   # 清掉负载遗留的 cwd 持有者
    umount "$V/mnt" 2>"$R/umount.err"; echo "$?" > "$R/umount.rc"
    if grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs; then
      umount -l "$V/mnt" 2>>"$R/umount.err"; echo "lazy-$?" >> "$R/umount.rc"
    fi
    wait "$GP"; echo "$?" > "$R/gocryptfs.exit"
    ;;
  rootload)
    bash "$T/rootload.sh" >"$R/rootload.out" 2>&1
    echo "$?" > "$R/rootload.rc"
    umount "$V/mnt" 2>>"$R/umount.err"; echo "$?" > "$R/umount.rc"
    wait "$GP"; echo "$?" > "$R/gocryptfs.exit"
    ;;
  holder)
    REPO_DIR="$V/mnt/work/repo" unshare --user --map-user="$PU" --map-group="$PG" -- bash "$T/holder.sh" >"$R/holder.out" 2>&1 &
    echo $! > "$R/holder.pid"
    for i in $(seq 1 1200); do [ -f "$R/teardown" ] && break; kill -0 "$GP" 2>/dev/null || break; sleep 0.5; done
    [ -f "$R/teardown" ] && echo "supervisor: 收到 teardown"
    kill -TERM "$(cat "$R/holder.pid" 2>/dev/null)" 2>/dev/null; sleep 0.5
    for pf in sleeper.pid dumper.pid; do
      [ -s "$R/$pf" ] && kill -KILL "$(cat "$R/$pf")" 2>/dev/null
    done
    if grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs; then
      umount "$V/mnt" 2>>"$R/umount.err"; echo "post-$?" >> "$R/umount.rc"
    fi
    if grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs; then
      umount -l "$V/mnt" 2>>"$R/umount.err"; echo "lazy-$?" >> "$R/umount.rc"
    fi
    wait "$GP" 2>/dev/null; echo "$?" > "$R/gocryptfs.exit"
    ;;
  idle)
    wait "$GP"; echo "$?" > "$R/gocryptfs.exit"
    echo "idle supervisor: gocryptfs 已退出（外部 lock 生效路径）"
    grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs \
      && { umount "$V/mnt" 2>>"$R/umount.err"; echo "residual-$?" >> "$R/umount.rc"; }
    ;;
  killme)
    sleep 600
    ;;
  holdns)
    unshare --user --map-user="$PU" --map-group="$PG" -- bash -c '
      cd "$V/mnt/work/repo" || exit 9
      setsid sleep 600 & echo $! > "$R/daemon.pid"
      echo "inner: 模拟守护已起 pid=$(cat "$R/daemon.pid")，inner 即将退出"
    ' >"$R/holdns.out" 2>&1
    echo "holdns supervisor: 退出（gocryptfs 与模拟守护留在 ns 内）"
    ;;
esac
grep " $V/mnt " /proc/self/mountinfo | grep -q fuse.gocryptfs \
  && echo still-mounted > "$R/final.state" || echo unmounted > "$R/final.state"
EOF

run_outer() { # $1=PHASE $2=标签：setsid + 外层 unshare 启动，登记 pgid
  rm -f "$R"/teardown "$R"/gocryptfs.pid "$R"/outer.pid "$R"/ns-mnt.id "$R"/umount.rc \
        "$R"/gocryptfs.exit "$R"/final.state "$R"/holder.pid "$R"/sleeper.pid \
        "$R"/dumper.pid "$R"/dumper.fd "$R"/daemon.pid "$R"/rootfile
  env T="$T" V="$V" R="$R" PW="$PW" PU="$PU" PG="$PG" PHASE="$1" PI_TIMEOUT_S="${PI_TIMEOUT_S:-75}" \
    setsid unshare --user --map-root-user --mount --propagation private -- bash "$T/outer.sh" \
    >"$R/outer-$2.out" 2>&1 &
  LAST_PGID=$!
  PGIDS+=("$LAST_PGID"); sleep 0.3
  echo "outer[$2] pgid=$LAST_PGID gocryptfs.pid=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo ?)"
}

wait_file_value() { # $1=文件 $2=期望内容 $3=超时秒
  local i n=$(( ${3:-10} * 5 ))
  for i in $(seq 1 "$n"); do [ -f "$1" ] && [ "$(cat "$1" 2>/dev/null)" = "$2" ] && return 0; sleep 0.2; done
  return 1
}
wait_mounted() { # 等 outer 日志出现 MOUNT-READY（$1=标签）
  local i
  for i in $(seq 1 100); do grep -q "MOUNT-READY" "$R/outer-$1.out" 2>/dev/null && return 0; sleep 0.2; done
  echo "WARN: $1 挂载未就绪"; return 1
}
k9()  { [ "${1:-0}" -ge 2 ] 2>/dev/null && kill -KILL "$1" 2>/dev/null; }
kterm(){ [ "${1:-0}" -ge 2 ] 2>/dev/null && kill -TERM "$1" 2>/dev/null; }

verify_plain() { # $1=标签：普通模式重挂（fusermount 路径）核对完整性
  rm -rf "$T/vm"; mkdir -p "$T/vm"
  timeout 15 gocryptfs -passfile "$PW" -- "$V/cipher" "$T/vm" >>"$R/verify.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then echo "[$1] 普通模式重挂 FAILED rc=$rc"; return 1; fi
  echo "[$1] 完整性: secret=$(cat "$T/vm/work/repo/secret.txt" 2>&1) git=$(git -C "$T/vm/work/repo" log --oneline -1 2>&1 | head -1) node=$(cat "$T/vm/work/node.txt" 2>&1)"
  echo "[$1] 期望 secret=$(cat "$R/secret.expected" 2>/dev/null)"
  fusermount3 -u "$T/vm" 2>>"$R/verify.log"; echo "[$1] 卸载 verify-mnt rc=$?"
}

sibling_try() { # $1=标签 $2=命令（子进程执行＝目标的非祖先旁观者）
  local out rc
  out=$(bash -c "$2" 2>&1); rc=$?
  echo "[sibling] $1 → rc=$rc out=$(printf '%s' "$out" | head -2 | tr '\n' ' ' | head -c 230)"
}
ancestor_read() { # $1=标签 $2=路径：主脚本（祖先）在当前 shell 用内建重定向直接 open（不 fork，保持祖先语义）
  local label=$1 path=$2 _b=""
  if IFS= read -r -N 60 _b < "$path" 2>"$T/anc.err"; then
    echo "[ancestor] $label → OPEN-OK 内容: $(printf '%s' "$_b" | tr -d '\0' | head -c 90)"
  elif [ -s "$T/anc.err" ]; then
    echo "[ancestor] $label → OPEN-DENIED ($(head -c 130 "$T/anc.err" | tr '\n' ' '))"
  else
    echo "[ancestor] $label → OPEN-OK(EOF短读) 内容: $(printf '%s' "$_b" | tr -d '\0' | head -c 90)"
  fi
}
plain_target() { # 基线：初始 ns 中的普通同 uid 进程（无任何命名空间）
  setsid sleep 300 &
  PLAINPID=$!
  PIDS+=("$PLAINPID")
  sleep 0.3
}

# ───────────────── P3/P4/P6 挂载 + 内层负载 + 正常收尾 ─────────────────
sec P3 "私有挂载（外层 ns-root 直接 FUSE 挂载，不经 fusermount）+ 传播隔离"
sec P4 "内层真实 uid 负载（git/ssh/node/socket/子进程/pi）"
sec P6 "生命周期·正常收尾（负载退出 → umount → gocryptfs 退出）"
run_outer workload runA
wait_mounted runA
sentinel_state "runA 挂载期间(外部)"
grep -q "shared:" "$R/outer-runA.out" && echo "!! mountinfo 出现 shared: 传播泄漏" || echo "mountinfo 无 shared: 传播标记（私有 OK）"
wait_file_value "$R/final.state" unmounted 200 || echo "runA 未在 200s 内收尾"
note "outer 输出:"; sed 's/^/  /' "$R/outer-runA.out" | head -8
note "inner 输出:"; sed 's/^/  /' "$R/inner.out" 2>/dev/null
echo "inner.rc=$(cat "$R/inner.rc" 2>/dev/null) umount.rc=$(cat "$R/umount.rc" 2>/dev/null) gocryptfs.exit=$(cat "$R/gocryptfs.exit" 2>/dev/null) umount.err=$(head -c 150 "$R/umount.err" 2>/dev/null)"
sentinel_state "runA 收尾后"
echo "收尾后 cipher 属主（应全为 $PU）: $(ls -ln "$V/cipher" | tail -n +2 | awk '{print $3":"$4}' | sort -u | tr '\n' ' ')"
verify_plain runA

# ───────────────── P4b ns-root 直接跑负载（对照） ─────────────────
sec P4b "对照：直接以 ns-root 跑负载（不经内层 uid 映射）"
run_outer rootload runR
wait_file_value "$R/final.state" unmounted 30 || echo "runR 未收尾"
sed 's/^/  /' "$R/rootload.out" 2>/dev/null
RF=$(cat "$R/rootfile" 2>/dev/null)
[ -n "$RF" ] && { echo "ns-root 在 /tmp 新建的文件，外部（真实内核视角）属主: $(stat -c '%u:%g' "$RF" 2>&1)"; rm -f "$RF"; }
echo "runR: umount.rc=$(cat "$R/umount.rc" 2>/dev/null) gocryptfs.exit=$(cat "$R/gocryptfs.exit" 2>/dev/null)"

# ───────────────── P5 外部可见性（挂载活跃期间） ─────────────────
sec P5 "外部同用户进程可见性（/proc 各通道 + nsenter/setns）［ptrace_scope=1］"
plain_target
PL=$PLAINPID
note "基线对照（目标=初始 ns 普通 sleep pid $PL，无任何命名空间）："
sibling_try "基线 /proc/<初始ns进程>/root 读文件" "cat /proc/$PL/root/etc/hostname"
sibling_try "基线 /proc/<初始ns进程>/mem 打开" "dd if=/proc/$PL/mem of=/dev/null bs=1 count=1"
sibling_try "基线 /proc/<初始ns进程>/maps 读" "head -1 /proc/$PL/maps"
sibling_try "基线 /proc/<初始ns进程>/fd 列举" "ls /proc/$PL/fd"
run_outer holder runB
for i in $(seq 1 100); do grep -q "holder 就绪" "$R/holder.out" 2>/dev/null && break; sleep 0.2; done
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
WP=$(cat "$R/sleeper.pid" 2>/dev/null || echo 0)
DP=$(cat "$R/dumper.pid" 2>/dev/null || echo 0)
DFD=$(cat "$R/dumper.fd" 2>/dev/null || echo 0)
note "holder: $(head -1 "$R/holder.out" 2>/dev/null)  gocryptfs=$GP sleeper=$WP dumper(dumpable=0)=$DP fd=$DFD"
PIDS+=("$WP" "$DP")
sentinel_state "runB 挂载期间"
sibling_try "① 直接读 mnt/work/repo/secret.txt"   "cat '$V/mnt/work/repo/secret.txt'"
sibling_try "② /proc/<gocryptfs>/root 读明文"      "cat /proc/$GP/root$V/mnt/work/repo/secret.txt"
sibling_try "③ /proc/<sleeper>/root 读明文"        "cat /proc/$WP/root$V/mnt/work/repo/secret.txt"
sibling_try "④ /proc/<sleeper>/cwd 读明文"         "cat /proc/$WP/cwd/secret.txt"
sibling_try "⑤ /proc/<sleeper>/cwd readlink（路径泄露）" "readlink /proc/$WP/cwd"
sibling_try "⑥ /proc/<dumper>/fd/$DFD 打开"        "cat /proc/$DP/fd/$DFD"
sibling_try "⑦ /proc/<dumper>/fd/$DFD readlink"    "readlink /proc/$DP/fd/$DFD"
sibling_try "⑧ /proc/<gocryptfs>/mem 打开(offset0)" "dd if=/proc/$GP/mem of=/dev/null bs=1 count=1"
MOFF=$(bash -c "grep -m1 ' r-.xp ' /proc/$GP/maps 2>/dev/null | cut -d- -f1" 2>/dev/null || true)
if [ -n "${MOFF:-}" ]; then
  MOFFDEC=$((16#$MOFF))
  sibling_try "⑧b /proc/<gocryptfs>/mem 有效偏移 0x$MOFF" "dd if=/proc/$GP/mem bs=1 skip=$MOFFDEC count=8 2>&1 | od -An -tx1 | head -1"
fi
sibling_try "⑨ /proc/<dumpable=0>/root 读明文"     "cat /proc/$DP/root$V/mnt/work/repo/secret.txt"
sibling_try "⑩ nsenter --user --mount"             "nsenter --target $GP --user --mount true"
sibling_try "⑪ 读 /proc/<gocryptfs>/mountinfo"     "grep -c fuse.gocryptfs /proc/$GP/mountinfo"
note "⑫ setns PoC（模拟攻击者：同 uid join userns+mntns 后读明文）:"
GP="$GP" V="$V" python3 - <<'PY' 2>&1 | sed 's/^/    /'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
GP, V = os.environ["GP"], os.environ["V"]
def setns(path, nstype):
    fd = os.open(path, os.O_RDONLY)
    r = libc.syscall(308, fd, nstype)   # __NR_setns=308 (x86_64)
    if r != 0:
        print(f"setns {path} 失败 errno={ctypes.get_errno()}"); sys.exit(1)
try:
    setns(f"/proc/{GP}/ns/user", 0x10000000)   # CLONE_NEWUSER
    setns(f"/proc/{GP}/ns/mnt",  0x00020000)   # CLONE_NEWNS
    p = f"{V}/mnt/work/repo/secret.txt"
    print("join 成功，明文可见:", os.path.isfile(p), "内容:", open(p).read().strip()[:40])
except Exception as e:
    print("PoC 失败:", e)
PY
if command -v strace >/dev/null; then
  note "⑬ strace 证据（nsenter 的 setns 序列）:"
  strace -f -e trace=setns,setgroups nsenter --target "$GP" --user --mount true 2>&1 | grep -E "setns|setgroups" | sed 's/^/    /'
fi
ancestor_read "祖先读 /proc/<gocryptfs>/root 明文" "/proc/$GP/root$V/mnt/work/repo/secret.txt"
ancestor_read "祖先读 /proc/<dumpable=0>/root（缓解验证）" "/proc/$DP/root$V/mnt/work/repo/secret.txt"
echo "/proc/$GP/status（外部视角）: $(grep -E '^(Uid|Gid):' /proc/$GP/status 2>/dev/null | tr '\n' ' ' | tr -s '\t' ' ')"
echo "gocryptfs ns/mnt=$(readlink /proc/$GP/ns/mnt 2>&1)  主脚本自身=$(readlink /proc/self/ns/mnt)（不同＝ns 隔离生效）"
: > "$R/teardown"; sleep 2
k9 "$WP"; k9 "$DP"
note "runB 收尾: umount.rc=$(cat "$R/umount.rc" 2>/dev/null) gocryptfs.exit=$(cat "$R/gocryptfs.exit" 2>/dev/null) final=$(cat "$R/final.state" 2>/dev/null)"
sentinel_state "runB 收尾后"
verify_plain runB

# ───────────────── P7 外部 lock（TERM gocryptfs） ─────────────────
sec P7 "生命周期·外部 pi-secure lock（跨 ns 向 gocryptfs 发 SIGTERM）"
run_outer idle runC
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
wait_mounted runC; sentinel_state "runC 挂载期间"
kterm "$GP"; sleep 2
wait_file_value "$R/final.state" unmounted 20 || echo "runC 未收尾"
echo "runC: gocryptfs.exit=$(cat "$R/gocryptfs.exit" 2>/dev/null) final=$(cat "$R/final.state" 2>/dev/null)"
note "outer 输出: $(tail -3 "$R/outer-runC.out" 2>/dev/null | tr '\n' ' ')"
sentinel_state "runC lock 后"
verify_plain runC

# ───────────────── P8 pi-secure 被 SIGKILL（gocryptfs 成孤儿） ─────────────────
sec P8 "生命周期·监督者被 SIGKILL → gocryptfs 孤儿"
run_outer killme runD
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
wait_mounted runD; sleep 0.5
SP=$LAST_PGID
k9 "$SP"; sleep 1
echo "监督者(pgid $SP)已 SIGKILL；gocryptfs $GP: $(kill -0 $GP 2>/dev/null && echo 存活 || echo 已死)  ppid=$(awk '{print $4}' /proc/$GP/stat 2>/dev/null)"
sentinel_state "runD 孤儿期间"
sibling_try "孤儿期间 /proc/<gocryptfs>/root 读明文" "cat /proc/$GP/root$V/mnt/work/repo/secret.txt"
echo "外部收尾: kill -TERM $GP"; kterm "$GP"; PIDS+=("$GP"); sleep 2
sentinel_state "runD TERM 收尾后"
verify_plain runD

# ───────────────── P9 SIGKILL gocryptfs + ns 最后进程退出自动销毁 ─────────────────
sec P9 "生命周期·gocryptfs SIGKILL → ns 随最后进程退出自动销毁"
run_outer killme runE
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
wait_mounted runE; sleep 0.3
k9 "$GP"; PIDS+=("$GP"); sleep 1
echo "gocryptfs 已 KILL；监督者(pgid $LAST_PGID)状态: $(kill -0 $LAST_PGID 2>/dev/null && echo 存活 || echo 已退出)"
kterm "$LAST_PGID"; sleep 2
sentinel_state "runE 全部 ns 进程退出后"
echo "fuse connections: $(ls /sys/fs/fuse/connections 2>&1 | head -3)"
verify_plain runE

# ───────────────── P10 守护进程被困 ns（web-hub 模拟） ─────────────────
sec P10 "web-hub 模拟：ns 内拉起的守护继承挂载与 ns 引用"
run_outer holdns runF
for i in $(seq 1 60); do [ -s "$R/daemon.pid" ] && break; sleep 0.3; done
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
DM=$(cat "$R/daemon.pid" 2>/dev/null || echo 0)
PIDS+=("$DM" "$GP")
for i in $(seq 1 100); do kill -0 "$LAST_PGID" 2>/dev/null || break; sleep 0.2; done
echo "监督者已退出；残留: gocryptfs=$GP($(kill -0 $GP 2>/dev/null && echo 存活 || echo 死)) 模拟守护=$DM($(kill -0 $DM 2>/dev/null && echo 存活 || echo 死))"
echo "模拟守护 ns/mnt=$(readlink /proc/$DM/ns/mnt 2>&1) vs gocryptfs=$(readlink /proc/$GP/ns/mnt 2>&1)（相同＝同 ns，守护持有挂载视图）"
sentinel_state "runF 守护存活期间"
ancestor_read "守护继承 ns：祖先读 /proc/<守护>/root 明文" "/proc/$DM/root$V/mnt/work/repo/secret.txt"
sibling_try  "守护继承 ns：sibling 读 /proc/<守护>/root" "cat /proc/$DM/root$V/mnt/work/repo/secret.txt"
sibling_try  "守护继承 ns：sibling 经守护 cwd 读"       "cat /proc/$DM/cwd/secret.txt"
k9 "$DM"; kterm "$GP"; sleep 2
sentinel_state "runF 清理后"
verify_plain runF

# ───────────────── P11 外部 status 判定 ─────────────────
sec P11 "status 判定配方（pidfile + /proc 存活 + ns id 比对）"
run_outer idle runG
GP=$(cat "$R/gocryptfs.pid" 2>/dev/null || echo 0)
NSID=$(cat "$R/ns-mnt.id" 2>/dev/null)
wait_mounted runG
echo "pidfile: gocryptfs=$GP  ns-mnt.id=$NSID"
echo "运行中判定: kill -0 → $(kill -0 $GP 2>/dev/null && echo alive || echo dead)；ns id 比对 → $(readlink /proc/$GP/ns/mnt 2>/dev/null) $([ "$(readlink /proc/$GP/ns/mnt 2>/dev/null)" = "$NSID" ] && echo MATCH || echo MISMATCH)"
echo "外部旁进程读 /proc/<pid>/mountinfo 作为挂载 oracle: $(bash -c "grep -c fuse.gocryptfs /proc/$GP/mountinfo" 2>&1 | head -1)"
sentinel_state "runG 运行中"
kterm "$GP"; PIDS+=("$GP"); sleep 1.5
echo "gocryptfs 退出后: kill -0 → $(kill -0 $GP 2>/dev/null && echo alive || echo dead)（= status 可判 not-running）"

# ───────────────── 汇总 ─────────────────
sec SUMMARY "关键状态汇总"
for f in inner.rc umount.rc gocryptfs.exit final.state rootload.rc; do echo "$f: $(cat "$R/$f" 2>/dev/null || echo -)"; done
echo "探针目录 $T 由 trap 清理。逐项结论见 docs/dev/data-encryption/private-ns-probe.md"
