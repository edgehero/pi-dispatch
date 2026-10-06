#!/usr/bin/env sh
# Verify a job image against INT-CONTAINER-RUNTIME-CONTRACT's conformance checklist.
#
#   ./image/verify-image.sh my-python:1.2.0
#
# Runs ON THE HOST THAT HOLDS THE IMAGE, which is the only place it can run: jobs launch with
# --pull=never, so the images pi-dispatch can actually run are exactly the ones you built or pulled onto
# the worker's own machine. A CI runner elsewhere has no access to those, which is why this is a script and
# not a workflow input -- the checks have to happen where the image is.
#
# These are the CORE assertions: what ANY image must satisfy to be nameable in a trigger's `run.image`
# (INT-TRIGGERS-FILE-CONTRACT). The pi-upgrade-check workflow calls this same script against the image this
# repo builds, and then adds RUNNER assertions on top -- those pin properties of the runner THIS repo ships
# (its exact refusal strings, a path under /app) and are deliberately not part of the portable checklist.
#
# Every check below covers a failure that is SILENT or LATE. That is the whole reason the list exists: an
# image missing its guardrails, or carrying a stale pi, does not crash -- it produces jobs that look fine.
#
# Exits 0 when every check passes, 1 on the first failure. See docs/job-image.md.

set -eu

IMAGE_REF="${1:-}"
if [ -z "$IMAGE_REF" ]; then
	echo "usage: $0 <image-ref>" >&2
	echo "  e.g. $0 my-python:1.2.0" >&2
	exit 2
fi

fail() {
	echo "FAIL: $1" >&2
	exit 1
}
ok() { echo "  ok   $1"; }

echo "Verifying $IMAGE_REF against the job-image conformance checklist (docs/job-image.md)"
echo

# The image must be present locally -- the same thing the worker's pre-spend preflight checks, and for the
# same reason: with --pull=never nothing is ever fetched at job time, so an image that is not here cannot
# run. Checking it first turns "some docker error" into one clear sentence.
docker image inspect --format='{{.Id}}' "$IMAGE_REF" >/dev/null 2>&1 \
	|| fail "$IMAGE_REF is not present on this host. Build or pull it first -- jobs run with --pull=never and the worker never fetches one."
ok "image is present on this host"

# --entrypoint is required throughout: ENTRYPOINT is the runner and ignores CMD, so `docker run img pi ...`
# would silently run the runner instead of pi and the assertion would test nothing.
docker run --rm --entrypoint pi "$IMAGE_REF" -p --help >/dev/null 2>&1 \
	|| fail "pi is not on PATH, or -p is no longer a flag. The image must carry the pinned pi (CONST-PI-VERSION-PINNED); a stale or absent pi makes jobs no-ops that still report success."
ok "pi is present and -p is still a flag"

# bash, because `pi-dispatch sandbox` re-opens a finished run with `--entrypoint bash`
# (REQ-RESURRECTABLE-SANDBOX). An image without it fails that at exit 127 -- long after the run it is
# meant to let you inspect, and with an error naming a flag rather than a missing shell. It is also what
# reads TMOUT, which is the only thing that closes a forgotten sandbox.
docker run --rm --entrypoint bash "$IMAGE_REF" -c 'exit 0' >/dev/null 2>&1 \
	|| fail "bash is not present. \`pi-dispatch sandbox\` re-opens a run with --entrypoint bash and would fail at exit 127, and TMOUT (the sandbox idle logout) is a bash feature."
ok "bash is present (an operator can re-open a finished run)"

# The forge CLIs the job envelopes instruct the agent to use. Each is only meaningful for jobs on its own
# forge, but a MISSING one fails the same silent way: the agent follows an envelope naming a command that
# is not there, reports what went wrong in prose, and exits 0.
#
# The forge => CLI mapping is spelled out here because the next block checks the image's own
# `dev.pi-dispatch.forges` label against it. That label is what the worker's pre-spend preflight trusts to
# refuse a job this image cannot serve, so it has to be checked against reality rather than believed.
forge_cli() {
	case "$1" in
		github) echo gh ;;
		gitlab) echo glab ;;
		forgejo) echo tea ;;
		azure) echo az ;;
		*) echo "" ;;
	esac
}

