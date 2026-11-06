#!/bin/bash
# scripts/setup-case-linux-runner.sh — Case's Linux CI runners in Lima VMs on the Mac mini (CASE-261).
# Design, isolation, residual risks and the qualification run: docs/CI-RUNNERS.md.
#
#   bash scripts/setup-case-linux-runner.sh plan                       no sudo: what install creates
#   bash scripts/setup-case-linux-runner.sh template N                 no sudo: slot N's Lima YAML (with the
#                                                                      guest provisioning and firewall)
#   bash scripts/setup-case-linux-runner.sh hook started|completed     no sudo: a guest job hook
#   bash scripts/setup-case-linux-runner.sh idle-reset                 no sudo: root guest reset admission
#   bash scripts/setup-case-linux-runner.sh supervisor                 no sudo: the host supervisor (3 slots)
#   sudo /bin/bash <root-owned copy> install [--instances N]           create or repair (idempotent)
#   sudo /bin/bash <root-owned copy> probe                             re-run the isolation probes
#   sudo /bin/bash <root-owned copy> uninstall                         remove everything install made
#
# Julian runs the sudo forms from a root-owned copy of the reviewed file on main (docs/CI-RUNNERS.md §Install).
# Root runs only system binaries and never Lima itself: every limactl call runs as the `case-runner` account.
# Registration: config.sh asks for the token inside the VM on Julian's terminal; this script never reads,
# stores, passes or prints it.
#
# What install makes:
#   - a hidden, non-admin, no-login macOS account `case-runner` (own group, home outside the people's homes);
#     the owner's home goes to mode 700;
#   - one Lima VM per slot (Ubuntu 24.04 arm64, Apple Virtualization.framework, `plain: true`: no mounts,
#     no port forwards, no guest agent, no containerd, no Rosetta, no agent forwarding), provisioned with
#     Postgres 16, the Playwright browsers and their system packages, and the pinned Actions runner as an
#     unprivileged `runner` user without sudo, behind a root-owned nftables firewall that blocks the host
#     and every private network;
#   - one LaunchDaemon (`caffeinate -s`, ProcessType Interactive) running a supervisor as `case-runner`
#     that keeps each VM and its runner up and factory-resets each idle VM once a night.
# Nothing routes to the runners until Julian sets CASE_*_RUNNER=case-linux (docs/CI-RUNNERS.md §Activate).
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

REPO_URL=https://github.com/julianjming-hash/case
RUNNER_USER=case-runner
RUNNER_GROUP=case-runner
# Directory-service record root (not a filesystem path). The service home lives outside it.
DS_USERS=/Users
RUNNER_HOME=/private/var/$RUNNER_USER
LIMA_HOME_DIR=$RUNNER_HOME/.lima
STATE_HOME=$RUNNER_HOME/state
LIMACTL=/opt/homebrew/bin/limactl
LABEL=case-linux
INSTANCE_PREFIX=case-linux
DEFAULT_INSTANCES=3
MAX_INSTANCES=4
FIRST_ID=600
VM_CPUS=4
VM_MEMORY=6GiB
VM_DISK=40GiB
# Local hour for the nightly factory reset (the mini runs on Perth time; 03:00 is 19:00 UTC).
REBUILD_HOUR=03
# Ubuntu 24.04 arm64 cloud image, release 20260926 (SHA256SUMS read 2026-10-15).
IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img
IMAGE_SHA256=1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55
# Actions runner v2.338.0 linux-arm64 (release notes and API digest, read 2026-10-15).
RUNNER_VERSION=2.338.0
RUNNER_SHA256=628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b
# Node 22 for provisioning only (jobs use actions/setup-node); nodejs.org SHASUMS256, read 2026-10-15.
NODE_VERSION=22.23.3
NODE_SHA256=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
# Must equal package.json's @playwright/test (tests/setup-case-linux-runner.test.mjs checks it).
PLAYWRIGHT_VERSION=1.63.0
LIBEXEC=/usr/local/libexec/case-ci
LOG_DIR=/private/var/log/case-ci
STATE_DIR=/private/var/db/case-ci
DAEMON_LABEL=app.iatrogenic.case-linux-supervisor
PLIST=/Library/LaunchDaemons/$DAEMON_LABEL.plist
MIN_FREE_GB=60
# The supervisor takes every runner offline below this much free host disk (VM disks grow between resets).
MIN_HOST_FREE_GB=30
# A free host loopback port for the firewall's known-answer probe.
PROBE_PORT=47311
# Inside the guest: no network or host-shared filesystem is mounted. Judged on OUTPUT, never on exit
# status: Ubuntu 24.04's findmnt exits 0 with no match for this -t list, so `! findmnt` failed a VM
# with no mounts (Julian's first install). /proc/mounts is checked too, and must be readable.
MOUNT_CHECK='[ -z "$(findmnt -rn -t virtiofs,9p,fuse.sshfs,nfs,nfs4,cifs,smb3 2>/dev/null)" ] && [ -r "${MOUNTS:-/proc/mounts}" ] && [ -z "$(grep -E "^[^ ]+ [^ ]+ (virtiofs|9p|fuse\.sshfs|nfs|nfs4|cifs|smb3) " "${MOUNTS:-/proc/mounts}")" ]'

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
instance_of() { echo "$INSTANCE_PREFIX-$1"; }

plan() {
  local n="$1" slot=1
  say "account       $RUNNER_USER (hidden, non-admin, no login shell, primary group $RUNNER_GROUP, uid/gid >= $FIRST_ID)"
  say "home          $RUNNER_HOME (700); LIMA_HOME $LIMA_HOME_DIR; the owner's home is set to 700"
  say "vm            Ubuntu 24.04 arm64, vz, plain mode, $VM_CPUS vCPU, $VM_MEMORY, $VM_DISK disk each"
  say "image         $IMAGE_URL sha256 $IMAGE_SHA256"
  say "runner        v$RUNNER_VERSION linux-arm64 sha256 $RUNNER_SHA256, guest user runner (no sudo)"
  say "labels        self-hosted, Linux, ARM64, $LABEL"
  say "supervisor    $DAEMON_LABEL (as $RUNNER_USER), factory reset of each idle VM at $REBUILD_HOUR:00 local"
  say "logs          $LOG_DIR"
  while [ "$slot" -le "$n" ]; do
    say "slot $slot        instance $(instance_of "$slot")  name $(instance_of "$slot")  state $STATE_HOME/slot-$slot"
    slot=$((slot + 1))
  done
}

