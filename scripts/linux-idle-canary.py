#!/usr/bin/env python3
"""Generate offline; --run is owner-only in an explicitly confirmed disposable Linux VM.

Never targets case-runner.service or the runner UID. No registration, network, apt or GitHub calls.
The helper's identity constants change; its admission algorithm is byte-for-byte preserved.
"""
import argparse
import datetime
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC"}
ACK = "I_HAVE_RESERVED_THIS_DISPOSABLE_VM"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def identities(token, uid):
    require(bool(re.fullmatch(r"[0-9a-f]{8}", token)), "id must be eight lowercase hex digits")
    require(61000 <= uid <= 61999, "disposable UID/GID must be in 61000..61999")
    name = "case-idle-canary-" + token
    return dict(token=token, uid=uid, name=name, unit=name + ".service", admit=name + "-admit.service",
                program="/opt/" + name, runtime="/run/" + name,
                cgroup="/sys/fs/cgroup/system.slice/" + name + ".service",
                admit_cgroup="/sys/fs/cgroup/system.slice/" + name + "-admit.service",
                evidence="/var/tmp/" + name + "-evidence")


def adapt(source, cfg):
    replacements = {
        "case-runner.service": cfg["unit"],
        "OWNED=/run/case-ci/idle-reset-freeze-owned": "OWNED=" + cfg["runtime"] + "/freeze-owned",
        "runner_uid=$(id -u runner)": "runner_uid=$(id -u " + cfg["name"] + ")",
        '[ "$(property User)" = runner ]': '[ "$(property User)" = ' + cfg["name"] + ' ]',
        # The idle allow-list's one Listener executable is the canary's native copy; /usr/bin/bash stays real.
        "/opt/actions-runner/bin/Runner.Listener)": cfg["program"] + "/Runner.Listener)",
        # The quiet period reads Worker logs here; the canary writes none, so it is always quiet.
        "DIAG=/opt/actions-runner/_diag": "DIAG=" + cfg["program"] + "/_diag",
    }
    text = source
    for old, new in replacements.items():
        require(old in text, "unrecognized source identity: " + old)
        text = text.replace(old, new)
    require(not re.search(r"case-runner\.service|id -u runner\b|/run/case-ci|/opt/actions-runner", text), "production identity remains")
    reverse = text
    for old, new in reversed(list(replacements.items())):
        reverse = reverse.replace(new, old)
    require(reverse == source, "adaptation changed more than identity constants")
    return text


# The canary's run.sh stand-in is Bash, like production, so the helper's real /usr/bin/bash allowance is
# exercised. It starts the one native Listener, then spawns what the harness asks for: a Worker, a job
# leftover or a second Listener executable. The control FIFO is opened read-write so it never blocks or EOFs.
LISTENER = r'''#!/bin/bash
set -u
root=$1 program=$2
"$program/Runner.Listener" 600 &
printf '%s\n' "$!" > "$root/listener-state/listener"
exec 3<>"$root/control"
printf '%s\n' "$$" > "$root/listener-state/ready"
while IFS= read -r line <&3; do
  case "$line" in
    spawn) "$program/Runner.Worker" 600 & ;;
    leftover) "$program/job-leftover" 600 & ;;
    listener) "$program/Runner.Listener" 600 & ;;
    *) continue ;;
  esac
  printf '%s\n' "$!" > "$root/listener-state/worker"
done
'''

# Scenarios whose process is visible before the probe: each must defer (3) without any freeze.
VISIBLE = {"before": ("spawn", "Runner.Worker"), "leftover": ("leftover", "job-leftover"),
           "second-listener": ("listener", "Runner.Listener")}
SCENARIOS = ["before", "leftover", "second-listener", "race", "sigkill", "idle", "timeout"]