for cli in gh glab tea; do
	docker run --rm --entrypoint "$cli" "$IMAGE_REF" --version >/dev/null 2>&1 \
		|| fail "$cli is not on PATH. A ${cli}-driven job envelope cannot publish its work, and the failure looks like a completed run."
	ok "$cli is present"
done

# THE LABEL MUST NOT LIE. The worker refuses a job pre-spend when this list excludes its forge, and admits
# it when the list includes it -- so a label naming a forge whose CLI is absent converts a loud pre-spend
# refusal into a paid container that fails at step 3. Declaring nothing is allowed (it means "no claim",
# and the preflight then admits everything); declaring something false is not.
declared=$(docker image inspect --format '{{index .Config.Labels "dev.pi-dispatch.forges"}}' "$IMAGE_REF" 2>/dev/null)
if [ -z "$declared" ] || [ "$declared" = "<no value>" ]; then
	ok "no dev.pi-dispatch.forges label -- the image makes no claim, and the preflight admits every forge"
else
	for forge in $(echo "$declared" | tr ',' ' '); do
		cli=$(forge_cli "$forge")
		[ -n "$cli" ] || fail "dev.pi-dispatch.forges names an unknown forge '$forge'"
		docker run --rm --entrypoint "$cli" "$IMAGE_REF" --version >/dev/null 2>&1 \
			|| fail "the image declares it serves '$forge' but $cli is not on PATH -- the label would turn a pre-spend refusal into a paid container that fails at step 3"
	done
	ok "dev.pi-dispatch.forges ($declared) matches the CLIs actually installed"
fi

# THE CAPABILITIES LABEL MUST NOT LIE EITHER, and this one guards a quieter failure than the forge check
# does. `replicas` (REQ-REPLICA-RUNS) tells the worker that this image's baked safety floor knows a replica
# commits to `pi/issue-<n>-r<i>`. An image whose HARD_RULES.md still hard-codes `pi/issue-<n>` would
# contradict the replica prompt from the SYSTEM side -- which the model treats as authoritative -- so both
# replicas would converge on one branch. Nothing errors: you pay for two runs and get one pull request.
#
# Its polarity is the opposite of `forges` above: declaring nothing means "no claim", and the worker then
# refuses replica jobs on this image rather than admitting them.
any_uid=0
capabilities=$(docker image inspect --format '{{index .Config.Labels "dev.pi-dispatch.capabilities"}}' "$IMAGE_REF" 2>/dev/null)
if [ -z "$capabilities" ] || [ "$capabilities" = "<no value>" ]; then
	ok "no dev.pi-dispatch.capabilities label -- the image claims no optional feature, and the worker refuses replica jobs on it"