# ------------------------------------------------------------------ guest (Ubuntu) pieces
# The guest firewall: default drop, with an allowlist. Root (provisioning, apt) may reach anything; every
# other user, the job's `runner` included, may reach public IPv4 only: never the host (192.168.5.2 is the
# host's loopback in Lima's user network), the LAN or any private, shared, special or multicast range.
# Lima's user network has no IPv6 (it needs a vmnet interface, which this setup does not add), so
# non-root IPv6 is simply refused; install checks there is no IPv6 route (CASE-261 red-team).
guest_firewall() {
  cat <<'NFT'
table inet case_ci
delete table inet case_ci
table inet case_ci {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    meta skuid 0 accept
    ct state established,related accept
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } reject
    meta nfproto ipv4 accept
    reject
  }
}
NFT
}

# Shared by both hooks: reset the runner's home to its baseline (nothing but the verified browser cache
# and an empty TMPDIR) and drop its files in the shared temporary folders, so a job cannot plant
# ~/.npmrc, ~/.gitconfig, ~/.bashrc, ~/.local/bin or a poisoned cache for the next job (CASE-261 red-team).
hook_scrub() {
  cat <<'SCRUB'
scrub() {
  find "$HOME" -mindepth 1 -maxdepth 1 ! -name .cache -exec rm -rf {} +
  [ ! -d "$HOME/.cache" ] || find "$HOME/.cache" -mindepth 1 -maxdepth 1 ! -name ms-playwright -exec rm -rf {} +
  mkdir -p -m 700 "$HOME/tmp"
  find /tmp /var/tmp /dev/shm -mindepth 1 -maxdepth 1 -user "$(id -u)" -exec rm -rf {} + 2>/dev/null
  return 0
}
SCRUB
}

hook_started() {
  cat <<HOOK
#!/bin/bash
# case-ci guest job-started hook (CASE-261; written by scripts/setup-case-linux-runner.sh). Runs as the
# runner user before every job; a non-zero exit fails the job before any repository code runs.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
MIN_FREE_GB=$1
fail() { echo "case-ci: \$*" >&2; exit 1; }
$(hook_scrub)
[ "\$(id -u)" -ne 0 ] || fail 'the job is running as root'
case " \$(id -Gn) " in *' sudo '*|*' admin '*|*' lxd '*|*' docker '*) fail 'the runner user is in a privileged group' ;; esac
[ -f /run/case-ci/firewall.ok ] || fail 'the guest firewall is not applied on this boot'
case "\${TMPDIR:-}" in "\$HOME"/tmp) ;; *) fail "TMPDIR is not the runner's private directory: \${TMPDIR:-unset}" ;; esac
scrub || fail 'cannot reset the runner home'
# The one cache kept between jobs is checked against the manifest root wrote at provisioning.
cd "\$HOME/.cache/ms-playwright" 2>/dev/null || fail 'the browser cache is missing'
manifest=/var/lib/case-ci/ms-playwright.sha256
[ "\$(find . -path ./.links -prune -o -type f -print | LC_ALL=C sort)" = "\$(sed 's/^[0-9a-f]*  //' "\$manifest" | LC_ALL=C sort)" ] || fail 'the browser cache has files the provisioned one did not'
sha256sum --quiet --strict -c "\$manifest" >/dev/null 2>&1 || fail 'a browser file differs from the provisioned one'
cd "\$HOME"
if nc -z -w 2 127.0.0.1 4317 >/dev/null 2>&1; then fail 'port 4317 is already in use in this VM'; fi
free=\$(df -BG --output=avail "\$HOME" | awk 'NR==2{gsub("G","");print \$1}')
case "\$free" in ''|*[!0-9]*) fail 'cannot read free disk space' ;; esac
[ "\$free" -ge "\$MIN_FREE_GB" ] || fail "only \$free GB free in the VM; need \$MIN_FREE_GB"
echo "case-ci: slot \${CASE_CI_SLOT:-?} isolation canary ok, port 4317 free, \$free GB free"
HOOK
}

hook_completed() {
  cat <<HOOK
#!/bin/bash
# case-ci guest job-completed hook (CASE-261): stop what the job left running, then reset the runner home
# and drop the runner's tool cache, downloaded actions and workspace, all of which a job could poison
# for the next one (they are fetched again per job).
PATH=/usr/bin:/bin:/usr/sbin:/sbin
$(hook_scrub)
HOOK
  cat <<'HOOK'
leftovers() {
  pgrep -u "$(id -u)" -f '/opt/actions-runner/_work/' 2>/dev/null
  lsof -t -nP -iTCP:4317 -sTCP:LISTEN 2>/dev/null
}
pids=$(leftovers | grep -vx "$$" | sort -u)
if [ -n "$pids" ]; then
  kill $pids 2>/dev/null; sleep 2
  pids=$(leftovers | grep -vx "$$" | sort -u)
  [ -z "$pids" ] || kill -9 $pids 2>/dev/null
fi
rm -rf /opt/actions-runner/_work/_tool /opt/actions-runner/_work/_actions /opt/actions-runner/_work/case
scrub
exit 0
HOOK
}

# Root helpers run outside the runner's cgroup. The systemd cleanup runs after success, failure,
# timeout or SIGKILL: cleanup does not depend on the main helper surviving. No hook/test is skipped.
guest_idle_reset() {
  cat <<'RESET'
#!/bin/bash
# Root-only ordinary nightly reset admission. This is not an exclusive performance scheduler.
# Kernel contract: docs.kernel.org/admin-guide/cgroup-v2.html (cgroup.freeze/events/kill).
# Runner v2.338.0 JobDispatcher.ShutdownAsync cancels work: never stop a live Worker.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
UNIT=case-runner.service
CGROUP=/sys/fs/cgroup/system.slice/case-runner.service
MEMBERSHIP=0::/system.slice/case-runner.service
OWNED=/run/case-ci/idle-reset-freeze-owned
fail() { echo "case-ci: reset refused: $*" >&2; exit 1; }
# systemd may remove the killed, stopped unit's empty group at any moment, including between this
# write and its read-back. A group that no longer exists is thawed; only a surviving one must read 0.
thaw() {
  [ -f "$OWNED" ] || return 0
  if { printf '0\n' > "$CGROUP/cgroup.freeze"; } 2>/dev/null; then
    [ "$(cat "$CGROUP/cgroup.freeze" 2>/dev/null)" = 0 ] || [ ! -e "$CGROUP" ] || return 1
  else
    [ ! -e "$CGROUP" ] || return 1
  fi
  rm -f "$OWNED"
}
[ "$(id -u)" = 0 ] || fail 'root required'
# ExecStopPost invokes this even if the main helper is killed or its SSH caller disappears.
if [ "${1:-}" = thaw ]; then thaw; exit; fi
[ "$#" = 0 ] || fail 'unexpected argument'
finish() { local code=$?; trap - EXIT; thaw || code=1; exit "$code"; }
trap finish EXIT
trap 'exit 1' HUP INT TERM
umask 077

property() { systemctl show "$UNIT" --property="$1" --value; }
runner_uid=$(id -u runner) || fail 'runner account missing'
case "$runner_uid" in ''|*[!0-9]*|0) fail 'invalid runner uid' ;; esac
# No automatic restart may race the empty proof and the host's subsequent VM stop.
[ "$(property Restart)" = no ] || fail 'Restart=no must be installed first'
forced=$(property RestartForceExitStatus) || fail 'cannot inspect forced restart policy'
[ -z "$forced" ] || fail 'forced restart policy is set'
[ "$(property User)" = runner ] || fail 'unexpected service user'
[ "$(property Delegate)" = no ] || fail 'delegated cgroup'
[ "$(property ProtectControlGroups)" = yes ] || fail 'cgroup protection missing'
[ "$(stat -f -c %T /sys/fs/cgroup)" = cgroup2fs ] || fail 'cgroup v2 required'

