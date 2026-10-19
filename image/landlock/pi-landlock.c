// pi-landlock: confine every write of a command's process tree to the paths named on its command line, then exec it.
//
// Issue #683 (DES-OPENSHELL-VENUE, INT-CONTAINER-JOB-INPUTS). On a venue that COPIES the job's files into the box
// (`openshell`), `/job` cannot be a read-only bind, and the venue's own Landlock policy cannot make it read-only
// either: its uploads run as the workload's own uid UNDER the workload's own rules, so a path the policy marks
// read-only cannot be uploaded into, and the filesystem policy cannot change on a live sandbox (both measured on
// OpenShell 0.1.4). What is left is the order of events. The worker uploads first, then starts the runner through
// this helper, which stacks one more Landlock domain onto itself: every write right is HANDLED, and granted only
// beneath the `--rw` paths. A Landlock domain is inherited by every child and can only be narrowed, never widened, so
// no tool the agent runs can write `/job` again, whatever the venue's own policy allows (measured: write, remove,
// rename out, symlink, a nested shell and a nested pi-landlock asking for `/` all refused).
//
// READS are deliberately NOT handled: the venue's own policy decides them, and narrowing them here would only make
// this helper a second, drifting copy of that policy. Nor is METADATA: Landlock (ABI 3 to 5) does not mediate chmod,
// chown, utimes or xattrs, so the agent can still change an uploaded file's mode, never its bytes or the tree.
//
// On a kernel with Landlock ABI 6 or later the domain is also SCOPED: signals and abstract unix sockets cannot leave
// it, so a process outside it that takes commands over such a socket cannot be asked to write on the agent's behalf.
// Below ABI 6 there is no such knob, and the domain is the write confinement alone.
//
// The worker builds this command line (`--rw` per writable path, then `--`, then the absolute entrypoint), never the
// image: the paths are the box, and the box is the worker's (CONST-ISOLATION-CONTAINER-PER-JOB). A venue that binds
// its mounts (`local`, `podman`) never runs this helper; `:ro` binds do that job there.
//
// Fails CLOSED, with exit 126 and one line on stderr, on anything short of a fully applied domain: a kernel below
// Landlock ABI 3 (TRUNCATE is unhandled before it, so `/job` files could be truncated), a missing `--rw` path, a rule
// the kernel refuses, a relative or missing command. 126 is "found but could not run", which is what this is, and it
// never collides with the runner's own codes (0 to 3) or a signal's (128 and up).
//
// Static, and no header for Landlock itself: the build image's kernel headers predate ABI 3, so the constants are
// spelled here from the kernel's uapi (include/uapi/linux/landlock.h), whose values are ABI and never change. Beyond the
// Landlock syscalls it uses only prctl, open, fstat, close and execv, and stdio for its one refusal line.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

#define CREATE_RULESET_VERSION (1U << 0)
#define RULE_PATH_BENEATH 1

#define ACCESS_FS_WRITE_FILE (1ULL << 1)
#define ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define ACCESS_FS_MAKE_DIR (1ULL << 7)
#define ACCESS_FS_MAKE_REG (1ULL << 8)
#define ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define ACCESS_FS_MAKE_SYM (1ULL << 12)
#define ACCESS_FS_REFER (1ULL << 13)
#define ACCESS_FS_TRUNCATE (1ULL << 14)

// Every right that changes the tree or a file's bytes. REFER (ABI 2) is the one that lets a rename or link move a
// file between directories; leaving it unhandled would let `/job` be moved out from under its own rules.
#define WRITE_RIGHTS (ACCESS_FS_WRITE_FILE | ACCESS_FS_REMOVE_DIR | ACCESS_FS_REMOVE_FILE | ACCESS_FS_MAKE_CHAR | \
	ACCESS_FS_MAKE_DIR | ACCESS_FS_MAKE_REG | ACCESS_FS_MAKE_SOCK | ACCESS_FS_MAKE_FIFO | ACCESS_FS_MAKE_BLOCK | \
	ACCESS_FS_MAKE_SYM | ACCESS_FS_REFER | ACCESS_FS_TRUNCATE)
// The subset the kernel accepts on a rule for a non-directory (/dev/null is one).
#define FILE_WRITE_RIGHTS (ACCESS_FS_WRITE_FILE | ACCESS_FS_TRUNCATE)

// ABI 6: the scopes, in `struct landlock_ruleset_attr`'s third field.
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define SCOPE_SIGNAL (1ULL << 1)
#define SCOPE_ABI 6

#define MIN_ABI 3
#define EXIT_REFUSED 126

// The kernel's struct, whose size tells it which fields the caller knows: the short form below ABI 6, the long one from it.
struct ruleset_attr {
	uint64_t handled_access_fs;
	uint64_t handled_access_net;
	uint64_t scoped;
};

struct path_beneath_attr {
	uint64_t allowed_access;
	int32_t parent_fd;
} __attribute__((packed));

static int refuse(const char *what, const char *detail) {
	if (detail != NULL) fprintf(stderr, "pi-landlock: %s: %s\n", what, detail);
	else fprintf(stderr, "pi-landlock: %s\n", what);
	return EXIT_REFUSED;
}

int main(int argc, char **argv) {
	long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, CREATE_RULESET_VERSION);
	if (abi < MIN_ABI) {
		int err = errno;
		char detail[64];
		snprintf(detail, sizeof detail, "abi %ld, want %d or later", abi, MIN_ABI);
		return refuse("Landlock is unavailable", abi < 0 ? strerror(err) : detail);
	}
	// No network rights are handled (the venue's policy decides egress), so `handled_access_net` stays 0 on every ABI.
	struct ruleset_attr attr = { .handled_access_fs = WRITE_RIGHTS, .handled_access_net = 0, .scoped = abi >= SCOPE_ABI ? (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL) : 0 };
	size_t attr_size = abi >= SCOPE_ABI ? sizeof attr : sizeof attr.handled_access_fs;
	int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, attr_size, 0);
	if (ruleset < 0) return refuse("landlock_create_ruleset", strerror(errno));

	int i = 1;
	for (; i < argc && strcmp(argv[i], "--") != 0; i += 2) {
		if (strcmp(argv[i], "--rw") != 0 || i + 1 >= argc) return refuse("usage", "pi-landlock --rw <path>... -- <absolute command> [args...]");
		const char *path = argv[i + 1];
		if (path[0] != '/') return refuse("a --rw path must be absolute", path);
		int fd = open(path, O_PATH | O_CLOEXEC);
		if (fd < 0) return refuse(path, strerror(errno));
		struct stat st;
		if (fstat(fd, &st) != 0) return refuse(path, strerror(errno));
		struct path_beneath_attr rule = { .allowed_access = S_ISDIR(st.st_mode) ? WRITE_RIGHTS : FILE_WRITE_RIGHTS, .parent_fd = fd };
		if (syscall(SYS_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &rule, 0) != 0) return refuse(path, strerror(errno));
		close(fd);
	}
	if (i >= argc || i + 1 >= argc) return refuse("usage", "pi-landlock --rw <path>... -- <absolute command> [args...]");
	const char *command = argv[i + 1];
	if (command[0] != '/') return refuse("the command must be an absolute path", command);

	// Required by landlock_restrict_self for an unprivileged caller, and already set on every venue this runs on.
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return refuse("no_new_privs", strerror(errno));
	if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) return refuse("landlock_restrict_self", strerror(errno));
	close(ruleset);

	execv(command, argv + i + 1);
	return refuse(command, strerror(errno));
}
