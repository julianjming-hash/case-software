#!/bin/bash
# scripts/setup-case-macos-vm.sh: owner-run staged setup for an isolated macOS CI VM.
# Generators are read-only; install-host/guest-bootstrap/configure-guest/probe-host are OWNER-RUN.
# Installation/activation commands are owner-run. Invoking generators never mutates host/guest.
# Tart 2.40.1/Softnet 0.24.0 command sources and release hashes, read 2026-10-18:
# https://github.com/openai/tart/tree/2.40.1/Sources/tart/Commands
# https://github.com/openai/softnet/tree/0.24.0
# https://github.com/openai/homebrew-tools/tree/main/Formula
# Source is not live qualification: isolation, logout/reboot and paired gate proofs remain owner steps.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL

TART_VERSION=2.40.1
TART_ARCHIVE_SHA256=363e2701154a8155cbc1bb6d845430c9b42697d2a186bc49574471ca2877db46
SOFTNET_VERSION=0.24.0
SOFTNET_ARCHIVE_SHA256=dc208e5037b525e769337c064f5dda83da83b4d1e4a038f434e83050b39a560b
SERVICE_USER=case-macos-runner
SERVICE_HOME=/private/var/case-macos-runner
LIBEXEC=/usr/local/libexec/case-macos-vm
TART_BIN=$LIBEXEC/tart.app/Contents/MacOS/tart
# Softnet permits the bridge gateway by default. Block it explicitly; never add a private allow rule.
# Softnet enables macOS vmnet bridge isolation unless the allow list holds the bare 0.0.0.0/0 (Softnet
# 0.24.0 lib/proxy/mod.rs). macOS 27 writes that isolation's IPv4 pass rule without its mask for 192.168
# /30s, cutting the host off from the guest (CASE-301). Every block below is more specific than /0, so
# Softnet's longest-prefix match still denies it; only already-allowed public traffic matches the /0.
NETWORK_ALLOW='in @host,0.0.0.0/0'
NETWORK_BLOCK='@host,0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.18.0.0/15,198.51.100.0/24,203.0.113.0/24,224.0.0.0/4,240.0.0.0/4'
STATE=/private/var/db/case-macos-vm
GUEST_RUNNER_VERSION=2.338.0
GUEST_RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
DAEMON=app.iatrogenic.case-macos-vm
PLIST=/Library/LaunchDaemons/$DAEMON.plist
# Directory-service record root, not a machine checkout path.
DS_USERS=/Users
GUEST_RUNNER_HOME=/private/var/case-vm-runner
# Julian approved (2026-10-18) Apple's catalog image macOS 27.0.1 / 26A434, Apple's published SHA-256.
APPROVED_GUEST_VERSION=27.0.1
APPROVED_GUEST_BUILD=26A434
APPROVED_IPSW_SHA256=2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1
APPROVED_IPSW_BYTES=26637307067
# Staged after install-host: Tart reads the image as the service account (stage-ipsw, remove-ipsw).
IPSW_NAME=UniversalMac_27.0.1_26A434_Restore.ipsw
IPSW_DIR=$STATE/ipsw
IPSW_PATH=$IPSW_DIR/$IPSW_NAME
# Known-answer isolation canaries listen on this host port (host-helper, case-network-canary.mjs).
CANARY_PORT=18443
# Softnet's DHCP names the blocked gateway as DNS. The base image pins these public resolvers instead.
GUEST_DNS='1.1.1.1 9.9.9.9'
GUEST_DNS_CSV=1.1.1.1,9.9.9.9
# The one hosted macos-bash32 reference inventory: run/job, image, OS and runner version.
HOSTED_REFERENCE=39100396720/117595552764
HOSTED_REFERENCE_TEXT='hosted run 39100396720/job 117595552764: image macos-26-arm64 20261013.0424.1, macOS 26.6.2 build 25G83, runner 2.337.0'
# Free space required on the service volume before creating the base from the 26.64 GB image.
CREATE_FREE_KB=125829120
CONSOLE_FILE=$SERVICE_HOME/console-vnc.txt
COORDINATION_HOLD=/private/var/run/case-ci-coordination/hold
# Guest admission socket directory (CASE-300): persistent, root:wheel 0755 under root-only parents.
GATE_RUN_DIR=/private/var/db/case-macos-vm-run
GATE_LABEL=app.iatrogenic.case-macos-gate
GATE_PLIST=/Library/LaunchDaemons/$GATE_LABEL.plist

die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'TEXT'
usage: /bin/bash scripts/setup-case-macos-vm.sh plan|owner-guide|manual-guest|lifecycle-guide|guest-probe
       /bin/bash scripts/setup-case-macos-vm.sh commands --ipsw /absolute/image.ipsw --sha256 <approved 64 lowercase hex>
       /bin/bash scripts/setup-case-macos-vm.sh console-commands case-macos-base|case-macos-1|case-macos-rebase
       /bin/bash scripts/setup-case-macos-vm.sh clone-commands
       /bin/bash scripts/setup-case-macos-vm.sh host-helper --repo /absolute/Case --node /absolute/node --runner-archive /absolute/runner.tar.gz --guest-ip <private IPv4> --guest-admin <name>
These print only. commands also reads and hashes the supplied local IPSW.
Owner-run phases, in order (root-owned reviewed copy and sudo required):
  host   install-host --tart-archive /absolute/tart.tar.gz --softnet-archive /absolute/softnet.tar.gz
  host   stage-ipsw --ipsw /absolute/downloaded.ipsw, then the reviewed commands output (base, console)
  both   host-helper canary-up and push (setup admin's temporary Remote Login), then receive in the guest
  guest  guest-bootstrap --inside-guest --management-public-key /absolute/control.pub --runner-archive /absolute/runner.tar.gz
  host   configure-guest --host-key /absolute/ssh_host_ed25519_key.pub
  host   probe-host (a probe fix before seal-guest: host-helper push-script, then refresh-guest-probe)
  guest  update-guest-lifecycle --inside-guest ... (a gate/peer fix in an unregistered guest; see push-script)
  host   refresh-host-network (no VM running; re-stages the Softnet helpers, then re-prove isolation)
  guest  install-guest-lifecycle --inside-guest --gate-source /protected/case-macos-gate.mjs --peer-source /protected/case-macos-peer.c
  guest  seal-guest --inside-guest --isolation-evidence /protected/isolation.json
  guest  enable-guest-gate --inside-guest
  host   seal-base, then the reviewed clone-commands output
  host   rebase-clone [--delete-stopped-working-clone], then reseal-base --gate-sha256 <reviewed> --peer-source-sha256 <reviewed> [--check-only]; rollback-base --confirm-rollback
  guest  prepare-registration --inside-guest, then seal-registration --inside-guest, then enable-guest-gate --inside-guest
  host   install-host-lifecycle --owner-evidence /protected/isolation.json
  host   install-owner-status --owner <login> (one password-free read-only gate status for the owner, CASE-307); uninstall-owner-status removes it
  host   remove-ipsw (after the first qualification passes)
  host   uninstall-host --confirm-remove-case-macos-vm
Read-only generators: softnet-shim|softnet-root|socket-probe|guest-management|guest-root-probe|supervisor|cleanup|guest-status|host-plist|guest-gate-plist
The bare install/start/register/activate/uninstall aliases refuse. Activation is a separate reviewed owner change.
TEXT
}

plan() {
  cat <<TEXT
status        SOURCE ONLY: installation/probes are owner-run; no live qualified runner
host          Apple Silicon macOS, dedicated non-admin $SERVICE_USER; no host Actions runner
home          $SERVICE_HOME, private service group, mode 700; no owner credentials
software      Tart $TART_VERSION archive sha256 $TART_ARCHIVE_SHA256
network       Softnet $SOFTNET_VERSION archive sha256 $SOFTNET_ARCHIVE_SHA256
image         Apple catalog macOS $APPROVED_GUEST_VERSION/$APPROVED_GUEST_BUILD, SHA-256 $APPROVED_IPSW_SHA256; latest/OCI/other images refused
licence       macOS SLA counted conservatively: base plus working clone = 2 VMs; delete the clone before any rebuild
vm            case-macos-base (stopped clean base), case-macos-1 (one working VM)
resources     one active VM, 4 vCPU, 8192 MiB RAM, 80 GB sparse disk; measure under normal load
guest         non-admin runner, no sudo; separate provisioning admin; system /bin/bash 3.2
labels        proposed self-hosted, macOS, ARM64, case-macos-vm; no runner registration here
devices       no shared directories/disks, clipboard, audio, USB, bridge, port exposure or guest agent
egress        Softnet outside guest; explicit @host and private/special IPv4 block; IPv6 proof pending
dns           guest resolvers pinned to $GUEST_DNS_CSV in the base image (DHCP names the blocked gateway)
console       loopback-only Virtualization.framework VNC, URL in a mode 0600 service file; bind address checked
lifecycle     owner-run authenticated admission, cleanup, protected base and a daily idle reset after 00:00 UTC (08:00 AWST); services disabled by default
scope         macos-bash32 only; Linux perf/nightly reference and monthly budget redesign unchanged
TEXT
}

owner_guide() {
  cat <<TEXT
OWNER PROCEDURE / MISSING PREREQUISITES (this tool does not perform these steps)
1. Licences. Julian approved (2026-10-18) the macOS SLA reading: up to two extra macOS VMs on Apple
   hardware for development and testing, counted conservatively as base plus working clone = 2.
   Delete the working clone before creating any new base. Tart and Softnet are FSL-1.1-ALv2
   (internal use). This is not legal advice; the installed Apple agreement controls.
2. Image. Julian approved Apple's catalog image macOS $APPROVED_GUEST_VERSION / $APPROVED_GUEST_BUILD,
   $APPROVED_IPSW_BYTES bytes, Apple-published SHA-256 $APPROVED_IPSW_SHA256.
   Before downloading, confirm at least 150 GiB free on the data volume (df -h /System/Volumes/Data).
   Hash the download locally. After install-host, stage-ipsw copies it to $IPSW_DIR,
   root:$SERVICE_USER mode 0440: Tart reads it as the service account, which cannot change it.
   No mirror, older media or other build: stage-ipsw and commands refuse any other hash.
   Delete the IPSW after the first qualification passes (remove-ipsw). A catalog hash proves bytes,
   not compatibility.
3. Verify the two pinned release archives before staging the signed Tart app and Softnet under
   the root-owned LIBEXEC path printed by plan. brew install openai/tools/tart is a floating
   formula, not a release pin, and does not install this service layout.
4. Review/copy this tool to a root-owned path, then install-host stages the hidden non-admin host
   service account, private home/group, root-owned app/helper and DISABLED LaunchDaemon.
   No general sudo or sudoers wildcard. Softnet requires privilege to create its network, then
   drops it; review its narrowly restricted root-owned helper. The Linux account stays independent.
5. Review generated commands before running them. The hidden service account has no WindowServer,
   so the console is Tart's Virtualization.framework VNC (console-commands): headless, URL written to
   a mode 0600 service file, and the VM is stopped unless every listener is bound to loopback.
   No password/token in command arguments, image, host keychain, shared folder or source control.
6. INSIDE THE GUEST ONLY: create a separate provisioning admin. guest-bootstrap creates the runner
   and management accounts; do not precreate them. Install Command Line Tools and Postgres 16 under
   /opt/homebrew/opt/postgresql@16 first; guest-bootstrap stages the verified macOS ARM64 Actions
   package and pins guest DNS to $GUEST_DNS_CSV. Preinstall tools so jobs need no sudo/Homebrew write.
   Do not register a runner yet. Do not import an Apple ID, SSH keys or personal gh credentials.
   Files reach the guest once, by host-helper push over the setup admin's temporary Remote Login.
7. INSIDE THE GUEST ONLY: after confirming this is the VM console, create the root-owned role marker
   /Library/Application Support/Case CI/vm-role containing exactly case-macos-vm plus a newline,
   mode 0444. It prevents an accidental inventory run on an ordinary host; it is NOT attestation.
   Review/run the guest-probe template as runner. It checks inventory only, not network isolation.
8. Prove host/LAN/peer isolation with known-answer listeners and recorded positive controls (host-helper
   and case-network-canary.mjs serve the canaries and check them before and after), with
   the final Softnet policy enabled. Test root and runner in the guest, host loopback via gateway,
   host LAN addresses, peer Linux VMs, private ranges, IPv6, and permitted public GitHub/npm access.
   IPv4 blocks do not prove IPv6 denial. No host mounts/guest agent/clipboard/forwarded credentials.
   Record the router's public IPv4 address as the guest's expected egress. Refuse registration if
   any proof is absent. Plain NAT or plain Softnet is not sufficient.
9. Review lifecycle-guide and the implemented guest gate/cleanup, protected base and the daily idle
   reset after 00:00 UTC (08:00 AWST). Low disk drains; offline/unknown recovery stays closed.
   FileVault needs owner login. Runner registration records are readable by jobs and persist until
   re-registration (lifecycle-guide RE-REGISTRATION). A per-job disposable VM plus ephemeral/JIT
   registration is stronger and needs a separate broker design. Never put registration credentials
   in the clean image or silently add a long-lived PAT.
10. Julian registers only inside the proved guest, using GitHub's macOS ARM64 setup page and an
    interactive config.sh prompt. Tokens stay in that terminal. No registration/activation command
    exists in the preparation aliases. Follow lifecycle-guide only after physical isolation proof.
11. Qualify the unchanged full Mac lane at an exact SHA, including real Postgres tests and bash 3.2,
    compare hosted counts/results and repeat under normal mini load. Never weaken a failing gate.
    Queue/offline/probe failures stay pending/failed; any hosted rollback is an owner cost decision.
12. Removal: uninstall-host --confirm-remove-case-macos-vm, after the VM is stopped. Remove the
    runner in GitHub settings yourself; the tool holds no GitHub credential.
TEXT
}

validate_image() {
  [ -n "$1" ] && [ -n "$2" ] || die '--ipsw and --sha256 are both required'
  case "$1" in /*.ipsw) ;; *) die '--ipsw must be an absolute local .ipsw path' ;; esac
  # Deliberately narrow input language: paths may contain spaces, but not shell/control characters.
  case "$1" in *[!a-zA-Z0-9_./\ -]*|*/../*|*/./*) die 'unsafe IPSW path' ;; esac
  [ ! -L "$1" ] && [ -f "$1" ] && [ -r "$1" ] && [ -s "$1" ] || die 'IPSW must be a non-empty readable regular file, not a symlink'
  [ "${#2}" -eq 64 ] || die '--sha256 must be 64 lowercase hexadecimal characters'
  case "$2" in *[!a-f0-9]*) die '--sha256 must be 64 lowercase hexadecimal characters' ;; esac
  [ "$2" = "$APPROVED_IPSW_SHA256" ] || die "only the approved macOS $APPROVED_GUEST_VERSION/$APPROVED_GUEST_BUILD image hash is accepted"
  local actual
  actual=$(shasum -a 256 "$1") || die 'cannot hash IPSW'
  actual=${actual%% *}
  [ "$actual" = "$2" ] || die 'IPSW SHA-256 mismatch; no commands generated'
}

commands() {
  local ipsw='' digest='' key lan=0
  while [ "$#" -gt 0 ]; do
    key="$1"; shift
    if [ "$key" = --accept-lan-vnc ]; then [ "$lan" = 0 ] || die 'duplicate --accept-lan-vnc'; lan=1; continue; fi
    [ "$#" -gt 0 ] || die 'each image option requires a value'
    case "$key" in
      --ipsw) [ -z "$ipsw" ] || die 'duplicate --ipsw'; ipsw="$1" ;;
      --sha256) [ -z "$digest" ] || die 'duplicate --sha256'; digest="$1" ;;
      *) die 'unknown image option; only --ipsw, --sha256 and --accept-lan-vnc are supported' ;;
    esac
    shift
  done
  validate_image "$ipsw" "$digest"
  cat <<TEXT
#!/bin/bash
# REVIEW ONLY; generated commands are NOT an installer or an isolation/qualification proof.
# Owner must first complete owner-guide steps 1-5 and install the service account/helper/layout.
# Save to a root-owned file, review it, then run it with sudo; only Tart runs as $SERVICE_USER.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
TEXT
  # Fail again on a changed image when the owner later executes these commands.
  printf 'image=%q\nexpected=%q\n' "$ipsw" "$digest"
  cat <<TEXT
actual=\$(shasum -a 256 "\$image")
actual=\${actual%% *}
[ "\$actual" = "\$expected" ] || { echo 'IPSW hash changed' >&2; exit 1; }
[ "\$(id -u)" = 0 ] || { echo 'Run this reviewed root-owned copy with sudo' >&2; exit 1; }
# Tart creates the base as the service account: it must read the staged image and never write it.
sudo -u '$SERVICE_USER' /bin/test -r "\$image" || { echo 'The service account cannot read the image; use stage-ipsw' >&2; exit 1; }
if sudo -u '$SERVICE_USER' /bin/test -w "\$image"; then echo 'The service account can write the image; use stage-ipsw' >&2; exit 1; fi
[ -x '$TART_BIN' ] && [ -x '$LIBEXEC/softnet' ] || { echo 'Missing reviewed root-owned Tart/Softnet layout; complete owner-guide' >&2; exit 1; }
/usr/bin/id '$SERVICE_USER' >/dev/null || { echo 'Missing reviewed service account; complete owner-guide' >&2; exit 1; }
free_kb=\$(df -Pk /private/var | awk 'NR==2 {print \$4}')
[[ "\$free_kb" =~ ^[0-9]+\$ ]] && [ "\$free_kb" -ge $CREATE_FREE_KB ] || { echo 'Less than 120 GiB free for the macOS install, clone and 40 GiB reset floor' >&2; exit 1; }
# SLA count (base plus clone = 2): no other local VM may exist when a new base is created.
listing=\$(sudo -u '$SERVICE_USER' /usr/bin/env TART_HOME='$SERVICE_HOME/.tart' PATH='$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' list --source local --format json)
if printf '%s\\n' "\$listing" | plutil -extract 0.Name raw -o - - >/dev/null 2>&1; then echo 'Delete the existing clone and base before creating a new base' >&2; exit 1; fi
# Release versions, signatures, root ownership, account permissions and helper privilege must also
# be proved by the owner procedure. The following commands alone do NOT establish those controls.
sudo -u '$SERVICE_USER' /usr/bin/env TART_HOME='$SERVICE_HOME/.tart' PATH='$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' create --from-ipsw="\$image" --disk-size=80 case-macos-base
sudo -u '$SERVICE_USER' /usr/bin/env TART_HOME='$SERVICE_HOME/.tart' PATH='$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' set case-macos-base --cpu=4 --memory=8192
TEXT
  console_block case-macos-base "$lan"
  cat <<TEXT
# STOP after provisioning. Shut down the guest from its console, delete $CONSOLE_FILE, then
# follow lifecycle-guide. The base is not a registered runner. No host directory shares.
# Registration, startup supervision, reset, network proofs and workflow activation remain absent.
TEXT
}

# Headless console for a hidden service account, which has no WindowServer for Tart's window.
console_block() {
  cat <<TEXT
# Console for $1$([ "${3:-0}" = 1 ] && printf ' in recoveryOS'): Virtualization.framework VNC. Tart $TART_VERSION prints a vnc:// URL with a one-time
# password; it sets no bind address, so the listener is on every interface. Without the owner's
# --accept-lan-vnc, every service listener must be loopback or the VM stops.
console='$CONSOLE_FILE'
sudo -u '$SERVICE_USER' /bin/bash -c 'umask 077; rm -f "\$1"; : > "\$1"' case-console "\$console"
sudo -u '$SERVICE_USER' /bin/bash -c 'umask 077; exec /usr/bin/env TART_HOME="\$1" PATH="\$2" "\$3" run --no-graphics --vnc-experimental --no-clipboard --no-audio --no-usb-accessories --net-softnet-allow="$NETWORK_ALLOW" --net-softnet-block="out \$4"$([ "${3:-0}" = 1 ] && printf ' --recovery') "\$5" >> "\$6" 2>&1' case-console '$SERVICE_HOME/.tart' '$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' '$NETWORK_BLOCK' '$1' "\$console" &
url=''
attempt=0
while [ "\$attempt" -lt 90 ] && [ -z "\$url" ]; do
  sleep 2; attempt=\$((attempt + 1))
  url=\$(sudo -u '$SERVICE_USER' /usr/bin/sed -n 's|^VNC server is running at \(vnc://.*\)\$|\1|p' "\$console")
done
stop_console() { sudo -u '$SERVICE_USER' /usr/bin/env TART_HOME='$SERVICE_HOME/.tart' PATH='$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' stop '$1' || true; echo "STOPPED: \$1" >&2; exit 1; }
case "\$url" in vnc://:*@127.0.0.1:[0-9]*) ;; *) stop_console 'no loopback VNC URL; VM stopped' ;; esac
listeners=\$(sudo /usr/sbin/lsof -nP -a -u '$SERVICE_USER' -iTCP -sTCP:LISTEN -F n | sed -n 's/^n//p')
[ -n "\$listeners" ] || stop_console 'no VNC listener found; VM stopped'
TEXT
  if [ "${2:-0}" = 1 ]; then
    cat <<TEXT
# Owner-accepted (Julian, 2026-10-19, CASE-298): Tart's VNC server listens on every interface, so
# the console is reachable from the LAN while this VM runs. Nothing but that one port may listen.
port=\${url##*:}
case "\$port" in ''|*[!0-9]*) stop_console 'unparseable VNC port; VM stopped' ;; esac
while IFS= read -r address; do
  case "\$address" in "127.0.0.1:\$port"|"[::1]:\$port"|"*:\$port") ;; *) stop_console "listener \$address is not the VNC port; VM stopped" ;; esac
done <<LISTENERS
\$listeners
LISTENERS
unset url port
echo 'Console reachable from the LAN while this VM runs (owner-accepted, CASE-298). Shut the guest down when you finish.'
echo 'On this Mac: sudo cat the console file, open its vnc:// URL in Screen Sharing. Never paste that URL into chat.'
echo 'Delete the console file after the guest shuts down.'
TEXT
    return
  fi
  cat <<TEXT
# Bind check: every TCP listener of the service account (Tart's VNC server) must be loopback only.
while IFS= read -r address; do
  case "\$address" in 127.0.0.1:[0-9]*|'[::1]':[0-9]*) ;; *) stop_console "listener \$address is not loopback; VM stopped" ;; esac
done <<LISTENERS
\$listeners
LISTENERS
unset url
echo 'Console on loopback only. On this Mac: sudo cat the console file, open its vnc:// URL in Screen Sharing.'
echo 'Never paste that URL into chat. Delete the console file after the guest shuts down.'
TEXT
}

console_commands() {
  local vm="${1:-}" lan=0 recovery=0 option
  [ "$#" -ge 1 ] && [ "$#" -le 3 ] || die 'console-commands needs one VM name, optionally --accept-lan-vnc and --recovery'
  case "$vm" in case-macos-base|case-macos-1|case-macos-rebase) ;; *) die 'console-commands accepts case-macos-base, case-macos-1 or case-macos-rebase' ;; esac
  shift
  for option in "$@"; do
    case "$option" in
      --accept-lan-vnc) [ "$lan" = 0 ] || die 'duplicate --accept-lan-vnc'; lan=1 ;;
      --recovery) [ "$recovery" = 0 ] || die 'duplicate --recovery'; recovery=1 ;;
      *) die 'unknown console option' ;;
    esac
  done
  # recoveryOS is for finishing the unregistered base's setup only (CASE-299), never the registered clone.
  [ "$recovery" = 0 ] || [ "$vm" = case-macos-base ] || die '--recovery is for case-macos-base only'
  set -- "$vm"
  cat <<TEXT
#!/bin/bash
# REVIEW ONLY. Boots $1 headless with a loopback VNC console for owner provisioning/registration.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ -x '$TART_BIN' ] && [ -x '$LIBEXEC/softnet' ] || { echo 'Missing reviewed root-owned Tart/Softnet layout; complete owner-guide' >&2; exit 1; }
TEXT
  console_block "$1" "$lan" "$recovery"
}

# Never echo supplied options: these entry points do not accept credentials, commands or paths to run.
absolute_file() {
  case "$1" in /*) ;; *) die 'expected an absolute local file path' ;; esac
  case "$1" in *[!a-zA-Z0-9_./\ -]*|*/../*|*/./*) die 'unsafe input path' ;; esac
  [ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ] && [ -s "$1" ] || die 'expected a non-empty readable regular file, not a symlink'
}
root_path() {
  local p="$1" owner mode
  while :; do
    [ ! -L "$p" ] || die 'privileged path contains a symlink'
    [ -e "$p" ] || die 'privileged path is missing'
    owner=$(stat -f '%u' "$p"); mode=$(stat -f '%Lp' "$p")
    case "$(/bin/ls -ld "$p" | awk '{print $1}')" in *+*) die 'ACL on privileged path requires owner review' ;; esac
    [ "$owner" = 0 ] && [ "$((8#$mode & 022))" -eq 0 ] || die 'privileged path must be root-owned and not group/world writable'
    [ "$p" != / ] || break
    p=${p%/*}; [ -n "$p" ] || p=/
  done
}
owner_root() {
  [ "$(id -u)" -eq 0 ] || die 'owner-run phase requires sudo and a reviewed root-owned copy'
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die 'owner-run phase requires Apple Silicon macOS'
  case "$(sw_vers -productVersion)" in 2[6-9].*|[3-9][0-9].*) ;; *) die 'macOS 26 or later is required by the pinned Softnet' ;; esac
  local self
  case "$0" in /*) self="$0" ;; *) self="$(pwd -P)/$0" ;; esac
  root_path "$self"
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || die 'run from the owner terminal through sudo'
}
free_id() {
  local kind="$1" field="$2" n=650
  while [ "$n" -lt 10000 ]; do
    if [ -z "$(dscl . -search "/$kind" "$field" "$n")" ]; then printf '%s\n' "$n"; return; fi
    n=$((n + 1))
  done
  die 'no free directory-service identifier'
}
no_sudo_rules() {
  local result=0 rules
  rules=$(sudo -n -l -U "$1" 2>&1) || result=$?
  # sudo 1.9.17 (macOS 27) exits 0 for a user without rules; older releases exit 1. The proof is the
  # exact one-line refusal for this user, never a listing.
  [ "$result" = 0 ] || [ "$result" = 1 ] || die 'service identity has sudo rules or its policy cannot be inspected'
  case "$rules" in *$'\n'*) ;; "User $1 is not allowed to run sudo on "*.) return 0 ;; esac
  die 'cannot prove service identity has no existing sudo permissions'
}
ensure_user() {
  local user="$1" home="$2" shell="$3" gid uid
  if ! dscl . -read "/Groups/$user" PrimaryGroupID >/dev/null 2>&1; then
    gid=$(free_id Groups PrimaryGroupID)
    dscl . -create "/Groups/$user"; dscl . -create "/Groups/$user" PrimaryGroupID "$gid"
  fi
  gid=$(dscl . -read "/Groups/$user" PrimaryGroupID | awk '{print $2}')
  if ! id "$user" >/dev/null 2>&1; then
    uid=$(free_id Users UniqueID)
    dscl . -create "$DS_USERS/$user"
    dscl . -create "$DS_USERS/$user" UniqueID "$uid"
    dscl . -create "$DS_USERS/$user" PrimaryGroupID "$gid"
    dscl . -create "$DS_USERS/$user" NFSHomeDirectory "$home"
    dscl . -create "$DS_USERS/$user" UserShell "$shell"
    dscl . -create "$DS_USERS/$user" Password '*'
    dscl . -create "$DS_USERS/$user" IsHidden 1
  fi
  [ "$(id -u "$user")" -ge 650 ] && [ "$(id -g "$user")" = "$gid" ] || die 'existing service identity differs from the reviewed account'
  [ "$(dscl . -read "$DS_USERS/$user" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')" = "$home" ] || die 'existing service home differs'
  [ "$(dscl . -read "$DS_USERS/$user" UserShell | sed 's/^UserShell: //')" = "$shell" ] || die 'existing service shell differs'
  case " $(id -Gn "$user") " in *' admin '*|*' wheel '*) die 'service account has privileged group membership' ;; esac
  no_sudo_rules "$user"
}
as_service() { sudo -u "$SERVICE_USER" -H "$@"; }

softnet_shim() {
  cat <<TEXT
#!/bin/bash
# Tart's verified argv/socket interface. Never accepts caller-supplied privilege or network policy.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "\$#" -eq 8 ] || exit 64
[ "\$1" = --vm-fd ] && [ "\$2" = 0 ] && [ "\$3" = --vm-mac-address ] || exit 64
[ "\$5" = --allow ] && [ "\$6" = '$NETWORK_ALLOW' ] || exit 64
[ "\$7" = --block ] && [ "\$8" = 'out $NETWORK_BLOCK' ] || exit 64
[[ "\$4" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}\$ ]] || exit 64
# sudo's command is one immutable path. Root validates this one non-secret MAC argument again.
exec /usr/bin/sudo -n '$LIBEXEC/softnet-root' "\$4"
TEXT
}
softnet_root() {
  cat <<TEXT
#!/bin/bash -p
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "\$(id -u)" = 0 ] && [ "\${SUDO_USER:-}" = '$SERVICE_USER' ] || exit 77
[ "\$#" -eq 1 ] || exit 64
[[ "\$1" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}\$ ]] || exit 64
'$LIBEXEC/socket-probe' || { echo 'Softnet requires a connected Unix datagram VM socket on stdin' >&2; exit 78; }
# No SUID bit; no --user/--group, FD, exposure, allow or block value is supplied by a job/caller.
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin '$LIBEXEC/softnet-binary' \\
  --vm-fd 0 --vm-mac-address "\$1" --user '$SERVICE_USER' --group '$SERVICE_USER' \\
  --allow '$NETWORK_ALLOW' --block 'out $NETWORK_BLOCK'
TEXT
}

socket_probe() {
  cat <<'C'
/* Read-only descriptor check. Does not receive packets or open any caller-selected object. */
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 64;
  int type = 0;
  socklen_t length = sizeof(type);
  struct sockaddr_storage peer;
  socklen_t peer_length = sizeof(peer);
  if (getsockopt(STDIN_FILENO, SOL_SOCKET, SO_TYPE, &type, &length) != 0) return 78;
  if (type != SOCK_DGRAM) return 78;
  if (getpeername(STDIN_FILENO, (struct sockaddr *)&peer, &peer_length) != 0) return 78;
  return peer.ss_family == AF_UNIX ? 0 : 78;
}
C
}

