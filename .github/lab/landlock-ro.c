// Lab helper: stack a Landlock domain that handles every write right and grants it only beneath the named paths,
// then exec the command. Reads are not handled, so the outer (OpenShell) domain alone decides them.
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
struct rs_attr { uint64_t handled_access_fs; };
struct pb_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));
#define FS_WRITE_FILE (1ULL << 1)
#define DIR_RIGHTS ((1ULL << 4) | (1ULL << 5) | (1ULL << 6) | (1ULL << 7) | (1ULL << 8) | (1ULL << 9) | (1ULL << 10) | (1ULL << 11) | (1ULL << 12) | (1ULL << 13))
#define FS_TRUNCATE (1ULL << 14)
int main(int argc, char **argv) {
	long abi = syscall(444, NULL, 0, 1UL);
	fprintf(stderr, "landlock abi=%ld errno=%d\n", abi, abi < 0 ? errno : 0);
	if (abi < 3) return 90;
	uint64_t w = FS_WRITE_FILE | DIR_RIGHTS | FS_TRUNCATE;
	struct rs_attr a = { .handled_access_fs = w };
	long fd = syscall(444, &a, sizeof a, 0UL);
	if (fd < 0) { perror("create_ruleset"); return 91; }
	int i = 1;
	for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
		int p = open(argv[i], O_PATH | O_CLOEXEC);
		if (p < 0) { perror(argv[i]); return 92; }
		struct stat st; fstat(p, &st);
		struct pb_attr pb = { .allowed_access = S_ISDIR(st.st_mode) ? w : (FS_WRITE_FILE | FS_TRUNCATE), .parent_fd = p };
		if (syscall(445, fd, 1, &pb, 0UL)) { perror("add_rule"); return 93; }
		close(p);
	}
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) { perror("no_new_privs"); return 94; }
	if (syscall(446, fd, 0UL)) { perror("restrict_self"); return 95; }
	if (i + 1 >= argc) return 0;
	execvp(argv[i + 1], argv + i + 1);
	perror("exec");
	return 96;
}