else
	for capability in $(echo "$capabilities" | tr ',' ' '); do
		case "$capability" in
			replicas)
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "the branch your prompt names" /opt/pi-dispatch/HARD_RULES.md 2>/dev/null \
					|| fail "the image declares 'replicas' but its baked HARD_RULES.md still hard-codes a single branch name -- the system prompt would contradict the replica prompt and both replicas would push to one branch"
				;;
			commands)
				# The claim is about the RUNNER, so the evidence is the baked runner source: the reason string
				# only the command classification emits. A runner without it would run a PI_COMMAND job to
				# exit 1 no-terminal-message -- paid infra retries of a job that can never classify.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "command-completed" /app/image/runner/src/outcome.mjs 2>/dev/null \
					|| fail "the image declares 'commands' but its baked runner does not classify a headless command run -- a run.command job would be retried as infra forever"
				;;
			anyUid)
				# Issue #341. The claim is that a job run as an ARBITRARY non-root uid with HOME=/home/pi works: the id
				# took, the home is writable, and pi's agent dir and the tool caches can be created there. uid 4242 has
				# no passwd entry in any image, which is what a worker's own uid is inside one. The Chromium half of the
				# claim is checked with the render below.
				# EVERY directory under the home must be writable by that uid, not only the ones this script names: a derived
				# layer that creates ~/.cache or ~/.npm as 0755 pi leaves a dir `mkdir -p` happily "creates" and no tool can
				# write. Plus a real file write, so a home on a read-only layer cannot pass on permission bits alone.
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --user 4242:4242 -e HOME=/home/pi \
					--entrypoint sh "$IMAGE_REF" -c '[ "$(id -u):$(id -g)" = 4242:4242 ] || exit 1; mkdir -p "$HOME/.pi/agent" && : > "$HOME/.pi/agent/.anyuid-probe" || exit 1; d=$(find "$HOME" -xdev -type d ! -writable 2>/dev/null) && [ -z "$d" ]' >/dev/null 2>&1 \
					|| fail "the image declares 'anyUid' but /home/pi is not writable by an arbitrary uid -- a job run as the worker's own uid would lose auth.json and every tool cache"
				any_uid=1
				;;
			costCap)
				# Issue #501. The claim is that a job under PI_MAX_COST_MICROS is stopped BEFORE a call that could pass it.
				# Proved by running one: a cap of 0, the default priced model, a fake key and no network. The
				# guard must refuse the very first call (its bound is about a dollar), so the runner exits 2 with
				# reason cost-cap and costRefused 1, and nothing is dialled. A runner that ignored the variable would try
				# the call and exit on the network error instead; one that could not enforce the cap would exit 2 with
				# cost-cap-unenforceable. Both fail here.
				cost_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$cost_job/prompt.md"
				chmod -R a+rX "$cost_job"
				cost_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$cost_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_COST_MICROS=0 \
					"$IMAGE_REF" 2>&1) && cost_code=0 || cost_code=$?
				rm -rf "$cost_job"
				cost_exit=$(echo "$cost_out" | grep '"event":"exit"' | tail -1)
				[ "$cost_code" = 2 ] && echo "$cost_exit" | grep -q '"reason":"cost-cap"' && echo "$cost_exit" | grep -Eq '"costRefused":1[,}]' \
					|| fail "the image declares 'costCap' but a job under PI_MAX_COST_MICROS=0 was not stopped before its first call (exit $cost_code: $cost_exit)"
				;;
			modelPolicy)
				# Issue #502. The claim is that a job under PI_ALLOWED_MODELS is stopped BEFORE a call to a model the list does
				# not name. Proved by running one: the default model, a list that names only another model, a fake key and no
				# network. The guard must refuse the very first call, so the runner exits 2 with reason model-not-allowed and
				# modelRefused 1, and nothing is dialled. A runner that ignored the variable would try the call and exit on the
				# network error instead; one that could not enforce the list would exit 2 with model-policy-unenforceable.
				# Both fail here.
				model_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$model_job/prompt.md"
				chmod -R a+rX "$model_job"
				model_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$model_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_ALLOWED_MODELS=anthropic/claude-haiku-4-5-20251001 \
					"$IMAGE_REF" 2>&1) && model_code=0 || model_code=$?
				rm -rf "$model_job"
				model_exit=$(echo "$model_out" | grep '"event":"exit"' | tail -1)
				[ "$model_code" = 2 ] && echo "$model_exit" | grep -Eq '"reason":"model-not-allowed"[,}]' && echo "$model_exit" | grep -Eq '"modelRefused":1[,}]' \
					|| fail "the image declares 'modelPolicy' but a job whose PI_ALLOWED_MODELS lacks its model was not stopped before its first call (exit $model_code: $model_exit)"
				;;
			exitAuth)
				# Issue #545. Two claims, both checked by running them. First, the runner signs its exit line with the key the
				# worker writes to its stdin: the same offline job as costCap's (a cap of 0 stops it before any call), handed a
				# key the way run-container.mjs hands one (-i, PI_EXIT_AUTH=stdin), must end on a line whose HMAC-SHA256 under
				# that key is right. Second, the runner runs under the exec-only node, so a child of it (a job's tool) cannot
				# read its /proc entries, where the key lives in memory: a plain node runner's were readable on Docker Desktop.
				auth_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$auth_job/prompt.md"
				chmod -R a+rX "$auth_job"
				auth_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
				auth_out=$(printf '%s\n' "$auth_key" | docker run -i --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges -v "$auth_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_COST_MICROS=0 -e PI_EXIT_AUTH=stdin \
					"$IMAGE_REF" 2>&1) || true
				rm -rf "$auth_job"
				auth_exit=$(echo "$auth_out" | grep '"event":"exit"' | tail -1)
				auth_mac=$(echo "$auth_exit" | sed -nE 's/.*,"auth":"([0-9a-f]{64})"\}$/\1/p')
				auth_body=$(echo "$auth_exit" | sed -E 's/,"auth":"[0-9a-f]{64}"\}$/}/')
				auth_want=$(printf '%s' "$auth_body" | openssl dgst -sha256 -hmac "$auth_key" | awk '{print $NF}')
				[ -n "$auth_mac" ] && [ "$auth_mac" = "$auth_want" ] \
					|| fail "the image declares 'exitAuth' but a job handed a key on stdin did not end on an exit line signed with it ($auth_exit)"
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --entrypoint grep "$IMAGE_REF" -q "exec /opt/pi-dispatch/runner-node " /entrypoint.sh 2>/dev/null \
					|| fail "the image declares 'exitAuth' but its entrypoint does not run the runner under /opt/pi-dispatch/runner-node"
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --entrypoint /opt/pi-dispatch/runner-node "$IMAGE_REF" \
					-e 'const r = require("node:child_process").spawnSync("sh", ["-c", "cat /proc/$PPID/environ"], { stdio: "ignore" }); process.exit(r.status === 0 ? 1 : 0)' >/dev/null 2>&1 \
					|| fail "the image declares 'exitAuth' but a child of /opt/pi-dispatch/runner-node can read its /proc entries -- the job's tools could read the exit line's key out of the runner"
				# Issue #596's review found a second way in, open since #545: a tool (same uid) sends SIGUSR1, or calls
				# process._debugProcess(pid), and a node process holding the key opens its inspector on 127.0.0.1:9229 (the
				# loopback exists under --network none), where a heap snapshot carries the key. The exec-only node does not
				# close that. So every key holder must start with --disable-sigusr1: the supervisor (the entrypoint's node) and
				# the runner (started by the supervisor). Proved by running the image's own entrypoint and supervisor with a
				# stand-in runner script mounted over run-job.mjs: it runs under whatever node flags the supervisor gives the
				# real one, and starts a tool child (plain node) that pokes the supervisor, then the runner, then a plain node
				# of its own as the control, which must OPEN (else the probe proves nothing on this host). An image whose
				# entrypoint runs the runner with no supervisor reports the supervisor `absent`, which passes. Once one process
				# opens, the port stays taken and every later check reads `open` too: any `open` fails, and the FIRST names it.
				probe_dir=$(mktemp -d)
				cat >"$probe_dir/run-job.mjs" <<'PROBE'
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
let parent = "";
try {
	parent = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8");
} catch {}
const tool = `
const { spawn } = require("node:child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
async function poke(pid) {
	try { process._debugProcess(pid); } catch { return "unsignalled"; }
	for (let i = 0; i < 20; i++) { await sleep(100); if (await open()) return "open"; }
	return "closed";
}
(async () => {
	const [runner, supervisor] = process.argv.slice(1).map(Number);
	const s = supervisor > 0 ? await poke(supervisor) : "absent";
	const r = await poke(runner);
	const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
	await sleep(300);
	const c = await poke(control.pid);
	control.kill("SIGKILL");
	console.log("inspector-probe control=" + c + " supervisor=" + s + " runner=" + r);
})();
`;
const supervisor = parent.includes("supervise") ? process.ppid : 0;
// spawn, never spawnSync: a node whose main thread is blocked cannot start its inspector, so a stand-in waiting in
// spawnSync would read `closed` with or without the flag and prove nothing.
const child = spawn("node", ["-e", tool, String(process.pid), String(supervisor)], { stdio: ["ignore", "inherit", "inherit"] });
const stop = setTimeout(() => child.kill("SIGKILL"), 30000);
child.on("exit", () => {
	clearTimeout(stop);
	process.exit(0);
});
PROBE
				chmod -R a+rX "$probe_dir"
				probe_out=$(docker run --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$probe_dir/run-job.mjs:/app/image/runner/run-job.mjs:ro" "$IMAGE_REF" 2>&1) || true
				rm -rf "$probe_dir"
				probe_line=$(echo "$probe_out" | grep '^inspector-probe ' | tail -1)
				echo "$probe_line" | grep -Eq '^inspector-probe control=open supervisor=(closed|absent) runner=closed$' \
					|| fail "the image declares 'exitAuth' but a tool's SIGUSR1 opens the Node inspector of a process holding the exit line's key, or the probe could not run (${probe_line:-no probe line}): start the supervisor and the runner with --disable-sigusr1"
				;;
			excludeTools)
				# Same evidence style as 'commands': the baked runner config must actually read the variable.
				# A runner that does not would run a "read-only" trigger's job with every tool it says to
				# remove and record a clean exit -- a permission quietly not enforced.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_EXCLUDE_TOOLS" /app/image/runner/src/config.mjs 2>/dev/null \
					|| fail "the image declares 'excludeTools' but its baked runner never reads PI_EXCLUDE_TOOLS -- a read-only trigger would run with every tool the file says to remove"
				;;
			*) fail "dev.pi-dispatch.capabilities names an unknown capability '$capability'" ;;
		esac
	done
	ok "dev.pi-dispatch.capabilities ($capabilities) matches what the image actually bakes"