runner_pids() {
  local pids code
  if pids=$(pgrep -u "$runner_uid"); then printf '%s\n' "$pids"; else
    code=$?; [ "$code" = 1 ] || return 1
  fi
}
inactive() {
  case "$(property ActiveState)" in inactive|failed) return 0 ;; *) return 1 ;; esac
}
# A stopped unit's empty cgroup may already have been removed by systemd. Kernel cgroup deletion
# requires no live processes; also reject any runner-UID process outside the removed group.
if [ "$(property ControlGroup)" = '' ] && [ ! -e "$CGROUP" ]; then
  inactive || fail 'unit has not stopped'
  pids=$(runner_pids) || fail 'cannot inspect runner processes'
  [ -z "$pids" ] || fail 'runner processes outside service'
  exit 0
fi
[ "$(property ActiveState)" = active ] || fail 'service is changing state'
[ "$(property ControlGroup)" = /system.slice/case-runner.service ] || fail 'unexpected cgroup identity'
[ "$(realpath -e "$CGROUP")" = "$CGROUP" ] || fail 'cgroup symlink or missing path'
# No delegation/migration writable by jobs: every ancestor and control file is root-owned and
# neither group- nor world-writable. The unit also configures a read-only control-group namespace.
for file in /sys/fs/cgroup /sys/fs/cgroup/system.slice "$CGROUP" \
  "$CGROUP/cgroup.freeze" "$CGROUP/cgroup.events" "$CGROUP/cgroup.procs" "$CGROUP/cgroup.kill"; do
  [ ! -L "$file" ] || fail 'control path is a symlink'
  [ "$(stat -c %u:%g "$file")" = 0:0 ] || fail 'control path is not root-owned'
  mode=$(stat -c %a "$file") || fail 'cannot inspect control permissions'
  case "$mode" in [0-7][0-7][0-7]) ;; *) fail 'unexpected control permissions' ;; esac
  [ "$((8#$mode & 8#022))" = 0 ] || fail 'control path permits cgroup escape'
done
[ "$(cat "$CGROUP/cgroup.type")" = domain ] || fail 'non-domain cgroup'
# Idle is an allow-list of executables, never a deny-list of names: a renamed or self-updated Worker,
# a job's leftover, or the Listener's fork before it execs a Worker all read as busy (3). Idle is only
# run.sh/run-helper.sh's bash plus exactly one Listener. A process that vanished mid-inspection is
# activity (3); an unreadable or escaped membership is an error (1).
inspect() {
  local pids pid member exe listeners=0
  pids=$(runner_pids) || return 1
  for pid in $pids; do
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    if ! member=$(cat "/proc/$pid/cgroup" 2>/dev/null); then
      [ -e "/proc/$pid" ] && return 1
      return 3
    fi
    [ "$member" = "$MEMBERSHIP" ] || return 1
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null) || return 3
    case "$exe" in
      /usr/bin/bash) ;;
      /opt/actions-runner/bin/Runner.Listener)
        listeners=$((listeners + 1))
        [ "$listeners" = 1 ] || return 3 ;;
      *) return 3 ;;
    esac
  done
}
event() {
  local text value
  text=$(cat "$CGROUP/cgroup.events") || return 1
  value=$(printf '%s\n' "$text" | awk -v key="$1" '$1 == key { print $2 }') || return 1
  case "$value" in 0|1) printf '%s\n' "$value" ;; *) return 1 ;; esac
}
# Just after a job ends, the Listener may already hold the next assignment with no Worker yet; the
# allow-list cannot see that (case-linux-3 lost a job this way, run 39157463351). So admission also
# needs QUIET seconds since the newest Worker diagnostic log was written: a queued job reaches an
# idle runner within seconds, so a quiet slot had no work waiting. A future-dated log defers too.
QUIET=600
DIAG=/opt/actions-runner/_diag
quiet() {
  local now log stamp
  now=$(date +%s) || return 1
  for log in "$DIAG"/Worker_*.log; do
    [ -e "$log" ] || continue
    stamp=$(stat -c %Y "$log" 2>/dev/null) || { [ -e "$log" ] && return 1; continue; }
    case "$stamp" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$((now - stamp))" -lt "$QUIET" ]; then
      echo "case-ci: reset deferred: a job ended $((now - stamp))s ago; need ${QUIET}s quiet" >&2
      return 3
    fi
  done
}
if quiet; then :; else code=$?; exit "$code"; fi
# Avoid even briefly pausing a Worker that is already visible. This is only an optimization;
# the *second* inspection, after the kernel's frozen acknowledgement, closes the dispatch race.
if inspect; then :; else code=$?; exit "$code"; fi
[ "$(cat "$CGROUP/cgroup.freeze")" = 0 ] || fail 'another controller owns the freeze'
[ "$(event frozen)" = 0 ] || fail 'ancestor or existing freeze'
: > "$OWNED"
printf '1\n' > "$CGROUP/cgroup.freeze" || fail 'cannot freeze service'
count=0
until [ "$(event frozen)" = 1 ]; do
  count=$((count + 1)); [ "$count" -lt 20 ] || fail 'freeze acknowledgement timed out'
  sleep 0.05
done
# A Worker that appeared during freezing is thawed and allowed to finish, never cancelled.
# This rare race briefly pauses it; an acquired job without a Worker may instead be abandoned/red.
if inspect; then :; else code=$?; exit "$code"; fi
[ "$(cat "$CGROUP/cgroup.freeze")" = 1 ] && [ "$(event frozen)" = 1 ] || fail 'freeze was lost'
# Unlike systemctl stop, cgroup.kill does not thaw first. It kills the entire still-frozen tree,
# including run.sh's helper, and handles concurrent fork/migration in the kernel.
printf '1\n' > "$CGROUP/cgroup.kill" || fail 'cannot terminate idle service'
count=0
while [ -e "$CGROUP" ] && [ "$(event populated)" != 0 ]; do
  count=$((count + 1)); [ "$count" -lt 20 ] || fail 'service did not become empty'
  sleep 0.05