def bundle(source, cfg):
    helper = adapt(source, cfg)
    runtime, program = cfg["runtime"], cfg["program"]
    # The wrapper obtains the *real* pgrep snapshot, then holds its return. It changes only timing.
    wrapper = f'''#!/bin/bash
set -eu
PATH=/usr/bin:/bin
ROOT={runtime}
wait_for_release() {{
  /usr/bin/python3 - "$1" <<'WAIT'
import os, sys, time
while not os.path.exists(sys.argv[1]): time.sleep(.01)
WAIT
}}
[ "$#" = 2 ] && [ "$1" = -u ] && [ "$2" = {cfg['uid']} ] || exit 2
set +e
pids=$({program}/pgrep.real "$@")
code=$?
set -e
count=$(cat "$ROOT/count")
count=$((count + 1))
printf '%s\\n' "$count" > "$ROOT/count"
phase=$(cat "$ROOT/phase")
if [ "$count" = 1 ]; then
  : > "$ROOT/first-snapshot"
  wait_for_release "$ROOT/release-first"
fi
if [ "$count" = 2 ] && {{ [ "$phase" = sigkill ] || [ "$phase" = timeout ]; }}; then
  : > "$ROOT/second-snapshot"
  wait_for_release "$ROOT/release-second"
fi
[ -z "$pids" ] || printf '%s\\n' "$pids"
exit "$code"
'''
    service = f'''[Unit]
Description=Disposable Case idle-reset canary {cfg['token']}
[Service]
User={cfg['name']}
Group={cfg['name']}
ExecStart=/bin/bash {program}/listener.sh {runtime} {program}
Restart=no
RestartForceExitStatus=
KillMode=process
Delegate=no
ProtectControlGroups=yes
'''
    # Bind is private to the root helper unit. Host pgrep and the canary worker's namespace do not change.
    admit = f'''[Unit]
Description=Disposable Case idle-reset admission {cfg['token']}
StartLimitIntervalSec=0
[Service]
Type=oneshot
User=root
PrivateMounts=yes
BindReadOnlyPaths={program}/pgrep-wrapper.sh:/usr/bin/pgrep
ExecStart=/bin/bash {program}/idle-reset.sh
ExecStopPost=/bin/bash {program}/idle-reset.sh thaw
KillMode=control-group
TimeoutStartSec=15
TimeoutStopSec=3
'''
    return {"idle-reset.sh": helper, "listener.sh": LISTENER, "pgrep-wrapper.sh": wrapper,
            cfg["unit"]: service, cfg["admit"]: admit}


def analyze_trace(text, cfg, phase):
    """Parse only successful writes and concrete reads/stats; ordering uses strace epoch timestamps."""
    events = []
    group = cfg["cgroup"]
    for line in text.splitlines():
        m = re.match(r"^(\d+\.\d+)\s+(.*)$", line)
        if not m:
            continue
        stamp, body = float(m[1]), m[2]
        write = re.search(r'write\(\d+<([^>]+)>, "([01])\\n", 2\)\s+= 2$', body)
        if write and write[1] in (group + "/cgroup.freeze", group + "/cgroup.kill"):
            events.append((stamp, "freeze" + write[2] if write[1].endswith("freeze") else "kill"))
        if group + "/cgroup.events" in body and '"populated 0\\n' in body and "read(" in body and re.search(r"\)\s+= [1-9][0-9]*$", body):
            events.append((stamp, "empty"))
        if "newfstatat(" in body and '"' + group + '"' in body and "ENOENT" in body:
            events.append((stamp, "removed"))
        if "execve(" in body and '"systemctl", "stop", "' + cfg["unit"] + '"' in body and "= 0" in body:
            events.append((stamp, "stop"))
    events.sort()
    kinds = [kind for _, kind in events]
    if phase == "idle":
        first = lambda kind: next((t for t, k in events if k == kind), None)
        freeze, kill, stop = first("freeze1"), first("kill"), first("stop")
        require(None not in (freeze, kill, stop) and freeze < kill < stop, "missing freeze/kill/stop syscall order")
        require(not any(k == "freeze0" and freeze < t < kill for t, k in events), "service thawed before idle kill")
        require(any(k in ("empty", "removed") and kill <= t < stop for t, k in events), "no empty/deleted proof before stop")
    else:
        require("kill" not in kinds and "stop" not in kinds, "busy/abnormal case killed or stopped the canary service")
        if phase in VISIBLE:
            require("freeze1" not in kinds, "already-visible busy process was paused")
        else:
            require("freeze1" in kinds, "race did not reach actual kernel freeze")
    return [{"time": t, "event": k} for t, k in events]


