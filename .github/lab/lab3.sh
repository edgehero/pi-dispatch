#!/usr/bin/env bash
# Round 3 for #683: the REAL job image (PR 1) on OpenShell: what the image's ENTRYPOINT does at create, the runner on
# the sandbox layout through pi-landlock with a signed exit line, the OOM score bump, download of the outputs.
set -u
OS=openshell
step() { echo; echo "### $*"; "$@"; echo "### exit=$?"; }
sh_step() { echo; echo "### sh: $1"; bash -c "$1"; echo "### exit=$?"; }
IMG=pi-job:683
POL=$PWD/pol.yaml
cat > "$POL" <<P
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /lib64, /etc, /bin, /sbin, /opt, /app, /ms-playwright, /proc, /sys/fs/cgroup, /dev/urandom, /entrypoint.sh]
  read_write: [/tmp, /dev/null, /home/pi]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: "1001"
  run_as_group: "1001"
P
mkdir -p up/job up/workspace up/session && echo "Reply with the single word ok." > up/job/prompt.md && : > up/session/current.jsonl && echo hi > up/workspace/README.md
step $OS sandbox create --detach --name r3 --from "$IMG" --label pi.dispatch.job=r3 --cpu 2 --memory 2Gi --policy "$POL" --no-auto-providers -o json
sleep 15
step $OS sandbox get r3 -o json
step $OS sandbox upload r3 up/job /sandbox
step $OS sandbox upload r3 up/workspace /sandbox
step $OS sandbox upload r3 up/session /sandbox
X="$OS sandbox exec --name r3 --no-login-shell --no-tty --workdir /sandbox/workspace"
LL="/opt/pi-dispatch/pi-landlock --rw /sandbox/workspace --rw /sandbox/session --rw /tmp --rw /home/pi --rw /dev/null --"
echo "===== oom score bump and /proc writes under the policy and the helper"
sh_step "$X -- /bin/sh -c 'echo 1000 > /proc/self/oom_score_adj; echo plain-bump=\$?; cat /proc/self/oom_score_adj' </dev/null"
sh_step "$X -- $LL /bin/sh -c 'echo 1000 > /proc/self/oom_score_adj; echo helper-bump=\$?; cat /proc/self/oom_score_adj' </dev/null"
echo "===== the real runner, keyed, on the sandbox layout, under a cost cap of 0"
KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENVS="--env PI_JOB_LAYOUT=sandbox --env PI_PROVIDER=anthropic --env PI_MODEL=claude-sonnet-4-5-20250929 --env PI_MAX_TURNS=1 --env ANTHROPIC_API_KEY=sk-ant-not-a-real-key --env PI_MAX_COST_MICROS=0 --env PI_EXIT_AUTH=stdin --env PI_JOB_ID=r3 --env HOME=/home/pi --env PI_SESSION_FILE=/sandbox/session/current.jsonl"
sh_step "printf '%s\n' $KEY | $X $ENVS -- $LL /entrypoint.sh > out.jsonl 2> err.txt; echo code=\$?; grep '\"event\":\"exit\"' out.jsonl | tail -2; tail -5 err.txt"
echo "key=$KEY"
echo "===== the agent cannot write its job inputs (a tool's view)"
sh_step "$X -- $LL /bin/sh -c 'echo x >> /sandbox/job/prompt.md; echo append=\$?; ls -la /sandbox /sandbox/job /sandbox/session' </dev/null"
echo "===== download the outputs"
mkdir -p dl/workspace dl/session
step $OS sandbox download r3 /sandbox/workspace dl/workspace
step $OS sandbox download r3 /sandbox/session dl/session
find dl -ls
echo "===== stop and the main process"
step $OS sandbox get r3 -o json
step $OS sandbox delete r3