done
pids=$(runner_pids) || fail 'cannot prove runner processes exited'
[ -z "$pids" ] || fail 'runner processes remain'
[ "$(property Restart)" = no ] || fail 'restart policy changed'
# The group is empty or deleted, and no automatic restart is possible. Only now may stop thaw it.
systemctl stop "$UNIT" || fail 'cannot finish stopping empty service'
inactive || fail 'service did not stop'
echo 'case-ci: idle reset admitted; frozen service terminated and empty'
RESET
}

# Rewritten on every boot and on an explicit owner-run install repair. daemon-reload changes the
# restart policy without stopping an active job; cgroup protection takes effect on the next start.
guest_runner_control() {
  cat <<CONTROL
install -d -o root -g root -m 755 /usr/local/libexec/case-ci /run/case-ci
cat > /usr/local/libexec/case-ci/idle-reset.sh <<'RESET'
$(guest_idle_reset)
RESET
chmod 755 /usr/local/libexec/case-ci/idle-reset.sh
cat > /etc/systemd/system/case-runner.service <<'UNIT'
[Unit]
Description=Case GitHub Actions runner (CASE-261)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/actions-runner/.runner

[Service]
User=runner
WorkingDirectory=/opt/actions-runner
ExecStart=/opt/actions-runner/run.sh
# The host supervisor is the sole restarter. An empty proof must survive until VM stop/reset.
Restart=no
RestartForceExitStatus=
KillMode=process
Delegate=no
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/case-runner-idle-reset.service <<'UNIT'
[Unit]
Description=Case idle-only nightly reset admission
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/libexec/case-ci/idle-reset.sh
ExecStopPost=/usr/local/libexec/case-ci/idle-reset.sh thaw
TimeoutStartSec=15
TimeoutStopSec=3
UNIT
systemctl daemon-reload
systemctl enable case-runner.service
CONTROL
}

# A separate prerequisite repair keeps already-provisioned disks usable without repeating downloads.
guest_compiler_prerequisite() {
  cat <<'COMPILER'
# C compiler prerequisite: independent of the runner/Node/Playwright provision marker.
ensure_compiler() {
  if [ -x /usr/bin/cc ] && [ "$(dpkg-query -W -f='${Status}' build-essential 2>/dev/null)" = 'install ok installed' ]; then
    return 0
  fi
  apt-get update -q
  apt-get install -yq --no-install-recommends build-essential
  [ -x /usr/bin/cc ] || { echo 'case-ci: /usr/bin/cc is missing after build-essential installation' >&2; return 1; }
  [ "$(dpkg-query -W -f='${Status}' build-essential 2>/dev/null)" = 'install ok installed' ] || { echo 'case-ci: build-essential is not fully installed' >&2; return 1; }
}
ensure_compiler
# End C compiler prerequisite.
COMPILER
}