def cmd(args, check=True, timeout=20):
    result = subprocess.run(args, env=ENV, text=True, capture_output=True, timeout=timeout)
    if check:
        require(result.returncode == 0, "command failed: " + args[0] + " " + " ".join(args[1:3]) + ": " + result.stderr[:300])
    return result


def properties(unit, *names):
    result = cmd(["/usr/bin/systemctl", "show", unit] + ["--property=" + name for name in names], check=False)
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def wait_until(predicate, message, seconds=6):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.01)
    raise RuntimeError("timed out: " + message)


def pids(uid):
    result = cmd(["/usr/bin/pgrep", "-u", str(uid)], check=False)
    require(result.returncode in (0, 1), "cannot inspect disposable UID")
    return [int(value) for value in result.stdout.split()]


def member(pid):
    return Path(f"/proc/{pid}/cgroup").read_text().strip()


def frozen(cfg):
    group = Path(cfg["cgroup"])
    if not group.exists():
        return False
    return (group / "cgroup.freeze").read_text().strip() == "1"


def preflight(args, cfg, source):
    require(platform.system() == "Linux" and os.geteuid() == 0, "--run requires root in a disposable Linux VM")
    require(args.disposable_ack == ACK, "explicit disposable-VM acknowledgement required")
    machine = Path("/etc/machine-id").read_text().strip()
    require(bool(re.fullmatch(r"[0-9a-f]{32}", args.confirm_machine_id or "")) and args.confirm_machine_id == machine,
            "exact disposable machine-id confirmation required")
    require(platform.node().startswith("case-idle-canary-"), "hostname must start case-idle-canary-; production VMs refused")
    require(args.expected_sha256 == digest(source), "explicit reviewed helper SHA256 mismatch")
    require(cmd(["/usr/bin/systemd-detect-virt", "--vm"], check=False).returncode == 0, "VM detection required; containers/hosts refused")
    require(cmd(["/usr/bin/systemd-detect-virt", "--container"], check=False).returncode != 0, "containers refused, even inside a VM")
    require(properties("case-runner.service", "LoadState").get("LoadState") == "not-found", "real runner service present: refuse")
    require(not Path("/etc/systemd/system/case-runner.service").exists(), "production runner unit file present")
    require(not Path("/opt/actions-runner/.runner").exists() and not Path("/run/case-ci/firewall.ok").exists(), "production runner installation detected")
    require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "pidfd signal APIs required; never signal a recyclable bare PID")
    for name in ("program", "runtime", "evidence"):
        require(not Path(cfg[name]).exists(), "scratch path already exists: " + cfg[name])
    for name in (cfg["unit"], cfg["admit"]):
        require(properties(name, "LoadState").get("LoadState") == "not-found", "scratch unit already exists")
        require(not (Path("/etc/systemd/system") / name).exists(), "scratch unit file exists")
    require(all(item.pw_uid != cfg["uid"] and item.pw_name != cfg["name"] for item in pwd.getpwall()), "UID/user already exists")
    require(all(item.gr_gid != cfg["uid"] and item.gr_name != cfg["name"] for item in grp.getgrall()), "GID/group already exists")
    require(not pids(cfg["uid"]), "disposable UID already has processes, even without an account")
    for executable in ("/usr/bin/systemctl", "/usr/bin/strace", "/usr/bin/pgrep", "/usr/bin/sleep", "/usr/bin/python3",
                       "/usr/sbin/useradd", "/usr/sbin/groupadd", "/usr/sbin/userdel", "/usr/sbin/groupdel"):
        file = Path(executable)
        require(file.is_file() and os.access(file, os.X_OK), "missing prerequisite (no automatic install): " + executable)
        info = file.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "untrusted system executable: " + executable)
    for helper in (Path(args.helper), Path(__file__)):
        info = helper.stat()
        require(not helper.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022, "reviewed harness/helper must be root-owned, non-writable by others")