fi
if [ "$any_uid" != 1 ]; then
	# Said out loud for the same reason as the playwright skip below: a check that silently does not apply reads
	# like one that passed.
	echo "  note no 'anyUid' capability -- on a daemon that enforces bind-mount ownership (native Linux Docker, rootful"
	echo "       Podman), a job on this image can only run as the image's own user (issue #341)."
fi

# --cap-drop=ALL is CONST-ISOLATION-CONTAINER-PER-JOB's enforcement surface. Read the effective capability
# set directly rather than install libcap just to ask.
caps=$(docker run --rm --cap-drop=ALL --security-opt no-new-privileges \
	--entrypoint sh "$IMAGE_REF" -c 'grep ^CapEff /proc/self/status' | awk '{print $2}')
[ "$caps" = "0000000000000000" ] || fail "container retains capabilities under --cap-drop=ALL: $caps"
ok "no capabilities under --cap-drop=ALL (CapEff=$caps)"

uid=$(docker run --rm --entrypoint id "$IMAGE_REF" -u)
[ "$uid" != "0" ] || fail "the image runs as root. Jobs must run non-root."
ok "runs as a non-root user (uid $uid)"

# /job:ro is what makes CONST-ISSUE-TEXT-IS-DATA enforceable by filesystem permission rather than by asking
# nicely, so assert the kernel enforces it rather than trusting the flag.
#
# The fixture is opened to every uid first, and a control write WITHOUT :ro must succeed. Without both, a host
# whose uid is not the image's (native Linux, issue #341) refuses the write with EACCES before :ro is ever
# consulted, and the check passes having tested nothing.
fixture=$(mktemp -d)
mkdir -p "$fixture/pi"
echo "x" >"$fixture/pi/APPEND_SYSTEM.md"
chmod 0777 "$fixture" "$fixture/pi"
chmod 0666 "$fixture/pi/APPEND_SYSTEM.md"
if ! docker run --rm --cap-drop=ALL -v "$fixture:/job" --entrypoint sh "$IMAGE_REF" \
	-c 'echo control >> /job/pi/APPEND_SYSTEM.md' 2>/dev/null; then
	rm -rf "$fixture"
	fail "the control write to a writable /job failed, so the :ro check below would prove nothing -- check that this host can bind-mount $fixture"