# Runs as root in the guest on every boot (Lima system provisioning). The heavy part runs once per disk
# (the nightly factory reset starts from the image again); the firewall is applied on every boot.
guest_provision() {
  local slot="$1"
  cat <<GUEST
#!/bin/bash
set -eu -o pipefail
export DEBIAN_FRONTEND=noninteractive
MARK=/var/lib/case-ci/provisioned-$RUNNER_VERSION-$NODE_VERSION-$PLAYWRIGHT_VERSION
mkdir -p /var/lib/case-ci /run/case-ci /etc/case-ci
# The firewall first, before any job could run.
cat > /etc/case-ci/firewall.nft <<'NFT'
$(guest_firewall)
NFT
if ! command -v nft >/dev/null 2>&1; then apt-get update -q && apt-get install -yq --no-install-recommends nftables; fi
nft -f /etc/case-ci/firewall.nft
touch /run/case-ci/firewall.ok
if [ ! -f "\$MARK" ]; then
  apt-get update -q
  apt-get install -yq --no-install-recommends ca-certificates curl git jq xz-utils zstd unzip zip locales lsof \\
    netcat-openbsd procps postgresql-16 postgresql-client-16 build-essential
  locale-gen en_US.UTF-8
  systemctl disable --now postgresql || true
  id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group runner
  for g in sudo admin lxd docker adm; do gpasswd -d runner "\$g" >/dev/null 2>&1 || true; done
  install -d -o runner -g runner -m 700 /home/runner/tmp
  # Node only to install Playwright's system packages and browsers; jobs bring their own (setup-node).
  curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz
  echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c -
  rm -rf /opt/case-node && mkdir -p /opt/case-node && tar -xJf /tmp/node.tar.xz -C /opt/case-node --strip-components=1 && rm -f /tmp/node.tar.xz
  PATH=/opt/case-node/bin:\$PATH npx -y playwright@$PLAYWRIGHT_VERSION install-deps chromium webkit
  sudo -u runner -H env PATH=/opt/case-node/bin:/usr/bin:/bin npx -y playwright@$PLAYWRIGHT_VERSION install chromium webkit
  # The browser cache is the one thing a job's user keeps between jobs; the job-started hook checks it
  # against this root-owned manifest (Playwright's .links bookkeeping is excluded).
  (cd /home/runner/.cache/ms-playwright && find . -path ./.links -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /var/lib/case-ci/ms-playwright.sha256
  chmod 644 /var/lib/case-ci/ms-playwright.sha256
  # No scheduled jobs for anyone but root: a job cannot leave a crontab or an at job behind.
  echo root > /etc/cron.allow; echo root > /etc/at.allow; chmod 644 /etc/cron.allow /etc/at.allow
  crontab -u runner -r 2>/dev/null || true
  curl -fsSL -o /tmp/runner.tar.gz https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz
  echo "$RUNNER_SHA256  /tmp/runner.tar.gz" | sha256sum -c -
  install -d -o runner -g runner /opt/actions-runner
  sudo -u runner tar -xzf /tmp/runner.tar.gz -C /opt/actions-runner && rm -f /tmp/runner.tar.gz
  /opt/actions-runner/bin/installdependencies.sh
  install -d -o root -g root -m 755 /usr/local/libexec/case-ci
  cat > /usr/local/libexec/case-ci/job-started.sh <<'HOOK'
$(hook_started 15)
HOOK
  cat > /usr/local/libexec/case-ci/job-completed.sh <<'HOOK'
$(hook_completed)
HOOK
  chmod 755 /usr/local/libexec/case-ci/job-started.sh /usr/local/libexec/case-ci/job-completed.sh
  # Hosted ubuntu-24.04 runs jobs with LANG=C.UTF-8 in UTC; so does this VM.
  sudo -u runner sh -c 'umask 077; cat > /opt/actions-runner/.env' <<ENV
LANG=C.UTF-8
TZ=UTC
TMPDIR=/home/runner/tmp
CASE_CI_SLOT=$slot
ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/case-ci/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/case-ci/job-completed.sh
ENV
  touch "\$MARK"
fi
$(guest_runner_control)
$(guest_compiler_prerequisite)
GUEST
}

# Slot N's Lima template. plain: no mounts, no port forwards, no guest agent, no containerd, no Rosetta.
# The host resolver is off (it NATs DNS through the host's loopback); public resolvers are used instead.
lima_template() {
  local slot="$1"
  cat <<YAML
# Case CI slot $slot (CASE-261). Generated by scripts/setup-case-linux-runner.sh; do not edit by hand.
vmType: vz
arch: aarch64
plain: true
cpus: $VM_CPUS
memory: $VM_MEMORY
disk: $VM_DISK
images:
- location: "$IMAGE_URL"
  arch: aarch64
  digest: "sha256:$IMAGE_SHA256"
mounts: []
containerd:
  system: false
  user: false
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
  forwardX11: false
hostResolver:
  enabled: false
dns:
- 1.1.1.1
- 8.8.8.8
timezone: "Etc/UTC"
upgradePackages: false
provision:
- mode: system
  script: |
$(guest_provision "$slot" | sed 's/^/    /')
YAML
}

# ------------------------------------------------------------------ host (macOS) pieces
supervisor_script() {
  cat <<SUP
#!/bin/bash
# case-ci supervisor (CASE-261; written by scripts/setup-case-linux-runner.sh). Runs as $RUNNER_USER under
# the $DAEMON_LABEL LaunchDaemon. Every minute it keeps each slot's VM and runner up, and once a day it
# factory-resets each slot from the pinned image: from $REBUILD_HOUR:00 local, at the slot's first idle
# moment, so a busy night defers the reset rather than skipping it. Logs to stdout (the daemon's log).
set -u
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export LIMA_HOME='$LIMA_HOME_DIR'
SLOTS='$1'
STATE='$STATE_HOME'
TEMPLATES='$LIBEXEC/lima'
REBUILD_HOUR=$REBUILD_HOUR
MIN_HOST_FREE_GB=$MIN_HOST_FREE_GB
log() { printf '%s %s\n' "\$(date -u +%FT%TZ)" "\$*"; }
inst() { printf '%s-%s' '$INSTANCE_PREFIX' "\$1"; }
status() { limactl list --format '{{.Status}}' "\$(inst "\$1")" 2>/dev/null || true; }
guest() { local i; i=\$(inst "\$1"); shift; limactl shell --workdir / "\$i" "\$@"; }
restore() {
  local slot="\$1" f
  for f in .runner .credentials .credentials_rsaparams; do
    [ -s "\$STATE/slot-\$slot/\$f" ] || { log "slot \$slot: no saved registration; run install"; return 1; }
    guest "\$slot" sudo sh -c "umask 077; cat > /opt/actions-runner/\$f && chown runner:runner /opt/actions-runner/\$f" < "\$STATE/slot-\$slot/\$f" || return 1
  done
  guest "\$slot" sudo systemctl start case-runner.service
}
# Due: not reset today, and the reset hour has passed (10# keeps "08" decimal under bash 3.2).
due() { [ "\$((10#\$(date +%H)))" -ge "\$((10#\$REBUILD_HOUR))" ] && [ "\$(cat "\$STATE/slot-\$1/reset-on" 2>/dev/null || true)" != "\$(date +%F)" ]; }
# The root oneshot freezes/ACKs the service, inspects all runner processes, kills only a still-idle
# frozen cgroup, and proves it empty with Restart=no. Its ExecStopPost thaws on every failure path.
offline_if_idle() { guest "\$1" sudo systemctl start --wait case-runner-idle-reset.service; }
# Over a day late: the last reset was neither today nor yesterday (BSD date on the Mac).
stale() { local on; on=\$(cat "\$STATE/slot-\$1/reset-on" 2>/dev/null || true); [ "\$on" != "\$(date +%F)" ] && [ "\$on" != "\$(date -v-1d +%F)" ]; }
# A refused admission is busy only when the helper itself exited 3. Anything else (a guard, a timeout,
# an unreachable guest) is an ALERT with the oneshot's last journal lines, never a silent "waiting".
refused() {
  local slot="\$1" show status result
  show=\$(guest "\$slot" systemctl show -p ExecMainStatus,Result case-runner-idle-reset.service 2>/dev/null || true)
  status=\$(printf '%s\n' "\$show" | sed -n 's/^ExecMainStatus=//p')
  result=\$(printf '%s\n' "\$show" | sed -n 's/^Result=//p')
  if [ "\$status" = 3 ] && [ "\$result" = exit-code ]; then
    log "slot \$slot: reset due, waiting for its job to finish"
    return
  fi
  log "ALERT slot \$slot: reset refused (ExecMainStatus=\${status:-?} Result=\${result:-?})"
  guest "\$slot" sudo journalctl -u case-runner-idle-reset.service -n 10 --no-pager -o cat 2>&1 |
    while IFS= read -r line; do log "slot \$slot: reset journal: \$line"; done
}
# One slot, once a minute. The restore check runs whether or not a reset is due, so a slot whose
# reset keeps being refused is still brought back up.
tend() {
  local slot="\$1" vm
  vm=\$(status "\$slot")
  if [ -n "\$vm" ] && stale "\$slot"; then
    log "ALERT slot \$slot: last factory reset \$(cat "\$STATE/slot-\$slot/reset-on" 2>/dev/null || echo never), over a day ago"
  fi
  case "\$vm" in
    Running)
      if due "\$slot"; then
        if offline_if_idle "\$slot"; then reset "\$slot"; return; fi
        refused "\$slot"
      fi
      if ! guest "\$slot" systemctl is-active --quiet case-runner.service; then
        log "slot \$slot: runner down; restoring"; restore "\$slot" || true
      fi ;;
    Stopped|Broken)
      log "slot \$slot: VM \$vm; starting"
      limactl start --tty=false --timeout 45m "\$(inst "\$slot")" && restore "\$slot" || log "slot \$slot: start FAILED" ;;
    '') log "slot \$slot: no VM; run install" ;;
  esac
}
reset() {
  local slot="\$1" i
  i=\$(inst "\$slot")
  log "slot \$slot: factory reset"
  # Start from the root-owned template, not whatever the instance directory now holds.
  cp "\$TEMPLATES/\$i.yaml" "\$LIMA_HOME/\$i/lima.yaml" &&
    limactl stop "\$i" && limactl factory-reset "\$i" && limactl start --tty=false --timeout 45m "\$i" &&
    restore "\$slot" && date +%F > "\$STATE/slot-\$slot/reset-on" || log "slot \$slot: factory reset FAILED"
}
low=0
while :; do
  free=\$(df -g "\$HOME" | awk 'NR==2{print \$4}')
  if [ "\${free:-0}" -lt "\$MIN_HOST_FREE_GB" ]; then
    [ "\$low" = 1 ] || { log "ALERT host disk: \${free:-?} GB free, under \$MIN_HOST_FREE_GB; runners taken offline"; for slot in \$SLOTS; do guest "\$slot" sudo systemctl stop case-runner.service >/dev/null 2>&1; done; }
    low=1; sleep 60; continue
  fi
  [ "\$low" = 0 ] || log "host disk: \$free GB free again; runners back"
  low=0
  for slot in \$SLOTS; do tend "\$slot"; done
  sleep 60