class Harness:
    def __init__(self, cfg, files):
        self.cfg, self.files = cfg, files
        self.created = {"program": False, "runtime": False, "group": False, "user": False, "units": []}
        self.results = []
        self.clients = []
        self.evidence_identity = None

    def owns_evidence(self):
        if self.evidence_identity is None:
            return False
        try:
            info = Path(self.cfg["evidence"]).lstat()
        except OSError:
            return False
        return (stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == 0
                and (info.st_dev, info.st_ino) == self.evidence_identity)

    def receipt(self):
        require(self.owns_evidence(), "refuse writes to unowned/replaced evidence directory")
        (Path(self.cfg["evidence"]) / "receipt.json").write_text(json.dumps({
            "identity": self.cfg, "created": self.created,
            "machine_id": Path("/etc/machine-id").read_text().strip(), "hostname": platform.node(),
            "file_sha256": {name: digest(text) for name, text in self.files.items()},
            "cleanup_scope": "Only these scratch units, cgroup, UID/GID and directories; no UID-wide kill"
        }, indent=2))

    def setup(self):
        c = self.cfg
        Path(c["evidence"]).mkdir(mode=0o700)
        info = Path(c["evidence"]).lstat()
        self.evidence_identity = (info.st_dev, info.st_ino)
        require(self.owns_evidence(), "new evidence directory is not root-owned mode 0700")
        self.receipt()
        for name in ("program", "runtime"):
            Path(c[name]).mkdir(mode=0o755)
            Path(c[name]).chmod(0o755)
            self.created[name] = True
            self.receipt()
        for name, text in self.files.items():
            target = Path(c["program"]) / name
            target.write_text(text)
            target.chmod(0o755 if name.endswith((".py", ".sh")) else 0o644)
        shutil.copyfile("/usr/bin/pgrep", Path(c["program"]) / "pgrep.real")
        # Native executables, so each has its real Linux exe and comm: Worker, Listener, and a job leftover.
        natives = ("Runner.Worker", "Runner.Listener", "job-leftover")
        for name in natives:
            shutil.copyfile("/usr/bin/sleep", Path(c["program"]) / name)
        for name in ("pgrep.real",) + natives:
            (Path(c["program"]) / name).chmod(0o755)
        cmd(["/usr/sbin/groupadd", "--gid", str(c["uid"]), c["name"]])
        self.created["group"] = True
        self.receipt()
        cmd(["/usr/sbin/useradd", "--system", "--uid", str(c["uid"]), "--gid", str(c["uid"]), "--no-create-home",
             "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", c["name"]])
        self.created["user"] = True
        self.receipt()
        state = Path(c["runtime"]) / "listener-state"
        state.mkdir(mode=0o700)
        os.chown(state, c["uid"], c["uid"])
        control = Path(c["runtime"]) / "control"
        # Group-writable only so the listener can hold it read-write; the canary UID can only ask itself to spawn.
        os.mkfifo(control, 0o660)
        os.chown(control, 0, c["uid"])
        os.chmod(control, 0o660)
        for name in (c["unit"], c["admit"]):
            path = Path("/etc/systemd/system") / name
            path.write_text(self.files[name])
            path.chmod(0o644)
            self.created["units"].append(name)
            self.receipt()
        cmd(["/usr/bin/systemctl", "daemon-reload"])
        for name in self.created["units"]:
            effective = properties(name, "User", "FragmentPath", "DropInPaths")
            require(effective.get("FragmentPath") == "/etc/systemd/system/" + name and effective.get("DropInPaths", "") == "", "unexpected effective unit/drop-in")
            require(effective.get("User") == (c["name"] if name == c["unit"] else "root"), "unexpected effective service UID")
        (Path(c["evidence"]) / "loaded-units.json").write_text(json.dumps({
            c["unit"]: properties(c["unit"], "User", "FragmentPath", "DropInPaths", "Restart", "RestartForceExitStatus", "Delegate", "ProtectControlGroups", "ExecStart"),
            c["admit"]: properties(c["admit"], "User", "Type", "PrivateMounts", "BindReadOnlyPaths", "ExecStart", "ExecStopPost", "TimeoutStartUSec", "TimeoutStopUSec")
        }, indent=2))

    def clean_case(self):
        c = self.cfg
        # Validate ownership before *any* stop/signal, including error cleanup.
        for name in self.created["units"]:
            path = Path("/etc/systemd/system") / name
            require(path.read_text() == self.files[name], "cleanup refuses changed unit file")
            expected = c["name"] if name == c["unit"] else "root"
            effective = properties(name, "User", "FragmentPath", "DropInPaths")
            require(effective.get("User") == expected, "cleanup refuses changed service identity")
            require(effective.get("FragmentPath") == "/etc/systemd/system/" + name and not effective.get("DropInPaths"), "cleanup refuses changed unit fragment/drop-ins")
        for name in ("release-first", "release-second"):
            if self.created["runtime"]:
                (Path(c["runtime"]) / name).touch()
        if c["admit"] in self.created["units"]:
            cmd(["/usr/bin/systemctl", "stop", c["admit"]], check=False)
        if c["unit"] in self.created["units"]:
            group = Path(c["cgroup"])
            live = properties(c["unit"], "ControlGroup").get("ControlGroup")
            if group.exists():
                require(live == "/system.slice/" + c["unit"], "cleanup refuses foreign cgroup identity")
                require(str(group.resolve()) == c["cgroup"], "cleanup refuses cgroup symlink")
                (group / "cgroup.freeze").write_text("0\n")
                # Only this exact disposable service tree is killed, never a UID-wide pkill.
                (group / "cgroup.kill").write_text("1\n")
            cmd(["/usr/bin/systemctl", "stop", c["unit"]], check=False)
        if self.created["user"]:
            wait_until(lambda: not pids(c["uid"]), "disposable service processes exit")
        if self.created["units"]:
            cmd(["/usr/bin/systemctl", "reset-failed"] + self.created["units"], check=False)

    def native(self, pid, name):
        c = self.cfg
        wait_until(lambda: Path(f"/proc/{pid}/comm").read_text().strip() == name, "native " + name + " comm")
        require(member(pid) == "0::/system.slice/" + c["unit"], "canary " + name + " escaped its cgroup")
        require(Path(f"/proc/{pid}/exe").resolve() == Path(c["program"]) / name, "wrong " + name + " executable")
        return pid

    def worker(self, request="spawn", name="Runner.Worker"):
        c = self.cfg
        file = Path(c["runtime"]) / "listener-state/worker"
        file.unlink(missing_ok=True)
        control = os.open(str(Path(c["runtime"]) / "control"), os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(control, request.encode() + b"\n")
        finally:
            os.close(control)
        wait_until(lambda: file.exists() and file.read_text().endswith("\n"), name + " PID")
        return self.native(int(file.read_text()), name)

    def idle_identity(self):
        """The idle allow-list's live inputs: the run.sh stand-in is real /usr/bin/bash, plus one Listener."""
        c, state = self.cfg, Path(self.cfg["runtime"]) / "listener-state"
        shell = int((state / "ready").read_text())
        require(member(shell) == "0::/system.slice/" + c["unit"], "canary listener escaped its cgroup")
        require(str(Path(f"/proc/{shell}/exe").resolve()) == "/usr/bin/bash", "the run.sh stand-in is not /usr/bin/bash on this image")
        wait_until((state / "listener").exists, "Listener PID")
        listener = self.native(int((state / "listener").read_text()), "Runner.Listener")
        require(sorted(pids(c["uid"])) == sorted([shell, listener]), "unexpected idle canary processes")

    def case(self, phase):
        c, root = self.cfg, Path(self.cfg["runtime"])
        self.clean_case()
        for name in ("first-snapshot", "second-snapshot", "release-first", "release-second", "freeze-owned"):
            (root / name).unlink(missing_ok=True)
        for path in (root / "listener-state").iterdir():
            path.unlink()
        for path in root.glob("trace*"):
            path.unlink()
        (root / "phase").write_text(phase)
        (root / "count").write_text("0\n")
        cmd(["/usr/bin/systemctl", "start", c["unit"]])
        wait_until(lambda: (root / "listener-state/ready").exists() and (root / "listener-state/ready").read_text().endswith("\n"), "listener ready")
        self.idle_identity()
        busy = VISIBLE.get(phase, ("spawn", "Runner.Worker"))
        worker = self.worker(*busy) if phase in VISIBLE else None
        client = subprocess.Popen(["/usr/bin/systemctl", "start", "--wait", c["admit"]], env=ENV,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.clients.append(client)
        killed_pid = None
        # Stop at the external pgrep snapshot before releasing the unmodified helper algorithm.
        wait_until((root / "first-snapshot").exists, "initial real pgrep snapshot")
        helper_pid = int(properties(c["admit"], "MainPID")["MainPID"])
        require(member(helper_pid) == "0::/system.slice/" + c["admit"], "refuse to trace foreign process")
        require(Path(f"/proc/{helper_pid}/exe").resolve().name == "bash", "helper is not Bash")
        argv = Path(f"/proc/{helper_pid}/cmdline").read_bytes().split(b"\0")
        require(str(Path(c["program"]) / "idle-reset.sh").encode() in argv, "wrong helper executable arguments")
        observer = subprocess.Popen(["/usr/bin/strace", "-ff", "-ttt", "-yy", "-s", "120", "-o", str(root / "trace"),
                                     "-e", "trace=openat,read,write,close,newfstatat,execve,exit_group", "-p", str(helper_pid)],
                                    env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.clients.append(observer)
        def attached():
            status = Path(f"/proc/{helper_pid}/status").read_text()
            return re.search(r"^TracerPid:\s+" + str(observer.pid) + r"$", status, re.MULTILINE) is not None
        wait_until(attached, "observer attaches to owned helper", seconds=2)
        if phase in ("race", "sigkill", "timeout"):
            worker = self.worker()
        (root / "release-first").touch()
        if phase in ("sigkill", "timeout"):
            wait_until((root / "second-snapshot").exists, "frozen inspection barrier")
            require(frozen(c), "helper barrier was reached without actual kernel freeze")
            require("frozen 1" in (Path(c["cgroup"]) / "cgroup.events").read_text(), "no kernel frozen ACK")
            if phase == "sigkill":
                killed_pid = helper_pid
                descriptor = os.pidfd_open(killed_pid)
                try:
                    require(member(killed_pid) == "0::/system.slice/" + c["admit"], "refuse to signal foreign process")
                    require(Path(f"/proc/{killed_pid}/exe").resolve().name == "bash", "refuse to signal non-helper process")
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                finally:
                    os.close(descriptor)
                # The manager sees the real helper MainPID die; the observer is outside its unit.
                (root / "release-second").touch()
        out, err = client.communicate(timeout=23 if phase == "timeout" else 9)
        observer_out, observer_err = observer.communicate(timeout=4)
        info = properties(c["admit"], "Result", "ExecMainStatus", "ExecStopPost", "ActiveState")
        if phase == "idle":
            require(client.returncode == 0, "idle admission failed: " + err)
            require(not pids(c["uid"]), "idle unit still has processes")
            require(properties(c["unit"], "ActiveState").get("ActiveState") == "inactive", "idle unit not inactive")
        else:
            require(client.returncode != 0 and info.get("Result") != "success", "failed/busy case reported successful admission")
            require(Path(f"/proc/{worker}/comm").read_text().strip() == busy[1], "busy process was interrupted")
            require(not frozen(c), "worker remains frozen")
            if phase in VISIBLE or phase == "race":
                require(info.get("ExecMainStatus") == "3" and info.get("Result") == "exit-code", "helper did not report busy")
            if phase == "sigkill":
                require(re.search(r"code=exited.*status=0", info.get("ExecStopPost", "")), "independent cleanup did not succeed")
            if phase == "timeout":
                require(info.get("Result") == "timeout", "timeout scenario did not time out")
        require(not (root / "freeze-owned").exists(), "freeze ownership marker remains")
        trace = "\n".join(path.read_text(errors="replace") for path in root.glob("trace*"))
        require((root / ("trace." + str(helper_pid))).is_file() and trace, "missing actual helper observation trace")
        order = analyze_trace(trace, c, phase)
        require(self.owns_evidence(), "refuse result writes to unowned/replaced evidence directory")
        destination = Path(c["evidence"]) / phase
        destination.mkdir(mode=0o700)
        for path in root.glob("trace*"):
            shutil.copyfile(path, destination / path.name)
        result = dict(phase=phase, status="PASS", worker_pid=worker, helper_pid=helper_pid, observer_pid=observer.pid,
                      killed_helper_pid=killed_pid, observer_returncode=observer.returncode, observer_stderr=observer_err,
                      returncode=client.returncode, unit=info, kernel_events=order, stdout=out, stderr=err)
        (destination / "result.json").write_text(json.dumps(result, indent=2))
        (destination / "journal.txt").write_text(cmd(["/usr/bin/journalctl", "--unit=" + c["admit"], "--no-pager", "--lines=150"], check=False).stdout)
        self.results.append(result)

    def capture_failure(self, phase, error):
        require(self.owns_evidence(), "refuse failure capture in unowned/replaced evidence directory")
        c, root = self.cfg, Path(self.cfg["runtime"])
        destination = Path(c["evidence"]) / (phase or "setup-failure")
        destination.mkdir(mode=0o700, exist_ok=True)
        for path in root.glob("trace*"):
            if path.is_file():
                shutil.copyfile(path, destination / path.name)
        record = {"error": error, "created": self.created}
        for unit in self.created["units"]:
            record[unit] = properties(unit, "ActiveState", "Result", "ExecMainStatus", "ExecStopPost", "ControlGroup", "User")
        (destination / "failure.json").write_text(json.dumps(record, indent=2))
        if self.created["units"]:
            (destination / "journal.txt").write_text(cmd(["/usr/bin/journalctl", "--unit=" + c["admit"], "--no-pager", "--lines=150"], check=False).stdout)

    def cleanup(self):
        self.clean_case()
        for client in self.clients:
            client.communicate(timeout=5)
        c = self.cfg
        for name in self.created["units"]:
            path = Path("/etc/systemd/system") / name
            require(path.read_text() == self.files[name], "cleanup refuses changed unit file")
            path.unlink()
        if self.created["units"]:
            cmd(["/usr/bin/systemctl", "daemon-reload"])
        if self.created["user"]:
            require(pwd.getpwnam(c["name"]).pw_uid == c["uid"] and not pids(c["uid"]), "cleanup refuses changed/busy UID")
            cmd(["/usr/sbin/userdel", c["name"]])
        if self.created["group"]:
            # userdel policy can already have removed the same-name private group.
            try:
                group = grp.getgrnam(c["name"])
            except KeyError:
                group = None
            if group is not None:
                require(group.gr_gid == c["uid"], "cleanup refuses changed group")
                cmd(["/usr/sbin/groupdel", c["name"]])
        for name in ("runtime", "program"):
            if self.created[name]:
                require(str(Path(c[name]).resolve()) == c[name], "cleanup refuses scratch path symlink")
                shutil.rmtree(c[name])



def load_recovery_receipt(cfg, files, machine_id):
    """Only a root-private, genuine receipt may grant cleanup ownership after harness death."""
    evidence = Path(cfg["evidence"])
    info = evidence.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "recovery refuses untrusted evidence directory")
    receipt = evidence / "receipt.json"
    info = receipt.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            "recovery refuses untrusted receipt file")
    record = json.loads(receipt.read_text())
    require(isinstance(record, dict), "invalid receipt document")
    require(record.get("identity") == cfg and record.get("machine_id") == machine_id, "receipt identity mismatch")
    require(record.get("file_sha256") == {name: digest(text) for name, text in files.items()}, "reviewed bundle changed")
    created = record.get("created")
    require(isinstance(created, dict) and set(created) == {"program", "runtime", "group", "user", "units"}, "invalid ownership schema")
    require(all(type(created[key]) is bool for key in ("program", "runtime", "group", "user")), "invalid ownership booleans")
    units = created["units"]
    require(isinstance(units, list) and all(isinstance(name, str) for name in units)
            and len(units) == len(set(units)) and set(units) <= {cfg["unit"], cfg["admit"]}, "foreign/invalid units in receipt")
    return dict(created, units=list(units))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True, help="reviewed output of: /bin/bash scripts/setup-case-linux-runner.sh idle-reset")
    parser.add_argument("--id")
    parser.add_argument("--uid", type=int, default=61234)
    parser.add_argument("--emit-dir")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--confirm-machine-id")
    parser.add_argument("--disposable-ack")
    args = parser.parse_args(argv)
    source = Path(args.helper).read_text()
    token = args.id or uuid.uuid4().hex[:8]
    cfg = identities(token, args.uid)
    files = bundle(source, cfg)
    manifest = dict(mode="RUN" if args.run else "OFFLINE PLAN", identity=cfg, helper_sha256=digest(source),
                    adapted_helper_sha256=digest(files["idle-reset.sh"]), scenarios=SCENARIOS,
                    warning="No live proof until owner executes in a confirmed disposable VM; never targets real runner service or UID",
                    coverage={"scope": "seven-scenario compatibility canary, not complete unattended-reset qualification",
                              "pending_live": ["frozen-inspection/read failure", "wrong identity/delegation/permissions/forced restart"],
                              "factory_reset_exercised": False})
    if not args.run:
        if args.emit_dir:
            directory = Path(args.emit_dir)
            directory.mkdir(mode=0o700)
            for name, text in files.items():
                (directory / name).write_text(text)
            (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(json.dumps(manifest, indent=2))
        return 0
    require(args.id is not None and args.emit_dir is None, "--run requires explicit reviewed --id and no --emit-dir")
    preflight(args, cfg, source)
    manifest["host"] = {"hostname": platform.node(), "kernel": platform.release(), "machine_id": args.confirm_machine_id,
                        "python": platform.python_version()}
    harness = Harness(cfg, files)
    def interrupted(signum, frame):
        raise RuntimeError("owner harness interrupted by signal " + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    error, cleanup_error, phase = None, None, None
    try:
        harness.setup()
        for phase in manifest["scenarios"]:
            harness.case(phase)
    except BaseException as exc:
        error = str(exc)
        if harness.owns_evidence():
            try:
                harness.capture_failure(phase, error)
            except BaseException as capture_error:
                error += "; failure capture: " + str(capture_error)
    finally:
        try:
            harness.cleanup()
        except BaseException as exc:
            cleanup_error = str(exc)
        manifest.update(results=harness.results, error=error, cleanup_error=cleanup_error,
                        captured_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        complete=not error and not cleanup_error and len(harness.results) == len(SCENARIOS))
        if harness.owns_evidence():
            (Path(cfg["evidence"]) / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(json.dumps(manifest, indent=2))
    return 0 if manifest["complete"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as exc:
        print("REFUSED: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
