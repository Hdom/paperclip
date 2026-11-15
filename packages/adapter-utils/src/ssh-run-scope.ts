import { isDeepStrictEqual } from "node:util";

/** Private controller-issued execution ownership, never an isolation boundary
 * between programs sharing the SSH login. Persisted with its exact lease. */
export interface SshRunScope {
  schema: "paperclip.ssh-run-scope.v1";
  companyId: string;
  runId: string | null;
  leaseId: string;
  generation: string;
  bootId: string;
}
export interface SshRunScopeStop {
  owner: SshRunScope;
  phase: "stopped";
  waitProof: "ECHILD_WALL";
  admissionClosed: true;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseSshRunScope(value: unknown): SshRunScope {
  const owner = value as SshRunScope | null;
  if (!owner || Object.keys(owner).sort().join(",") !== "bootId,companyId,generation,leaseId,runId,schema" ||
      owner.schema !== "paperclip.ssh-run-scope.v1" ||
      ![owner.bootId, owner.companyId, owner.leaseId, owner.generation].every(id => typeof id === "string" && uuid.test(id)) ||
      (owner.runId !== null && (typeof owner.runId !== "string" || !uuid.test(owner.runId)))) {
    throw new Error("ssh_run_scope_unverified");
  }
  return Object.freeze({ ...owner });
}
export function verifiedSshRunScopeStop(owner: SshRunScope, value: unknown): SshRunScopeStop {
  parseSshRunScope(owner);
  const expected: SshRunScopeStop = { owner, phase: "stopped", waitProof: "ECHILD_WALL", admissionClosed: true };
  if (!isDeepStrictEqual(value, expected)) throw new Error("ssh_run_scope_unverified");
  return expected;
}
const quote = (text: string) => "'" + text.replace(/'/g, `'"'"'`) + "'";
export function sshRunScopeControl(mode: "prepare" | "stop", owner: SshRunScope): string {
  parseSshRunScope(owner);
  return `python3 -c ${quote(SSH_RUN_SUPERVISOR_SOURCE)} ${mode} ${quote(JSON.stringify(owner))}`;
}
export function supervisedSshCommand(scope: SshRunScope | undefined, script: string): string {
  if (!scope) return script;
  parseSshRunScope(scope);
  return `python3 -c ${quote(SSH_RUN_SUPERVISOR_SOURCE)} exec ${quote(JSON.stringify(scope))} ${quote(JSON.stringify(["sh", "-c", script]))}`;
}
export function sshRunScopeProbe(workspace: string): string {
  return `python3 -c ${quote(SSH_RUN_SUPERVISOR_SOURCE)} probe ${quote(workspace)}`;
}

export const SSH_RUN_SUPERVISOR_SOURCE = String.raw`"""Linux-only per-lease SSH command owner. No command/environment is persisted.

The authenticated SSH user is the trust boundary. This is process ownership,
not isolation from other programs running under that same user identity.
"""
import array
import ctypes
import errno
import json
import os
import pathlib
import pwd
import resource
import selectors
import signal
import socket
import stat
import sys
import time

PROTOCOL = 'paperclip.ssh-run-scope.v1'
WALL = 0x40000000
MAX_PACKET = 256 * 1024
MAX_SCOPES = 10000


def reject():
    raise RuntimeError('ssh_run_scope_unverified')


def identity(value):
    import re
    if not isinstance(value, dict) or value.get('schema') != PROTOCOL:
        reject()
    for key in ('companyId', 'leaseId', 'generation', 'bootId'):
        if not re.fullmatch('[a-f0-9-]{36}', str(value.get(key, ''))):
            reject()
    if value.get('runId') is not None and not re.fullmatch('[a-f0-9-]{36}', str(value['runId'])):
        reject()
    if pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() != value['bootId']:
        reject()
    if set(value) != {'schema', 'companyId', 'runId', 'leaseId', 'generation', 'bootId'}:
        reject()
    return value


def secure(path, directory=False):
    s = path.lstat()
    if s.st_uid != os.getuid() or s.st_mode & 0o077 or path.is_symlink():
        reject()
    if directory:
        if not stat.S_ISDIR(s.st_mode):
            reject()
    elif not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > MAX_PACKET:
        reject()


def scope_root():
    home = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)
    if home.resolve() != home or home.stat().st_uid != os.getuid() or home.stat().st_mode & 0o022:
        reject()
    root = home
    for part in ('.local', 'state', 'paperclip'):
        root = root / part
        root.mkdir(mode=0o700, exist_ok=True)
        s = root.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o022 or root.is_symlink():
            reject()
    root = root / 'ssh-scopes-v1'
    root.mkdir(mode=0o700, exist_ok=True)
    secure(root, True)
    return root


def paths(owner):
    root = scope_root()
    return root, root / owner['leaseId']


def read_state(folder):
    secure(folder, True)
    path = folder / 'state.json'
    secure(path)
    return json.loads(path.read_text())


def write_state(folder, owner, phase):
    value = {'owner': owner, 'phase': phase}
    if phase == 'stopped':
        value.update(waitProof='ECHILD_WALL', admissionClosed=True)
    path = folder / 'state.next'
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path, folder / 'state.json')
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return value


def response(connection, value):
    try:
        connection.send(json.dumps(value).encode())
    except OSError:
        pass
    finally:
        connection.close()


def exchange(folder, message, descriptors=()):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    client.settimeout(20 if message['kind'] != 'exec' else None)
    try:
        client.connect(str(folder / 'control.sock'))
        data = json.dumps(message).encode()
        if len(data) > MAX_PACKET:
            reject()
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', descriptors))] if descriptors else []
        client.sendmsg([data], ancillary)
        data, _, flags, _ = client.recvmsg(MAX_PACKET)
        if flags & socket.MSG_TRUNC:
            reject()
        return json.loads(data)
    finally:
        client.close()


def establish_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0):
        reject()
    current = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(current), 0, 0, 0) or current.value != 1:
        reject()
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        reject()
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def kill_owned_children():
    # Discovery is used only for signalling, never as the completion predicate.
    for text in pathlib.Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().split():
        pid = int(text)
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            fields = pathlib.Path('/proc/' + text + '/stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) != os.getpid():
                continue
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
        finally:
            os.close(fd)


def serve(folder, owner):
    os.setsid()
    null = os.open('/dev/null', os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)
    establish_subreaper()
    # Clone children may select another exit signal (or no signal). Do not let
    # an ordinary notification kill the sole waiter. Spawned commands restore
    # the normal unblocked mask before exec. SIGKILL remains unmaskable.
    signal.pthread_sigmask(signal.SIG_BLOCK, signal.valid_signals() - {
        signal.SIGCHLD, signal.SIGTERM, signal.SIGKILL, signal.SIGSTOP})
    selector = selectors.DefaultSelector()
    read_fd, write_fd = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    signal.set_wakeup_fd(write_fd)
    # A handler (not SIG_IGN/SA_NOCLDWAIT) preserves waitable children.
    signal.signal(signal.SIGCHLD, lambda *_: None)
    signal.signal(signal.SIGTERM, lambda *_: None)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    server.bind(str(folder / 'control.sock'))
    server.listen(32)
    selector.register(server, selectors.EVENT_READ, 'accept')
    selector.register(read_fd, selectors.EVENT_READ, 'signal')
    jobs = {}
    pending = set()
    stop_clients = []
    closing = False
    deadline = None
    write_state(folder, owner, 'open')

    def reap():
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG | WALL)
            except ChildProcessError:
                return True
            if pid == 0:
                return False
            connection = jobs.pop(pid, None)
            if connection:
                response(connection, {'exitCode': os.waitstatus_to_exitcode(status)})

    while True:
        if closing:
            kill_owned_children()
            if reap():
                stopped = write_state(folder, owner, 'stopped')
                for connection in stop_clients:
                    response(connection, stopped)
                for connection in pending:
                    response(connection, {'error': 'ssh_run_scope_closed'})
                server.close()
                return
        else:
            reap()
        # Bounded polling is confined to an active Stop obligation: clone(2)
        # can suppress SIGCHLD, so notification alone cannot drive its wait.
        timeout = min(0.05, max(0, deadline - time.monotonic())) if deadline else None
        for key, _ in selector.select(timeout):
            if key.data == 'accept':
                connection, _ = server.accept()
                connection.setblocking(False)
                # Bound incomplete clients. They cannot hold an idle timer.
                if len(pending) >= 32:
                    connection.close()
                else:
                    pending.add(connection)
                    selector.register(connection, selectors.EVENT_READ, 'request')
            elif key.data == 'signal':
                try:
                    signals = os.read(read_fd, 4096)
                except BlockingIOError:
                    signals = b''
                if signal.SIGTERM in signals and not closing:
                    closing = True
                    write_state(folder, owner, 'closing')
                    deadline = time.monotonic() + 15
            else:
                connection = key.fileobj
                selector.unregister(connection)
                pending.discard(connection)
                received = []
                try:
                    data, ancillary, flags, _ = connection.recvmsg(MAX_PACKET, socket.CMSG_SPACE(3 * array.array('i').itemsize))
                    for level, kind, body in ancillary:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            values = array.array('i')
                            values.frombytes(body[:len(body) - len(body) % values.itemsize])
                            received.extend(values)
                    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                        reject()
                    message = json.loads(data)
                    if message.get('owner') != owner:
                        reject()
                    if message['kind'] == 'stop':
                        if not closing:
                            write_state(folder, owner, 'closing')
                            closing = True
                        deadline = time.monotonic() + 15
                        stop_clients.append(connection)
                    elif message['kind'] == 'ping' and not closing:
                        response(connection, {'owner': owner, 'phase': 'open'})
                    elif message['kind'] == 'exec' and not closing:
                        argv = message['argv']
                        if len(received) != 3 or not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
                            reject()
                        pid = os.fork()
                        if pid == 0:
                            try:
                                signal.set_wakeup_fd(-1)
                                for sig in (signal.SIGCHLD, signal.SIGTERM, signal.SIGINT):
                                    signal.signal(sig, signal.SIG_DFL)
                                signal.pthread_sigmask(signal.SIG_SETMASK, [])
                                for target, source in enumerate(received):
                                    os.dup2(source, target)
                                os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
                                os.execvp(argv[0], argv)
                            finally:
                                os._exit(126)
                        jobs[pid] = connection
                    else:
                        response(connection, {'error': 'ssh_run_scope_closed'})
                except Exception:
                    response(connection, {'error': 'ssh_run_scope_unverified'})
                finally:
                    for fd in received:
                        os.close(fd)
        if deadline and time.monotonic() >= deadline:
            for connection in stop_clients:
                response(connection, {'error': 'ssh_run_scope_stop_pending'})
            stop_clients.clear()
            deadline = None
            # Stay closed and wake on child exit or an explicit Stop retry.


def main():
    os.umask(0o077)
    mode = sys.argv[1]
    if mode == 'probe':
        establish_subreaper()
        if sum(1 for _ in scope_root().iterdir()) >= MAX_SCOPES:
            raise RuntimeError('ssh_run_scope_history_capacity')
        print(json.dumps({'schema': PROTOCOL, 'bootId': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'remoteCwd': os.path.abspath(sys.argv[2])}))
        return
    owner = identity(json.loads(sys.argv[2]))
    root, folder = paths(owner)
    if mode == 'prepare':
        try:
            if sum(1 for _ in root.iterdir()) >= MAX_SCOPES:
                raise RuntimeError('ssh_run_scope_history_capacity')
            folder.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            write_state(folder, owner, 'preparing')
            pid = os.fork()
            if pid == 0:
                try:
                    serve(folder, owner)
                finally:
                    os._exit(0)
        for _ in range(100):
            state = read_state(folder)
            if state['owner'] != owner or state['phase'] in ('closing', 'stopped'):
                reject()
            try:
                value = exchange(folder, {'kind': 'ping', 'owner': owner})
                if value == {'owner': owner, 'phase': 'open'}:
                    print(json.dumps(value))
                    return
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            time.sleep(0.02)
        reject()
    else:
        state = read_state(folder)
        if state['owner'] != owner:
            reject()
        if mode == 'stop' and state == {'owner': owner, 'phase': 'stopped', 'waitProof': 'ECHILD_WALL', 'admissionClosed': True}:
            value = state
        else:
            if state['phase'] != 'open' and mode != 'stop':
                reject()
            message = {'kind': mode, 'owner': owner}
            if mode == 'exec':
                message['argv'] = json.loads(sys.argv[3])
            value = exchange(folder, message, (0, 1, 2) if mode == 'exec' else ())
        if mode == 'exec':
            code = value.get('exitCode')
            if type(code) is not int:
                reject()
            sys.exit(code if code >= 0 else 128 - code)
        if mode == 'stop' and (value != {'owner': owner, 'phase': 'stopped', 'waitProof': 'ECHILD_WALL', 'admissionClosed': True} or type(value.get('admissionClosed')) is not bool):
            reject()
        print(json.dumps(value))


try:
    main()
except Exception as error:
    # No command arguments, environment, filesystem path or credential in errors.
    print('ssh_run_scope_history_capacity' if str(error) == 'ssh_run_scope_history_capacity' else 'ssh_run_scope_unverified', file=sys.stderr)
    sys.exit(125)
`;