archive_members() {
  local members types line
  members=$(tar -tzf "$1") || die 'cannot inspect archive member paths'
  [ -n "$members" ] || die 'empty archive'
  while IFS= read -r line; do
    case "$line" in ''|/*|../*|*/../*|*/..|*\\*|*$'\r'*|*$'\t'*) die 'unsafe archive member path' ;; esac
  done <<TEXT
$members
TEXT
  types=$(tar -tvzf "$1") || die 'cannot inspect archive member types'
  while IFS= read -r line; do
    case "$line" in
      -*|d*) ;;
      l*)
        # Exact pinned runner CLI links are safe only in the UNPRIVILEGED runner extraction below.
        [ "${2:-}" = runner ] || die 'archive links and special members are refused'
        case "$line" in
          *' ./externals/node20/bin/corepack -> ../lib/node_modules/corepack/dist/corepack.js'|*' ./externals/node24/bin/corepack -> ../lib/node_modules/corepack/dist/corepack.js'|*' ./externals/node20/bin/npx -> ../lib/node_modules/npm/bin/npx-cli.js'|*' ./externals/node24/bin/npx -> ../lib/node_modules/npm/bin/npx-cli.js'|*' ./externals/node20/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js'|*' ./externals/node24/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js') ;;
          *) die 'unexpected runner archive link' ;;
        esac ;;
      *) die 'archive links and special members are refused' ;;
    esac
  done <<TEXT
$types
TEXT
}

