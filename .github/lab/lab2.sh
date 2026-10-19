#!/usr/bin/env bash
# Round 2 for #683: a workable filesystem policy, cgroup reads, the in-image Landlock self-restriction, download, key.
set -u
OS=openshell
step() { echo; echo "### $*"; "$@"; echo "### exit=$?"; }
sh_step() { echo; echo "### sh: $1"; bash -c "$1"; echo "### exit=$?"; }
IMG=os-lab:1
P2=$PWD/p2.yaml
cat > "$P2" <<P
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /lib64, /etc, /bin, /sbin, /opt, /app, /proc, /sys/fs/cgroup, /dev/urandom]
  read_write: [/tmp, /dev/null, /home/pi]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: "1001"
  run_as_group: "1001"
P
mkdir -p in/job/pi in/out in/workspace && echo hello > in/job/a.txt && echo s > in/job/pi/s.md && echo o > in/out/o.txt && echo w > in/workspace/w.txt
X="$OS sandbox exec --name l2 --no-login-shell --no-tty"
step $OS sandbox create --detach --name l2 --from "$IMG" --label pi.dispatch.job=l2 --cpu 1 --memory 256Mi --policy "$P2" --no-auto-providers -o json
step $OS policy get l2 --full -o json
step $OS policy get l2 --base -o json
step $OS sandbox upload l2 in/job /sandbox
step $OS sandbox upload l2 in/out /sandbox
step $OS sandbox upload l2 in/workspace /sandbox
sh_step "$X -- sh -c 'find /sandbox -ls; for f in memory.max memory.peak memory.swap.max memory.events cpu.max pids.max; do echo \"\$f: \$(cat /sys/fs/cgroup/\$f 2>&1 | tr \"\\n\" \" \")\"; done' </dev/null"
echo "===== self-restrict"
sh_step "$X -- landlock-ro /sandbox/out /sandbox/workspace /tmp /dev/null -- sh -c 'echo x > /sandbox/job/new; echo \"write job: \$?\"; echo y > /sandbox/out/ok; echo \"write out: \$?\"; rm /sandbox/job/a.txt; echo \"rm job: \$?\"; mv /sandbox/job /sandbox/out/stolen; echo \"mv job: \$?\"; ln -s /x /sandbox/job/l; echo \"ln: \$?\"; sh -c \"echo z > /sandbox/job/nested\"; echo \"nested: \$?\"; landlock-ro / -- sh -c \"echo q > /sandbox/job/q\"; echo \"re-widen: \$?\"; echo t > /tmp/t; echo \"tmp: \$?\"; cat /sandbox/job/a.txt' </dev/null"
sh_step "$X -- sh -c 'echo plain > /sandbox/job/plain; echo \"plain write job: \$?\"; ls /sandbox/job' </dev/null"
echo "===== workdir flag and env"
sh_step "$X --workdir /sandbox/workspace --env FOO=bar --env 'SPACED=a b' -- sh -c 'pwd; echo \$FOO \"\$SPACED\"; cat /proc/\$\$/cmdline | tr \"\\0\" \" \"; echo; cat /proc/\$PPID/cmdline | tr \"\\0\" \" \"' </dev/null"
echo "===== key on stdin"
sh_step "printf 'abcdef0123\n' | $X -- node /usr/local/lib/lab/keyprobe.mjs 3; echo code=\$?"
sh_step "printf 'abcdef0123\n' | $X -- landlock-ro /sandbox/out /tmp /dev/null -- node /usr/local/lib/lab/keyprobe.mjs 0; echo code=\$?"
echo "===== download"
mkdir -p dl && step $OS sandbox download l2 /sandbox/out dl && find dl -ls
mkdir -p dl2 && step $OS sandbox download l2 /sandbox/workspace dl2 && find dl2 -ls
mkdir -p dl3 && step $OS sandbox download l2 /sandbox/workspace/ dl3 && find dl3 -ls
echo "===== OOM with cgroup readable"
step $OS sandbox create --detach --name l2oom --from "$IMG" --cpu 1 --memory 64Mi --policy "$P2" --no-auto-providers -o json
sh_step "$OS sandbox exec --name l2oom --no-login-shell --no-tty -- node -e 'const a=[];for(;;)a.push(Buffer.alloc(8<<20,1))' </dev/null; echo code=\$?"
sh_step "$OS sandbox exec --name l2oom --no-login-shell --no-tty -- sh -c 'for f in memory.max memory.peak memory.events; do echo \"\$f: \$(cat /sys/fs/cgroup/\$f | tr \"\\n\" \" \")\"; done' </dev/null"
echo "===== live network rule add (for #684)"
cp "$P2" p3.yaml && cat >> p3.yaml <<P
network_policies:
  lab:
    endpoints:
      - host: example.com
        port: 443
    binaries:
      - path: /usr/bin/curl
P
step $OS policy set l2 --policy p3.yaml --wait --timeout 60
step $OS policy get l2 -o json
step $OS sandbox get l2 -o json
echo "===== cleanup"
step $OS sandbox delete l2 l2oom
step $OS sandbox list -o json
