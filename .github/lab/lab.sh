#!/usr/bin/env bash
# Throwaway measurement for #683, phase 0. Every probe prints its command, its exit code and its output.
set -u
OS=openshell
step() { echo; echo "### $*"; "$@"; echo "### exit=$?"; }
sh_step() { echo; echo "### sh: $1"; bash -c "$1"; echo "### exit=$?"; }
IMG=os-lab:1
IMG_ID=$(docker image inspect --format '{{.Id}}' "$IMG")
echo "image id $IMG_ID"
POL_RO=$PWD/pol-ro.yaml
cat > "$POL_RO" <<P
version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /lib, /etc, /bin, /sbin, /opt, /proc, /dev/urandom, /sandbox/job]
  read_write: [/sandbox/out, /tmp, /dev/null, /home/pi]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: "1001"
  run_as_group: "1001"
P
mkdir -p in/job in/out && echo hello > in/job/a.txt && echo o > in/out/o.txt

echo "===== Q8 status / gateway info / global policy"
step $OS --version
step $OS status -o json
step $OS gateway info -o json
step $OS policy get --global -o json
step $OS sandbox list -o json

echo "===== Q3 image refs"
step $OS sandbox create --detach --name lab-tag --from "$IMG" --label pi.dispatch.job=lab-tag --cpu 1 --memory 512Mi --no-auto-providers -o json
step $OS sandbox create --detach --name lab-id --from "$IMG_ID" --no-auto-providers -o json
step $OS sandbox create --detach --name lab-bare --from "${IMG_ID#sha256:}" --no-auto-providers -o json
step $OS sandbox list --selector pi.dispatch.job=lab-tag -o json
step $OS sandbox get lab-tag -o json

echo "===== Q4 cgroup"
step $OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'id; pwd; cat /proc/self/cgroup; ls /sys/fs/cgroup | head -40; for f in memory.max memory.peak memory.events memory.swap.max cpu.max pids.max cgroup.controllers; do echo "$f: $(cat /sys/fs/cgroup/$f 2>&1)"; done; cat /proc/1/cmdline | tr "\0" " "; echo; ps -ef 2>/dev/null || ls /proc'
step $OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'env | sort | cut -c1-80; mount | head -40; cat /proc/self/status | grep -E "Uid|Gid|Cap|NoNewPrivs|Seccomp"'

echo "===== Q6 stdin key"
sh_step "printf 'abcdef0123\n' | $OS sandbox exec --name lab-tag --no-login-shell --no-tty -- node /opt/lab/keyprobe.mjs 0"
sh_step "printf 'k\n' | $OS sandbox exec --name lab-tag --no-login-shell --no-tty -- node /opt/lab/keyprobe.mjs 3; echo code=\$?"

echo "===== Q5 exit codes"
for c in 0 1 2 3 137 255; do sh_step "$OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'exit $c' </dev/null; echo code=\$?"; done
sh_step "$OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'kill -TERM \$\$' </dev/null; echo code=\$?"
sh_step "$OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'kill -KILL \$\$' </dev/null; echo code=\$?"
sh_step "$OS sandbox exec --name no-such-sandbox --no-login-shell --no-tty -- true </dev/null; echo code=\$?"
sh_step "$OS sandbox exec --name lab-tag --no-login-shell --no-tty -- /no/such/binary </dev/null; echo code=\$?"
sh_step "$OS sandbox create --detach --name lab-badimg --from does-not-exist:nope --no-auto-providers -o json; echo code=\$?"
sh_step "$OS sandbox create --detach --name lab-badpol --from $IMG --policy /dev/null --no-auto-providers -o json; echo code=\$?"

echo "===== Q4b OOM under --memory 64Mi"
step $OS sandbox create --detach --name lab-oom --from "$IMG" --cpu 1 --memory 64Mi --no-auto-providers -o json
sh_step "$OS sandbox exec --name lab-oom --no-login-shell --no-tty -- node -e 'const a=[];for(;;)a.push(Buffer.alloc(8<<20,1))' </dev/null; echo code=\$?"
step $OS sandbox exec --name lab-oom --no-login-shell --no-tty -- sh -c 'for f in memory.max memory.peak memory.events; do echo "$f: $(cat /sys/fs/cgroup/$f 2>&1)"; done'
step $OS sandbox get lab-oom -o json

echo "===== Q1/Q2 upload under a read-only policy"
step $OS sandbox create --detach --name lab-ro --from "$IMG" --policy "$POL_RO" --no-auto-providers -o json
step $OS sandbox exec --name lab-ro --no-login-shell --no-tty -- sh -c 'id; ls -la /sandbox; mkdir -p /sandbox/job /sandbox/out; ls -la /sandbox; echo w > /sandbox/job/x; echo "write job: $?"; cat /opt/lab/baked; ls /app 2>&1 | head -3'
step $OS sandbox upload lab-ro in/job /sandbox
step $OS sandbox upload lab-ro in/out /sandbox
step $OS sandbox upload lab-ro in/job /tmp
step $OS sandbox upload lab-ro in/job /opt/lab
step $OS sandbox exec --name lab-ro --no-login-shell --no-tty -- sh -c 'find /sandbox /tmp/job /opt/lab -ls 2>&1; echo z > /sandbox/out/new; echo "write out: $?"; echo z > /sandbox/job/new; echo "write job: $?"'
mkdir -p dl && step $OS sandbox download lab-ro /sandbox/out dl && find dl -ls
step $OS sandbox download lab-ro /tmp/job dl2
step $OS sandbox get lab-ro -o json
step $OS sandbox get lab-ro --policy-only -o json
step $OS policy get lab-ro -o json
echo "-- create --upload form"
step $OS sandbox create --detach --name lab-cu --from "$IMG" --policy "$POL_RO" --upload "in/job:/sandbox" --no-auto-providers -o json
step $OS sandbox exec --name lab-cu --no-login-shell --no-tty -- sh -c 'find /sandbox -ls'
echo "-- policy set after upload (filesystem is startup-only per docs)"
step $OS sandbox create --detach --name lab-late --from "$IMG" --no-auto-providers -o json
step $OS sandbox upload lab-late in/job /sandbox
step $OS policy set lab-late --policy "$POL_RO" --wait --timeout 60
step $OS sandbox exec --name lab-late --no-login-shell --no-tty -- sh -c 'echo z > /sandbox/job/new; echo "write job after set: $?"'

echo "===== Q7 delete during exec"
step $OS sandbox create --detach --name lab-del --from "$IMG" --no-auto-providers -o json
( sleep 8; echo "deleting"; $OS sandbox delete lab-del; echo "delete exit=$?" ) &
sh_step "time $OS sandbox exec --name lab-del --no-login-shell --no-tty -- sleep 120 </dev/null; echo code=\$?"
wait
step $OS sandbox get lab-del -o json
step $OS sandbox delete lab-del
echo "-- stdin overflow"
sh_step "head -c 6000000 /dev/zero | $OS sandbox exec --name lab-tag --no-login-shell --no-tty -- sh -c 'sleep 5; wc -c'; echo code=\$?"

echo "===== list all + delete"
step $OS sandbox list -o json
step $OS sandbox delete lab-tag lab-id lab-bare lab-oom lab-ro lab-cu lab-late lab-badimg lab-badpol
step $OS sandbox list -o json
echo "===== docker side"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Labels}}' | cut -c1-300