supervisor_template() {
  cat <<'TEXT' | sed -e "s|@NETWORK_BLOCK@|$NETWORK_BLOCK|g" -e "s|@NETWORK_ALLOW@|$NETWORK_ALLOW|g"
#!/bin/bash
# Owner-installed controller. No credentials/guest-supplied shell commands; Tart runs unprivileged.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL
LIB=/usr/local/libexec/case-macos-vm
STATE=/private/var/db/case-macos-vm
HOME_DIR=/private/var/case-macos-runner
TART=$LIB/tart.app/Contents/MacOS/tart
export TART_HOME=$HOME_DIR/.tart
export TART_NO_AUTO_PRUNE=1
export PATH=$LIB:/usr/bin:/bin:/usr/sbin:/sbin
stop() { printf 'STOPPED: %s\n' "$*" >&2; exit 78; }
json() { /usr/bin/plutil -extract "$1" raw -o - -; }
protected() {
  local p="$1" owner mode
  while :; do
    [ -e "$p" ] && [ ! -L "$p" ] || return 1
    owner=$(stat -f '%u' "$p"); mode=$(stat -f '%Lp' "$p")
    case "$(/bin/ls -ld "$p" | awk '{print $1}')" in *+*) return 1 ;; esac
    [ "$owner" = 0 ] && [ "$((8#$mode & 022))" = 0 ] || return 1
    [ "$p" != / ] || break
    p=${p%/*}; [ -n "$p" ] || p=/
  done
}
# Missing approval is a hard stop before user, network, VM, lock or state mutations.
protected "$STATE/host-sealed.json" || stop 'owner-reviewed root-controlled admission/drain and isolation/base approval missing'
[ "$(id -un)" = case-macos-runner ] && [ "$(id -u)" != 0 ] || stop 'run only as dedicated non-admin Mac VM service'
[ "$(json version < "$STATE/host-sealed.json")" = 1 ] || stop 'unsupported host seal'
for path in "$TART" "$LIB/softnet" "$STATE/known-hosts" "$STATE/base.sha256" "$STATE/base/config.json" "$STATE/base/disk.img" "$STATE/base/nvram.bin"; do protected "$path" || stop 'unprotected controller prerequisite'; done
umask 077
lock_inode=''; lock_nonce=''; lock_owned=0
release_lock() {
  if [ "$lock_owned" = 1 ] && [ -d /tmp/case-heavy.lock ] && [ ! -L /tmp/case-heavy.lock ] && [ "$(stat -f '%i:%u' /tmp/case-heavy.lock)" = "$lock_inode" ] && [ -f /tmp/case-heavy.lock/macos-owner ] && [ ! -L /tmp/case-heavy.lock/macos-owner ] && [ "$(cat /tmp/case-heavy.lock/macos-owner)" = "$lock_nonce" ]; then
    rm /tmp/case-heavy.lock/macos-owner
    rmdir /tmp/case-heavy.lock || true
  fi
  lock_owned=0
}
trap release_lock EXIT
trap 'exit 78' TERM INT HUP
acquire_lock() {
  # Existing local/heavy/perf work always wins. No stale-lock removal or blocking spin.
  # The coordination hold is an owner-created empty file that defers every reset while it exists.
  [ ! -e /private/var/run/case-ci-coordination/hold ] || return 1
  mkdir -m 700 /tmp/case-heavy.lock 2>/dev/null || return 1
  lock_inode=$(stat -f '%i:%u' /tmp/case-heavy.lock)
  lock_nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s\n' "$lock_nonce" > /tmp/case-heavy.lock/macos-owner
  lock_owned=1
  # Recheck a concurrent coordinator hold after acquiring the existing heavy lock.
  if [ -e /private/var/run/case-ci-coordination/hold ]; then release_lock; return 1; fi
}
free_space() {
  local kb
  kb=$(df -Pk "$HOME_DIR" | awk 'NR==2 {print $4}')
  [[ "$kb" =~ ^[0-9]+$ ]] && [ "$kb" -ge 41943040 ]
}
vm_state() {
  local name="$1" listing i found
  listing=$("$TART" list --source local --format json) || return 1
  i=0
  while [ "$i" -lt 20 ]; do
    found=$(printf '%s\n' "$listing" | json "$i.Name" 2>/dev/null) || break
    if [ "$found" = "$name" ]; then printf '%s\n' "$listing" | json "$i.State"; return; fi
    i=$((i + 1))
  done
  printf '%s\n' absent
}
ssh_gate() {
  local ip
  ip=$("$TART" ip --resolver dhcp --wait 5 case-macos-1) || return 1
  # Transport is pinned to a key/alias, not a DHCP address. No TOFU, forwarding or guest agent.
  [[ "$ip" =~ ^(10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)$ ]] || return 1
  /usr/bin/ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=case-macos-vm -o "UserKnownHostsFile=$STATE/known-hosts" -o GlobalKnownHostsFile=/dev/null -o ForwardAgent=no -o ClearAllForwardings=yes -i "$HOME_DIR/.ssh/control" "case-vm-control@$ip" gate
}
request() { printf '{"op":"%s"}\n' "$1" | ssh_gate; }
check_reply() {
  local reply="$1"
  [ "$(printf '%s\n' "$reply" | json ok)" = true ] && [ "$(printf '%s\n' "$reply" | json protocol)" = 1 ]
}
claim_hold() {
  local reply="$1" current
  hold_generation=$(printf '%s\n' "$reply" | json generation)
  [[ "$hold_generation" =~ ^[a-f0-9]{32}$ ]] || return 1
  current=$(printf '%s\n' "$reply" | json hold) || return 1
  if [ -n "$current" ]; then
    [ -f "$HOME_DIR/controller-hold.json" ] && [ ! -L "$HOME_DIR/controller-hold.json" ] || return 1
    [ "$(json generation < "$HOME_DIR/controller-hold.json")" = "$hold_generation" ] && [ "$(json nonce < "$HOME_DIR/controller-hold.json")" = "$current" ] || return 1
    hold_nonce="$current"
  else
    hold_nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    printf '{"generation":"%s","nonce":"%s"}\n' "$hold_generation" "$hold_nonce" > "$HOME_DIR/controller-hold.pending"
    chmod 600 "$HOME_DIR/controller-hold.pending"
    mv "$HOME_DIR/controller-hold.pending" "$HOME_DIR/controller-hold.json"
  fi
  printf '{"op":"close","generation":"%s","nonce":"%s"}\n' "$hold_generation" "$hold_nonce" | ssh_gate
}
reopen_hold() {
  local reply
  reply=$(printf '{"op":"reopen","generation":"%s","nonce":"%s"}\n' "$hold_generation" "$hold_nonce" | ssh_gate) || return 1
  [ "$(printf '%s\n' "$reply" | json ok)" = true ] && [ "$(printf '%s\n' "$reply" | json mode)" = OPEN ] || return 1
  rm -f "$HOME_DIR/controller-hold.json"
}
close_guest() {
  local reply until leave_closed="${1:-false}"
  reply=$(request status) || return 1; check_reply "$reply" || return 1
  reply=$(claim_hold "$reply") || return 1
  # claim_hold runs in a subshell capture; load the durable non-secret ownership record locally.
  hold_generation=$(json generation < "$HOME_DIR/controller-hold.json")
  hold_nonce=$(json nonce < "$HOME_DIR/controller-hold.json")
  check_reply "$reply" || return 1
  until=$(( $(date +%s) + 900 ))
  while :; do
    reply=$(request status) || return 1; check_reply "$reply" || return 1
    [ "$(printf '%s\n' "$reply" | json generation)" = "$hold_generation" ] && [ "$(printf '%s\n' "$reply" | json hold)" = "$hold_nonce" ] || return 1
    if [ "$(printf '%s\n' "$reply" | json drained)" = true ]; then
      if [ "$(printf '%s\n' "$reply" | json parked)" != 0 ]; then [ "$leave_closed" = false ] || return 1; reopen_hold || return 1; return 75; fi
      break
    fi
    if [ "$(date +%s)" -ge "$until" ]; then [ "$leave_closed" = false ] || return 1; reopen_hold || return 1; return 75; fi
    sleep 5
  done
  reply=$(request idle-stop) || return 1
  [ "$(printf '%s\n' "$reply" | json ok)" = true ] && [ "$(printf '%s\n' "$reply" | json stopped)" = true ] || return 1
}

backup_registration() {
  # Secrets are only a stream into a private file. No argv, environment, diagnostics or console copy.
  request registration-export > "$HOME_DIR/registration.pending" || { rm -f "$HOME_DIR/registration.pending"; return 1; }
  [ "$(wc -c < "$HOME_DIR/registration.pending")" -le 131072 ] && [ "$(json ok < "$HOME_DIR/registration.pending")" = true ] || return 1
  /usr/bin/plutil -extract bundle json -o /dev/null "$HOME_DIR/registration.pending" || return 1
  chmod 600 "$HOME_DIR/registration.pending"
  mv "$HOME_DIR/registration.pending" "$HOME_DIR/registration.json"
}
restore_registration() {
  [ -f "$HOME_DIR/registration.json" ] && [ ! -L "$HOME_DIR/registration.json" ] && [ "$(stat -f '%u:%Lp' "$HOME_DIR/registration.json")" = "$(id -u):600" ] || return 1
  local reply generation nonce
  reply=$(request status) || return 1; check_reply "$reply" || return 1
  reply=$(claim_hold "$reply") || return 1
  hold_generation=$(json generation < "$HOME_DIR/controller-hold.json")
  hold_nonce=$(json nonce < "$HOME_DIR/controller-hold.json")
  reply=$({ printf '{"op":"registration-import","bundle":'; /usr/bin/plutil -extract bundle json -o - "$HOME_DIR/registration.json"; printf '}\n'; } | ssh_gate) || return 1
  [ "$(printf '%s\n' "$reply" | json ok)" = true ] && [ "$(printf '%s\n' "$reply" | json restored)" = true ] || return 1
  request start >/dev/null || return 1
  local attempt=0
  while [ "$attempt" -lt 30 ]; do
    reply=$(request status) || return 1; check_reply "$reply" || return 1
    if [ "$(printf '%s\n' "$reply" | json listener)" = true ]; then break; fi
    sleep 1; attempt=$((attempt + 1))
  done
  [ "$attempt" -lt 30 ] || return 1
  reopen_hold
}
restore_base() {
  local part build
  # The clean reference is root-owned. Writable Tart base metadata is reconstructed unprivileged.
  (cd "$STATE/base" && shasum -a 256 -c "$STATE/base.sha256" >/dev/null) || return 1
  [ "$(vm_state case-macos-1)" = absent ] || return 1
  if [ "$(vm_state case-macos-base)" != absent ]; then
    [ "$(vm_state case-macos-base)" = stopped ] || return 1
    "$TART" delete case-macos-base || return 1
  fi
  build=$(mktemp -d "$TART_HOME/vms/.case-base.XXXXXX") || return 1
  for part in config.json disk.img nvram.bin; do /bin/cp -c -P "$STATE/base/$part" "$build/$part" || return 1; chmod u+w "$build/$part"; done
  mv "$build" "$TART_HOME/vms/case-macos-base" || return 1
  "$TART" clone case-macos-base case-macos-1
}
boot_working() {
  free_space || return 1
  # stdout is never a TTY: pinned Tart must never offer to set SUID on Softnet.
  "$TART" run --no-graphics --no-clipboard --no-audio --no-usb-accessories --net-softnet-allow='@NETWORK_ALLOW@' --net-softnet-block='out @NETWORK_BLOCK@' case-macos-1 > /dev/null 2> "$HOME_DIR/tart-last-error.log" &
  local attempt=0
  while [ "$attempt" -lt 90 ]; do
    if request status >/dev/null 2>&1; then return 0; fi
    sleep 2; attempt=$((attempt + 1))
  done
  # Loud, never a silent retry (CASE-301): admission stays closed and the owner inspects.
  printf '%s\n' 'ALERT case-macos-1 is unreachable from the host after boot; no retry, admission stays closed' >&2
  return 1
}
low_disk_fault() {
  # Closure is safe without the heavy lock; no VM start/stop/reset happens here.
  if [ "$(vm_state case-macos-1)" = running ]; then close_guest true || stop 'low disk; admission held closed, owner inspection required'; fi
  stop 'less than 40 GiB free; admission closed, owner must recover disk'
}
cycle_work() {
  free_space || low_disk_fault
  case "$(vm_state case-macos-1)" in
    running) if close_guest; then :; else return "$?"; fi
      backup_registration || return 1
      "$TART" stop --timeout 30 case-macos-1 || return 1
      [ "$(vm_state case-macos-1)" = stopped ] || return 1
      "$TART" delete case-macos-1 || return 1 ;;
    stopped) [ -f "$HOME_DIR/registration.json" ] || return 1
      "$TART" delete case-macos-1 || return 1 ;;
    absent) [ -f "$HOME_DIR/registration.json" ] || return 1 ;;
    *) return 1 ;;
  esac
  restore_base && boot_working && restore_registration || return 1
  date -u +%F > "$HOME_DIR/last-reset"
}
cycle() {
  acquire_lock || return 75
  local result=0
  cycle_work || result=$?
  release_lock
  return "$result"
}
case "${1:-}" in
  cycle-once) [ "$#" = 1 ] || stop 'unexpected controller arguments'; cycle || stop 'reset deferred/failed; no automatic busy cancellation' ;;
  supervise) [ "$#" = 1 ] || stop 'unexpected controller arguments'
    # The UTC date changes at 00:00 UTC = 08:00 AWST: one reset per day at the first idle moment.
    while :; do
      free_space || low_disk_fault
      if [ ! -f "$HOME_DIR/last-reset" ] || [ "$(cat "$HOME_DIR/last-reset")" != "$(date -u +%F)" ] || [ "$(vm_state case-macos-1)" != running ]; then
        if cycle; then :; else result=$?; [ "$result" = 75 ] || stop 'reset/recovery failed; owner inspection required'; fi
      fi
      sleep 60
    done ;;
  *) stop 'owner must choose cycle-once or supervise after lifecycle-guide' ;;
esac
TEXT
}

# launchd kills a stopped job's whole process group unless AbandonProcessGroup is set. Without it,
# stopping or restarting the host supervisor would kill Tart (the VM and any running job), and
# stopping the guest gate would kill the runner listener and its Worker. Both keep their children.
host_plist() {
  cat <<TEXT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$DAEMON</string><key>UserName</key><string>$SERVICE_USER</string>
<key>GroupName</key><string>$SERVICE_USER</string><key>Disabled</key><true/>
<key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$LIBEXEC/supervisor.sh</string></array>
</dict></plist>
TEXT
}
guest_gate_plist() {
  cat <<TEXT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>app.iatrogenic.case-macos-gate</string>
<key>Disabled</key><true/><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/>
<key>ProgramArguments</key><array><string>/opt/actions-runner/externals/node24/bin/node</string><string>$LIBEXEC/case-macos-gate.mjs</string><string>serve</string></array>
</dict></plist>
TEXT
}

install_host() {
  local tart_archive='' softnet_archive='' key stage owner_home developer
  while [ "$#" -gt 0 ]; do
    key="$1"; shift; [ "$#" -gt 0 ] || die 'archive option needs a value'
    case "$key" in
      --tart-archive) [ -z "$tart_archive" ] || die 'duplicate archive option'; tart_archive="$1" ;;
      --softnet-archive) [ -z "$softnet_archive" ] || die 'duplicate archive option'; softnet_archive="$1" ;;
      *) die 'unknown host staging option' ;;
    esac; shift
  done
  [ -n "$tart_archive" ] && [ -n "$softnet_archive" ] || die 'both pinned release archives are required'
  absolute_file "$tart_archive"; absolute_file "$softnet_archive"
  owner_root
  # Owner first stages these archives under a protected root-owned directory. Root never copies
  # from a caller-writable path or follows an archive-input symlink.
  root_path "$tart_archive"; root_path "$softnet_archive"
  [ ! -e "$LIBEXEC" ] && [ ! -e "$STATE" ] && [ ! -e "$SERVICE_HOME" ] && [ ! -e "$PLIST" ] || die 'staging already exists; refusing implicit repair/removal'
  [ ! -e /private/etc/sudoers.d/case-macos-softnet ] || die 'sudo policy already exists; review it manually'
  root_path /usr/local; root_path /private/var; root_path /Library/LaunchDaemons; root_path /private/etc/sudoers.d
  if [ -e /usr/local/libexec ] || [ -L /usr/local/libexec ]; then root_path /usr/local/libexec; fi
  owner_home=$(dscl . -read "$DS_USERS/$SUDO_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')
  [ -d "$owner_home" ] && [ "$(stat -f '%Lp' "$owner_home")" = 700 ] || die 'owner home must already be mode 700; this tool does not change it'
  developer=$(xcode-select -p) || die 'Command Line Tools are required for the descriptor validator'
  root_path "$developer"; [ -x /usr/bin/clang ] || die 'system clang is required'
  stage=$(mktemp -d /private/var/root/case-macos-stage.XXXXXX)
  trap "rm -rf '$stage'" EXIT
  # Hash the protected copies, closing the mutable-source verification/extraction gap.
  cp "$tart_archive" "$stage/tart.tar.gz"; cp "$softnet_archive" "$stage/softnet.tar.gz"
  printf '%s  %s\n' "$TART_ARCHIVE_SHA256" "$stage/tart.tar.gz" "$SOFTNET_ARCHIVE_SHA256" "$stage/softnet.tar.gz" | shasum -a 256 -c - >/dev/null || die 'pinned software archive hash mismatch; no account or policy installed'
  archive_members "$stage/tart.tar.gz"; archive_members "$stage/softnet.tar.gz"
  mkdir "$stage/tart" "$stage/softnet"
  tar -xzf "$stage/tart.tar.gz" -C "$stage/tart" tart.app
  tar -xzf "$stage/softnet.tar.gz" -C "$stage/softnet" softnet
  [ -x "$stage/tart/tart.app/Contents/MacOS/tart" ] && [ -f "$stage/softnet/softnet" ] && [ ! -L "$stage/softnet/softnet" ] || die 'unexpected pinned archive layout'
  codesign --verify --deep --strict "$stage/tart/tart.app" || die 'Tart signature verification failed'
  socket_probe > "$stage/socket-probe.c"
  /usr/bin/clang -Wall -Wextra -Werror -O2 "$stage/socket-probe.c" -o "$stage/socket-probe" || die 'descriptor validator did not compile'
  [ -d /usr/local/libexec ] || install -d -o root -g wheel -m 755 /usr/local/libexec
  ensure_user "$SERVICE_USER" "$SERVICE_HOME" /usr/bin/false
  mkdir "$SERVICE_HOME" "$LIBEXEC" "$STATE"
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"; chmod 700 "$SERVICE_HOME"
  chown root:wheel "$LIBEXEC" "$STATE"; chmod 755 "$LIBEXEC" "$STATE"
  cp -R "$stage/tart/tart.app" "$LIBEXEC/tart.app"
  cp "$stage/softnet/softnet" "$LIBEXEC/softnet-binary"
  install -o root -g wheel -m 755 "$stage/socket-probe" "$LIBEXEC/socket-probe"
  chown -R root:wheel "$LIBEXEC"; chmod -R go-w "$LIBEXEC"; chmod 755 "$LIBEXEC/softnet-binary"
  softnet_shim > "$LIBEXEC/softnet"; softnet_root > "$LIBEXEC/softnet-root"
  supervisor_template > "$LIBEXEC/supervisor.sh"; chmod 755 "$LIBEXEC"/softnet "$LIBEXEC/softnet-root" "$LIBEXEC/supervisor.sh"
  # No argument wildcard. The root helper itself accepts exactly one validated MAC address.
  printf '%s ALL=(root) NOPASSWD: %s/softnet-root\n' "$SERVICE_USER" "$LIBEXEC" > "$stage/sudoers"
  visudo -cf "$stage/sudoers" >/dev/null || die 'generated sudo policy did not validate'
  install -o root -g wheel -m 440 "$stage/sudoers" /private/etc/sudoers.d/case-macos-softnet
  as_service mkdir -m 700 "$SERVICE_HOME/.ssh" "$SERVICE_HOME/.tart"
  # Empty passphrase is intentional for this narrowly scoped management key; private key never leaves
  # the private service home. Only its public half is copied to the manually provisioned guest.
  as_service ssh-keygen -q -t ed25519 -N '' -C case-macos-vm-control -f "$SERVICE_HOME/.ssh/control"
  host_plist > "$PLIST"
  chown root:wheel "$PLIST"; chmod 644 "$PLIST"; plutil -lint "$PLIST" >/dev/null
  as_service test ! -r "$owner_home" || die 'service user can read owner home'
  if as_service sudo -n /usr/bin/true >/dev/null 2>&1; then die 'service user has broad sudo'; fi
  as_service test ! -w "$LIBEXEC" || die 'service user can write privileged helpers'
  printf '%s\n' 'HOST STAGED ONLY. No VM started, no runner registered, supervisor not loaded and deliberately disabled.'
  printf '%s\n' "Public management key (not a credential): $SERVICE_HOME/.ssh/control.pub" 'Next: manual-guest. Network isolation and lifecycle remain unproved.'
  rm -rf "$stage"; trap - EXIT
}

guest_management() {
  cat <<'TEXT'
#!/bin/bash
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
# No interactive shell, SCP, SFTP, arbitrary commands, forwarding or credential output.
case "${SSH_ORIGINAL_COMMAND:-}" in
  gate) exec /usr/bin/env -i HOME=/private/var/case-vm-control PATH=/usr/bin:/bin:/usr/sbin:/sbin /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs control ;;
  inventory|status) ;;
  *) exit 64 ;;
esac
exec /usr/bin/sudo -n /usr/local/libexec/case-macos-vm/guest-root-probe
TEXT
}

cleanup_template() {
  cat <<'TEXT'
#!/bin/bash
# Runs UNPRIVILEGED as runner, only after the root gate observes all active Workers exit.
# Remove first, then audit (CASE-306): macOS protects some folders even from their owner (EPERM on
# ~/Library/Caches, CASE-305), so an undeletable EMPTY directory is tolerated, but any file left behind
# fails closed. On failure, one line "cleanup <reason> <location> <path>" names it for the gate's status.
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -un)" = runner ] && [ "$(id -u)" -ne 0 ] || exit 77
unset BASH_ENV ENV CDPATH
home=/private/var/case-vm-runner
users_root=/Users
report() { printf 'cleanup %s %s %s\n' "$1" "$2" "$(printf '%s' "${3:-}" | LC_ALL=C tr -c 'A-Za-z0-9._/-' '_' | cut -c1-80)"; exit 78; }
# The first non-directory below $1 (owned by runner when $3 is set), relative to $1.
leftover() {
  local first
  if [ -n "${3:-}" ]; then first=$(find "$1" -mindepth 1 -user runner ! -type d -print -quit 2>/dev/null)
  else first=$(find "$1" -mindepth 1 ! -type d -print -quit 2>/dev/null); fi
  [ -z "$first" ] || report leftover "$2" "${first#"$1"/}"; }
# rm/find do not follow symlinks. Never run this removal as root or use a job-supplied path.
for entry in "$home:home" /opt/actions-runner/_work:work /opt/actions-runner/_diag:diag; do
  directory=${entry%:*}; label=${entry##*:}
  [ -d "$directory" ] && [ ! -L "$directory" ] || report invalid "$label"
  find "$directory" -mindepth 1 -maxdepth 1 -exec /bin/rm -rf -- {} + 2>/dev/null
  leftover "$directory" "$label"
done
# Shared scratch: only objects owned by this isolated guest user, at any depth; others' files survive.
for entry in /private/tmp:tmp /private/var/tmp:var-tmp "$users_root/Shared:shared"; do
  directory=${entry%:*}; label=${entry##*:}
  find "$directory" -mindepth 1 -maxdepth 1 -user runner -exec /bin/rm -rf -- {} + 2>/dev/null
  find "$directory" -mindepth 2 -depth -user runner -exec /bin/rm -rf -- {} + 2>/dev/null
  leftover "$directory" "$label" owned
done
# The per-user Darwin folders under /private/var/folders (T temp, C cache, 0 and X) belong to runner only.
temp=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR) || report invalid user-folders
temp=${temp%/}
case "$temp" in /var/folders/*) temp=/private$temp ;; esac
[[ "$temp" =~ ^/private/var/folders/[A-Za-z0-9_+-]+/[A-Za-z0-9_+-]+/T$ ]] || report invalid user-folders
for kind in T C 0 X; do
  directory=${temp%/T}/$kind
  [ -e "$directory" ] || continue
  [ -d "$directory" ] && [ ! -L "$directory" ] && [ "$(stat -f '%u' "$directory")" = "$(id -u)" ] || report invalid "user-$kind"
  find "$directory" -mindepth 1 -maxdepth 1 -exec /bin/rm -rf -- {} + 2>/dev/null
  leftover "$directory" "user-$kind"
done
mkdir -m 700 "$home/tmp" 2>/dev/null || [ -d "$home/tmp" ] || report invalid home-tmp
exit 0
TEXT
}

install_guest_lifecycle() {
  local inside=0 gate='' peer='' option stage target
  while [ "$#" -gt 0 ]; do
    option="$1"; shift
    if [ "$option" = --inside-guest ]; then [ "$inside" = 0 ] || die 'duplicate guest acknowledgement'; inside=1; continue; fi
    [ "$#" -gt 0 ] || die 'lifecycle option needs a value'
    case "$option" in --gate-source) [ -z "$gate" ] || die 'duplicate source'; gate="$1" ;; --peer-source) [ -z "$peer" ] || die 'duplicate source'; peer="$1" ;; *) die 'unknown lifecycle option' ;; esac; shift
  done
  [ "$inside" = 1 ] && [ -n "$gate" ] && [ -n "$peer" ] || die 'explicit guest acknowledgement and both reviewed sources required'
  absolute_file "$gate"; absolute_file "$peer"; owner_root; root_path "$gate"; root_path "$peer"; root_path "$LIBEXEC"
  local marker='/Library/Application Support/Case CI/vm-role'
  [ "$(stat -f '%u:%Lp' "$marker")" = 0:444 ] && [ "$(cat "$marker")" = case-macos-vm ] || die 'guest role marker required'
  [ ! -e "$STATE" ] && [ ! -e /Library/LaunchDaemons/app.iatrogenic.case-macos-gate.plist ] || die 'guest lifecycle already staged; explicit recovery required'
  # Install before registration. No existing user-controlled process may race permission sealing.
  [ -z "$(pgrep -u runner || true)" ] || die 'runner processes exist; refuse sealing a live account'
  [ ! -e /opt/actions-runner/.runner ] || die 'install lifecycle before interactive registration'
  root_path "$(xcode-select -p)"
  stage=$(mktemp -d /private/var/root/case-macos-lifecycle.XXXXXX); trap "rm -rf '$stage'" EXIT
  cp "$gate" "$stage/gate.mjs"; cp "$peer" "$stage/peer.c"
  /usr/bin/clang -Wall -Wextra -Werror -O2 "$stage/peer.c" -lbsm -o "$stage/peer"
  # All package symlinks were pinned/allowlisted at archive validation and extracted unprivileged.
  # find's default -P never traverses those six links during ownership changes.
  find /opt/actions-runner -type f -exec chown root:wheel {} +
  find /opt/actions-runner -type d -exec chown root:wheel {} +
  find /opt/actions-runner -type f -exec chmod go-w {} +
  find /opt/actions-runner -type d -exec chmod 755 {} +
  root_path /opt/actions-runner/externals/node24/bin/node; root_path /opt/actions-runner/bin/Runner.Worker
  install -o root -g wheel -m 755 "$stage/peer" "$LIBEXEC/case-macos-peer"
  install -o root -g wheel -m 644 "$stage/gate.mjs" "$LIBEXEC/case-macos-gate.mjs"
  # Runner v2.338.0 HostContext.GetDefaultShellForScript requires .js/.sh. The hook gets the github
  # context (GITHUB_*) but no job env; this wrapper forwards only the three identity variables the
  # gate admits on, and clears inherited Node options.
  stage_job_scripts
  cat > /opt/actions-runner/.env <<'ENV'
HOME=/private/var/case-vm-runner
TMPDIR=/private/var/case-vm-runner/tmp
PATH=/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
CASE_REQUIRE_DB=1
ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/case-macos-vm/job-started.js
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/case-macos-vm/job-completed.js
ENV
  printf '%s\n' /opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin > /opt/actions-runner/.path
  chmod 444 /opt/actions-runner/.env /opt/actions-runner/.path
  install -d -o runner -g runner -m 700 /opt/actions-runner/_work /opt/actions-runner/_diag "$GUEST_RUNNER_HOME/tmp"
  install -d -o root -g wheel -m 700 "$STATE"
  install -d -o root -g wheel -m 755 "$GATE_RUN_DIR"
  printf '{"version":1,"runnerUID":%s,"runnerGID":%s,"controlUID":%s}\n' "$(id -u runner)" "$(id -g runner)" "$(id -u case-vm-control)" > "$STATE/guest.json"
  chmod 600 "$STATE/guest.json"
  guest_gate_plist > /Library/LaunchDaemons/app.iatrogenic.case-macos-gate.plist
  chmod 644 /Library/LaunchDaemons/app.iatrogenic.case-macos-gate.plist
  plutil -lint /Library/LaunchDaemons/app.iatrogenic.case-macos-gate.plist >/dev/null
  shasum -a 256 "$LIBEXEC/case-macos-gate.mjs" "$LIBEXEC/case-macos-peer"
  printf '%s\n' 'GUEST LIFECYCLE STAGED, NOT LOADED. Next lifecycle-guide: prove isolation, seal clean base, register only working clone.'
  rm -rf "$stage"; trap - EXIT
}

# The runner hooks and the post-job cleanup are generated by this reviewed script. install- and
# update-guest-lifecycle stage them, the seal records their hashes and reseal-base regenerates them
# on the host to compare (CASE-304).
job_hook_text() {
  printf "const {spawnSync}=require('node:child_process');\nconst e=process.env;\nconst r=spawnSync('/opt/actions-runner/externals/node24/bin/node',['%s/case-macos-gate.mjs','hook','%s'],{stdio:'inherit',env:{HOME:'/private/var/case-vm-runner',PATH:'/usr/bin:/bin:/usr/sbin:/sbin',GITHUB_WORKFLOW_REF:e.GITHUB_WORKFLOW_REF||'',GITHUB_EVENT_NAME:e.GITHUB_EVENT_NAME||'',GITHUB_REF:e.GITHUB_REF||''}});\nprocess.exit(r.status===null?78:r.status);\n" "$LIBEXEC" "$1"
}
stage_job_scripts() {
  local target
  for target in started completed; do
    job_hook_text "$target" > "$LIBEXEC/job-$target.js.pending"
    chown root:wheel "$LIBEXEC/job-$target.js.pending"; chmod 644 "$LIBEXEC/job-$target.js.pending"
    mv "$LIBEXEC/job-$target.js.pending" "$LIBEXEC/job-$target.js"
  done
  cleanup_template > "$LIBEXEC/cleanup.pending"
  chown root:wheel "$LIBEXEC/cleanup.pending"; chmod 755 "$LIBEXEC/cleanup.pending"
  mv "$LIBEXEC/cleanup.pending" "$LIBEXEC/cleanup"
}
text_sha() { local sum; sum=$(shasum -a 256) || die 'cannot hash generated text'; printf '%s\n' "${sum%% *}"; }

sha_of() { local sum; sum=$(shasum -a 256 "$1") || die 'cannot hash a lifecycle file'; printf '%s\n' "${sum%% *}"; }
# The seal records the lifecycle code it vouches for (CASE-300), so "sealed" keeps meaning "the
# installed gate and peer are the recorded ones"; enable-guest-gate refuses any other bytes.
# CASE-304 adds the cleanup script, both hooks and, from update-guest-lifecycle, the reviewed peer
# source hash (the peer entry is the compiled binary), so reseal-base can compare every one.
write_seal() {
  printf '{"version":1,"bootPolicy":"closed-until-owner-open","network":"owner-proved","lifecycle":{"gate":"%s","peer":"%s","peerSource":"%s","cleanup":"%s","hookStarted":"%s","hookCompleted":"%s"},"recorded":"%s","by":"%s"}\n' "$1" "$2" "${4:-}" "$(sha_of "$LIBEXEC/cleanup")" "$(sha_of "$LIBEXEC/job-started.js")" "$(sha_of "$LIBEXEC/job-completed.js")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$STATE/sealed.json.pending"
  chmod 600 "$STATE/sealed.json.pending"
  mv "$STATE/sealed.json.pending" "$STATE/sealed.json"
}
seal_guest() {
  local evidence=''
  [ "$#" -eq 3 ] && [ "$1" = --inside-guest ] && [ "$2" = --isolation-evidence ] || die 'seal-guest requires explicit guest acknowledgement and protected evidence'
  evidence="$3"; absolute_file "$evidence"; owner_root; root_path "$evidence"; root_path "$STATE/guest.json"
  [ ! -e "$STATE/sealed.json" ] || die 'guest already sealed; do not replace proof silently'
  [ -z "$(pgrep -u runner || true)" ] || die 'runner processes exist'
  no_sudo_rules runner
  # macOS sudo keeps the caller's HOME; -H gives runner its own, without which Homebrew crashes.
  (cd / && guest_probe | sudo -u runner -H /bin/bash --noprofile --norc >/dev/null) || die 'guest privilege/tool inventory failed before seal'
  check_evidence "$evidence"
  [ "$(plutil -extract guestVersion raw -o - "$evidence")" = "$(sw_vers -productVersion)" ] && [ "$(plutil -extract guestBuild raw -o - "$evidence")" = "$(sw_vers -buildVersion)" ] || die 'evidence guest build does not match this guest'
  cp "$evidence" "$STATE/isolation.json"; chmod 600 "$STATE/isolation.json"
  write_seal "$(sha_of "$LIBEXEC/case-macos-gate.mjs")" "$(sha_of "$LIBEXEC/case-macos-peer")" sealed
  printf '%s\n' 'GUEST SEALED by owner evidence. No daemon started, no registration or routing performed.'
}
guest_root_probe() {
  cat <<'TEXT' | sed -e "s|@GUEST_DNS@|$GUEST_DNS|g" -e "s|@GUEST_DNS_CSV@|$GUEST_DNS_CSV|g"
#!/bin/bash -p
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL
[ "$#" -eq 0 ] && [ "$(id -u)" = 0 ] && [ "${SUDO_USER:-}" = case-vm-control ] || exit 77
marker='/Library/Application Support/Case CI/vm-role'
[ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -f '%u:%Lp' "$marker")" = 0:444 ] && [ "$(cat "$marker")" = case-macos-vm ] || exit 78
case " $(id -Gn runner) " in *' admin '*|*' wheel '*) exit 78 ;; esac
# Root lists ALL effective sudo permissions. Testing just `sudo true` misses a narrow shell grant.
sudo_result=0
sudo_rules=$(sudo -n -l -U runner 2>&1) || sudo_result=$?
# sudo 1.9.17 exits 0 for a user without rules, older releases 1: only the exact one-line refusal passes.
[ "$sudo_result" = 0 ] || [ "$sudo_result" = 1 ] || exit 78
case "$sudo_rules" in *$'\n'*) exit 78 ;; 'User runner is not allowed to run sudo on '*.) ;; *) exit 78 ;; esac
/bin/bash -c '[ "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" = 3.2 ]' || exit 78
mounted=$(mount)
if printf '%s\n' "$mounted" | grep -E '(virtiofs|nfs|smbfs|afpfs)' >/dev/null; then exit 78; fi
for name in postgres initdb pg_ctl psql; do [ -x "/opt/homebrew/opt/postgresql@16/bin/$name" ] || exit 78; done
/opt/homebrew/opt/postgresql@16/bin/postgres --version | grep -E '^postgres \(PostgreSQL\) 16\.' >/dev/null || exit 78
# Softnet's DHCP names the gateway, which the egress policy blocks. The base image pins public
# resolvers; every enabled service and every effective resolver must use exactly those.
services=$(networksetup -listallnetworkservices) || exit 78
enabled=0
while IFS= read -r service; do
  case "$service" in 'An asterisk'*|'*'*|'') continue ;; esac
  [ "$(networksetup -getdnsservers "$service" | tr '\n' ' ')" = '@GUEST_DNS@ ' ] || exit 78
  enabled=$((enabled + 1))
done <<SERVICES
$services
SERVICES
[ "$enabled" -ge 1 ] || exit 78
resolvers=$(scutil --dns | sed -n 's/^ *nameserver\[[0-9]*\] : //p' | sort -u | tr '\n' ' ')
[ "$resolvers" = '@GUEST_DNS@ ' ] || exit 78
# Remote Login admits only the forced-command management account: the setup admin's transfer access is off.
ssh_access=$(dscl . -read /Groups/com.apple.access_ssh GroupMembership 2>/dev/null) || exit 78
[ "$ssh_access" = 'GroupMembership: case-vm-control' ] || exit 78
# macOS 27's dscl prints "No such key: <key>" and still exits 0 for a missing attribute, so the
# output decides. Anything else, a nested group or a missing group included, fails closed.
nested=$(dscl . -read /Groups/com.apple.access_ssh NestedGroups 2>&1 || true)
[ "$nested" = 'No such key: NestedGroups' ] || exit 78
# An enabled gate must be running with its socket present (CASE-300); a disabled one reports so.
lifecycle=disabled
plist=/Library/LaunchDaemons/app.iatrogenic.case-macos-gate.plist
if [ -f "$plist" ] && [ "$(plutil -extract Disabled raw -o - "$plist" 2>/dev/null || true)" = false ]; then
  state=$(launchctl print system/app.iatrogenic.case-macos-gate 2>/dev/null | awk -F' = ' '/^\tstate = / {print $2; exit}' || true)
  [ "$state" = running ] && [ -S /private/var/db/case-macos-vm-run/gate.sock ] || exit 78
  lifecycle=gate-up
fi
# Deliberately no registration files, keys, env, process arguments or arbitrary guest file output.
printf '%s\n' "case-macos-vm inventory=ok dns=@GUEST_DNS_CSV@ lifecycle=$lifecycle network=unproved qualification=unproved"
TEXT
}

# Base image: public resolvers on every enabled network service, replacing the blocked DHCP gateway.
pin_guest_dns() {
  local services service count=0
  services=$(networksetup -listallnetworkservices) || die 'cannot list guest network services'
  while IFS= read -r service; do
    case "$service" in 'An asterisk'*|'*'*|'') continue ;; esac
    # GUEST_DNS is two fixed addresses; word splitting is intended.
    networksetup -setdnsservers "$service" $GUEST_DNS || die 'cannot pin guest DNS'
    count=$((count + 1))
  done <<TEXT
$services
TEXT
  [ "$count" -ge 1 ] || die 'no enabled guest network service for DNS'
  dscacheutil -flushcache
}

guest_bootstrap() {
  local keyfile='' archive='' inside=0 option stage pub kind key comment
  while [ "$#" -gt 0 ]; do
    option="$1"; shift
    if [ "$option" = --inside-guest ]; then [ "$inside" = 0 ] || die 'duplicate guest acknowledgement'; inside=1; continue; fi
    [ "$#" -gt 0 ] || die 'guest option needs a value'
    case "$option" in
      --management-public-key) [ -z "$keyfile" ] || die 'duplicate guest key option'; keyfile="$1" ;;
      --runner-archive) [ -z "$archive" ] || die 'duplicate runner archive option'; archive="$1" ;;
      *) die 'unknown guest staging option' ;;
    esac; shift
  done
  [ "$inside" = 1 ] && [ -n "$keyfile" ] && [ -n "$archive" ] || die 'guest bootstrap requires --inside-guest, public key and runner archive'
  absolute_file "$keyfile"; absolute_file "$archive"; owner_root
  root_path "$keyfile"; root_path "$archive"
  local marker='/Library/Application Support/Case CI/vm-role'
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -f '%u:%Lp' "$marker")" = 0:444 ] && [ "$(cat "$marker")" = case-macos-vm ] || die 'missing owner-created guest console marker; refusing host execution'
  [ ! -e "$LIBEXEC" ] && [ ! -e /opt/actions-runner ] && [ ! -e /private/etc/sudoers.d/case-macos-management ] || die 'guest staging exists; refusing implicit replacement'
  pub=$(cat "$keyfile"); read -r kind key comment <<TEXT
$pub
TEXT
  [ "$kind" = ssh-ed25519 ] && [ -n "$key" ] || die 'expected one OpenSSH ed25519 public key'
  case "$pub" in *$'\n'*|*'"'*|*'\\'*|*'['*|*']'*) die 'invalid public key input' ;; esac
  ssh-keygen -l -f "$keyfile" >/dev/null || die 'invalid public key encoding'
  root_path /usr/local; root_path /private/etc/sudoers.d
  if [ -e /usr/local/libexec ] || [ -L /usr/local/libexec ]; then root_path /usr/local/libexec; fi
  for option in postgres initdb pg_ctl psql; do [ -x "/opt/homebrew/opt/postgresql@16/bin/$option" ] || die 'install Postgres 16 as guest provisioning admin first'; done
  stage=$(mktemp -d /private/var/root/case-macos-guest.XXXXXX); trap "rm -rf '$stage'" EXIT
  cp "$archive" "$stage/runner.tar.gz"
  printf '%s  %s\n' "$GUEST_RUNNER_SHA256" "$stage/runner.tar.gz" | shasum -a 256 -c - >/dev/null || die 'pinned macOS ARM64 runner hash mismatch'
  archive_members "$stage/runner.tar.gz" runner
  [ -d /usr/local/libexec ] || install -d -o root -g wheel -m 755 /usr/local/libexec
  [ -d /opt ] || install -d -o root -g wheel -m 755 /opt
  root_path /opt
  ensure_user runner "$GUEST_RUNNER_HOME" /bin/bash
  ensure_user case-vm-control /private/var/case-vm-control /bin/sh
  [ ! -e "$GUEST_RUNNER_HOME" ] && [ ! -e /private/var/case-vm-control ] || die 'guest home exists; review permissions manually'
  mkdir "$GUEST_RUNNER_HOME" /private/var/case-vm-control "$LIBEXEC"
  chown runner:runner "$GUEST_RUNNER_HOME"; chmod 700 "$GUEST_RUNNER_HOME"
  chown root:wheel /private/var/case-vm-control "$LIBEXEC"; chmod 755 /private/var/case-vm-control "$LIBEXEC"
  mkdir /private/var/case-vm-control/.ssh; chmod 755 /private/var/case-vm-control/.ssh
  printf 'restrict,command="%s/guest-management" %s %s\n' "$LIBEXEC" "$kind" "$key" > /private/var/case-vm-control/.ssh/authorized_keys
  chmod 444 /private/var/case-vm-control/.ssh/authorized_keys
  guest_management > "$LIBEXEC/guest-management"; guest_root_probe > "$LIBEXEC/guest-root-probe"
  chmod 755 "$LIBEXEC/guest-management" "$LIBEXEC/guest-root-probe"
  # Empty-argument sudoers form refuses ALL command arguments; helper accepts zero arguments too.
  printf 'case-vm-control ALL=(root) NOPASSWD: %s/guest-root-probe ""\n' "$LIBEXEC" > "$stage/sudoers"
  visudo -cf "$stage/sudoers" >/dev/null || die 'guest sudo policy did not validate'
  install -o root -g wheel -m 440 "$stage/sudoers" /private/etc/sudoers.d/case-macos-management
  install -d -o runner -g runner -m 700 /opt/actions-runner
  # Root reads the protected pinned archive; every extraction, including its six safe relative CLI
  # symlinks, runs unprivileged. Root never extracts these link members or follows them afterwards.
  cat "$stage/runner.tar.gz" | sudo -u runner /usr/bin/tar -xzf - -C /opt/actions-runner
  pin_guest_dns
  printf '%s\n' 'GUEST STAGED ONLY: runner NOT registered or started; no runner LaunchDaemon installed.'
  printf '%s\n' 'Enable Remote Login in guest Settings for case-vm-control ONLY; public-key forced command only.'
  printf '%s\n' 'Record the guest SSH host key through the console, then configure-guest/probe-host on the host.'
  rm -rf "$stage"; trap - EXIT
}

# Prints the four octets of a canonical dotted-quad IPv4 address, or fails.
ipv4_octets() {
  local ip="$1" a b c d extra octet
  case "$ip" in *[!0-9.]*|'') return 1 ;; esac
  IFS=. read -r a b c d extra <<TEXT
$ip
TEXT
  [ -z "${extra:-}" ] || return 1
  for octet in "$a" "$b" "$c" "$d"; do
    case "$octet" in ''|0[0-9]*|[0-9][0-9][0-9][0-9]*) return 1 ;; esac
    [ "$((10#$octet))" -le 255 ] || return 1
  done
  [ "$a.$b.$c.$d" = "$ip" ] || return 1
  printf '%s %s %s %s\n' "$a" "$b" "$c" "$d"
}
private_ip() {
  local octets a b c d
  octets=$(ipv4_octets "$1") || return 1
  read -r a b c d <<TEXT
$octets
TEXT
  case "$a.$b" in 10.*|192.168) return 0 ;; esac
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]
}
# The router's public egress address: refuses private, shared, loopback, link-local, documentation,
# benchmarking, multicast and reserved IPv4 (the same ranges NETWORK_BLOCK denies).
public_ipv4() {
  local octets a b c d
  octets=$(ipv4_octets "$1") || return 1
  read -r a b c d <<TEXT
$octets
TEXT
  case "$a" in 0|10|127) return 1 ;; esac
  [ "$a" -lt 224 ] || return 1
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1
  [ "$a" = 198 ] && { [ "$b" = 18 ] || [ "$b" = 19 ]; } && return 1
  case "$a.$b" in 169.254|192.168) return 1 ;; esac
  case "$a.$b.$c" in 192.0.0|192.0.2|192.88.99|198.51.100|203.0.113) return 1 ;; esac
  return 0
}
# Owner isolation evidence shared by seal-guest (guest copy) and install-host-lifecycle (host copy).
check_evidence() {
  local evidence="$1" field value
  for field in root runner positiveControls ipv6 mounts; do
    value=$(plutil -extract "$field" raw -o - "$evidence") || die 'incomplete owner isolation evidence'
    [ "$value" = passed ] || die 'owner isolation evidence has a failing or absent gate'
  done
  [ "$(plutil -extract guestVersion raw -o - "$evidence")" = "$APPROVED_GUEST_VERSION" ] && [ "$(plutil -extract guestBuild raw -o - "$evidence")" = "$APPROVED_GUEST_BUILD" ] || die "evidence must record the approved guest $APPROVED_GUEST_VERSION/$APPROVED_GUEST_BUILD"
  [ "$(plutil -extract ipswSHA256 raw -o - "$evidence")" = "$APPROVED_IPSW_SHA256" ] || die 'evidence must record the approved IPSW SHA-256'
  [ "$(plutil -extract dnsServers raw -o - "$evidence")" = "$GUEST_DNS_CSV" ] || die "evidence must record guest DNS $GUEST_DNS_CSV"
  value=$(plutil -extract routerPublicIP raw -o - "$evidence") || die 'evidence must record the router public IPv4 address'
  public_ipv4 "$value" || die 'routerPublicIP must be a canonical public IPv4 address'
}
# Binds only the console-verified host key. Softnet allocates a new /30 on every boot, so the guest's
# address is resolved from Tart when it is needed, never stored (CASE-299).
configure_guest() {
  local keyfile pub kind key comment
  [ "$#" -eq 2 ] && [ "$1" = --host-key ] || die 'configure-guest takes only --host-key /absolute/ssh_host_ed25519_key.pub'
  keyfile="$2"
  absolute_file "$keyfile"; owner_root; root_path "$keyfile"; root_path "$STATE"
  pub=$(cat "$keyfile"); read -r kind key comment <<TEXT
$pub
TEXT
  [ "$kind" = ssh-ed25519 ] && [ -n "$key" ] || die 'expected console-verified ed25519 guest host public key'
  case "$pub" in *$'\n'*|*'"'*|*'\\'*|*'['*|*']'*) die 'invalid host public key input' ;; esac
  ssh-keygen -l -f "$keyfile" >/dev/null || die 'invalid host public key encoding'
  [ ! -e "$STATE/known-hosts" ] || die 'guest binding already exists; refusing silent host-key replacement'
  printf '%s %s %s\n' case-macos-vm "$kind" "$key" > "$STATE/known-hosts"
  chmod 444 "$STATE/known-hosts"
  printf '%s\n' 'Guest binding staged from owner console evidence; no connection or trust-on-first-use performed.'
}
# The one running VM, base or clone; anything else is refused before any connection.
running_vm() {
  local listing i name state vm=''
  listing=$(as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" list --source local --format json) || die 'cannot list VMs'
  i=0
  while name=$(printf '%s\n' "$listing" | plutil -extract "$i.Name" raw -o - - 2>/dev/null); do
    state=$(printf '%s\n' "$listing" | plutil -extract "$i.State" raw -o - -)
    if [ "$state" = running ]; then [ -z "$vm" ] || die 'more than one VM is running'; vm="$name"; fi
    i=$((i + 1))
  done
  case "$vm" in case-macos-base|case-macos-1) printf '%s\n' "$vm" ;; *) die 'boot exactly one of case-macos-base or case-macos-1 first' ;; esac
}
probe_host() {
  owner_root; root_path "$STATE"; root_path "$STATE/known-hosts"; root_path "$TART_BIN"
  local vm ip output
  vm=$(running_vm)
  # Softnet reserves the guest's address for this boot in /etc/bootptab, which Tart's dhcp resolver reads.
  ip=$(as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" ip --resolver dhcp --wait 30 "$vm") || die 'cannot resolve the running guest address'
  private_ip "$ip" || die 'unexpected guest address'
  # An unreachable guest is an ALERT, never retried silently (CASE-301).
  /usr/bin/nc -z -G 5 "$ip" 22 >/dev/null 2>&1 || die "ALERT $vm at $ip is unreachable from the host on port 22; no retry. Check the Softnet allow list (CASE-301) and the guest console"
  output=$(as_service /usr/bin/ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=case-macos-vm -o "UserKnownHostsFile=$STATE/known-hosts" -o GlobalKnownHostsFile=/dev/null -o ForwardAgent=no -o ClearAllForwardings=yes -i "$SERVICE_HOME/.ssh/control" "case-vm-control@$ip" inventory) || die 'authenticated guest inventory failed; no lifecycle enabled'
  case "$output" in
    "case-macos-vm inventory=ok dns=$GUEST_DNS_CSV lifecycle=disabled network=unproved qualification=unproved") printf '%s\n' 'Authenticated guest inventory passed with pinned host key and forced command. Gate disabled.' ;;
    "case-macos-vm inventory=ok dns=$GUEST_DNS_CSV lifecycle=gate-up network=unproved qualification=unproved") printf '%s\n' 'Authenticated guest inventory passed with pinned host key and forced command. Gate running, socket present.' ;;
    *) die 'unexpected guest response; no lifecycle enabled' ;;
  esac
  die 'NOT QUALIFIED: lifecycle-guide stages admission/cleanup/reset controls; live known-answer root+runner host/LAN/peer/IPv6, drain/reset, load/reboot and exact-SHA qualification remain; owner activation is separate'
}

manual_guest() {
  cat <<TEXT
MANUAL OWNER GUEST PHASE (no CI code runs on the host; no registration in this phase)
1. Copy the reviewed script and pinned software archives into /private/var/root using owner Terminal.
   Set their owner root:wheel, script mode 0500, archive mode 0400. Confirm every parent is protected.
   Run: sudo /bin/bash /private/var/root/setup-case-macos-vm.sh install-host --tart-archive /private/var/root/tart.tar.gz --softnet-archive /private/var/root/softnet.tar.gz
   install-host stages signed/pinned Tart/Softnet and a private service management key. It deliberately
   does not create/start a VM or load the disabled supervisor. Preserve this state for source review.
2. Stage the approved IPSW: sudo /bin/bash /private/var/root/setup-case-macos-vm.sh stage-ipsw --ipsw /absolute/downloaded.ipsw
   It hashes a protected copy and stages it as $IPSW_PATH, root:$SERVICE_USER mode 0440.
   Generate the base commands into a root-owned file, review it (sudo less), then run it with sudo,
   keeping that Terminal open while the VM runs:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh commands --ipsw $IPSW_PATH --sha256 $APPROVED_IPSW_SHA256 | sudo tee /private/var/root/case-macos-base.sh >/dev/null
   sudo /bin/bash /private/var/root/case-macos-base.sh
   Its console is the VNC block (console-commands): the hidden service account has no WindowServer.
   Tart $TART_VERSION's VNC server listens on every interface, so the strict loopback check always stops
   the VM. Julian accepted (CASE-298) a LAN-reachable console while he provisions: add --accept-lan-vnc
   to commands or console-commands. Only Tart's VNC port may then listen; shut the guest down after.
   Tart runs with stdout redirected to a file, not a TTY: Tart $TART_VERSION otherwise offers to set SUID on
   its network helper. NEVER accept that offer. Use the staged strict helper, never a SUID Softnet.
   The staged shim requires exactly --net-softnet-allow='$NETWORK_ALLOW' and --net-softnet-block='out $NETWORK_BLOCK'.
   The directional exception permits host-initiated management flows (not a port-specific firewall);
   only Remote Login should listen. Outbound host access still MUST be proved. No dir/disk/clipboard/
   audio/USB/bridged/host/agent options may be added.
3. INSIDE THE GUEST CONSOLE ONLY: create one setup admin and skip Apple ID. Softnet's DHCP names the
   blocked gateway as DNS, so first, in Terminal as that admin, use the resolvers guest-bootstrap pins:
   sudo networksetup -setdnsservers Ethernet $GUEST_DNS
   (networksetup -listallnetworkservices names the service if it is not Ethernet.) Then install
   Command Line Tools and brew install postgresql@16 as that setup admin, then remove the unused
   default cluster it creates (mode 0700, which the runner inventory cannot audit; CI makes its own):
   rm -rf /opt/homebrew/var/postgresql@16
   If Setup Assistant hangs on a network-only step after the account exists (CASE-299), shut the VM
   down and boot recoveryOS: console-commands case-macos-base --accept-lan-vnc --recovery. In it,
   choose Options, sign in as the setup admin, then Utilities > Terminal. The data volume, which holds
   /private/var/db and /Users, is /Volumes/Macintosh HD - Data:
   ls '/Volumes/Macintosh HD - Data/private/var/db/dslocal/nodes/Default/users/setup.plist'
   touch '/Volumes/Macintosh HD - Data/private/var/db/.AppleSetupDone'
   shutdown -h now
   The first line must print the path (the account exists); otherwise stop. Then boot normally
   without --recovery, log in as the setup admin, skip any remaining panes and set DNS as above.
   On the host, download the Actions osx-arm64 package v$GUEST_RUNNER_VERSION, SHA256 $GUEST_RUNNER_SHA256, from GitHub's release page.
   The guest is the approved macOS $APPROVED_GUEST_VERSION/$APPROVED_GUEST_BUILD. The $HOSTED_REFERENCE_TEXT
   differs: record it as an environment difference. Matching the host's OS is not image parity.
4. In the guest console, create the accident guard (these commands modify the GUEST only):
   sudo mkdir -p '/Library/Application Support/Case CI'
   printf 'case-macos-vm\\n' | sudo tee '/Library/Application Support/Case CI/vm-role' >/dev/null
   sudo chmod 0444 '/Library/Application Support/Case CI/vm-role'
   Then the one-time transfer window: guest Settings > General > Sharing > Remote Login on, allowing
   ONLY the setup admin. Note the guest address (ipconfig getifaddr en0; the interface must be en0;
   Softnet gives a new address on every boot, so regenerate host-helper after any restart) and
   the host key fingerprint (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) shown on the console.
5. On the host, generate the helper into your home, review it, and start the canaries, then push:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh host-helper --repo /absolute/Case --node /absolute/node --runner-archive /absolute/runner.tar.gz --guest-ip <guest IPv4> --guest-admin <admin> > ~/case-macos-host-helper.sh
   /bin/bash ~/case-macos-host-helper.sh canary-up
   /bin/bash ~/case-macos-host-helper.sh push
   push copies the reviewed origin/main script (it must equal the root copy), gate.mjs, peer.c, the
   PUBLIC control.pub, the verified runner archive and network-targets.json to ~/case-transfer in the
   guest, and copies the guest's PUBLIC ssh_host_ed25519_key.pub back to /private/var/root/guest-host.pub.
   Type yes only when ssh's fingerprint matches the console. Never copy the private control key.
6. In the guest console, receive the bundle. The digest printed by the first command must match push:
   cd ~/case-transfer && shasum -a 256 -c SHA256SUMS && shasum -a 256 SHA256SUMS
   sudo install -o root -g wheel -m 0500 setup-case-macos-vm.sh /private/var/root/
   sudo install -o root -g wheel -m 0400 case-macos-gate.mjs case-macos-peer.c control.pub actions-runner-osx-arm64-$GUEST_RUNNER_VERSION.tar.gz /private/var/root/
   sudo install -o root -g wheel -m 0444 network-targets.json '/Library/Application Support/Case CI/'
   cd ~ && rm -rf ~/case-transfer
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh guest-bootstrap --inside-guest --management-public-key /private/var/root/control.pub --runner-archive /private/var/root/actions-runner-osx-arm64-$GUEST_RUNNER_VERSION.tar.gz
   guest-bootstrap also pins guest DNS to $GUEST_DNS_CSV; the gateway DNS that DHCP offers is blocked.
7. Continue lifecycle-guide A (install-guest-lifecycle) and B (canaries and evidence) while the
   transfer window is open; B ends by closing it. Then, on the host:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh configure-guest --host-key /private/var/root/guest-host.pub
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh probe-host
   Never use ssh-keyscan trust-on-first-use, StrictHostKeyChecking=no or sshpass.
8. probe-host proves authenticated inventory only, including that Remote Login admits only
   case-vm-control, and exits nonzero. Do not register or start yet. The staged root-owned home and
   restrict/forced-command authorized key prohibit shells, SCP/SFTP, user RC, PTY and forwarding.
   Continue lifecycle-guide B (seal-guest) for the root gate/hooks/base/reset phases, then retain live
   isolation, drain, logout/reboot and paired qualification evidence before owner activation.
TEXT
}

guest_probe() {
  cat <<'PROBE'
#!/bin/bash
# READ-ONLY INVENTORY TEMPLATE. Review and run INSIDE THE VM as its runner user.
# A role marker is an accident guard, not VM attestation or a network/qualification proof.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
fail() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'requires an Apple Silicon macOS guest'
[ "$(id -un)" = runner ] && [ "$(id -u)" -ne 0 ] || fail 'run as the guest non-admin runner'
marker='/Library/Application Support/Case CI/vm-role'
[ -f "$marker" ] && [ ! -L "$marker" ] || fail 'missing guest role marker; do not run on the host'
[ "$(stat -f '%u:%Lp' "$marker")" = '0:444' ] || fail 'role marker must be root-owned mode 0444'
[ "$(cat "$marker")" = case-macos-vm ] || fail 'wrong guest role marker'
case " $(id -Gn) " in *' admin '*|*' wheel '*) fail 'guest runner belongs to a privileged group' ;; esac
if sudo -n -l >/dev/null 2>&1; then fail 'guest runner has sudo rules'; fi
/bin/bash -c '[ "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" = 3.2 ]' || fail 'system bash must be 3.2'
mounted=$(mount) || fail 'cannot inspect guest mounts'
if printf '%s\n' "$mounted" | grep -E '(virtiofs|nfs|smbfs|afpfs)' >/dev/null; then fail 'shared filesystem mounted'; fi
# Audit as runner BEFORE enabling the gate. Follow symlinks so writable external targets fail too.
[ -d /opt/homebrew ] && [ ! -L /opt/homebrew ] && [ -x /opt/homebrew/bin/brew ] || fail 'preinstall guest Homebrew/Postgres as provisioning admin'
writable=$(find -L /opt/homebrew -exec /bin/test -w {} \; -print) || fail 'cannot audit complete guest Homebrew tree'
[ -z "$writable" ] || fail 'guest runner can write Homebrew tools or a symlink target'
[ "$HOME" = /private/var/case-vm-runner ] || fail 'run as runner with its own HOME (sudo -u runner -H); Homebrew cannot start with another user home'
/opt/homebrew/bin/brew list postgresql@16 >/dev/null 2>&1 || fail 'Postgres 16 brew receipt missing; CI must not install tools'
pg=/opt/homebrew/opt/postgresql@16/bin
for command in postgres initdb pg_ctl psql; do
  [ -x "$pg/$command" ] || fail "missing Postgres 16 tool: $command"
done
"$pg/postgres" --version | grep -E '^postgres \(PostgreSQL\) 16\.' >/dev/null || fail 'wrong Postgres major'
printf '%s\n' 'GUEST INVENTORY ONLY: network isolation, clean resets, runner registration and gate qualification still unproved.'
PROBE
}

seal_base() {
  [ "$#" = 0 ] || die 'seal-base takes no arguments'
  owner_root; root_path "$STATE"; root_path "$TART_BIN"
  [ -d "$SERVICE_HOME/.tart/vms/case-macos-base" ] && [ ! -e "$STATE/base" ] || die 'stopped provisioned clean base required; existing reference is immutable'
  local listing state part stage service_uid
  service_uid=$(id -u "$SERVICE_USER")
  listing=$(as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" list --source local --format json)
  state=$(printf '%s\n' "$listing" | plutil -extract 0.State raw -o - -)
  [ "$(printf '%s\n' "$listing" | plutil -extract 0.Name raw -o - -)" = case-macos-base ] && [ "$state" = stopped ] || die 'seal-base requires the only local VM to be the stopped clean base'
  if printf '%s\n' "$listing" | plutil -extract 1.Name raw -o - - >/dev/null 2>&1; then die 'remove working clones manually before sealing the initial reference'; fi
  stage=$(mktemp -d "$STATE/base-pending.XXXXXX")
  chown "$SERVICE_USER:$SERVICE_USER" "$stage"; chmod 700 "$stage"
  # Read/copy as the non-admin VM user: a mutable source cannot make root copy owner secrets.
  for part in config.json disk.img nvram.bin; do
    as_service /bin/cp -c -P "$SERVICE_HOME/.tart/vms/case-macos-base/$part" "$stage/$part" || die 'clean base copy failed; inspect pending directory manually'
  done
  chown root:wheel "$stage"; chmod 755 "$stage"
  for part in config.json disk.img nvram.bin; do
    [ -f "$stage/$part" ] && [ ! -L "$stage/$part" ] || die 'unexpected clean base object'
    # The service owned this directory during the copy. A hard link (link count above 1) or a file
    # it does not own could make root's chown/chmod below change some other file.
    [ "$(stat -f '%l:%u' "$stage/$part")" = "1:$service_uid" ] || die 'clean base copy is hard-linked or not service-owned; inspect pending directory manually'
    chown -h root:wheel "$stage/$part"; chmod -N "$stage/$part"; chmod 444 "$stage/$part"
  done
  mv "$stage" "$STATE/base"
  (cd "$STATE/base" && shasum -a 256 config.json disk.img nvram.bin) > "$STATE/base.sha256"
  chmod 444 "$STATE/base.sha256"
  printf '%s\n' 'Clean reference protected. It MUST have been sealed inside the guest before registration; this host copy cannot attest guest contents.'
}

# Re-base (CASE-304): the protected reference is replaced only from a dedicated clone of it, made by
# rebase-clone, updated in its console with update-guest-lifecycle and never registered. reseal-base
# proves that from the clone's own disk, mounted read-only, before an atomic swap that keeps the
# previous reference for rollback-base. Every swap is appended to base-history.log.
REBASE_VM=case-macos-rebase
service_tart() { as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" "$@"; }
# Prints the local VM names, one per line, and refuses unless every one is stopped.
stopped_vms() {
  local listing i state
  listing=$(service_tart list --source local --format json) || die 'cannot list VMs; nothing changed'
  i=0
  while state=$(printf '%s\n' "$listing" | plutil -extract "$i.State" raw -o - - 2>/dev/null); do
    [ "$state" = stopped ] || die 'a VM is running; drain and stop it first'
    printf '%s\n' "$listing" | plutil -extract "$i.Name" raw -o - -
    i=$((i + 1))
  done
}
verify_reference() { (cd "$STATE/$1" && shasum -a 256 -c "$STATE/$2" >/dev/null 2>&1); }
# A loaded supervisor could restore or boot case-macos-1 from $STATE/base while it is copied or renamed.
supervisor_unloaded() {
  ! launchctl print "system/$DAEMON" >/dev/null 2>&1 || die 'the host supervisor is loaded; unload it before changing the protected base'
}

rebase_clone() {
  local drop=0 names name build part
  case "$#:${1:-}" in 0:) ;; 1:--delete-stopped-working-clone) drop=1 ;; *) die 'rebase-clone takes only --delete-stopped-working-clone' ;; esac
  owner_root; root_path "$STATE"; root_path "$TART_BIN"; root_path "$STATE/base.sha256"
  supervisor_unloaded
  verify_reference base base.sha256 || die 'the protected base does not match base.sha256; inspect it before any rebase'
  [ ! -e "$STATE/rebase-pending.json" ] && [ ! -L "$STATE/rebase-pending.json" ] || die 'a rebase is already pending; finish reseal-base or remove the pending clone and record'
  names=$(stopped_vms)
  for name in $names; do
    case "$name" in
      case-macos-base) ;;
      case-macos-1) [ "$drop" = 1 ] || die 'the stopped working clone still exists; pass --delete-stopped-working-clone (SLA: base plus one clone)'
        [ -f "$SERVICE_HOME/registration.json" ] && [ ! -L "$SERVICE_HOME/registration.json" ] || die 'no host registration backup; cycle-once could not restore the working clone' ;;
      *) die "unexpected VM $name; remove it before a rebase" ;;
    esac
  done
  case " $(printf '%s ' $names)" in *' case-macos-1 '*) service_tart delete case-macos-1 || die 'cannot delete the working clone' ;; esac
  case " $(printf '%s ' $names)" in *' case-macos-base '*) service_tart delete case-macos-base || die 'cannot delete the writable base' ;; esac
  # The writable base is rebuilt from the protected reference, as the supervisor's restore does.
  build=$(as_service /usr/bin/mktemp -d "$SERVICE_HOME/.tart/vms/.case-base.XXXXXX") || die 'cannot stage the writable base'
  for part in config.json disk.img nvram.bin; do
    as_service /bin/cp -c -P "$STATE/base/$part" "$build/$part" || die 'cannot copy the protected base'
    as_service /bin/chmod u+w "$build/$part"
  done
  as_service /bin/mv "$build" "$SERVICE_HOME/.tart/vms/case-macos-base" || die 'cannot place the writable base'
  service_tart clone case-macos-base "$REBASE_VM" || die 'cannot clone the rebase VM'
  printf '{"version":1,"clone":"%s","base":"%s","created":"%s"}\n' "$REBASE_VM" "$(sha_of "$STATE/base.sha256")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE/rebase-pending.json"
  chmod 600 "$STATE/rebase-pending.json"
  printf '%s\n' "REBASE CLONE CREATED: $REBASE_VM, stopped and unregistered. Next: console-commands $REBASE_VM, update-guest-lifecycle in it, shut it down, then reseal-base --check-only."
}

# Attaches the image without mounting and mounts its single APFS Data-role volume read-only,
# nosuid, nodev and noexec. Sets REBASE_DISK for rebase_volume_release.
REBASE_DISK=''
rebase_volume_mount() {
  local image="$1" mnt="$2" attached i entry container j store data='' role
  attached=$(hdiutil attach -readonly -nomount -noverify -noautofsck -plist "$image") || die 'cannot attach the rebase clone disk read-only'
  i=0
  while entry=$(printf '%s\n' "$attached" | plutil -extract "system-entities.$i.dev-entry" raw -o - - 2>/dev/null); do
    case "$entry" in /dev/disk[0-9]|/dev/disk[0-9][0-9]|/dev/disk[0-9][0-9][0-9]) [ -n "$REBASE_DISK" ] || REBASE_DISK=${entry#/dev/} ;; esac
    i=$((i + 1))
  done
  [ -n "$REBASE_DISK" ] || die 'the attached clone disk has no whole-disk entry'
  container=$(diskutil apfs list -plist) || die 'cannot list APFS containers'
  i=0
  while store=$(printf '%s\n' "$container" | plutil -extract "Containers.$i.PhysicalStores.0.DeviceIdentifier" raw -o - - 2>/dev/null); do
    case "$store" in "${REBASE_DISK}s"[0-9]*)
      j=0
      while role=$(printf '%s\n' "$container" | plutil -extract "Containers.$i.Volumes.$j.Roles.0" raw -o - - 2>/dev/null || printf 'none'); do
        printf '%s\n' "$container" | plutil -extract "Containers.$i.Volumes.$j.DeviceIdentifier" raw -o - - >/dev/null 2>&1 || break
        if [ "$role" = Data ]; then [ -z "$data" ] || die 'the clone disk has more than one Data volume'; data=$(printf '%s\n' "$container" | plutil -extract "Containers.$i.Volumes.$j.DeviceIdentifier" raw -o - -); fi
        j=$((j + 1))
      done ;;
    esac
    i=$((i + 1))
  done
  [ -n "$data" ] || die 'the clone disk has no APFS Data volume'
  /sbin/mount_apfs -o rdonly,nobrowse,nosuid,nodev,noexec "/dev/$data" "$mnt" || die 'cannot mount the clone Data volume read-only (a FileVault-locked guest volume cannot be checked)'
}
rebase_volume_release() {
  local mnt="$1"
  /sbin/umount "$mnt" 2>/dev/null || true
  [ -z "$REBASE_DISK" ] || hdiutil detach -force "/dev/$REBASE_DISK" >/dev/null 2>&1 || true
  rmdir "$mnt" 2>/dev/null || true
}

# A symlink anywhere in a path read from the clone would resolve on the host, so every component
# must be a real object on the mounted volume.
clone_real() {
  local p="$1" rest="$2" part
  while [ -n "$rest" ]; do
    part=${rest%%/*}
    if [ "$part" = "$rest" ]; then rest=''; else rest=${rest#*/}; fi
    p="$p/$part"
    [ ! -L "$p" ] || die 'a clone path contains a symlink'
  done
}
# Every check reads the clone's own files. A registered guest keeps root-owned records the runner
# cannot delete; prepare-registration leaves registration-history; the runner leaves work or logs.
verify_rebase_volume() {
  local root="$1" gate="$2" peer_source="$3" host_script="$4" name dir seal field want rel
  for rel in opt/actions-runner private/var/db/case-macos-vm usr/local/libexec/case-macos-vm private/var/root; do
    clone_real "$root" "$rel"; [ -d "$root/$rel" ] || die "the clone has no $rel"
  done
  for rel in usr/local/libexec/case-macos-vm/case-macos-gate.mjs usr/local/libexec/case-macos-vm/case-macos-peer usr/local/libexec/case-macos-vm/cleanup usr/local/libexec/case-macos-vm/job-started.js usr/local/libexec/case-macos-vm/job-completed.js private/var/root/setup-case-macos-vm.sh; do
    [ -f "$root/$rel" ] && [ ! -L "$root/$rel" ] || die "the clone has no regular $rel"
  done
  for name in .runner .credentials .credentials_rsaparams; do
    [ ! -e "$root/opt/actions-runner/$name" ] && [ ! -L "$root/opt/actions-runner/$name" ] || die 'the clone holds registration records; never reseal a registered guest'
  done
  for name in registration-maintenance registration-history; do
    [ ! -e "$root/private/var/db/case-macos-vm/$name" ] && [ ! -L "$root/private/var/db/case-macos-vm/$name" ] || die 'the clone entered registration; never reseal it'
  done
  for name in _work _diag; do
    dir="$root/opt/actions-runner/$name"
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ -z "$(ls -A "$dir")" ] || die "runner $name is not empty; the clone ran the runner"
  done
  seal="$root/private/var/db/case-macos-vm/sealed.json"
  [ -f "$seal" ] && [ ! -L "$seal" ] && [ "$(stat -f '%u' "$seal")" = 0 ] || die 'the clone has no root-owned guest seal'
  [ "$(plutil -extract bootPolicy raw -o - "$seal" 2>/dev/null)" = closed-until-owner-open ] && [ "$(plutil -extract network raw -o - "$seal" 2>/dev/null)" = owner-proved ] || die 'the clone seal is not an owner seal'
  # Installed bytes, the seal's record and the owner's reviewed values must all agree.
  [ "$(sha_of "$root/usr/local/libexec/case-macos-vm/case-macos-gate.mjs")" = "$gate" ] || die 'the clone gate differs from the reviewed gate'
  [ "$(plutil -extract lifecycle.gate raw -o - "$seal" 2>/dev/null)" = "$gate" ] || die 'the clone seal does not record the reviewed gate'
  [ "$(plutil -extract lifecycle.peerSource raw -o - "$seal" 2>/dev/null)" = "$peer_source" ] || die 'the clone seal does not record the reviewed peer source; run update-guest-lifecycle in it'
  [ "$(plutil -extract lifecycle.peer raw -o - "$seal" 2>/dev/null)" = "$(sha_of "$root/usr/local/libexec/case-macos-vm/case-macos-peer")" ] || die 'the clone peer binary differs from its seal'
  for field in cleanup:cleanup hookStarted:job-started.js hookCompleted:job-completed.js; do
    case "${field%%:*}" in
      cleanup) want=$(cleanup_template | text_sha) ;;
      hookStarted) want=$(job_hook_text started | text_sha) ;;
      hookCompleted) want=$(job_hook_text completed | text_sha) ;;
    esac
    [ "$(sha_of "$root/usr/local/libexec/case-macos-vm/${field#*:}")" = "$want" ] && [ "$(plutil -extract "lifecycle.${field%%:*}" raw -o - "$seal" 2>/dev/null)" = "$want" ] || die "the clone ${field#*:} differs from this reviewed script"
  done
  [ "$(sha_of "$root/private/var/root/setup-case-macos-vm.sh")" = "$host_script" ] || die 'the clone setup script differs from the host reviewed copy'
}

# Atomic in the sense that matters: the previous reference and hashes are renamed aside, never
# deleted, until the new reference verifies; any failure renames them back.
swap_base_reference() {
  local stage="$1" sums="$2"
  [ ! -e "$STATE/base.swap" ] && [ ! -e "$STATE/base.sha256.swap" ] || die 'an interrupted swap exists; inspect base.swap manually'
  mv "$STATE/base" "$STATE/base.swap"; mv "$STATE/base.sha256" "$STATE/base.sha256.swap"
  mv "$stage" "$STATE/base"; mv "$sums" "$STATE/base.sha256"
  if verify_reference base base.sha256; then
    rm -rf "$STATE/base.previous"; rm -f "$STATE/base.sha256.previous"
    mv "$STATE/base.swap" "$STATE/base.previous"; mv "$STATE/base.sha256.swap" "$STATE/base.sha256.previous"
    return 0
  fi
  rm -rf "$STATE/base"; rm -f "$STATE/base.sha256"
  mv "$STATE/base.swap" "$STATE/base"; mv "$STATE/base.sha256.swap" "$STATE/base.sha256"
  die 'the new reference did not verify; the previous reference is restored'
}
base_history() {
  printf '%s %s %s->%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >> "$STATE/base-history.log"
  chmod 600 "$STATE/base-history.log"
}

reseal_base() {
  local gate='' peer_source='' check=0 option names mnt stage copy part old service_uid identity
  while [ "$#" -gt 0 ]; do
    option="$1"; shift
    if [ "$option" = --check-only ]; then [ "$check" = 0 ] || die 'duplicate --check-only'; check=1; continue; fi
    [ "$#" -gt 0 ] || die 'reseal-base option needs a value'
    case "$option" in
      --gate-sha256) [ -z "$gate" ] || die 'duplicate hash'; gate="$1" ;;
      --peer-source-sha256) [ -z "$peer_source" ] || die 'duplicate hash'; peer_source="$1" ;;
      *) die 'unknown reseal-base option' ;;
    esac; shift
  done
  for option in "$gate" "$peer_source"; do
    [ "${#option}" -eq 64 ] || die 'reseal-base needs --gate-sha256 and --peer-source-sha256 (64 lowercase hexadecimal characters, reviewed main)'
    case "$option" in *[!0123456789abcdef]*) die 'expected 64 lowercase hexadecimal characters' ;; esac
  done
  owner_root; root_path "$STATE"; root_path "$TART_BIN"; root_path "$STATE/base.sha256"; root_path "$STATE/rebase-pending.json"
  supervisor_unloaded
  [ "$(plutil -extract base raw -o - "$STATE/rebase-pending.json" 2>/dev/null)" = "$(sha_of "$STATE/base.sha256")" ] && [ "$(plutil -extract clone raw -o - "$STATE/rebase-pending.json" 2>/dev/null)" = "$REBASE_VM" ] || die 'the rebase clone was not made from the current protected base'
  names=$(stopped_vms | sort | tr '\n' ' ')
  [ "$names" = "case-macos-base $REBASE_VM " ] || die "only the stopped base and $REBASE_VM may exist (found: $names)"
  [ -f "$SERVICE_HOME/.tart/vms/$REBASE_VM/disk.img" ] && [ ! -L "$SERVICE_HOME/.tart/vms/$REBASE_VM/disk.img" ] || die 'the rebase clone disk is missing'
  # The service copies the clone (root never opens a service-controlled path), with seal-base's link
  # and owner checks. A service process could still hold a writable descriptor to those inodes, so
  # root then clones them into new inodes in a root-only stage: everything below reads only those.
  service_uid=$(id -u "$SERVICE_USER")
  copy=$(mktemp -d "$STATE/base-copy.XXXXXX"); stage=$(mktemp -d "$STATE/base-pending.XXXXXX")
  trap "rm -rf '$copy' '$stage'" EXIT
  chown "$SERVICE_USER:$SERVICE_USER" "$copy"; chmod 700 "$copy"; chmod 700 "$stage"
  for part in config.json disk.img nvram.bin; do
    as_service /bin/cp -c -P "$SERVICE_HOME/.tart/vms/$REBASE_VM/$part" "$copy/$part" || die 'clone copy failed'
  done
  chown root:wheel "$copy"; chmod 700 "$copy"
  for part in config.json disk.img nvram.bin; do
    [ -f "$copy/$part" ] && [ ! -L "$copy/$part" ] && [ "$(stat -f '%l:%u' "$copy/$part")" = "1:$service_uid" ] || die 'clone copy is hard-linked or not service-owned'
    chown -h root:wheel "$copy/$part"; chmod -N "$copy/$part"; chmod 444 "$copy/$part"
    /bin/cp -c -P "$copy/$part" "$stage/$part" || die 'root copy of the clone failed'
    chmod -N "$stage/$part"; chmod 444 "$stage/$part"
  done
  rm -rf "$copy"
  # The reference hash is taken before the mount and kept only if the bytes are unchanged after it.
  (cd "$stage" && shasum -a 256 config.json disk.img nvram.bin) > "$STATE/base.sha256.pending"
  chmod 444 "$STATE/base.sha256.pending"
  identity=$(cd "$stage" && stat -f '%i:%z:%Fm' config.json disk.img nvram.bin)
  mnt=$(mktemp -d /private/var/root/case-macos-rebase-mount.XXXXXX)
  trap "rebase_volume_release '$mnt'; rm -rf '$stage' '$STATE/base.sha256.pending'" EXIT
  rebase_volume_mount "$stage/disk.img" "$mnt"
  verify_rebase_volume "$mnt" "$gate" "$peer_source" "$(sha_of "$0")"
  rebase_volume_release "$mnt"; trap "rm -rf '$stage' '$STATE/base.sha256.pending'" EXIT
  [ "$(cd "$stage" && stat -f '%i:%z:%Fm' config.json disk.img nvram.bin)" = "$identity" ] || die 'the staged clone changed during verification; nothing swapped'
  if [ "$check" = 1 ]; then printf '%s\n' "REBASE CLONE VERIFIED (check only): never registered, reviewed lifecycle and seal. Nothing changed."; return 0; fi
  chmod 755 "$stage"
  supervisor_unloaded
  names=$(stopped_vms | sort | tr '\n' ' ')
  [ "$names" = "case-macos-base $REBASE_VM " ] || die "only the stopped base and $REBASE_VM may exist (found: $names)"
  old=$(sha_of "$STATE/base.sha256")
  swap_base_reference "$stage" "$STATE/base.sha256.pending"
  trap - EXIT
  base_history reseal-base "$old" "$(sha_of "$STATE/base.sha256")" "gate=$gate peerSource=$peer_source"
  rm -f "$STATE/rebase-pending.json"
  service_tart delete "$REBASE_VM" || die "base resealed, but $REBASE_VM could not be deleted; delete it before cycle-once"
  printf '%s\n' 'BASE RESEALED. The previous reference is base.previous (rollback-base restores it). Next: cycle-once restores case-macos-1 from the new base and the host registration backup.'
}