fi
docker run --rm --cap-drop=ALL -v "$fixture:/job:ro" --entrypoint sh "$IMAGE_REF" -c 'cat /job/pi/APPEND_SYSTEM.md' >/dev/null 2>&1 \
	|| { rm -rf "$fixture"; fail "/job:ro could not even be read, so the write refusal below would prove nothing"; }
if docker run --rm --cap-drop=ALL -v "$fixture:/job:ro" --entrypoint sh "$IMAGE_REF" \
	-c 'echo pwned > /job/pi/APPEND_SYSTEM.md' 2>/dev/null; then
	rm -rf "$fixture"
	fail "/job is writable from inside. The agent can rewrite its own instructions."
fi
rm -rf "$fixture"
ok "/job:ro is enforced by the kernel (a writable control mount accepted the same write)"

# pi lazily creates ~/.pi/agent and writes auth.json on the FIRST credential operation. It swallows a failure to
# do so, so a root-owned dir does not stop the job: playwright, npm or gh fail later instead, on a path nothing in
# a Dockerfile hints at, and the runner logs agent_dir_not_writable (issue #341).
docker run --rm --entrypoint sh "$IMAGE_REF" -c 'touch "$HOME/.pi/agent/auth.json" && rm "$HOME/.pi/agent/auth.json"' >/dev/null 2>&1 \
	|| fail "\$HOME/.pi/agent is not writable by the runtime user. pi skips auth.json silently and the tools fail later."
ok "the agent dir is writable by the runtime user"