done
SUP
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run with sudo: sudo /bin/bash <root-owned copy> $1"
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || die "run from your own login with sudo, not from a root shell"
}

# A path root executes or writes must be root-owned and not group/world-writable, all the way up.
check_root_owned() {
  local p="$1" owner mode
  while :; do
    [ -L "$p" ] && die "$p is a symlink"
    [ -e "$p" ] || die "$p does not exist"
    owner=$(stat -f '%Su' "$p"); mode=$(stat -f '%Lp' "$p")
    [ "$owner" = root ] || die "$p is owned by $owner, not root"
    case "$mode" in
      *[2367]? | *[2367]) die "$p is group- or world-writable (mode $mode)" ;;
    esac
    [ "$p" = / ] && break
    p=$(dirname "$p")
  done
}

check_self() {
  case "$0" in /*) ;; *) die "run the root-owned copy by its absolute path" ;; esac
  check_root_owned "$0"
}

owner_home() {
  local home
  home=$(dscl . -read "$DS_USERS/$SUDO_USER" NFSHomeDirectory 2>/dev/null | sed 's/^NFSHomeDirectory: //')
  [ -n "$home" ] && [ -d "$home" ] && [ ! -L "$home" ] || die "cannot resolve the home of $SUDO_USER"
  case "$home" in / | "$RUNNER_HOME" | /private/var/*) die "unexpected owner home $home" ;; esac
  echo "$home"
}

free_id() {
  local kind="$1" attr="$2" id used
  used=" $(dscl . -list "/$kind" "$attr" | awk '{print $2}' | tr '\n' ' ') "
  id=$FIRST_ID
  while [ "${used#* $id }" != "$used" ]; do id=$((id + 1)); done
  echo "$id"
}

as_runner() { sudo -u "$RUNNER_USER" -H "$@"; }
# Lima runs only as the runner account, never as root.
lima() { as_runner env LIMA_HOME="$LIMA_HOME_DIR" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin "$LIMACTL" "$@"; }
guest() { local i; i=$(instance_of "$1"); shift; lima shell --workdir / "$i" "$@"; }

# Under pipefail a pipe into `grep -q` can read false on SIGPIPE (CASE-259): read writers to the end.
is_admin() {
  case "$(dseditgroup -o checkmember -m "$1" admin 2>/dev/null || true)" in yes*) return 0 ;; esac
  return 1
}

ensure_account() {
  local gid uid
  if dscl . -read "/Groups/$RUNNER_GROUP" PrimaryGroupID >/dev/null 2>&1; then
    gid=$(dscl . -read "/Groups/$RUNNER_GROUP" PrimaryGroupID | awk '{print $2}')
    say "group $RUNNER_GROUP exists (gid $gid)"
  else
    gid=$(free_id Groups PrimaryGroupID)
    dscl . -create "/Groups/$RUNNER_GROUP"
    dscl . -create "/Groups/$RUNNER_GROUP" PrimaryGroupID "$gid"
    dscl . -create "/Groups/$RUNNER_GROUP" RealName "Case CI runner"
    say "group $RUNNER_GROUP created (gid $gid)"
  fi
  if id "$RUNNER_USER" >/dev/null 2>&1; then
    say "user $RUNNER_USER exists (uid $(id -u "$RUNNER_USER"))"
  else
    uid=$(free_id Users UniqueID)
    dscl . -create "$DS_USERS/$RUNNER_USER"
    dscl . -create "$DS_USERS/$RUNNER_USER" UniqueID "$uid"
    dscl . -create "$DS_USERS/$RUNNER_USER" PrimaryGroupID "$gid"
    dscl . -create "$DS_USERS/$RUNNER_USER" UserShell /usr/bin/false
    dscl . -create "$DS_USERS/$RUNNER_USER" RealName "Case CI runner"
    dscl . -create "$DS_USERS/$RUNNER_USER" NFSHomeDirectory "$RUNNER_HOME"
    dscl . -create "$DS_USERS/$RUNNER_USER" Password '*'
    dscl . -create "$DS_USERS/$RUNNER_USER" IsHidden 1
    say "user $RUNNER_USER created (uid $uid)"
  fi
  [ "$(id -u "$RUNNER_USER")" -ge "$FIRST_ID" ] || die "$RUNNER_USER has uid $(id -u "$RUNNER_USER"), below $FIRST_ID"
  [ "$(id -g "$RUNNER_USER")" = "$gid" ] || die "$RUNNER_USER's primary group is not $RUNNER_GROUP"
  [ "$(dscl . -read "$DS_USERS/$RUNNER_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')" = "$RUNNER_HOME" ] || die "$RUNNER_USER's home is not $RUNNER_HOME"
  [ "$(dscl . -read "$DS_USERS/$RUNNER_USER" UserShell | sed 's/^UserShell: //')" = /usr/bin/false ] || die "$RUNNER_USER has a login shell"
  if is_admin "$RUNNER_USER"; then die "$RUNNER_USER is in the admin group"; fi
  [ -L "$RUNNER_HOME" ] && die "$RUNNER_HOME is a symlink"
  mkdir -p "$RUNNER_HOME"
  chown -h "$RUNNER_USER:$RUNNER_GROUP" "$RUNNER_HOME"
  chmod -h 700 "$RUNNER_HOME"
  # Inside the runner's home every write runs as the runner: root never follows a path it controls.
  as_runner /bin/mkdir -p -m 700 "$LIMA_HOME_DIR" "$STATE_HOME"
}

lock_owner_home() {
  local home="$1" mode
  mkdir -p "$STATE_DIR"; chown root:wheel "$STATE_DIR"; chmod 700 "$STATE_DIR"
  mode=$(stat -f '%Lp' "$home")
  [ -f "$STATE_DIR/owner-home-mode" ] || printf '%s %s\n' "$home" "$mode" > "$STATE_DIR/owner-home-mode"
  chmod 700 "$home"
  say "$home: mode $mode -> 700 (uninstall restores $(awk '{print $2}' "$STATE_DIR/owner-home-mode"))"
}

# The host account runs only Lima. It must not reach the owner's files, sudo or privileged paths.
host_probes() {
  local home="$1" failed=0 other uid
  deny() {
    local what="$1"; shift
    if as_runner "$@" >/dev/null 2>&1; then say "FAIL  $RUNNER_USER can $what"; failed=1; else say "ok    $RUNNER_USER cannot $what"; fi
  }
  deny "list $home" /bin/ls "$home"
  deny "traverse $home" /bin/test -x "$home"
  deny "read $home/.config/gh/hosts.yml" /bin/test -r "$home/.config/gh/hosts.yml"
  deny "read $home/.ssh" /bin/ls "$home/.ssh"
  while read -r other uid; do
    [ "$uid" -ge 500 ] 2>/dev/null || continue
    other=$(dscl . -read "$DS_USERS/$other" NFSHomeDirectory 2>/dev/null | sed 's/^NFSHomeDirectory: //')
    case "$other" in "" | "$home" | "$RUNNER_HOME" | /var/empty) continue ;; esac
    [ -d "$other" ] && deny "list $other" /bin/ls "$other"
  done < <(dscl . -list "$DS_USERS" UniqueID)
  deny "run sudo" /usr/bin/sudo -n /usr/bin/true
  deny "write Homebrew (/opt/homebrew)" /bin/test -w /opt/homebrew
  deny "write $LIBEXEC" /bin/test -w "$LIBEXEC"
  deny "write /Library/LaunchDaemons" /bin/test -w /Library/LaunchDaemons
  if is_admin "$RUNNER_USER"; then say "FAIL  $RUNNER_USER is an administrator"; failed=1; else say "ok    $RUNNER_USER is not an administrator"; fi
  return "$failed"
}

# Inside each VM: the firewall holds for the job's user, no host folder is mounted, and runner has no sudo.
guest_probes() {
  local slot="$1" failed=0
  check() {
    local what="$1"; shift
    if guest "$slot" "$@" >/dev/null 2>&1; then say "ok    slot $slot: $what"; else say "FAIL  slot $slot: $what"; failed=1; fi
  }
  check "firewall applied this boot" test -f /run/case-ci/firewall.ok
  # Known answer: a listener on the host's loopback. Root in the guest (exempt) must reach it, which proves
  # the path exists; the job's user must not, which proves the firewall closes it.
  as_runner /usr/bin/nc -lk 127.0.0.1 "$PROBE_PORT" >/dev/null 2>&1 &
  local listener=$!
  sleep 1
  check "root reaches a host listener (the path exists)" sudo nc -z -w 3 192.168.5.2 "$PROBE_PORT"
  check "runner cannot reach the same host listener" sh -c "! sudo -u runner nc -z -w 3 192.168.5.2 $PROBE_PORT"
  kill "$listener" 2>/dev/null || true; wait "$listener" 2>/dev/null || true
  check "runner reaches GitHub" sudo -u runner curl -fsS -m 10 -o /dev/null https://api.github.com/zen
  check "no IPv6 route (the firewall refuses non-root IPv6 anyway)" sh -c '[ -z "$(ip -6 route show default)" ]'
  check "runner cannot use IPv6" sh -c '! sudo -u runner curl -6 -s -m 5 -o /dev/null https://ipv6.google.com/'
  check "runner has no sudo" sh -c '! sudo -u runner sudo -n true'
  check "no host folder is mounted" sh -c "$MOUNT_CHECK"
  check "Postgres 16 present" test -x /usr/lib/postgresql/16/bin/initdb
  check "Playwright browsers present" sudo -u runner sh -c 'ls -d /home/runner/.cache/ms-playwright/chromium-* /home/runner/.cache/ms-playwright/webkit-*'
  return "$failed"
}

write_libexec() {
  local n="$1" slots="" slot=1 dir new
  while [ "$slot" -le "$n" ]; do slots="$slots $slot"; slot=$((slot + 1)); done
  mkdir -p "$LIBEXEC/lima"
  supervisor_script "${slots# }" > "$LIBEXEC/supervisor.sh"
  slot=1
  while [ "$slot" -le "$n" ]; do lima_template "$slot" > "$LIBEXEC/lima/$(instance_of "$slot").yaml"; slot=$((slot + 1)); done
  chown -R root:wheel "$LIBEXEC"
  chmod 755 "$LIBEXEC" "$LIBEXEC/lima" "$LIBEXEC/supervisor.sh"
  chmod 644 "$LIBEXEC"/lima/*.yaml
  check_root_owned "$LIBEXEC/supervisor.sh"
}

create_vm() {
  local slot="$1" inst status
  inst=$(instance_of "$slot")
  status=$(lima list --format '{{.Status}}' "$inst" 2>/dev/null || true)
  if [ -z "$status" ]; then
    say "slot $slot: creating $inst (downloads the image once; provisioning takes several minutes)"
    lima create --tty=false --name "$inst" "$LIBEXEC/lima/$inst.yaml"
    status=Stopped
  fi
  if [ "$status" != Running ]; then lima start --tty=false --timeout 45m "$inst"; fi
  say "slot $slot: $inst running"
}

register() {
  local slot="$1" inst f
  inst=$(instance_of "$slot")
  if [ -s "$STATE_HOME/slot-$slot/.runner" ] || as_runner /bin/test -s "$STATE_HOME/slot-$slot/.runner"; then
    say "slot $slot: $inst already registered"; return 0
  fi
  say "slot $slot: registering $inst. Open"
  say "  $REPO_URL/settings/actions/runners/new  (Linux, ARM64; the token is valid for one hour)"
  say "and type the token into THIS terminal when config.sh asks for it; never paste it into a chat."
  say "Press Enter at any other prompt."
  guest "$slot" sudo -u runner -H /opt/actions-runner/config.sh --url "$REPO_URL" --name "$inst" --labels "$LABEL" \
    --runnergroup Default --work _work --replace < /dev/tty
  as_runner /bin/mkdir -p -m 700 "$STATE_HOME/slot-$slot"
  # The runner's own credentials go to the host, readable only by the runner account, so the nightly
  # factory reset can restore the same registration without a new token.
  for f in .runner .credentials .credentials_rsaparams; do
    guest "$slot" sudo cat "/opt/actions-runner/$f" | as_runner /bin/sh -c 'umask 077; cat > "$1"' _ "$STATE_HOME/slot-$slot/$f"
    as_runner /bin/test -s "$STATE_HOME/slot-$slot/$f" || die "slot $slot: could not save $f"
  done
  # The VM was just built from the image: the supervisor's first factory reset is due tomorrow.
  date +%F | as_runner /bin/sh -c 'umask 077; cat > "$1"' _ "$STATE_HOME/slot-$slot/reset-on"
  guest "$slot" sudo systemctl start case-runner.service
}

write_daemon() {
  local log="$LOG_DIR/supervisor.log" new
  mkdir -p "$LOG_DIR"; chown root:wheel "$LOG_DIR"; chmod 755 "$LOG_DIR"
  # The file is the runner's, in root's folder: writable however launchd opens it, never swappable.
  [ -L "$log" ] && die "$log is a symlink"
  touch "$log"; chown -h "$RUNNER_USER:$RUNNER_GROUP" "$log"; chmod -h 640 "$log"
  new=$(mktemp "$STATE_DIR/plist.XXXXXX")
  cat > "$new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DAEMON_LABEL</string>
  <key>UserName</key><string>$RUNNER_USER</string>
  <key>GroupName</key><string>$RUNNER_GROUP</string>
  <key>WorkingDirectory</key><string>$RUNNER_HOME</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>/bin/bash</string><string>$LIBEXEC/supervisor.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$RUNNER_HOME</string>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
  plutil -lint "$new" >/dev/null || { rm -f "$new"; die "the supervisor plist does not lint"; }
  launchctl bootout "system/$DAEMON_LABEL" 2>/dev/null || true
  mv "$new" "$PLIST"; chown root:wheel "$PLIST"; chmod 644 "$PLIST"
  launchctl bootstrap system "$PLIST"
  launchctl enable "system/$DAEMON_LABEL"
  say "supervisor $DAEMON_LABEL loaded"
}

do_install() {
  local n="$1" home slot free version
  check_self
  home=$(owner_home)
  [ "$(uname -m)" = arm64 ] || die "this setup is for Apple silicon"
  [ -x "$LIMACTL" ] || die "Lima is missing: brew install lima (as yourself, not with sudo)"
  check_root_owned /usr/local
  free=$(df -g /System/Volumes/Data | awk 'NR==2{print $4}')
  [ "${free:-0}" -ge "$MIN_FREE_GB" ] || die "only ${free:-?} GB free; the VMs need about $MIN_FREE_GB"
  step "1/6 account $RUNNER_USER"; ensure_account
  version=$(lima --version 2>/dev/null || true)
  case "$version" in *"version 2."*) say "$version" ;; *) die "Lima 2.x is required as $RUNNER_USER (found: ${version:-none})" ;; esac
  step "2/6 lock $home"; lock_owner_home "$home"
  step "3/6 VM templates and supervisor in $LIBEXEC"; write_libexec "$n"
  step "4/6 host isolation probes (every line must be ok)"; host_probes "$home" || die "a host probe failed; nothing was created"
  step "5/6 VMs and runners"
  launchctl bootout "system/$DAEMON_LABEL" 2>/dev/null || true
  slot=1
  while [ "$slot" -le "$n" ]; do
    create_vm "$slot"
    guest_runner_control | guest "$slot" sudo /bin/bash
    guest_probes "$slot" || die "slot $slot: a guest probe failed; not registering"
    register "$slot"
    slot=$((slot + 1))
  done
  step "6/6 supervisor"; write_daemon
  printf '\nDONE: %s Linux runner slot(s). Nothing routes to them until CASE_*_RUNNER=case-linux is set (docs/CI-RUNNERS.md §Activate).\n' "$n"
}

do_probe() {
  local home slot failed=0 inst
  check_self
  home=$(owner_home)
  host_probes "$home" || failed=1
  for inst in $(lima list --quiet 2>/dev/null || true); do
    case "$inst" in "$INSTANCE_PREFIX"-[0-9]) slot=${inst##*-}; guest_probes "$slot" || failed=1 ;; esac
  done
  if launchctl print "system/$DAEMON_LABEL" >/dev/null 2>&1; then say "ok    supervisor loaded"; else say "FAIL  supervisor not loaded"; failed=1; fi
  [ "$failed" = 0 ] || say "PROBE FAILED: delete the CASE_*_RUNNER variables until this is fixed"
}

do_uninstall() {
  local answer inst home mode
  check_self
  say "This stops and deletes the Case Linux runner VMs, the supervisor, its logs, the $RUNNER_USER user,"
  say "its group and $RUNNER_HOME. Delete the CASE_*_RUNNER repository variables FIRST."
  printf 'Type DELETE to continue: '
  read -r answer < /dev/tty
  [ "$answer" = DELETE ] || die "nothing removed"
  launchctl bootout "system/$DAEMON_LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  if [ -x "$LIMACTL" ] && id "$RUNNER_USER" >/dev/null 2>&1; then
    for inst in $(lima list --quiet 2>/dev/null || true); do
      case "$inst" in "$INSTANCE_PREFIX"-[0-9]) lima stop -f "$inst" >/dev/null 2>&1 || true; lima delete -f "$inst" && say "deleted VM $inst" ;; esac
    done
  fi
  rm -rf "$LIBEXEC" "$LOG_DIR"
  if id "$RUNNER_USER" >/dev/null 2>&1; then pkill -u "$RUNNER_USER" 2>/dev/null || true; dscl . -delete "$DS_USERS/$RUNNER_USER"; say "deleted user $RUNNER_USER"; fi
  if dscl . -read "/Groups/$RUNNER_GROUP" >/dev/null 2>&1; then dscl . -delete "/Groups/$RUNNER_GROUP"; say "deleted group $RUNNER_GROUP"; fi
  case "$RUNNER_HOME" in /private/var/case-runner) rm -rf "$RUNNER_HOME"; say "deleted $RUNNER_HOME" ;; esac
  if [ -f "$STATE_DIR/owner-home-mode" ]; then
    read -r home mode < "$STATE_DIR/owner-home-mode"
    if [ -d "$home" ] && [ "$(stat -f '%Lp' "$home")" = 700 ]; then chmod "$mode" "$home"; say "$home restored to mode $mode"; fi
  fi
  rm -rf "$STATE_DIR"
  say "DONE. In GitHub, remove the offline case-linux-* runners: $REPO_URL/settings/actions/runners"
}

main() {
  local cmd="${1:-}" n="$DEFAULT_INSTANCES"
  [ "$#" -gt 0 ] && shift
  if [ "$cmd" = install ] || [ "$cmd" = plan ]; then
    if [ "${1:-}" = --instances ]; then
      n="${2:-}"
      case "$n" in [1-9]) ;; *) die "--instances takes 1..$MAX_INSTANCES" ;; esac
      [ "$n" -le "$MAX_INSTANCES" ] || die "--instances takes 1..$MAX_INSTANCES"
    fi
  fi
  case "$cmd" in
    plan) plan "$n" ;;
    template)
      case "${1:-}" in [1-9]) lima_template "$1" ;; *) die "usage: setup-case-linux-runner.sh template SLOT" ;; esac ;;
    idle-reset) guest_idle_reset ;;
    supervisor) supervisor_script "1 2 3" ;;
    hook)
      case "${1:-}" in
        started) hook_started "${2:-15}" ;;
        completed) hook_completed ;;
        *) die "usage: setup-case-linux-runner.sh hook started [MIN_FREE_GB] | hook completed" ;;
      esac ;;
    install) require_root install; do_install "$n" ;;
    probe) require_root probe; do_probe ;;
    uninstall) require_root uninstall; do_uninstall ;;
    *) die "usage: setup-case-linux-runner.sh plan|template N|hook started|completed|idle-reset|supervisor|install [--instances N]|probe|uninstall" ;;
  esac
}

main "$@"