rollback_base() {
  local names old
  [ "$#" = 1 ] && [ "$1" = --confirm-rollback ] || die 'rollback-base requires --confirm-rollback'
  owner_root; root_path "$STATE"; root_path "$TART_BIN"; root_path "$STATE/base.previous"; root_path "$STATE/base.sha256.previous"
  supervisor_unloaded
  names=$(stopped_vms | tr '\n' ' ')
  case " $names" in *" $REBASE_VM "*) die "delete $REBASE_VM before a rollback" ;; esac
  verify_reference base.previous base.sha256.previous || die 'the previous reference does not verify; nothing changed'
  old=$(sha_of "$STATE/base.sha256")
  supervisor_unloaded
  rm -rf "$STATE/base.rolled-back"; rm -f "$STATE/base.sha256.rolled-back"
  mv "$STATE/base" "$STATE/base.rolled-back"; mv "$STATE/base.sha256" "$STATE/base.sha256.rolled-back"
  mv "$STATE/base.previous" "$STATE/base"; mv "$STATE/base.sha256.previous" "$STATE/base.sha256"
  verify_reference base base.sha256 || die 'restored reference does not verify; inspect base and base.rolled-back manually'
  base_history rollback-base "$old" "$(sha_of "$STATE/base.sha256")" rolled-back
  printf '%s\n' 'BASE ROLLED BACK to the previous reference; the replaced one is base.rolled-back. Delete case-macos-1 (stopped) and run cycle-once to restore from it.'
}