# An agent that can rewrite its own safety floor has none, and an absent floor raises no error at all.
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-guardrails-v1" /opt/pi-dispatch/HARD_RULES.md 2>/dev/null \
	|| fail "the guardrails sentinel is missing from /opt/pi-dispatch/HARD_RULES.md -- the runner reads its safety floor from there."
ok "guardrails are baked where the runner reads them"

# The two gated personas (issue #505): the loader composes each only when its mount or file is there, and reads it from
# here. A missing file is no error, just a prompt without the protocol, so the image check is what notices.
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-outbox-v1" /opt/pi-dispatch/OUTBOX_PROTOCOL.md 2>/dev/null \
	|| fail "the outbox sentinel is missing from /opt/pi-dispatch/OUTBOX_PROTOCOL.md -- a local job would run without the outbox protocol."
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-portfolio-v1" /opt/pi-dispatch/PORTFOLIO_PROTOCOL.md 2>/dev/null \
	|| fail "the portfolio sentinel is missing from /opt/pi-dispatch/PORTFOLIO_PROTOCOL.md -- a portfolio job would run without the plan protocol."
ok "the outbox and portfolio protocols are baked where the runner reads them"

# Root-owned and NOT writable by the runtime user, or the floor is advisory.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'echo x >> /opt/pi-dispatch/HARD_RULES.md' 2>/dev/null; then
	fail "the runtime user can WRITE /opt/pi-dispatch/HARD_RULES.md. A safety floor the agent can edit is not a floor."
fi
ok "guardrails are not writable by the runtime user"

# The frontend half. Both are only meaningful for flows that do visual work, but neither failure announces
# itself: a fontless Chromium renders tofu, and screenshots look plausible while containing no legible text.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'command -v playwright-cli' >/dev/null 2>&1; then
	# $@ are extra `docker run` flags: none for the image's own user, a uid and HOME for the anyUid claim.
	render_check() {
		docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --shm-size=1g "$@" \
			-e PAGE='<html><body style="background:#f00"><h1 style="color:#fff">RENDER-CHECK-MARKER</h1></body></html>' \
			--entrypoint sh "$IMAGE_REF" -c \
			'node -e "require(\"http\").createServer((_,r)=>{r.writeHead(200,{\"content-type\":\"text/html\"});r.end(process.env.PAGE)}).listen(8099)" & sleep 1;
			 playwright-cli open http://localhost:8099 >/dev/null 2>&1;
			 playwright-cli snapshot 2>&1 | grep -q RENDER-CHECK-MARKER || exit 1;
			 playwright-cli screenshot --filename /tmp/s.png >/dev/null 2>&1;
			 test -s /tmp/s.png' >/dev/null 2>&1
	}
	render_check \
		|| fail "Chromium did not render a real page. Check PLAYWRIGHT_BROWSERS_PATH (set at BOTH build and run), PLAYWRIGHT_MCP_BROWSER, PLAYWRIGHT_MCP_SANDBOX, and fonts."
	ok "Chromium renders a real page as non-root"
	if [ "$any_uid" = 1 ]; then
		# Measured (issue #341): the image before that change rendered as pi and failed under --user 4242:4242,
		# with or without HOME.
		render_check --user 4242:4242 -e HOME=/home/pi \
			|| fail "the image declares 'anyUid' but Chromium does not render as an arbitrary uid with HOME=/home/pi"
		ok "Chromium renders a real page as an arbitrary non-root uid (anyUid)"
	fi

	n=$(docker run --rm --entrypoint sh "$IMAGE_REF" -c 'fc-list | wc -l')
	[ "$n" -gt 0 ] || fail "no fonts installed. Chromium renders tofu boxes: screenshots look plausible and contain no legible text."
	ok "fonts are installed ($n)"
else
	# Not a failure: an image for a non-visual flow has no reason to carry Chromium. Said out loud, because
	# a silently skipped check reads exactly like a passing one.
	echo "  skip playwright-cli is not in this image -- the Chromium and font checks do not apply."
	echo "       Flows that build or screenshot a frontend will NOT work in it (REQ-FRONTEND-VISUAL-VERIFY)."
fi

echo
echo "PASS: $IMAGE_REF satisfies the CORE conformance checklist."
echo
echo "What this did NOT check, and nothing in this project can: that the pi version inside matches the pin,"
echo "that the entrypoint honours the exit-code protocol on every path, or that the loader flags carry the"
echo "posture you expect. Those are yours (docs/job-image.md, OQ-012)."
