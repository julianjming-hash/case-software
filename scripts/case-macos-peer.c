/* macOS-only, no SUID. Root-owned companion to case-macos-gate.mjs.
 * Native interfaces: SDK sys/un.h LOCAL_PEERPID/getpeereid; libproc.h.
 * serve has fixed endpoints/commands; inspect never reads process arguments or environment.
 */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/sysctl.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/proc.h>
#include <libproc.h>
#include <bsm/libbsm.h>
#include <poll.h>
#include <time.h>
#include <signal.h>
#include <pwd.h>
#include <grp.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PUBLIC_SOCKET "/private/var/db/case-macos-vm-run/gate.sock"
#define PRIVATE_SOCKET "/private/var/db/case-macos-vm/gate.sock"
#define PACKAGE "/opt/actions-runner"
#define MAX_REQUEST 131072

static int address(struct sockaddr_un *sa, const char *name) {
  memset(sa, 0, sizeof(*sa)); sa->sun_family = AF_UNIX;
  if (strlen(name) >= sizeof(sa->sun_path)) return -1;
  strcpy(sa->sun_path, name); sa->sun_len = (unsigned char)SUN_LEN(sa); return 0;
}
static int peer_identity(int fd, uid_t *uid, pid_t *pid, char *start, size_t cap) {
  gid_t gid; socklen_t size = sizeof(*pid); audit_token_t token; socklen_t token_size = sizeof(token);
  struct proc_bsdinfo info; char path[PROC_PIDPATHINFO_MAXSIZE];
  if (getpeereid(fd, uid, &gid) || getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &size) ||
      getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_size) ||
      size != sizeof(*pid) || token_size != sizeof(token) || *pid <= 0 ||
      audit_token_to_pid(token) != *pid || audit_token_to_euid(token) != *uid) return -1;
  if (proc_pidinfo(*pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != *uid) return -1;
  /* Kernel audit token includes PID version. This lookup refuses reuse of the original peer PID. */
  if (proc_pidpath_audittoken(&token, path, sizeof(path)) <= 0) return -1;
  snprintf(start, cap, "%llu:%llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
  return 0;
}
static long long monotonic_ms(void) {
  struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int line_until(int fd, char *line, size_t cap, long long deadline) {
  size_t n = 0; char c;
  for (;;) {
    long long remaining = deadline - monotonic_ms(); if (remaining <= 0) return -1;
    struct pollfd item = { fd, POLLIN, 0 }; int ready = poll(&item, 1, (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || read(fd, &c, 1) != 1) return -1;
    if (c == '\n') { line[n] = 0; return (int)n; }
    if (n + 1 >= cap || c == 0 || c == '\r') return -1;
    line[n++] = c;
  }
}
static int write_all(int fd, const char *bytes, size_t n) {
  long long deadline = monotonic_ms() + 4000;
  while (n) {
    long long remaining = deadline - monotonic_ms(); if (remaining <= 0) return -1;
    struct pollfd item = { fd, POLLOUT, 0 }; int ready = poll(&item, 1, (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) return -1;
    ssize_t sent = send(fd, bytes, n, MSG_DONTWAIT);
    if (sent < 0 && (errno == EAGAIN || errno == EINTR)) continue;
    if (sent <= 0) return -1; bytes += sent; n -= (size_t)sent;
  }
  return 0;
}
static void timeout(int fd) {
  struct timeval limit = { 5, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, sizeof(limit));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, sizeof(limit));
}
static void json_string(const char *text) {
  putchar('"');
  for (const unsigned char *s = (const unsigned char *)text; *s; ++s) {
    if (*s == '"' || *s == '\\') printf("\\%c", *s);
    else if (*s < 32 || *s >= 127) printf("\\u%04x", *s);
    else putchar(*s);
  }
  putchar('"');
}
static int inspect(pid_t pid) {
  struct proc_bsdinfo info; char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 1;
  if (proc_pidpath(pid, path, sizeof(path)) <= 0) path[0] = 0;
  printf("{\"pid\":%u,\"ppid\":%u,\"uid\":%u,\"stopped\":%s,\"start\":\"%llu:%llu\",\"path\":",
    info.pbi_pid, info.pbi_ppid, info.pbi_uid,
    info.pbi_status == SSTOP ? "true" : "false",
    (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
  json_string(path); printf("}\n"); return 0;
}
/* An uninspectable PID is harmless only when it has vanished or exited: a zombie holds no task and
 * runs nothing (one root zombie stopped the gate on the mini guest). A live uninspectable process
 * could be runner work, so it still fails closed. */
static int harmless_uninspectable(pid_t pid) {
  if (kill(pid, 0) != 0 && errno == ESRCH) return 1;
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid };
  struct kinfo_proc kp; size_t size = sizeof(kp);
  if (sysctl(mib, 4, &kp, &size, NULL, 0) || size != sizeof(kp)) return kill(pid, 0) != 0 && errno == ESRCH;
  return kp.kp_proc.p_stat == SZOMB;
}
static int processes(void) {
  int count = proc_listallpids(NULL, 0);
  if (count <= 0 || count > 1000000) return 78;
  int capacity = count + 1024;
  pid_t *pids = calloc((size_t)capacity, sizeof(pid_t)); if (!pids) return 78;
  count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  if (count <= 0 || count >= capacity) { free(pids); return 78; }
  for (int i = 0; i < count; ++i) if (pids[i] > 0 && inspect(pids[i]) && !harmless_uninspectable(pids[i])) { free(pids); return 78; }
  free(pids); return 0;
}
static void handle_connection(int client, uid_t uid, pid_t pid, const char *start) {
  timeout(client); char request[MAX_REQUEST], reply[1024 * 1024];
  if (line_until(client, request, sizeof(request), monotonic_ms() + 3000) <= 0) return;
  struct sockaddr_un sa; int internal = socket(AF_UNIX, SOCK_STREAM, 0); timeout(internal);
  if (internal < 0 || address(&sa, PRIVATE_SOCKET) || connect(internal, (struct sockaddr *)&sa, sa.sun_len)) {
    if (internal >= 0) close(internal); return;
  }
  char header[128]; int n = snprintf(header, sizeof(header), "%u %d %s\n", uid, pid, start);
  if (!write_all(internal, header, (size_t)n) && !write_all(internal, request, strlen(request)) && !write_all(internal, "\n", 1)) {
    int length = line_until(internal, reply, sizeof(reply), monotonic_ms() + 4000);
    if (length > 0) { write_all(client, reply, (size_t)length); write_all(client, "\n", 1); }
  }
  close(internal);
}
static int serve(void) {
  if (geteuid() != 0) return 77;
  struct passwd *user = getpwnam("runner"); if (!user) return 78; uid_t runner_uid = user->pw_uid;
  user = getpwnam("case-vm-control"); if (!user) return 78; uid_t control_uid = user->pw_uid;
  /* Protected parents. Stale sockets are removed only by the explicit root recovery procedure. */
  struct sockaddr_un sa; if (address(&sa, PUBLIC_SOCKET)) return 78;
  int server = socket(AF_UNIX, SOCK_STREAM, 0); if (server < 0) return 78;
  umask(0111);
  if (bind(server, (struct sockaddr *)&sa, sa.sun_len) || chmod(PUBLIC_SOCKET, 0666) || listen(server, 32)) return 78;
  signal(SIGPIPE, SIG_IGN);
  pid_t children[16] = { 0 }; uid_t owners[16] = { 0 };
  for (;;) {
    for (int i = 0; i < 16; i++) if (children[i] && waitpid(children[i], NULL, WNOHANG) == children[i]) children[i] = 0;
    int client = accept(server, NULL, NULL); if (client < 0) { if (errno == EINTR) continue; return 78; }
    uid_t uid; pid_t pid; char start[64];
    if (peer_identity(client, &uid, &pid, start, sizeof(start)) || (uid != 0 && uid != runner_uid && uid != control_uid)) { close(client); continue; }
    int slot = -1, runner_count = 0;
    for (int i = 0; i < 16; i++) { if (!children[i] && slot < 0) slot = i; if (children[i] && owners[i] == runner_uid) runner_count++; }
    /* Runner clients cannot consume the twelve slots reserved for management/root. */
    if (slot < 0 || (uid == runner_uid && runner_count >= 4)) { close(client); continue; }
    pid_t child = fork();
    if (child == 0) { close(server); handle_connection(client, uid, pid, start); close(client); _exit(0); }
    if (child > 0) { children[slot] = child; owners[slot] = uid; }
    close(client);
  }
}
static int become_runner(void) {
  if (geteuid() != 0) return 77;
  struct passwd *user = getpwnam("runner"); if (!user || user->pw_uid == 0) return 78;
  if (initgroups(user->pw_name, user->pw_gid) || setgid(user->pw_gid) || setuid(user->pw_uid)) return 78;
  extern char **environ; static char *clean[] = { NULL }; environ = clean;
  setenv("HOME", "/private/var/case-vm-runner", 1);
  setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin", 1);
  setenv("TMPDIR", "/private/var/case-vm-runner/tmp", 1);
  return 0;
}
static int listener(void) {
  int result = become_runner(); if (result) return result;
  if (chdir(PACKAGE)) return 78;
  /* No inherited root/owner credentials, shell startup or arbitrary workflow hook paths. */
  setenv("USER", "runner", 1); setenv("LOGNAME", "runner", 1);
  setenv("PATH", "/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", 1);
  setenv("ACTIONS_RUNNER_HOOK_JOB_STARTED", "/usr/local/libexec/case-macos-vm/job-started.js", 1);
  setenv("ACTIONS_RUNNER_HOOK_JOB_COMPLETED", "/usr/local/libexec/case-macos-vm/job-completed.js", 1);
  execl(PACKAGE "/bin/Runner.Listener", "Runner.Listener", "run", "--startuptype", "service", (char *)NULL);
  return 78;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "serve")) return serve();
  if (argc == 2 && !strcmp(argv[1], "listener")) return listener();
  if (argc == 2 && !strcmp(argv[1], "cleanup")) {
    int result = become_runner(); if (result) return result;
    execl("/bin/bash", "bash", "--noprofile", "--norc", "/usr/local/libexec/case-macos-vm/cleanup", (char *)NULL);
    return 78;
  }
  if (argc == 5 && !strcmp(argv[1], "signal")) {
    if (geteuid() != 0) return 77;
    char *end; long pid = strtol(argv[2], &end, 10); struct proc_bsdinfo info;
    if (!*argv[2] || *end || pid < 2 || pid > 2147483647) return 64;
    int sig = !strcmp(argv[4], "KILL") ? SIGKILL : !strcmp(argv[4], "STOP") ? SIGSTOP : !strcmp(argv[4], "CONT") ? SIGCONT : !strcmp(argv[4], "TERM") ? SIGTERM : 0;
    if (!sig) return 64;
    if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    char start[64]; snprintf(start, sizeof(start), "%llu:%llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    struct passwd *user = getpwnam("runner");
    if (!user || info.pbi_uid != user->pw_uid || strcmp(start, argv[3])) return 78;
    int result = become_runner(); if (result) return result;
    /* Drop privilege BEFORE signaling: PID reuse can never signal another account's process. */
    return kill((pid_t)pid, sig) && errno != ESRCH ? 78 : 0;
  }
  if (argc == 2 && !strcmp(argv[1], "processes")) return processes();
  if (argc == 2 && !strcmp(argv[1], "boot")) {
    struct timeval boot; size_t size = sizeof(boot);
    if (sysctlbyname("kern.boottime", &boot, &size, NULL, 0)) return 78;
    printf("%lld:%d\n", (long long)boot.tv_sec, boot.tv_usec); return 0;
  }
  if (argc == 3 && !strcmp(argv[1], "inspect")) {
    char *end; long pid = strtol(argv[2], &end, 10);
    if (!*argv[2] || *end || pid < 1 || pid > 2147483647) return 64;
    return inspect((pid_t)pid);
  }
  return 64;
}