# Owner's read-only gate status (CASE-307, Julian 2026-10-28): the one command an agent may run without
# a password. It runs as the service through a single NOPASSWD sudo rule, takes no arguments, sends only
# {"op":"status"} over the pinned control transport and redacts the hold nonce.
guest_status_template() {
  cat <<TEXT
#!/bin/bash
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "\$#" = 0 ] || exit 64
[ "\$(id -un)" = '$SERVICE_USER' ] || exit 77
cd /
export TART_HOME='$SERVICE_HOME/.tart' TART_NO_AUTO_PRUNE=1
ip=\$('$TART_BIN' ip --resolver dhcp --wait 5 case-macos-1) || { echo 'case-macos-1 is not running'; exit 3; }
[[ "\$ip" =~ ^(10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)\$ ]] || exit 78
# Control characters stripped and the reply capped before parsing; nothing raw from the guest is printed.
reply=\$(printf '{"op":"status"}\n' | /usr/bin/ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=case-macos-vm -o 'UserKnownHostsFile=$STATE/known-hosts' -o GlobalKnownHostsFile=/dev/null -o ForwardAgent=no -o ClearAllForwardings=yes -i '$SERVICE_HOME/.ssh/control' "case-vm-control@\$ip" gate | /usr/bin/tr -d '\000-\010\013-\037\177' | /usr/bin/cut -c1-4096)
# Each field has one expected type; anything else prints as null.
field() {
  local type value
  type=\$(printf '%s' "\$reply" | /usr/bin/plutil -type "\$1" - 2>/dev/null) || { printf 'null'; return; }
  [ "\$type" = "\$2" ] || { printf 'null'; return; }
  value=\$(printf '%s' "\$reply" | /usr/bin/plutil -extract "\$1" raw -o - -)
  case "\$2" in
    bool) case "\$value" in true|false) printf '%s' "\$value" ;; *) printf 'null' ;; esac ;;
    integer) case "\$value" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "\$value" ;; esac ;;
    string) printf '"%s"' "\$(printf '%s' "\$value" | LC_ALL=C /usr/bin/tr -cd 'A-Za-z0-9 ._/:,()-' | /usr/bin/cut -c1-120)" ;;
  esac; }
