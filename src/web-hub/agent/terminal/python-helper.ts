/** Versioned fixed source; no disk script/pycache, dependencies or interpolated user text.
 * Linux Python stdlib only. All shell bytes travel through the PTY, never stderr/logs. */
export const TERMINAL_PYTHON_HELPER = String.raw`
import os, sys, time, json, base64, selectors, signal, fcntl, termios, struct, pwd, ctypes, errno, socket, re
VERSION = 1
CAP = 131072
sel = selectors.DefaultSelector()
for fd in (0, 1, 2): os.set_blocking(fd, False)
sel.register(0, selectors.EVENT_READ)
boot = open('/proc/sys/kernel/random/boot_id').read().strip()
uid = os.getuid()
def identity(pid, role='descendant'):
    try:
        text = open('/proc/%d/stat' % pid).read()
        fields = text[text.rfind(')')+2:].split()
        st = os.stat('/proc/%d' % pid)
        return dict(bootId=boot, pid=pid, starttime=fields[19], uid=st.st_uid,
                    sid=int(fields[3]), pgid=int(fields[2]), role=role), int(fields[1]), fields[0]
    except FileNotFoundError: return None

def capability():
    if not sys.platform.startswith('linux') or not hasattr(os, 'forkpty'): raise RuntimeError()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0: raise RuntimeError()
    value = ctypes.c_int(0)
    if libc.prctl(37, ctypes.byref(value), 0, 0, 0) != 0 or value.value != 1: raise RuntimeError()
    # Prove actual adoption+waitpid, not merely a successful prctl return.
    r, w = os.pipe2(os.O_CLOEXEC)
    p = os.fork()
    if p == 0:
        os.close(r)
        q = os.fork()
        if q == 0:
            os.close(w); time.sleep(.01); os._exit(23)
        os.write(w, str(q).encode()); os._exit(0)
    os.close(w)
    os.waitpid(p, 0)
    q = int(os.read(r, 32)); os.close(r)
    adopted, status = os.waitpid(q, 0)
    if adopted != q or os.waitstatus_to_exitcode(status) != 23: raise RuntimeError()

queue = bytearray()
stdout_alive = True
stdin_buf = bytearray()
config = None
master = None
shell = None
shell_sid = None
gate = None
execfd = None
execbuf = bytearray()
spawn_settled = False
ready = False
display = {}
closing = None
reason = 'exit'
known = {}
waited = []
scan_ok = True
scan_reason = None
shell_exit_at = None
shell_code = None
shell_signal = None
parent_beat = time.monotonic()
started = parent_beat
last_scan = 0
last_meta = 0
last_win = 0
input_buf = bytearray()
input_seq = None
stages = set()
rate_at = started
rate_bytes = 0
flood_at = None

def emit(obj, data=False):
    global stdout_alive
    if not stdout_alive: return
    line = (json.dumps(obj, separators=(',', ':'))+'\n').encode()
    if len(line) > 16384 or len(queue)+len(stdin_buf)+len(input_buf)+len(line) > (CAP-32768 if data else CAP):
        if not data: close('control-overflow')
        return
    queue.extend(line)
    try: sel.modify(1, selectors.EVENT_WRITE)
    except KeyError: sel.register(1, selectors.EVENT_WRITE)

def close(why):
    global closing, reason, master, gate, spawn_settled
    if closing is not None: return
    closing = time.monotonic(); reason = why
    input_buf.clear()
    if shell is None: spawn_settled = True
    if gate is not None:
        os.close(gate); gate = None
    if master is not None:
        try: sel.unregister(master)
        except Exception: pass
        os.close(master); master = None
    emit(dict(t='closing', reason=why))

def scan():
    global scan_ok, scan_reason
    begin = time.monotonic()
    rows = []
    try:
        names = os.listdir('/proc')
        pids = [int(n) for n in names if n.isdigit()]
        if len(pids) > 8192: raise RuntimeError("scan-budget")
        for pid in pids:
            if time.monotonic()-begin > .1: raise RuntimeError("scan-budget")
            row = identity(pid)
            if row: rows.append(row)
        descendants = {os.getpid()}
        for unused in range(32):
            old = len(descendants)
            for i, ppid, state in rows:
                if ppid in descendants: descendants.add(i['pid'])
            if len(descendants) == old: break
        else: raise RuntimeError()
        alive = []
        for i, ppid, state in rows:
            pid = i['pid']
            if pid == os.getpid(): continue
            if (shell_sid is not None and i['sid'] == shell_sid) or pid in descendants:
                i['role'] = 'shell' if pid == shell else ('background' if i['pgid'] != shell else 'descendant')
                if master is not None:
                    try:
                        if i['pgid'] == os.tcgetpgrp(master) and pid != shell: i['role'] = 'foreground'
                    except OSError: pass
                if (pid, i['starttime']) not in known and len(known) >= 255: raise RuntimeError()
                known[(pid, i['starttime'])] = i
                alive.append((i, state))
        if len(known) > 255: raise RuntimeError()
        return alive
    except Exception as error:
        scan_reason = ('scan-vanished' if isinstance(error, (FileNotFoundError, ProcessLookupError)) else
                       'scan-denied' if isinstance(error, PermissionError) else
                       'scan-budget' if isinstance(error, RuntimeError) and str(error) == 'scan-budget' else 'scan-invalid')
        scan_ok = False
        return None

def reap():
    global shell_code, shell_signal
    while True:
        try: pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError: break
        except InterruptedError: continue
        if pid == 0: break
        if len(waited) < 256: waited.append(pid)
        if pid == shell:
            c = os.waitstatus_to_exitcode(status)
            if c >= 0: shell_code = c
            else: shell_signal = signal.Signals(-c).name

def signal_rows(rows, sig):
    if rows is None: return
    groups = set()
    for i, state in rows:
        try:
            cur = identity(i['pid'])
            if not cur or any(cur[0][k] != i[k] for k in ('bootId','pid','starttime','uid','sid','pgid')): continue
            if i['pgid'] != os.getpgrp() and i['pgid'] not in groups:
                # Groups are session-scoped and each surviving member is identity checked.
                os.killpg(i['pgid'], signal.SIGCONT)
                os.killpg(i['pgid'], sig); groups.add(i['pgid'])
            os.kill(i['pid'], signal.SIGCONT); os.kill(i['pid'], sig)
        except ProcessLookupError: pass
        except Exception:
            global scan_ok
            scan_ok = False

def do_fork():
    global shell, shell_sid, master, gate, execfd, display
    record = config.get('fixture')
    if record is None:
        pw = pwd.getpwuid(uid)
        home, user, path = pw.pw_dir, pw.pw_name, pw.pw_shell
        kind = os.path.basename(path)
    else:
        if record['uid'] != uid or record['gid'] != os.getgid(): raise RuntimeError()
        home, user, path, kind = record['home'], 'terminal-fixture', record['shell'], record['shellKind']
    if kind not in ('bash', 'zsh') or not os.path.isabs(path) or not os.access(path, os.X_OK):
        emit(dict(t='error', code='E_BACKEND_CAPABILITY')); close('unsupported-shell'); return
    display = dict(shellName=kind, userLabel=user, hostLabel=socket.gethostname())
    env = dict(os.environ)
    env.update(HOME=home, USER=user, LOGNAME=user, SHELL=path, TERM='xterm-256color', COLORTERM='truecolor')
    if not os.path.isabs(home): raise RuntimeError()
    for k,v in env.items():
        if '\0' in v or len(v.encode()) > 8192 or re.search(r'://[^/\s]*@|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|\s)(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]+|AKIA[A-Z0-9]{16}|Bearer\s)', v): raise RuntimeError()
    if sum(len(k.encode())+len(v.encode())+2 for k,v in env.items()) > 32768: raise RuntimeError()
    r, w = os.pipe2(os.O_CLOEXEC)
    er, ew = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    pid, fd = os.forkpty()
    if pid == 0:
        try:
            os.close(w); os.close(er)
            # Control descriptors 0/1/2 now reference only the PTY slave. All other fds CLOEXEC.
            if os.read(r, 1) != b'x': os._exit(125)
            os.close(r)
            os.chdir(config['cwd'])
            argv = [path, '--login', '-i'] if kind == 'bash' else [path, '-l', '-i']
            os.execve(path, argv, env)
        except BaseException:
            try: os.write(ew, b'E')
            except OSError: pass
            os._exit(126)
    os.close(r); os.close(ew)
    shell, shell_sid, master, gate, execfd = pid, pid, fd, w, er
    os.set_blocking(fd, False)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', config['rows'], config['cols'], 0, 0))
    sel.register(fd, selectors.EVENT_READ)
    row = identity(pid, 'shell')
    if row: known[(pid, row[0]['starttime'])] = row[0]
    emit(dict(t='spawn', managed=list(known.values())))

def command(c):
    global config, parent_beat, input_seq, last_win
    op = c.get('op')
    if op == 'start' and config is None:
        config = c
        if not scan_ok:
            emit(dict(t='error', code='E_BACKEND_CAPABILITY', reason=scan_reason)); close('identity-unavailable'); return
        emit(dict(t='capable', version=VERSION, subreaper=True, adoptionExit=23))
        return
    if op == 'close': close('requested'); return
    if config is None or closing is not None: return
    if op == 'heartbeat': parent_beat = time.monotonic(); return
    if op == 'input':
        data = base64.b64decode(c['bytesB64'], validate=True)
        if len(data) > 4096 or len(input_buf)+len(data) > 32768 or input_seq is not None: raise RuntimeError()
        input_buf.extend(data); input_seq = c['seq']
        if c['kind'] == 'user': config['idleAt'] = time.monotonic()+config['inputIdleMs']/1000
    if op == 'resize' and master is not None:
        cols, rows = c['cols'], c['rows']
        if not 2 <= cols <= 500 or not 1 <= rows <= 200: raise RuntimeError()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        now = time.monotonic()
        if c.get('redraw') and now-last_win >= .5:
            group = os.tcgetpgrp(master)
            matches = scan()
            if matches is not None and any(i['pgid'] == group for i,s in matches): os.killpg(group, signal.SIGWINCH)
            last_win = now
        emit(dict(t='resized', seq=c['seq']))

try:
    capability()
except BaseException:
    try: os.write(1, b'{"t":"error","code":"E_BACKEND_CAPABILITY","reason":"subreaper"}\n')
    except OSError: pass
    os._exit(70)

while True:
    now = time.monotonic()
    reap()
    if config is None and now-started >= 3: close('startup-deadline')
    if config is not None:
        if 'idleAt' not in config:
            config['idleAt'] = now + config['inputIdleMs']/1000
            config['lifeAt'] = now + config['maxLifetimeMs']/1000
        if closing is None and (now-parent_beat >= 15 or now >= config['idleAt'] or now >= config['lifeAt']): close('deadline')
        if closing is None and not ready and now-started >= 3: close('startup-deadline')
        fixture = config.get('fixture') or {}
        if closing is None and shell is None and now-started >= fixture.get('startDelayMs', 0)/1000:
            try: do_fork()
            except BaseException:
                emit(dict(t='error', code='E_BACKEND_CAPABILITY')); close('spawn-failed')
        if closing is None and gate is not None and now-started >= (fixture.get('startDelayMs',0)+fixture.get('execDelayMs',0))/1000:
            os.write(gate, b'x'); os.close(gate); gate = None
        if execfd is not None:
            try:
                b = os.read(execfd, 16)
                execbuf.extend(b)
                if not b:
                    os.close(execfd); execfd = None; spawn_settled = True
                    if not execbuf and closing is None:
                        ready = True; emit(dict(t='ready', shellPid=shell, display=display))
                    elif closing is None: close('exec-failed')
            except BlockingIOError: pass
        if shell is not None and shell in waited and closing is None:
            if shell_exit_at is None: shell_exit_at = now
            if now-shell_exit_at >= .5: close('exit')
    if now-last_scan >= .1 or closing is not None:
        rows = scan(); last_scan = now
        if rows is None and closing is None:
            emit(dict(t='error', code='E_BACKEND_CAPABILITY', reason=scan_reason)); close('identity-unavailable')
        if now-last_meta >= 1 and closing is None:
            emit(dict(t='managed', managed=list(known.values()))); last_meta = now
        if closing is not None:
            age = now-closing
            for stage, after, sig in ((0,0,signal.SIGHUP),(1,1,signal.SIGTERM),(2,3,signal.SIGKILL)):
                if age >= after:
                    # Re-signal late adopted/forked descendants, never just the shell's pgid.
                    signal_rows(rows, sig)
                    stages.add(stage)
            reap()
            remaining = scan()
            if remaining == [] and spawn_settled and (shell is None or shell in waited):
                emit(dict(t='reaped', ptyClosed=master is None, spawnSettled=True, managedGroupsGone=scan_ok,
                          managed=list(known.values()), waited=waited, exitCode=shell_code, signal=shell_signal))
                break
            if age >= 5:
                emit(dict(t='incomplete', managed=list(known.values()), waited=waited)); break
    if now-rate_at >= 1:
        if rate_bytes >= 131072:
            if flood_at is None: flood_at = now
            elif now-flood_at >= 30: close('output-flood')
        else: flood_at = None
        rate_at = now; rate_bytes = 0
    if master is not None:
        events = (selectors.EVENT_READ if len(queue)+len(stdin_buf)+len(input_buf) < CAP-49152 and rate_bytes < 131072 else 0)
        if input_buf: events |= selectors.EVENT_WRITE
        try:
            if events: sel.modify(master, events)
            else: sel.unregister(master)
        except KeyError:
            if events: sel.register(master, events)
    for key, mask in sel.select(.05):
        fd = key.fd
        try:
            if fd == 0:
                b = os.read(0, 16384)
                if not b:
                    sel.unregister(0); close('parent-eof'); continue
                stdin_buf.extend(b)
                if len(stdin_buf) > 16384 or len(queue)+len(stdin_buf)+len(input_buf) > CAP: raise RuntimeError()
                count = 0
                while b'\n' in stdin_buf and count < 32:
                    line, _, rest = stdin_buf.partition(b'\n'); stdin_buf = bytearray(rest)
                    if len(line) > 16384: raise RuntimeError()
                    command(json.loads(line)); count += 1
            elif fd == 1:
                n = os.write(1, queue[:16384]); del queue[:n]
                if not queue: sel.unregister(1)
            elif fd == master:
                if mask & selectors.EVENT_WRITE:
                    n = os.write(master, input_buf); del input_buf[:n]
                    if not input_buf and input_seq is not None:
                        emit(dict(t='input', seq=input_seq)); input_seq = None
                if mask & selectors.EVENT_READ:
                    try: b = os.read(master, min(8192, 131072-rate_bytes))
                    except OSError as e:
                        if e.errno == errno.EIO: b = b''
                        else: raise
                    if b:
                        rate_bytes += len(b); emit(dict(t='data', bytesB64=base64.b64encode(b).decode()), data=True)
                    else: close('pty-eof')
        except (BlockingIOError, InterruptedError): pass
        except BrokenPipeError:
            if fd == 1:
                stdout_alive = False; queue.clear()
                try: sel.unregister(1)
                except Exception: pass
            close('pipe-eof')
        except BaseException: close('invalid-control')
# Bound the final control drain; never let an unread stdout pin cleanup.
end = time.monotonic()+.25
while queue and stdout_alive and time.monotonic() < end:
    try:
        n=os.write(1, queue[:16384]); del queue[:n]
    except BlockingIOError: time.sleep(.005)
    except OSError: break
os._exit(0 if scan_ok and spawn_settled else 71)
`;