out='{'; sep=''
for spec in ok:bool protocol:integer generation:string mode:string listener:bool starting:bool active:integer parked:integer unknown:integer residual:integer dirty:bool fault:string drained:bool; do
  out="\$out\$sep\"\${spec%%:*}\":\$(field "\${spec%%:*}" "\${spec##*:}")"; sep=','
done
printf '%s}\n' "\$out"
TEXT
}
install_owner_status() {
  [ "$#" = 2 ] && [ "$1" = --owner ] || die 'install-owner-status requires --owner <login>'
  local owner="$2" stage
  [[ "$owner" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$owner" != root ] || die 'expected the owner login'
  id "$owner" >/dev/null 2>&1 || die 'unknown owner account'
  owner_root; root_path "$LIBEXEC"; root_path /private/etc/sudoers.d
  id "$SERVICE_USER" >/dev/null 2>&1 || die 'run install-host first'
  guest_status_template > "$LIBEXEC/guest-status.pending"
  chown root:wheel "$LIBEXEC/guest-status.pending"; chmod 755 "$LIBEXEC/guest-status.pending"
  mv "$LIBEXEC/guest-status.pending" "$LIBEXEC/guest-status"
  stage=$(mktemp -d /private/var/root/case-owner-status.XXXXXX); trap "rm -rf '$stage'" EXIT
  # The empty-argument form refuses every argument.
  printf '%s ALL=(%s) NOPASSWD: %s/guest-status ""\n' "$owner" "$SERVICE_USER" "$LIBEXEC" > "$stage/sudoers"
  visudo -cf "$stage/sudoers" >/dev/null || die 'generated owner status rule did not validate'
  install -o root -g wheel -m 440 "$stage/sudoers" /private/etc/sudoers.d/case-macos-owner-status
  rm -rf "$stage"; trap - EXIT
  printf '%s\n' "OWNER STATUS INSTALLED for $owner: sudo -n -u $SERVICE_USER $LIBEXEC/guest-status (read-only, hold redacted). Nothing else is granted."
}

uninstall_owner_status() {
  [ "$#" = 0 ] || die 'uninstall-owner-status takes no arguments'
  owner_root
  [ ! -L /private/etc/sudoers.d/case-macos-owner-status ] && [ ! -L "$LIBEXEC/guest-status" ] || die 'refusing to remove through a symlink; inspect manually'
  rm -f /private/etc/sudoers.d/case-macos-owner-status "$LIBEXEC/guest-status"
  printf '%s\n' 'OWNER STATUS REMOVED: the sudo rule and guest-status are gone.'
}

install_host_lifecycle() {
  [ "$#" = 2 ] && [ "$1" = --owner-evidence ] || die 'install-host-lifecycle requires protected owner evidence'
  local evidence="$2"
  absolute_file "$evidence"; owner_root; root_path "$evidence"; root_path "$STATE/base.sha256"; root_path "$PLIST"
  [ ! -e "$STATE/host-sealed.json" ] || die 'host lifecycle already approved; no implicit replacement'
  check_evidence "$evidence"
  [ "$(plutil -extract cleanBaseUnregistered raw -o - "$evidence")" = true ] || die 'owner must attest protected base has no registration'
  [ "$(plutil -extract hostedReference raw -o - "$evidence")" = "$HOSTED_REFERENCE" ] || die 'record the hosted reference inventory; qualification remains an exact-source comparison'
  supervisor_template > "$LIBEXEC/supervisor.sh"; chown root:wheel "$LIBEXEC/supervisor.sh"; chmod 755 "$LIBEXEC/supervisor.sh"
  cp "$evidence" "$STATE/owner-evidence.json"; chmod 444 "$STATE/owner-evidence.json"
  printf '{"version":1,"stage":"owner-qualification","liveQualified":false}\n' > "$STATE/host-sealed.json"
  chmod 444 "$STATE/host-sealed.json"
  /usr/libexec/PlistBuddy -c 'Add :ProgramArguments:2 string supervise' "$PLIST"
  plutil -lint "$PLIST" >/dev/null
  printf '%s\n' 'Controller installed but LaunchDaemon remains DISABLED. Owner first reviews/runs cycle-once; no routing or qualification is implied.'
}

# Owner-run removal of the host layout. Refuses while any VM runs: removal never stops live work.
uninstall_host() {
  [ "$#" = 1 ] && [ "$1" = --confirm-remove-case-macos-vm ] || die 'uninstall-host requires --confirm-remove-case-macos-vm'
  owner_root
  local listing i state path
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    [ "$(dscl . -read "$DS_USERS/$SERVICE_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')" = "$SERVICE_HOME" ] || die 'service account differs from the reviewed account; inspect manually'
    if [ -x "$TART_BIN" ] && [ -d "$SERVICE_HOME/.tart" ]; then
      listing=$(as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" list --source local --format json) || die 'cannot list VMs; refusing removal'
      i=0
      while state=$(printf '%s\n' "$listing" | plutil -extract "$i.State" raw -o - - 2>/dev/null); do
        [ "$state" = stopped ] || die 'a VM is running; drain it (cycle-once, or shut the guest down from its console) first'
        i=$((i + 1))
      done
    fi
  fi
  if launchctl print "system/$DAEMON" >/dev/null 2>&1; then launchctl bootout "system/$DAEMON" || die 'supervisor did not unload'; fi
  # launchd keeps per-user agents (distnoted, lsd, cfprefsd) alive for days under any account that ran
  # programs, so a bare "no service processes" check never passed (seen 2026-10-29, after 7 days). Every VM
  # is stopped by now: end the account's launchd domains, then any process left, then check.
  local uid waited=0
  if uid=$(id -u "$SERVICE_USER" 2>/dev/null); then
    launchctl bootout "gui/$uid" 2>/dev/null || true
    launchctl bootout "user/$uid" 2>/dev/null || true
    while [ -n "$(pgrep -u "$SERVICE_USER" 2>/dev/null || true)" ] && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done
    # Never a VM: Tart, Softnet or a Virtualization process still alive refuses removal instead.
    case "$(ps -U "$SERVICE_USER" -o comm= 2>/dev/null || true)" in *tart*|*softnet*|*Virtualization*) die 'a VM process is still running; shut the guest down first' ;; esac
    pkill -KILL -u "$SERVICE_USER" 2>/dev/null || true
    sleep 1
  fi
  [ -z "$(pgrep -u "$SERVICE_USER" 2>/dev/null || true)" ] || die 'service processes are still running; inspect before removal'
  for path in "$PLIST" /private/etc/sudoers.d/case-macos-softnet /private/etc/sudoers.d/case-macos-owner-status "$LIBEXEC" "$STATE" "$SERVICE_HOME"; do
    [ ! -L "$path" ] || die 'refusing to remove through a symlink; inspect manually'
  done
  rm -f "$PLIST" /private/etc/sudoers.d/case-macos-softnet /private/etc/sudoers.d/case-macos-owner-status
  rm -rf "$LIBEXEC" "$STATE" "$SERVICE_HOME"
  if id "$SERVICE_USER" >/dev/null 2>&1; then dscl . -delete "$DS_USERS/$SERVICE_USER"; fi
  if dscl . -read "/Groups/$SERVICE_USER" >/dev/null 2>&1; then dscl . -delete "/Groups/$SERVICE_USER"; fi
  printf '%s\n' 'HOST LAYOUT REMOVED: daemon, sudo rule, tools, protected base, VMs, registration backup and service account.'
  printf '%s\n' 'Owner: remove runner case-macos-1 in GitHub settings, and delete the IPSW if it is still staged.'
}

# The gate is up only when launchd reports it running and its public socket exists (CASE-300).
gate_up() {
  local tries="$1" state
  while [ "$tries" -gt 0 ]; do
    state=$(launchctl print "system/$GATE_LABEL" 2>/dev/null | awk -F' = ' '/^\tstate = / {print $2; exit}' || true)
    if [ "$state" = running ] && [ -S "$GATE_RUN_DIR/gate.sock" ]; then return 0; fi
    sleep 1; tries=$((tries - 1))
  done
  return 1
}
enable_guest_gate() {
  [ "$#" = 1 ] && [ "$1" = --inside-guest ] || die 'explicit guest acknowledgement required'
  owner_root; root_path "$STATE/sealed.json"
  [ "$(cat '/Library/Application Support/Case CI/vm-role')" = case-macos-vm ] || die 'guest role marker required'
  [ ! -e "$STATE/registration-maintenance" ] && [ ! -L "$STATE/registration-maintenance" ] || die 'registration maintenance remains active'
  root_path /opt/actions-runner/externals/node24/bin/node
  root_path "$LIBEXEC/case-macos-gate.mjs"; root_path "$LIBEXEC/case-macos-peer"; root_path "$GATE_RUN_DIR"
  local recorded
  # A seal from before CASE-300 has no lifecycle record; update-guest-lifecycle adds it.
  recorded=$(plutil -extract lifecycle.gate raw -o - "$STATE/sealed.json" 2>/dev/null) || die 'seal records no lifecycle hashes; run update-guest-lifecycle'
  [ "$recorded" = "$(sha_of "$LIBEXEC/case-macos-gate.mjs")" ] && [ "$(plutil -extract lifecycle.peer raw -o - "$STATE/sealed.json")" = "$(sha_of "$LIBEXEC/case-macos-peer")" ] || die 'installed gate or peer differs from the sealed record'
  [ -z "$(pgrep -u runner || true)" ] || die 'runner processes exist; drain/reset rather than restart over live work'
  root_path "$GATE_PLIST"
  /usr/libexec/PlistBuddy -c 'Set :Disabled false' "$GATE_PLIST"
  /usr/libexec/PlistBuddy -c 'Set :RunAtLoad true' "$GATE_PLIST"
  /usr/libexec/PlistBuddy -c 'Set :KeepAlive true' "$GATE_PLIST"
  launchctl enable "system/$GATE_LABEL"
  if launchctl print "system/$GATE_LABEL" >/dev/null 2>&1; then launchctl bootout "system/$GATE_LABEL" || die 'existing gate did not unload'; fi
  launchctl bootstrap system "$GATE_PLIST"
  gate_up 30 || die 'gate did not come up: launchctl state is not running or the socket is missing'
  printf '%s\n' 'Guest gate loaded CLOSED and running. No listener starts until authenticated start; no workflow routing changed.'
}

prepare_registration() {
  [ "$#" = 1 ] && [ "$1" = --inside-guest ] || die 'explicit guest acknowledgement required'
  owner_root; root_path "$STATE/sealed.json"; root_path /opt/actions-runner
  [ "$(cat '/Library/Application Support/Case CI/vm-role')" = case-macos-vm ] || die 'guest role marker required'
  [ ! -e "$STATE/registration-maintenance" ] && [ ! -L "$STATE/registration-maintenance" ] || die 'registration maintenance already exists'
  local existing
  for existing in .runner .credentials .credentials_rsaparams; do
    [ ! -e "/opt/actions-runner/$existing" ] && [ ! -L "/opt/actions-runner/$existing" ] || die 'fresh unregistered clone required'
  done
  [ -z "$(pgrep -u runner || true)" ] || die 'runner work exists; refuse registration maintenance'
  # Never removed: reseal-base refuses any guest that ever entered registration (CASE-304).
  printf '%s prepare-registration\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE/registration-history"
  chmod 600 "$STATE/registration-history"
  # Persist first: even reboot/restart cannot activate cleanup while the owner is configuring.
  printf '%s\n' owner-registration-maintenance > "$STATE/registration-maintenance"
  chmod 600 "$STATE/registration-maintenance"
  launchctl disable system/app.iatrogenic.case-macos-gate
  if launchctl print system/app.iatrogenic.case-macos-gate >/dev/null 2>&1; then
    launchctl bootout system/app.iatrogenic.case-macos-gate
  fi
  if launchctl print system/app.iatrogenic.case-macos-gate >/dev/null 2>&1; then die 'guest gate did not unload'; fi
  [ -z "$(pgrep -u runner || true)" ] || die 'runner work appeared; package remains sealed'
  local file
  for file in /opt/actions-runner/.env /opt/actions-runner/.path; do root_path "$file"; done
  chown runner:runner /opt/actions-runner /opt/actions-runner/.env /opt/actions-runner/.path
  chmod u+w /opt/actions-runner/.env /opt/actions-runner/.path
  printf '%s\n' 'OWNER REGISTRATION MAINTENANCE ONLY: gate unloaded and restart blocked. Configure interactively, restore parent root ownership, then seal-registration and enable-guest-gate.'
}

# GitHub's runner (.NET) writes its registration JSON with a UTF-8 byte-order mark, which the gate's
# JSON.parse rejects on registration export/import (CASE-302). The runner reads these files with or without
# one, so drop it in place.
strip_utf8_bom() {
  local file="$1" tmp
  [ "$(head -c 3 "$file" | od -An -tx1 | tr -d ' \n')" = efbbbf ] || return 0
  tmp=$(mktemp "$file.XXXXXX") || return 1
  if tail -c +4 "$file" > "$tmp" && mv -f "$tmp" "$file"; then return 0; fi
  rm -f "$tmp"; return 1
}

seal_registration() {
  [ "$#" = 1 ] && [ "$1" = --inside-guest ] || die 'explicit guest acknowledgement required'
  owner_root; root_path "$STATE/sealed.json"
  [ "$(cat '/Library/Application Support/Case CI/vm-role')" = case-macos-vm ] || die 'guest role marker required'
  [ -z "$(pgrep -u runner || true)" ] || die 'runner must not be running while registration is sealed'
  root_path "$STATE/registration-maintenance"
  root_path /opt/actions-runner
  local name file node=/opt/actions-runner/externals/node24/bin/node
  root_path "$node"
  for name in .runner .credentials .credentials_rsaparams; do
    file="/opt/actions-runner/$name"
    [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -f '%z' "$file")" -le 24576 ] || die 'missing or invalid registration file'
    strip_utf8_bom "$file" || die 'cannot remove the registration byte-order mark'
    # The gate's own parser: plutil's lint accepts only property lists and fails every JSON file.
    /usr/bin/env -i "$node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" || die 'registration record is not valid JSON'
  done
  [ "$(plutil -extract agentName raw -o - /opt/actions-runner/.runner)" = case-macos-1 ] && [ "$(plutil -extract gitHubUrl raw -o - /opt/actions-runner/.runner)" = https://github.com/julianjming-hash/case ] && [ "$(plutil -extract workFolder raw -o - /opt/actions-runner/.runner)" = _work ] || die 'registration identity differs from dedicated Case runner'
  for name in .runner .credentials .credentials_rsaparams; do
    chown -h root:runner "/opt/actions-runner/$name"; chmod -N "/opt/actions-runner/$name"; chmod 440 "/opt/actions-runner/$name"
  done
  for name in .env .path; do
    [ ! -L "/opt/actions-runner/$name" ] || die 'runner environment file is a symlink'
    [ ! -e "/opt/actions-runner/$name" ] || [ -f "/opt/actions-runner/$name" ] || die 'unexpected runner environment object'
    rm -f "/opt/actions-runner/$name"
  done
  cat > /opt/actions-runner/.env <<'ENV'
HOME=/private/var/case-vm-runner
TMPDIR=/private/var/case-vm-runner/tmp
PATH=/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
CASE_REQUIRE_DB=1
ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/case-macos-vm/job-started.js
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/case-macos-vm/job-completed.js
ENV
  printf '%s\n' /opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin > /opt/actions-runner/.path
  chmod 444 /opt/actions-runner/.env /opt/actions-runner/.path
  rm "$STATE/registration-maintenance"
  printf '%s\n' 'Registration sealed. No listener started. The three records stay private; rebuild update is owner-managed.'
}

# Approved image staging (Julian, 2026-10-18): Tart reads the IPSW as the service account, so the
# file is root:$SERVICE_USER 0440 in a root-owned directory the service may enter but not write.
stage_ipsw() {
  [ "$#" = 2 ] && [ "$1" = --ipsw ] || die 'stage-ipsw requires --ipsw /absolute/downloaded.ipsw'
  local source="$2" stage actual
  case "$source" in /*.ipsw) ;; *) die '--ipsw must be an absolute local .ipsw path' ;; esac
  absolute_file "$source"; owner_root; root_path "$STATE"
  id "$SERVICE_USER" >/dev/null 2>&1 || die 'run install-host first: the service account reads the staged image'
  [ ! -e "$IPSW_DIR" ] && [ ! -L "$IPSW_DIR" ] || die 'an image is already staged; remove-ipsw first'
  [ "$(stat -f '%z' "$source")" = "$APPROVED_IPSW_BYTES" ] || die 'IPSW size differs from the approved image; nothing staged'
  stage=$(mktemp -d "$STATE/ipsw-pending.XXXXXX")
  trap "rm -rf '$stage'" EXIT
  # An APFS clone where possible: later writes to the owner's download cannot reach these bytes.
  # The protected copy is the one hashed, so a source changed mid-copy fails the hash.
  cp -c "$source" "$stage/$IPSW_NAME" 2>/dev/null || cp "$source" "$stage/$IPSW_NAME" || die 'cannot copy the IPSW into protected staging'
  [ -f "$stage/$IPSW_NAME" ] && [ ! -L "$stage/$IPSW_NAME" ] && [ "$(stat -f '%l' "$stage/$IPSW_NAME")" = 1 ] || die 'unexpected staged IPSW object'
  chown root:wheel "$stage/$IPSW_NAME"; chmod 0400 "$stage/$IPSW_NAME"
  actual=$(shasum -a 256 "$stage/$IPSW_NAME") || die 'cannot hash the staged IPSW'
  actual=${actual%% *}
  [ "$actual" = "$APPROVED_IPSW_SHA256" ] || die 'IPSW SHA-256 mismatch; nothing staged'
  chown "root:$SERVICE_USER" "$stage" "$stage/$IPSW_NAME"; chmod 0750 "$stage"; chmod 0440 "$stage/$IPSW_NAME"
  mv "$stage" "$IPSW_DIR"; trap - EXIT
  as_service /bin/test -r "$IPSW_PATH" || die 'the service account cannot read the staged image'
  if as_service /bin/test -w "$IPSW_PATH" || as_service /bin/test -w "$IPSW_DIR"; then die 'the service account can write the staged image'; fi
  printf 'IPSW STAGED: %s, root:%s mode 0440, SHA-256 %s\n' "$IPSW_PATH" "$SERVICE_USER" "$actual"
  printf '%s\n' 'Delete your downloaded copy now. remove-ipsw deletes this one after the first qualification passes.'
}

remove_ipsw() {
  [ "$#" = 0 ] || die 'remove-ipsw takes no arguments'
  owner_root; root_path "$STATE"
  [ -d "$IPSW_DIR" ] && [ ! -L "$IPSW_DIR" ] && [ ! -L "$IPSW_PATH" ] || die 'no staged image'
  rm -f "$IPSW_PATH"
  rmdir "$IPSW_DIR" || die 'unexpected objects beside the staged image; inspect manually'
  printf '%s\n' 'IPSW REMOVED.'
}

# The one working clone after seal-base. Registration happens only in this clone (lifecycle-guide C).
clone_commands() {
  [ "$#" = 0 ] || die 'clone-commands takes no arguments'
  cat <<TEXT
#!/bin/bash
# REVIEW ONLY. Clones the sealed, stopped base into case-macos-1 (SLA: base plus this clone = 2).
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
tart() { sudo -u '$SERVICE_USER' /usr/bin/env TART_HOME='$SERVICE_HOME/.tart' TART_NO_AUTO_PRUNE=1 PATH='$LIBEXEC:/usr/bin:/bin:/usr/sbin:/sbin' '$TART_BIN' "\$@"; }
[ -x '$TART_BIN' ] || { echo 'Missing reviewed root-owned Tart layout; complete owner-guide' >&2; exit 1; }
sudo /bin/test -f '$STATE/base.sha256' || { echo 'Run seal-base first: only the sealed base is cloned' >&2; exit 1; }
listing=\$(tart list --source local --format json)
[ "\$(printf '%s\\n' "\$listing" | plutil -extract 0.Name raw -o - -)" = case-macos-base ] && [ "\$(printf '%s\\n' "\$listing" | plutil -extract 0.State raw -o - -)" = stopped ] || { echo 'The only local VM must be the stopped case-macos-base' >&2; exit 1; }
if printf '%s\\n' "\$listing" | plutil -extract 1.Name raw -o - - >/dev/null 2>&1; then echo 'Another VM exists; the SLA count allows the base plus one clone' >&2; exit 1; fi
tart clone case-macos-base case-macos-1
listing=\$(tart list --source local --format json)
names=\$(for i in 0 1 2; do printf '%s\\n' "\$listing" | plutil -extract "\$i.Name" raw -o - - 2>/dev/null || true; done | sort | tr '\\n' ' ')
[ "\$names" = 'case-macos-1 case-macos-base ' ] || { echo "Unexpected VMs after clone: \$names" >&2; exit 1; }
echo 'CLONE CREATED: case-macos-1, stopped and unregistered. Next: console-commands case-macos-1, then prepare-registration in its console.'
TEXT
}

# Absolute owner path, same input language as the IPSW path; existence is checked when the helper runs.
safe_absolute() {
  case "$1" in /*) ;; *) die 'expected an absolute path' ;; esac
  case "$1" in *[!a-zA-Z0-9_./\ -]*|*/../*|*/./*) die 'unsafe input path' ;; esac
}

# Owner host helper for provisioning the base: isolation canaries, the one-time file transfer over the
# setup admin's temporary Remote Login, and the owner evidence. Julian ruled the transfer (2026-10-18):
# host-initiated scp (Softnet's 'in @host' allows it), then Remote Login is restricted to case-vm-control.
host_helper() {
  local repo='' node='' archive='' ip='' admin='' option
  while [ "$#" -gt 0 ]; do
    option="$1"; shift; [ "$#" -gt 0 ] || die 'host-helper option needs a value'
    case "$option" in
      --repo) [ -z "$repo" ] || die 'duplicate --repo'; repo="$1" ;;
      --node) [ -z "$node" ] || die 'duplicate --node'; node="$1" ;;
      --runner-archive) [ -z "$archive" ] || die 'duplicate --runner-archive'; archive="$1" ;;
      --guest-ip) [ -z "$ip" ] || die 'duplicate --guest-ip'; ip="$1" ;;
      --guest-admin) [ -z "$admin" ] || die 'duplicate --guest-admin'; admin="$1" ;;
      *) die 'unknown host-helper option' ;;
    esac; shift
  done
  [ -n "$repo" ] && [ -n "$node" ] && [ -n "$archive" ] && [ -n "$ip" ] && [ -n "$admin" ] || die 'host-helper needs --repo --node --runner-archive --guest-ip --guest-admin'
  safe_absolute "$repo"; safe_absolute "$node"; safe_absolute "$archive"
  private_ip "$ip" || die 'expected the guest private IPv4 address from its console'
  [[ "$admin" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die 'expected the guest setup admin short name'
  cat <<'TEXT'
#!/bin/bash
# REVIEW ONLY. Owner host helper for provisioning case-macos-base. Run as yourself, one phase at a time:
#   canary-up | push | check before | check after | pull-results | verify <router public IPv4> | admin-refused | push-script | canary-down
# One-command owner sittings (CASE-307): dry-run-cleanup | rebase | qualify-pair <40-hex main SHA>
# It uses sudo only for the bridge canary addresses, reading control.pub, comparing the root copy and
# installing guest-host.pub and isolation.json. It never stores a password; ssh asks for it on the terminal.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
TEXT
  printf 'repo=%q\nnode=%q\nrunner_archive=%q\nguest_ip=%q\nguest_admin=%q\n' "$repo" "$node" "$archive" "$ip" "$admin"
  printf 'service_home=%q\nrunner_name=%q\nrunner_sha256=%q\ncanary_port=%q\n' "$SERVICE_HOME" "actions-runner-osx-arm64-$GUEST_RUNNER_VERSION.tar.gz" "$GUEST_RUNNER_SHA256" "$CANARY_PORT"
  printf 'service_user=%q\ntart_bin=%q\nlibexec=%q\n' "$SERVICE_USER" "$TART_BIN" "$LIBEXEC"
  cat <<'TEXT'
work="$HOME/case-macos-provision"
stop() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || stop 'run as yourself; the helper uses sudo only where it says so'
[ -x "$node" ] || stop 'node is not executable'
[ "$#" -ge 1 ] || stop 'name a phase: canary-up, push, check before|after, pull-results, verify <router IPv4>, admin-refused, push-script, canary-down, dry-run-cleanup, rebase, qualify-pair <sha>'
umask 077
mkdir -p "$work"; chmod 700 "$work"
reviewed() { git -C "$repo" --no-replace-objects show "origin/main:$1"; }
# A fresh known_hosts per run, pinned to the ed25519 key Julian compares with the guest console.
guest_scp() { /usr/bin/scp -F /dev/null -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=ask -o HostKeyAlgorithms=ssh-ed25519 -o ForwardAgent=no -o ClearAllForwardings=yes -o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive,password -o ControlMaster=auto -o "ControlPath=$work/cm-%C" -o ControlPersist=600 "$@"; }
# One password per sitting: scp and ssh share a control connection for ten minutes.
guest_ssh() { /usr/bin/ssh -F /dev/null -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=ask -o HostKeyAlgorithms=ssh-ed25519 -o ForwardAgent=no -o ClearAllForwardings=yes -o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive,password -o ServerAliveInterval=30 -o ControlMaster=auto -o "ControlPath=$work/cm-%C" -o ControlPersist=600 "$@"; }
svc_tart() { sudo -u "$service_user" /usr/bin/env TART_HOME="$service_home/.tart" TART_NO_AUTO_PRUNE=1 "$tart_bin" "$@"; }
vm_state() { (cd / && svc_tart list --source local) | awk -v vm="$1" '$2 == vm {print $NF}'; }
vm_ip() {
  local ip
  ip=$(cd / && svc_tart ip --resolver dhcp --wait 60 "$1") || stop "cannot resolve the address of $1"
  [[ "$ip" =~ ^(10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)$ ]] || stop "unexpected address for $1"
  printf '%s\n' "$ip"
}
wait_stopped() {
  local waited=0
  until [ "$(vm_state "$1")" = stopped ]; do [ "$waited" -lt 600 ] || stop "$1 did not stop"; sleep 5; waited=$((waited + 5)); done
}
stop_vm() {
  [ "$(vm_state "$1")" = running ] || return 0
  echo "This stops $1. GitHub must show case-macos-1 idle (no job running)."
  read -r -p 'Press Return to stop it, or Ctrl-C to abort: ' _
  (cd / && svc_tart stop --timeout 30 "$1")
  wait_stopped "$1"
}
reviewed_root_copy() {
  git -C "$repo" fetch -q origin
  reviewed scripts/setup-case-macos-vm.sh | sudo /usr/bin/cmp -s /private/var/root/setup-case-macos-vm.sh - || stop 'the root copy differs from origin/main; re-copy it first'
}
console_boot() {
  local url
  sudo /bin/bash /private/var/root/setup-case-macos-vm.sh console-commands "$1" --accept-lan-vnc | sudo /usr/bin/tee "/private/var/root/case-macos-console-$1.sh" > /dev/null
  sudo /bin/chmod 0500 "/private/var/root/case-macos-console-$1.sh"
  (cd /tmp && sudo /bin/bash "/private/var/root/case-macos-console-$1.sh")
  # Opens Screen Sharing here; the one-time URL is never printed.
  url=$(sudo -u "$service_user" /usr/bin/sed -n 's|^VNC server is running at \(vnc://.*\)$|\1|p' "$service_home/console-vnc.txt")
  [ -n "$url" ] || stop 'no console URL'
  /usr/bin/open "$url"; unset url
}
open_ssh_window() {
  echo 'In the guest console (Screen Sharing): log in as setup, open Terminal and type exactly:'
  echo '  sudo dseditgroup -o edit -a setup -t user com.apple.access_ssh'
  read -r -p 'Press Return here once it is done: ' _
}
gate_clean() {
  local status
  status=$(sudo -n -u "$service_user" "$libexec/guest-status" 2>/dev/null) || return 1
  case "$status" in *'"mode":"OPEN"'*'"dirty":false,"fault":null'*) return 0 ;; *) return 1 ;; esac
}
# The guest script ends by shutting the guest down, so ssh exits non-zero even on success. The guest's
# own last line decides instead of ssh's exit status. Lines over ssh -t end in CR.
guest_finished() {
  /usr/bin/tr -d '\r' < "$1" | /usr/bin/grep -qx -- "$2"
}
guest_dryrun_script() {
  cat <<'GUEST'
#!/bin/bash
set -uo pipefail
cd /
echo 'DRY-RUN of the reviewed cleanup in the DISPOSABLE faulted clone, with its gate unloaded.'
sudo launchctl bootout system/app.iatrogenic.case-macos-gate 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print system/app.iatrogenic.case-macos-gate >/dev/null 2>&1 || break; sleep 1; done
if launchctl print system/app.iatrogenic.case-macos-gate >/dev/null 2>&1; then echo 'STOPPED: the gate is still loaded'; exit 1; fi
if pgrep -f /opt/actions-runner/bin/Runner.Listener >/dev/null; then echo 'STOPPED: a runner listener is running'; exit 1; fi
echo 'Gate unloaded; no Runner.Listener.'
sudo install -o root -g wheel -m 0444 ~/case-cleanup-dryrun /private/var/tmp/case-cleanup-dryrun
rm -f ~/case-cleanup-dryrun ~/case-dryrun-guest.sh
echo '--- before (top three levels):'
sudo find /private/var/case-vm-runner /opt/actions-runner/_work /opt/actions-runner/_diag -mindepth 1 -maxdepth 3 2>/dev/null | sed -n '1,40p'
sudo -u runner /bin/bash /private/var/tmp/case-cleanup-dryrun; status=$?
echo "--- cleanup exit $status"
echo '--- after:'
sudo find /private/var/case-vm-runner /opt/actions-runner/_work /opt/actions-runner/_diag -mindepth 1 2>/dev/null | sed -n '1,40p'
sudo rm -f /private/var/tmp/case-cleanup-dryrun
sudo dseditgroup -o edit -d setup -t user com.apple.access_ssh
echo 'DRY-RUN DONE. Shutting the disposable clone down.'
sudo shutdown -h now
GUEST
}
guest_rebase_script() {
  cat <<'GUEST'
#!/bin/bash
set -euo pipefail
[[ "${1:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${2:-}" =~ ^[0-9a-f]{64}$ ]] || { echo 'STOPPED: reviewed hashes required'; exit 1; }
cd ~/script-update
shasum -a 256 -c SHA256SUMS
shasum -a 256 SHA256SUMS
sudo install -o root -g wheel -m 0500 setup-case-macos-vm.sh /private/var/root/
sudo install -o root -g wheel -m 0400 case-macos-gate.mjs case-macos-peer.c /private/var/root/
cd /
rm -rf ~/script-update ~/case-rebase-guest.sh
update() { sudo /bin/bash /private/var/root/setup-case-macos-vm.sh update-guest-lifecycle --inside-guest --gate-source /private/var/root/case-macos-gate.mjs --peer-source /private/var/root/case-macos-peer.c --gate-sha256 "$1" --peer-sha256 "$2"; }
# A running gate can still be exiting when the update checks it (known race): retry once.
update "$1" "$2" || { sleep 3; update "$1" "$2"; }
sudo /bin/bash /private/var/root/setup-case-macos-vm.sh enable-guest-gate --inside-guest
sudo dseditgroup -o edit -d setup -t user com.apple.access_ssh
dscl . -read /Groups/com.apple.access_ssh GroupMembership
echo 'GUEST UPDATED. Shutting the rebase clone down.'
sudo shutdown -h now
GUEST
}
phase="$1"; shift
case "$phase" in
  canary-up)
    [ "$#" = 0 ] || stop 'canary-up takes no arguments'
    [ ! -e "$work/network-targets.json" ] || stop "a canary run exists in $work; move that folder aside to start again"
    reviewed scripts/case-network-canary.mjs > "$work/case-network-canary.mjs"
    reviewed scripts/case-macos-gate.mjs > "$work/case-macos-gate.mjs"
    bridge=$(route -n get "$guest_ip" | awk '/interface:/ {print $2}')
    [[ "$bridge" =~ ^bridge[0-9]+$ ]] || stop "the guest is not behind a VM bridge (route: $bridge)"
    gateway=$(ifconfig "$bridge" | awk '$1 == "inet" {print $2; exit}')
    lan=$(ipconfig getifaddr "$(route -n get default | awk '/interface:/ {print $2}')" || true)
    linklocal=$(ifconfig "$bridge" | awk '$1 == "inet6" && $2 ~ /^fe80:/ {print $2; exit}')
    [ -n "$gateway" ] && [ -n "$lan" ] && [ -n "$linklocal" ] || stop 'cannot read the bridge gateway, the LAN address or the bridge link-local address'
    printf '%s\n' "$bridge" > "$work/bridge"
    echo "Adding temporary canary addresses to $bridge (canary-down removes them; they also go when the VM stops)."
    sudo /sbin/ifconfig "$bridge" alias 10.250.0.1 netmask 255.255.255.255
    sudo /sbin/ifconfig "$bridge" alias 172.31.250.1 netmask 255.255.255.255
    sudo /sbin/ifconfig "$bridge" alias 192.168.5.2 netmask 255.255.255.255
    sudo /sbin/ifconfig "$bridge" inet6 fd00:ca5e::1 prefixlen 64 alias
    sudo /sbin/ifconfig "$bridge" inet6 2001:db8:ca5e::1 prefixlen 64 alias
    sleep 3
    "$node" "$work/case-network-canary.mjs" targets --out "$work/network-targets.json" --port "$canary_port" --guest-interface en0 \
      --target "host-gateway=$gateway" --target "host-lan=$lan" --target private-routes=10.250.0.1 --target private-routes=172.31.250.1 \
      --target linux-peer=192.168.5.2 --target "ipv6-linklocal=$linklocal" --target ipv6-ula=fd00:ca5e::1 --target ipv6-global=2001:db8:ca5e::1
    nohup "$node" "$work/case-network-canary.mjs" serve --targets "$work/network-targets.json" --log "$work/canary-log.jsonl" > "$work/canary-serve.out" 2>&1 &
    printf '%s\n' "$!" > "$work/canary.pid"
    sleep 2
    kill -0 "$(cat "$work/canary.pid")" 2>/dev/null || { cat "$work/canary-serve.out" >&2; rm -f "$work/canary.pid"; stop 'the canary listener did not start'; }
    echo "CANARIES UP on $bridge. Next: push." ;;
  push)
    [ "$#" = 0 ] || stop 'push takes no arguments'
    [ -f "$work/network-targets.json" ] || stop 'run canary-up first'
    bundle="$work/case-transfer"
    [ ! -e "$bundle" ] || stop "$bundle exists; remove it to rebuild the bundle"
    mkdir "$bundle"
    reviewed scripts/setup-case-macos-vm.sh > "$bundle/setup-case-macos-vm.sh"
    sudo /usr/bin/cmp -s /private/var/root/setup-case-macos-vm.sh "$bundle/setup-case-macos-vm.sh" || stop 'the origin/main setup script differs from the reviewed root copy'
    reviewed scripts/case-macos-gate.mjs > "$bundle/case-macos-gate.mjs"
    reviewed scripts/case-macos-peer.c > "$bundle/case-macos-peer.c"
    sudo /bin/cat "$service_home/.ssh/control.pub" > "$bundle/control.pub"
    /bin/cp "$runner_archive" "$bundle/$runner_name"
    printf '%s  %s\n' "$runner_sha256" "$bundle/$runner_name" | shasum -a 256 -c - >/dev/null || stop 'the runner archive is not the pinned package'
    /bin/cp "$work/network-targets.json" "$bundle/network-targets.json"
    (cd "$bundle" && shasum -a 256 setup-case-macos-vm.sh case-macos-gate.mjs case-macos-peer.c control.pub "$runner_name" network-targets.json) > "$work/SHA256SUMS"
    mv "$work/SHA256SUMS" "$bundle/SHA256SUMS"
    echo "Bundle from origin/main $(git -C "$repo" rev-parse origin/main). Compare this SHA256SUMS digest in the guest:"
    shasum -a 256 "$bundle/SHA256SUMS" | awk '{print $1}'
    echo 'ssh shows the guest host key fingerprint: type yes only if it matches the guest console. Then type the setup admin password.'
    guest_scp -r "$bundle" "$guest_admin@$guest_ip:"
    guest_scp "$guest_admin@$guest_ip:/etc/ssh/ssh_host_ed25519_key.pub" "$work/guest-host.pub"
    known=$(awk '$2 == "ssh-ed25519" {print $2, $3}' "$work/known_hosts")
    [ -n "$known" ] && [ "$known" = "$(awk '{print $1, $2}' "$work/guest-host.pub")" ] || stop 'the copied guest host key differs from the key ssh accepted'
    ssh-keygen -lf "$work/guest-host.pub"
    sudo /usr/bin/install -o root -g wheel -m 0400 "$work/guest-host.pub" /private/var/root/guest-host.pub
    echo 'PUSHED to ~/case-transfer in the guest. Guest host key staged at /private/var/root/guest-host.pub.' ;;
  check)
    [ "$#" = 1 ] && { [ "$1" = before ] || [ "$1" = after ]; } || stop 'check before|after'
    [ -f "$work/canary.pid" ] || stop 'the canaries are not up'
    "$node" "$work/case-network-canary.mjs" check --targets "$work/network-targets.json" --out "$work/positive-$1.json" ;;
  pull-results)
    [ "$#" = 0 ] || stop 'pull-results takes no arguments'
    guest_scp "$guest_admin@$guest_ip:case-probe-root.json" "$guest_admin@$guest_ip:case-probe-runner.json" "$work/" ;;
  verify)
    [ "$#" = 1 ] || stop 'verify <router public IPv4>'
    for file in positive-before.json positive-after.json case-probe-root.json case-probe-runner.json canary-log.jsonl; do [ -f "$work/$file" ] || stop "missing $file"; done
    echo 'The host copy records cleanBaseUnregistered=true: the base is never registered, only its clone.'
    "$node" "$work/case-network-canary.mjs" verify --targets "$work/network-targets.json" --before "$work/positive-before.json" --after "$work/positive-after.json" \
      --root "$work/case-probe-root.json" --runner "$work/case-probe-runner.json" --log "$work/canary-log.jsonl" --router-ip "$1" \
      --attest-clean-base-unregistered --guest-out "$work/isolation-guest.json" --host-out "$work/isolation-host.json"
    sudo /usr/bin/install -o root -g wheel -m 0400 "$work/isolation-host.json" /private/var/root/isolation.json
    guest_scp "$work/isolation-guest.json" "$guest_admin@$guest_ip:isolation.json"
    echo 'EVIDENCE STAGED: /private/var/root/isolation.json on the host, ~/isolation.json in the guest.' ;;
  admin-refused)
    [ "$#" = 0 ] || stop 'admin-refused takes no arguments'
    echo 'Type the setup admin password once if asked. A refusal is the expected result.'
    result=0
    output=$(/usr/bin/ssh -F /dev/null -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive,password -o NumberOfPasswordPrompts=1 -o ForwardAgent=no -o ClearAllForwardings=yes "$guest_admin@$guest_ip" true 2>&1) || result=$?
    [ "$result" != 0 ] || stop 'the setup admin can still log in over SSH'
    # macOS denies an account outside com.apple.access_ssh in PAM and closes the connection after the
    # password ("Access denied ... by PAM account configuration" in the guest log); OpenSSH elsewhere
    # says Permission denied. A timeout or refused port is not a refusal.
    case "$output" in
      *'Permission denied'*|*"Connection closed by $guest_ip port 22"*) echo 'SETUP ADMIN REFUSED over SSH. Confirm in the guest log: Access denied for user setup by PAM account configuration.' ;;
      *) stop "no SSH refusal seen: $output" ;;
    esac ;;
  push-script)
    [ "$#" = 0 ] || stop 'push-script takes no arguments'
    update="$work/script-update"
    [ ! -e "$update" ] || stop "$update exists; remove it to rebuild the update"
    mkdir "$update"
    reviewed scripts/setup-case-macos-vm.sh > "$update/setup-case-macos-vm.sh"
    sudo /usr/bin/cmp -s /private/var/root/setup-case-macos-vm.sh "$update/setup-case-macos-vm.sh" || stop 'the origin/main setup script differs from the reviewed root copy'
    reviewed scripts/case-macos-gate.mjs > "$update/case-macos-gate.mjs"
    reviewed scripts/case-macos-peer.c > "$update/case-macos-peer.c"
    (cd "$update" && shasum -a 256 setup-case-macos-vm.sh case-macos-gate.mjs case-macos-peer.c) > "$work/script-update.sums"
    mv "$work/script-update.sums" "$update/SHA256SUMS"
    echo "Script from origin/main $(git -C "$repo" rev-parse origin/main). Compare this SHA256SUMS digest in the guest:"
    shasum -a 256 "$update/SHA256SUMS" | awk '{print $1}'
    guest_scp -r "$update" "$guest_admin@$guest_ip:"
    echo 'PUSHED the reviewed script, gate and peer source to ~/script-update in the guest.'
    echo 'For a gate/peer fix, run in the guest after installing them (the hashes are reviewed main):'
    echo "sudo /bin/bash /private/var/root/setup-case-macos-vm.sh update-guest-lifecycle --inside-guest --gate-source /private/var/root/case-macos-gate.mjs --peer-source /private/var/root/case-macos-peer.c --gate-sha256 $(shasum -a 256 "$update/case-macos-gate.mjs" | awk '{print $1}') --peer-sha256 $(shasum -a 256 "$update/case-macos-peer.c" | awk '{print $1}')" ;;
  canary-down)
    [ "$#" = 0 ] || stop 'canary-down takes no arguments'
    if [ -f "$work/canary.pid" ]; then kill "$(cat "$work/canary.pid")" 2>/dev/null || true; rm -f "$work/canary.pid"; fi
    if [ -f "$work/bridge" ]; then
      bridge=$(cat "$work/bridge")
      [[ "$bridge" =~ ^bridge[0-9]+$ ]] || stop 'unexpected bridge record'
      for address in 10.250.0.1 172.31.250.1 192.168.5.2; do sudo /sbin/ifconfig "$bridge" -alias "$address" 2>/dev/null || true; done
      for address in fd00:ca5e::1 2001:db8:ca5e::1; do sudo /sbin/ifconfig "$bridge" inet6 "$address" -alias 2>/dev/null || true; done
    fi
    echo "CANARIES DOWN. Keep $work as owner evidence." ;;
  dry-run-cleanup)
    # Orchestrator conditions (2026-10-28): only in the faulted working clone, which rebase then deletes;
    # the gate is unloaded and no Runner.Listener may run; no workflow is dispatched meanwhile.
    [ "$#" = 0 ] || stop 'dry-run-cleanup takes no arguments'
    reviewed_root_copy
    stamp=$(date -u +%Y%m%dT%H%M%SZ); dry="$work/dry-run-$stamp"; mkdir "$dry"
    reviewed scripts/setup-case-macos-vm.sh > "$dry/setup-case-macos-vm.sh"
    /bin/bash "$dry/setup-case-macos-vm.sh" cleanup > "$dry/case-cleanup-dryrun"
    guest_dryrun_script > "$dry/case-dryrun-guest.sh"
    echo 'Do not dispatch any workflow until this phase ends.'
    stop_vm case-macos-1
    console_boot case-macos-1
    open_ssh_window
    ip=$(vm_ip case-macos-1)
    guest_scp "$dry/case-cleanup-dryrun" "$dry/case-dryrun-guest.sh" "setup@$ip:"
    guest_ssh -t "setup@$ip" /bin/bash ./case-dryrun-guest.sh | tee "$dry/evidence.log" || true
    guest_finished "$dry/evidence.log" 'DRY-RUN DONE. Shutting the disposable clone down.' || stop "the guest dry-run did not finish; read $dry/evidence.log"
    wait_stopped case-macos-1
    sudo /bin/rm -f "$service_home/console-vnc.txt"
    printf '%s gate unloaded for the dry-run in the disposable faulted clone; rebase deletes it\n' "$stamp" >> "$dry/evidence.log"
    guest_finished "$dry/evidence.log" '--- cleanup exit 0' || stop "the cleanup did not exit 0; do not rebase. Read $dry/evidence.log"
    echo "DRY-RUN PASSED. Evidence: $dry/evidence.log. Next: rebase (it deletes this clone)." ;;
  rebase)
    [ "$#" = 0 ] || stop 'rebase takes no arguments'
    reviewed_root_copy
    stamp=$(date -u +%Y%m%dT%H%M%SZ); round="$work/rebase-$stamp"; update="$round/script-update"; mkdir -p "$update"
    reviewed scripts/setup-case-macos-vm.sh > "$update/setup-case-macos-vm.sh"
    reviewed scripts/case-macos-gate.mjs > "$update/case-macos-gate.mjs"
    reviewed scripts/case-macos-peer.c > "$update/case-macos-peer.c"
    (cd "$update" && shasum -a 256 setup-case-macos-vm.sh case-macos-gate.mjs case-macos-peer.c) > "$round/SHA256SUMS"
    mv "$round/SHA256SUMS" "$update/SHA256SUMS"
    gate_sha=$(shasum -a 256 "$update/case-macos-gate.mjs" | awk '{print $1}')
    peer_sha=$(shasum -a 256 "$update/case-macos-peer.c" | awk '{print $1}')
    guest_rebase_script > "$round/case-rebase-guest.sh"
    echo "Re-base from origin/main $(git -C "$repo" rev-parse origin/main): gate $gate_sha, peer source $peer_sha."
    stop_vm case-macos-1
    sudo /bin/bash /private/var/root/setup-case-macos-vm.sh rebase-clone --delete-stopped-working-clone
    console_boot case-macos-rebase
    open_ssh_window
    ip=$(vm_ip case-macos-rebase)
    echo "Bundle digest (the guest checks it): $(shasum -a 256 "$update/SHA256SUMS" | awk '{print $1}')"
    guest_scp -r "$update" "$round/case-rebase-guest.sh" "setup@$ip:"
    guest_ssh -t "setup@$ip" /bin/bash ./case-rebase-guest.sh "$gate_sha" "$peer_sha" | tee "$round/guest.log" || true
    guest_finished "$round/guest.log" 'GUEST UPDATED. Shutting the rebase clone down.' || stop "the guest update did not finish; read $round/guest.log"
    wait_stopped case-macos-rebase
    sudo /bin/rm -f "$service_home/console-vnc.txt"
    sudo /bin/bash /private/var/root/setup-case-macos-vm.sh reseal-base --gate-sha256 "$gate_sha" --peer-source-sha256 "$peer_sha" --check-only
    sudo /bin/bash /private/var/root/setup-case-macos-vm.sh reseal-base --gate-sha256 "$gate_sha" --peer-source-sha256 "$peer_sha"
    (cd / && sudo -u "$service_user" -H /bin/bash "$libexec/supervisor.sh" cycle-once)
    echo 'REBASED: base resealed and case-macos-1 restored from it. Next: qualify-pair <main SHA>.' ;;
  qualify-pair)
    [ "$#" = 1 ] && [[ "$1" =~ ^[0-9a-f]{40}$ ]] || stop 'qualify-pair needs one full lowercase main SHA'
    command -v gh >/dev/null || stop 'gh is required'
    sha="$1"; runs=''
    for n in 1 2; do
      gate_clean || stop "the gate is not clean before run $n; read guest-status"
      since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      gh workflow run qualify-macos-vm.yml --repo julianjming-hash/case --ref main -f "sha=$sha"
      id=''
      for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
        sleep 5
        id=$(gh run list --repo julianjming-hash/case --workflow qualify-macos-vm.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")] | first | .databaseId // empty")
        [ -z "$id" ] || break
      done
      [ -n "$id" ] || stop "run $n did not appear"
      echo "Run $n: https://github.com/julianjming-hash/case/actions/runs/$id"
      gh run watch "$id" --repo julianjming-hash/case --exit-status --interval 30 >/dev/null || stop "run $n ($id) did not pass; see the link above"
      runs="$runs $id"
      # The second run must start only after the first one's post-job cleanup has finished.
      waited=0
      until gate_clean; do [ "$waited" -lt 1200 ] || stop 'the gate did not return clean after the run'; sleep 15; waited=$((waited + 15)); done
    done
    echo "QUALIFIED PAIR on $sha:$runs" ;;
  *) stop "unknown phase $phase" ;;
esac
TEXT
}

# Re-stages the root inventory probe from this reviewed script in a guest that is not yet sealed, so a
# probe fix reaches an already bootstrapped base without rebuilding it.
refresh_guest_probe() {
  [ "$#" = 1 ] && [ "$1" = --inside-guest ] || die 'refresh-guest-probe requires --inside-guest'
  owner_root; root_path "$LIBEXEC"; root_path "$LIBEXEC/guest-root-probe"
  local marker='/Library/Application Support/Case CI/vm-role'
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -f '%u:%Lp' "$marker")" = 0:444 ] && [ "$(cat "$marker")" = case-macos-vm ] || die 'guest role marker required; refusing host execution'
  [ ! -e "$STATE/sealed.json" ] && [ ! -L "$STATE/sealed.json" ] || die 'guest already sealed; rebuild the base instead of changing it'
  guest_root_probe > "$LIBEXEC/guest-root-probe.pending"
  chown root:wheel "$LIBEXEC/guest-root-probe.pending"; chmod 755 "$LIBEXEC/guest-root-probe.pending"
  mv "$LIBEXEC/guest-root-probe.pending" "$LIBEXEC/guest-root-probe"
  shasum -a 256 "$LIBEXEC/guest-root-probe"
  printf '%s\n' 'GUEST ROOT PROBE REFRESHED from this reviewed script. Guest not sealed; run probe-host on the host.'
}

# Replaces the gate and peer in an UNREGISTERED guest, sealed or not (CASE-300), from root-owned copies
# whose SHA-256 the owner pastes from host-helper push-script (reviewed main). It never runs once a
# runner registration, maintenance marker, runner process or runner service exists: those mean a job
# could have run, and such a guest is rebuilt instead. The seal is re-recorded with the new hashes.
update_guest_lifecycle() {
  local inside=0 gate='' peer='' gate_sha='' peer_sha='' option stage name item old_gate old_peer
  while [ "$#" -gt 0 ]; do
    option="$1"; shift
    if [ "$option" = --inside-guest ]; then [ "$inside" = 0 ] || die 'duplicate guest acknowledgement'; inside=1; continue; fi
    [ "$#" -gt 0 ] || die 'lifecycle update option needs a value'
    case "$option" in
      --gate-source) [ -z "$gate" ] || die 'duplicate source'; gate="$1" ;;
      --peer-source) [ -z "$peer" ] || die 'duplicate source'; peer="$1" ;;
      --gate-sha256) [ -z "$gate_sha" ] || die 'duplicate hash'; gate_sha="$1" ;;
      --peer-sha256) [ -z "$peer_sha" ] || die 'duplicate hash'; peer_sha="$1" ;;
      *) die 'unknown lifecycle update option' ;;
    esac; shift
  done
  [ "$inside" = 1 ] && [ -n "$gate" ] && [ -n "$peer" ] && [ -n "$gate_sha" ] && [ -n "$peer_sha" ] || die 'update-guest-lifecycle needs --inside-guest, both sources and both reviewed SHA-256 values'
  for item in "$gate_sha" "$peer_sha"; do
    [ "${#item}" -eq 64 ] || die 'expected 64 lowercase hexadecimal characters'
    # An explicit list, not a range: in a UTF-8 locale a-f can collate uppercase letters in.
    case "$item" in *[!0123456789abcdef]*) die 'expected 64 lowercase hexadecimal characters' ;; esac
  done
  absolute_file "$gate"; absolute_file "$peer"; owner_root; root_path "$gate"; root_path "$peer"; root_path "$LIBEXEC"; root_path "$STATE/guest.json"
  local marker='/Library/Application Support/Case CI/vm-role'
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -f '%u:%Lp' "$marker")" = 0:444 ] && [ "$(cat "$marker")" = case-macos-vm ] || die 'guest role marker required; refusing host execution'
  for name in .runner .credentials .credentials_rsaparams; do
    [ ! -e "/opt/actions-runner/$name" ] && [ ! -L "/opt/actions-runner/$name" ] || die 'registered guest: rebuild from a clean base instead of updating it'
  done
  [ ! -e "$STATE/registration-maintenance" ] && [ ! -L "$STATE/registration-maintenance" ] || die 'registration maintenance is active; finish or rebuild instead'
  [ -z "$(pgrep -u runner || true)" ] || die 'runner processes exist; refusing to replace the gate under live work'
  for item in /Library/LaunchDaemons/actions.runner.* /Library/LaunchAgents/actions.runner.*; do
    [ ! -e "$item" ] || die 'a runner service is installed; rebuild instead'
  done
  stage=$(mktemp -d /private/var/root/case-macos-update.XXXXXX); trap "rm -rf '$stage'" EXIT
  cp "$gate" "$stage/gate.mjs"; cp "$peer" "$stage/peer.c"
  # The staged copies are the ones hashed, compiled and installed.
  [ "$(sha_of "$stage/gate.mjs")" = "$gate_sha" ] && [ "$(sha_of "$stage/peer.c")" = "$peer_sha" ] || die 'source SHA-256 differs from the reviewed value; nothing installed'
  /usr/bin/clang -Wall -Wextra -Werror -O2 "$stage/peer.c" -lbsm -o "$stage/peer" || die 'peer helper did not compile; nothing installed'
  if launchctl print "system/$GATE_LABEL" >/dev/null 2>&1; then launchctl bootout "system/$GATE_LABEL" || die 'gate did not unload'; fi
  ! launchctl print "system/$GATE_LABEL" >/dev/null 2>&1 || die 'gate is still loaded'
  old_gate=$(sha_of "$LIBEXEC/case-macos-gate.mjs"); old_peer=$(sha_of "$LIBEXEC/case-macos-peer")
  install -o root -g wheel -m 755 "$stage/peer" "$LIBEXEC/case-macos-peer"
  install -o root -g wheel -m 644 "$stage/gate.mjs" "$LIBEXEC/case-macos-gate.mjs"
  stage_job_scripts
  install -d -o root -g wheel -m 755 "$GATE_RUN_DIR"
  # The root inventory reports the gate state (CASE-300); re-stage it from this reviewed script too.
  guest_root_probe > "$LIBEXEC/guest-root-probe.pending"
  chown root:wheel "$LIBEXEC/guest-root-probe.pending"; chmod 755 "$LIBEXEC/guest-root-probe.pending"
  mv "$LIBEXEC/guest-root-probe.pending" "$LIBEXEC/guest-root-probe"
  if [ -d /private/var/run/case-macos-vm ] && [ ! -L /private/var/run/case-macos-vm ]; then rmdir /private/var/run/case-macos-vm 2>/dev/null || true; fi
  printf '%s gate %s->%s peer %s->%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$old_gate" "$(sha_of "$LIBEXEC/case-macos-gate.mjs")" "$old_peer" "$(sha_of "$LIBEXEC/case-macos-peer")" >> "$STATE/lifecycle-updates.log"
  chmod 600 "$STATE/lifecycle-updates.log"
  if [ -e "$STATE/sealed.json" ]; then write_seal "$(sha_of "$LIBEXEC/case-macos-gate.mjs")" "$(sha_of "$LIBEXEC/case-macos-peer")" update-guest-lifecycle "$peer_sha"; fi
  shasum -a 256 "$LIBEXEC/case-macos-gate.mjs" "$LIBEXEC/case-macos-peer" "$LIBEXEC/guest-root-probe" "$LIBEXEC/cleanup" "$LIBEXEC/job-started.js" "$LIBEXEC/job-completed.js"
  printf '%s\n' 'LIFECYCLE UPDATED, gate unloaded. Next: enable-guest-gate --inside-guest, then reboot the guest and run probe-host (expects lifecycle=gate-up).'
  rm -rf "$stage"; trap - EXIT
}

# Re-stages the host's Softnet shim, root helper and supervisor from this reviewed script while no VM runs
# (CASE-301), because install-host refuses an existing layout. Network isolation must be re-proved after.
refresh_host_network() {
  [ "$#" = 0 ] || die 'refresh-host-network takes no arguments'
  owner_root; root_path "$LIBEXEC"; root_path "$TART_BIN"
  local listing i state name
  listing=$(as_service env TART_HOME="$SERVICE_HOME/.tart" TART_NO_AUTO_PRUNE=1 "$TART_BIN" list --source local --format json) || die 'cannot list VMs; nothing changed'
  i=0
  while state=$(printf '%s\n' "$listing" | plutil -extract "$i.State" raw -o - - 2>/dev/null); do
    [ "$state" = stopped ] || die 'a VM is running; stop it before changing its network helpers'
    i=$((i + 1))
  done
  softnet_shim > "$LIBEXEC/softnet.pending"; softnet_root > "$LIBEXEC/softnet-root.pending"; supervisor_template > "$LIBEXEC/supervisor.sh.pending"
  for name in softnet softnet-root supervisor.sh; do
    chown root:wheel "$LIBEXEC/$name.pending"; chmod 755 "$LIBEXEC/$name.pending"; mv "$LIBEXEC/$name.pending" "$LIBEXEC/$name"
  done
  shasum -a 256 "$LIBEXEC/softnet" "$LIBEXEC/softnet-root" "$LIBEXEC/supervisor.sh"
  printf '%s\n' "HOST NETWORK HELPERS REFRESHED (CASE-301): Softnet allow is now '$NETWORK_ALLOW', which disables vmnet bridge isolation; every private, host and special block still applies. Re-run the isolation canaries before registration."
}

lifecycle_guide() {
  cat <<'TEXT' | sed -e "s|@GUEST_DNS_CSV@|$GUEST_DNS_CSV|g" -e "s|@CANARY_PORT@|$CANARY_PORT|g" -e "s|@HOSTED_REFERENCE@|$HOSTED_REFERENCE|g" -e "s|@HOSTED_REFERENCE_TEXT@|$HOSTED_REFERENCE_TEXT|g" -e "s|@COORDINATION_HOLD@|$COORDINATION_HOLD|g"
OWNER LIFECYCLE PROCEDURE — source engineering, NOT live qualification
Only Julian performs the following installation/registration/VM operations. No agent has run them.
Use protected reviewed copies under /private/var/root, root:wheel, code 0500/inputs 0400; never sudo repository code.

A. Provision initial unregistered base using manual-guest. host-helper push already put the reviewed
   gate.mjs and peer.c into /private/var/root in the guest; run in the GUEST console:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh install-guest-lifecycle --inside-guest --gate-source /private/var/root/case-macos-gate.mjs --peer-source /private/var/root/case-macos-peer.c
   Pinned Node 24 comes from the verified Actions archive; its tree becomes root-owned. Work/diag
   stay runner-owned. The root socket daemon, hooks and native broker are staged DISABLED.

B. Before registration, prove isolation with host/LAN/peer known-answer listeners. Record positive
   connectivity immediately before AND after each guest-negative test; closed ports prove nothing.
   In both root and runner guest contexts test host gateway/loopback routes, every host LAN address,
   Linux peers, private/special IPv4 routes and IPv6 (global, ULA and link-local). All must be denied.
   Record public GitHub and registry.npmjs.org TLS success; no host mounts, sharing, guest agent,
   clipboard, forwarded credential or general sudo. Any unexpected TCP connection is failure.
   Confirm effective sshd settings allow ONLY case-vm-control, public-key authentication and the
   fixed forced command; attempt a shell, SFTP, forwarding, PTY and wrong key and record refusal.
   host-helper canary-up (manual-guest 5) serves known-answer canaries on port @CANARY_PORT@ at
   the bridge gateway, the host LAN address and temporary bridge addresses for private routes
   (10.250.0.1, 172.31.250.1), the Linux peers' host address (192.168.5.2: Lima's user-mode VMs have
   no address of their own on the host or LAN), the bridge link-local address, a ULA (fd00:ca5e::1) and
   a global documentation address (2001:db8:ca5e::1). network-targets.json carries the run's witness.
   On the host: /bin/bash ~/case-macos-host-helper.sh check before
   In the GUEST console, saving each JSON result to the setup admin's home:
   sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs probe-network > ~/case-probe-root.json
   sudo -u runner /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs probe-network > ~/case-probe-runner.json
   On the host: check after, then pull-results, then verify <router public IPv4>, then canary-down.
   Only ETIMEDOUT, ENETUNREACH or EHOSTUNREACH counts as blocked; a refused connection reached a host.
   verify passes only if every canary answered the host with the witness before AND after, both guest
   contexts tested exactly these targets with the same witness and every one was blocked, public TLS
   and dnsServers='@GUEST_DNS_CSV@' passed, no shared mount was reported, and the canary log holds
   only the host's own check connections: any other connection is failure. It then writes the
   evidence (root/runner/positiveControls/ipv6/mounts='passed', the approved guestVersion/guestBuild
   and ipswSHA256, dnsServers, routerPublicIP; the host copy adds cleanBaseUnregistered=true and
   hostedReference='@HOSTED_REFERENCE@', the @HOSTED_REFERENCE_TEXT@), installs the host copy as
   /private/var/root/isolation.json and copies the guest copy to ~/isolation.json in the guest.
   A matching version alone never proves gate parity. These proofs cannot come from offline tests.
   Close the transfer window: in guest Settings > General > Sharing > Remote Login, allow ONLY
   case-vm-control; in the console dscl . -read /Groups/com.apple.access_ssh GroupMembership must print
   exactly GroupMembership: case-vm-control. On the host run admin-refused (the setup admin must get
   Permission denied, or on macOS a closed connection with "Access denied for user setup by PAM account
   configuration" in the guest log), then configure-guest and probe-host (manual-guest 7), which checks
   it again. If a probe fix lands before seal-guest: re-copy the root script, regenerate host-helper,
   briefly re-add setup to Remote Login (sudo dseditgroup -o edit -a setup -t user com.apple.access_ssh),
   run host-helper push-script, then in the guest verify ~/script-update/SHA256SUMS, install the script
   to /private/var/root root:wheel 0500, run refresh-guest-probe --inside-guest, remove setup again
   (dseditgroup -d) and rerun admin-refused and probe-host.
   A gate or peer fix in a guest that is not registered, sealed or not (CASE-300): the same transfer,
   then also install case-macos-gate.mjs and case-macos-peer.c to /private/var/root root:wheel 0400,
   run the update-guest-lifecycle line push-script printed (its hashes are reviewed main), remove setup,
   run enable-guest-gate (it waits for a running gate with its socket), reboot the guest with
   console-commands, and rerun admin-refused and probe-host (Gate running, socket present).
   In the GUEST console:
   sudo install -o root -g wheel -m 0400 ~/isolation.json /private/var/root/isolation.json
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh seal-guest --inside-guest --isolation-evidence /private/var/root/isolation.json
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh enable-guest-gate --inside-guest
   In console, verify gate status CLOSED, no listener and no registration. Shut down the guest OS.
   On HOST, with only stopped case-macos-base present:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh seal-base
   The protected COW reference has no registration. Never register or boot that reference again.

C. Network first (CASE-301): with every VM stopped, run refresh-host-network on the HOST so Softnet runs
   with the allow list that disables macOS vmnet isolation (whose IPv4 pass rule loses its mask for
   192.168 /30s, cutting the host off). After the clone boots, re-run the isolation canaries on it
   (host-helper canary-up, push, check before, both probe-network runs, check after, pull-results,
   verify) before registering: every target must still be blocked and GitHub reachable.
   On the HOST, generate clone-commands, review it and run it (SLA: base plus this clone = 2):
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh clone-commands > ~/case-macos-clone.sh
   /bin/bash ~/case-macos-clone.sh
   Boot the clone with console-commands case-macos-1 --accept-lan-vnc (CASE-298; exact Softnet and
   device restrictions). In its GUEST console, registration is interactive:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh prepare-registration --inside-guest
   This persistently disables/unloads the CLOSED gate and writes a maintenance block BEFORE config writes.
   It refuses active runner processes; never register while the ordinary gate cleanup is running.
   cd /opt/actions-runner
   sudo -u runner -H ./config.sh --url https://github.com/julianjming-hash/case --name case-macos-1 --labels case-macos-vm --disableupdate --work _work
   Enter the short-lived token ONLY into that prompt, never argv/env/log/source/image. Do not run
   run.sh or install svc.sh. Restore the package parent root ownership immediately after config:
   sudo chown root:wheel /opt/actions-runner
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh seal-registration --inside-guest
   This validates the fixed repo/name/work root, seals credentials and writes fixed root-owned
   .env/.path settings, then clears the maintenance block. Restart the guest gate CLOSED:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh enable-guest-gate --inside-guest
   No general sudo and no package auto-update.
   Gate controls use stdin JSON, not argument interpolation. As GUEST owner:
   printf '{"op":"start"}\n' | sudo /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs control
   printf '{"op":"status"}\n' | sudo /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs control
   Poll status until listener=true, then root open for a strictly bounded manual qualification job:
   printf '{"op":"open"}\n' | sudo /opt/actions-runner/externals/node24/bin/node /usr/local/libexec/case-macos-vm/case-macos-gate.mjs control
   Do not route the production Mac lane yet. Owner registration material is guest-readable by
   necessity; malicious same-repo jobs remain able to steal their current job/runner credentials.
   Until a reviewed activation change, the job-started hook admits only qualify-macos-vm.yml on
   refs/heads/main triggered by workflow_dispatch; any other job fails before checkout.

D. configure-guest already bound the console-verified host key in manual-guest 7, and the clone keeps
   the base's SSH host key; do not rerun it (it refuses an existing binding). On HOST, install the
   reviewed host controller after B's physical isolation evidence:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh install-host-lifecycle --owner-evidence /private/var/root/isolation.json
   Run owner-reviewed controller as the dedicated service (the first cycle backs up registration):
   sudo -u case-macos-runner -H /bin/bash /usr/local/libexec/case-macos-vm/supervisor.sh cycle-once
   It acquires the existing heavy lock, closes admission using current generation/nonce, waits for
   active Workers and cleanup, requires parked0, freezes/rescans/stops only an idle listener, saves
   only the three registration records through pinned SSH into private mode 0600 host state, then
   stops/deletes the idle working VM, reconstructs the writable base from root COW reference,
   clones/boots, restores registration and reopens only the matching current hold. Errors stay closed.
   Verify fresh home/work/tmp, immutable runner/hook files and unchanged registration identity.
   Prove that close during a real job lets it finish, a new job parks before checkout, and reboot /
   failed cleanup / low disk / stale hold / network offline never produces a false drained ACK.

   The daily reset runs at the first idle moment after 00:00 UTC (08:00 AWST). To defer every reset,
   the owner creates the empty coordination hold file @COORDINATION_HOLD@ (sudo touch);
   removing it resumes resets. /private/var/run is cleared at boot, so a hold never survives reboot.

E. After physical logout/reboot/FileVault recovery, realistic mini-load and exact-SHA paired Mac
   qualification pass, owner can enable the HOST service:
   sudo launchctl enable system/app.iatrogenic.case-macos-vm
   sudo /usr/libexec/PlistBuddy -c 'Set :Disabled false' /Library/LaunchDaemons/app.iatrogenic.case-macos-vm.plist
   sudo /usr/libexec/PlistBuddy -c 'Set :RunAtLoad true' /Library/LaunchDaemons/app.iatrogenic.case-macos-vm.plist
   sudo /usr/libexec/PlistBuddy -c 'Set :KeepAlive true' /Library/LaunchDaemons/app.iatrogenic.case-macos-vm.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/app.iatrogenic.case-macos-vm.plist
   Routing/variables remain a separately reviewed owner activation. No hosted fallback is automatic.

RECOVERY: a stale heavy lock is never auto-deleted. Owner inspects lock identity/owner/process and
removes ONLY their proven-dead lock; never rm -rf /tmp/case-heavy.lock. A failed/unknown guest stays
closed. Do not restart over active Workers or stop busy VMs. After all work is known finished, use
console shutdown and the last protected registration backup to restore a fresh clone; if backup is
missing or stale, manually unregister/re-register inside a fresh proved guest using prepare-registration
and seal-registration. A leftover maintenance marker keeps the gate disabled until owner completion.
Never copy an unknown working disk over the clean reference. Restore FileVault/login manually after
host power loss.
RE-REGISTRATION: the three registration records are readable by jobs and persist in the guest and in
the host backup (registration.json). Re-register after any suspected job compromise, at every runner
update rebuild, and whenever a job outside the admitted workflow ran: remove case-macos-1 in GitHub
settings, delete the host registration.json, then prepare-registration, interactive config.sh with
a new short-lived token and seal-registration inside a fresh clone of the clean base.
REBASE (CASE-304): a gate, peer, cleanup, hook or runner fix reaches future clones only through the
protected base, replaced from a never-registered clone of it. With the working clone drained and
stopped (shut it down from its console, or cycle-once's stop), on the HOST:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh rebase-clone --delete-stopped-working-clone
It verifies the reference, deletes the stopped working clone (the host registration backup restores
it later), rebuilds the writable base and clones case-macos-rebase, recording which base it came from.
Boot it with console-commands case-macos-rebase --accept-lan-vnc. In its console, briefly re-add the
setup admin to Remote Login (sudo dseditgroup -o edit -a setup -t user com.apple.access_ssh), run
host-helper push-script for its address, install the script, gate and peer source as for a lifecycle
fix and run the update-guest-lifecycle line push-script printed (it re-stages cleanup and hooks and
records every hash in the seal), then enable-guest-gate --inside-guest, remove setup again
(dseditgroup -d) and shut the guest down. Never run prepare-registration or config.sh in it.
On the HOST, with the reviewed main hashes of scripts/case-macos-gate.mjs and scripts/case-macos-peer.c:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh reseal-base --gate-sha256 <gate> --peer-source-sha256 <peer source> --check-only
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh reseal-base --gate-sha256 <gate> --peer-source-sha256 <peer source>
reseal-base mounts the clone's Data volume read-only (nosuid, nodev, noexec) and refuses registration
records, registration-maintenance or registration-history, any runner work or log, a symlinked path,
and any gate, peer, cleanup, hook, seal or setup script that differs from the reviewed values or this
script. It swaps the reference atomically, keeps base.previous, appends base-history.log and deletes
the rebase clone. Then run cycle-once to restore case-macos-1. To undo, with case-macos-1 stopped:
   sudo /bin/bash /private/var/root/setup-case-macos-vm.sh rollback-base --confirm-rollback
REMOVAL: drain and stop the VM, then sudo /bin/bash /private/var/root/setup-case-macos-vm.sh
uninstall-host --confirm-remove-case-macos-vm. Remove the runner in GitHub settings yourself.
IMAGE: after the first qualification passes, sudo /bin/bash /private/var/root/setup-case-macos-vm.sh
remove-ipsw deletes the staged IPSW (uninstall-host also removes it).
UPDATES: Julian checks actions/runner release/security notices at least weekly. --disableupdate
keeps this protected package immutable: rebuild a NEW unregistered base from the reviewed new hash,
rerun isolation/reset/reboot/exact-SHA qualification and replace the protected reference deliberately.
GitHub stops queueing jobs after 30 days without an available update, or immediately for a required
critical update. No silent in-place update or assertion skip. Record runner 2.338.0 versus hosted
reference 2.337.0 as an environment difference. Pin updates belong to a separate reviewed change.
Persistent guests and process attribution are not attestation of uncompromised jobs or green tests.
TEXT
}

[ "$#" -gt 0 ] || { usage >&2; exit 1; }
command="$1"; shift
case "$command" in
  install-host) install_host "$@" ;;
  install-guest-lifecycle) install_guest_lifecycle "$@" ;;
  seal-guest) seal_guest "$@" ;;
  seal-base) seal_base "$@" ;;
  rebase-clone) rebase_clone "$@" ;;
  reseal-base) reseal_base "$@" ;;
  rollback-base) rollback_base "$@" ;;
  install-host-lifecycle) install_host_lifecycle "$@" ;;
  install-owner-status) install_owner_status "$@" ;;
  uninstall-owner-status) uninstall_owner_status "$@" ;;
  enable-guest-gate) enable_guest_gate "$@" ;;
  seal-registration) seal_registration "$@" ;;
  prepare-registration) prepare_registration "$@" ;;
  lifecycle-guide) [ "$#" -eq 0 ] || die 'lifecycle-guide takes no arguments'; lifecycle_guide ;;
  cleanup) [ "$#" -eq 0 ] || die 'cleanup generator takes no arguments'; cleanup_template ;;
  guest-status) [ "$#" -eq 0 ] || die 'guest-status generator takes no arguments'; guest_status_template ;;
  guest-bootstrap) guest_bootstrap "$@" ;;
  configure-guest) configure_guest "$@" ;;
  probe-host) [ "$#" -eq 0 ] || die 'probe-host takes no arguments'; probe_host ;;
  refresh-guest-probe) refresh_guest_probe "$@" ;;
  update-guest-lifecycle) update_guest_lifecycle "$@" ;;
  refresh-host-network) refresh_host_network "$@" ;;
  uninstall-host) uninstall_host "$@" ;;
  stage-ipsw) stage_ipsw "$@" ;;
  remove-ipsw) remove_ipsw "$@" ;;
  clone-commands) clone_commands "$@" ;;
  host-helper) host_helper "$@" ;;
  softnet-shim|softnet-root|socket-probe|guest-management|guest-root-probe|supervisor|manual-guest|host-plist|guest-gate-plist)
    [ "$#" -eq 0 ] || die 'generator takes no arguments'
    case "$command" in softnet-shim) softnet_shim ;; softnet-root) softnet_root ;; socket-probe) socket_probe ;; guest-management) guest_management ;; guest-root-probe) guest_root_probe ;; supervisor) supervisor_template ;; manual-guest) manual_guest ;; host-plist) host_plist ;; guest-gate-plist) guest_gate_plist ;; esac ;;
  commands) commands "$@" ;;
  console-commands) console_commands "$@" ;;
  plan|owner-guide|guest-probe)
    [ "$#" -eq 0 ] || die 'this output command takes no arguments'
    case "$command" in plan) plan ;; owner-guide) owner_guide ;; guest-probe) guest_probe ;; esac ;;
  install|start|register|activate|uninstall) die 'unavailable: preparation only; owner-guide names the missing installation and isolation prerequisites' ;;
  -h|--help|help) [ "$#" -eq 0 ] || die 'help takes no arguments'; usage ;;
  *) usage >&2; exit 1 ;;
esac
