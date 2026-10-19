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

# Issue #683: the binaries the image says may need the network, at their real paths, for a venue whose egress policy
# names executables (issue #684 generates it). Each entry must be an absolute path to a regular file that is its own
# realpath: such a policy matches the executable the kernel ran, so a symlink or a moved binary would match nothing and
# the job would lose the network with no word why. Absent is no claim, and a venue that needs the list refuses it.
net_binaries=$(docker image inspect --format '{{index .Config.Labels "dev.pi-dispatch.net-binaries"}}' "$IMAGE_REF" 2>/dev/null)
if [ -z "$net_binaries" ] || [ "$net_binaries" = "<no value>" ]; then
	ok "no dev.pi-dispatch.net-binaries label -- the image makes no claim, and a venue that needs one refuses the image"
else
	for bin in $(echo "$net_binaries" | tr ',' ' '); do
		case "$bin" in /*) ;; *) fail "dev.pi-dispatch.net-binaries names '$bin', which is not an absolute path" ;; esac
		docker run --rm --entrypoint sh "$IMAGE_REF" -c '[ -f "$1" ] && [ ! -L "$1" ] && [ "$(readlink -f "$1")" = "$1" ]' sh "$bin" >/dev/null 2>&1 \
			|| fail "dev.pi-dispatch.net-binaries names '$bin', which is not a regular file at its own real path in the image -- a policy naming it would match nothing"
	done
	ok "dev.pi-dispatch.net-binaries ($net_binaries) are regular files at their real paths"
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
			mcp)
				# REQ-MCP-OPERATOR-SERVERS. The claim is that the runner reads /job/mcp.json, connects the stdio server it
				# names with only the environment it names, waits for it before the prompt, and closes it before it exits.
				# Proved by running one offline: a stub server in /job that answers the handshake and refuses it when the
				# provider's key reached it, and a cost cap of 0 so the job stops before its first call. The runner must log
				# mcp_servers_ready and then exit 2 with cost-cap. A runner that ignored the file would exit cost-cap without
				# the log line; one that leaked the key, or never connected, would exit mcp-unavailable or hang.
				mcp_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$mcp_job/prompt.md"
				cat >"$mcp_job/stub.mjs" <<'STUB'
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.id === undefined) return;
	if (m.method === "initialize") {
		if (process.env.ANTHROPIC_API_KEY || process.env.STUB_TOKEN !== "named") return send({ id: m.id, error: { code: -32603, message: "env" } });
		return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
	}
	if (m.method === "tools/list") return send({ id: m.id, result: { tools: [] } });
	send({ id: m.id, error: { code: -32601, message: "no" } });
});
STUB
				cat >"$mcp_job/mcp.json" <<'DOC'
{ "version": 1, "codemodeModels": false, "servers": { "stub": { "type": "stdio", "command": "node", "args": ["/job/stub.mjs"], "env": { "STUB_TOKEN": "${STUB_TOKEN}" }, "description": "Stub" } }, "refs": { "stub": ["STUB_TOKEN"] } }
DOC
				chmod -R a+rX "$mcp_job"
				mcp_started=$(date +%s)
				mcp_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$mcp_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_COST_MICROS=0 \
					-e PI_MCP_SERVERS=stub -e STUB_TOKEN=named \
					"$IMAGE_REF" 2>&1) && mcp_code=0 || mcp_code=$?
				mcp_took=$(($(date +%s) - mcp_started))
				rm -rf "$mcp_job"
				mcp_exit=$(echo "$mcp_out" | grep '"event":"exit"' | tail -1)
				[ "$mcp_code" = 2 ] && echo "$mcp_out" | grep -q '"event":"mcp_servers_ready"' && echo "$mcp_exit" | grep -q '"reason":"cost-cap"' && [ "$mcp_took" -lt 60 ] \
					|| fail "the image declares 'mcp' but a job naming a stdio server in /job/mcp.json did not connect it and stop cleanly (exit $mcp_code in ${mcp_took}s: $mcp_exit)"
				;;
			forgeMcp)
				# DES-FORGE-MCP and CONST-MERGE-NEVER-AUTOMATIC. The claim is that the image carries the forge's own servers
				# behind the wrappers the worker's `forge` entries name, runnable by the job user without the network, with
				# the tools each wrapper withholds (the forges' dedicated merge and approval tools among them) out of reach.
				# That keeps the harness from handing a job a ready made merge tool; it is not a boundary (a quick action in a
				# note, the job's CLI), and the token's role and branch protection are. Proved by running each wrapper offline
				# with a dummy token, as a job would: it must answer an MCP initialize and a tools/list in which no withheld
				# name appears and no name matching /merge|approv/i appears outside the names below (tools named for a merge
				# request that are not its dedicated merge or approval tools; some write notes, which can carry a quick
				# action, which this does not claim to stop; a new such name in a later pin is read and added here, or
				# withheld), and a tools/call of each withheld name, and of a tool the server never listed, must be refused
				# as an unknown tool (an error from the call's empty arguments does not count: it means the server ran it).
				# github-mcp-server must also print its release version (not `dev`, which a build without the release stamp
				# prints).
				docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges --entrypoint sh "$IMAGE_REF" \
					-c '[ "$(id -u)" != 0 ] && [ -x /usr/local/bin/forge-mcp-github ] && [ -x /usr/local/bin/forge-mcp-gitlab ] && [ -x /usr/local/bin/github-mcp-server ]' >/dev/null 2>&1 \
					|| fail "the image declares 'forgeMcp' but /usr/local/bin/forge-mcp-github, forge-mcp-gitlab or github-mcp-server is missing or not executable by the job user"
				forge_gh=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges --entrypoint /usr/local/bin/github-mcp-server "$IMAGE_REF" --version 2>&1) \
					&& echo "$forge_gh" | grep -Eqx 'Version: [0-9]+\.[0-9]+\.[0-9]+' \
					|| fail "the image declares 'forgeMcp' but github-mcp-server does not print a release version offline ($forge_gh)"
				forge_dir=$(mktemp -d)
				cat >"$forge_dir/probe.mjs" <<'PROBE'
import { spawn } from "node:child_process";
const [command, withheldList, allowedList] = process.argv.slice(2);
const withheld = withheldList.split(",");
const allowed = new Set(allowedList.split(",").filter(Boolean));
const child = spawn(command, [], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: "/tmp", GITHUB_PERSONAL_ACCESS_TOKEN: "ghp-not-a-real-token", GITHUB_TOOLSETS: "default", GITHUB_LOCKDOWN_MODE: "1", GITHUB_EXCLUDE_TOOLS: "", GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-not-a-real-token", GITLAB_API_URL: "https://gitlab.invalid/api/v4", GITLAB_DISABLE_VERSION_CHECK: "true", GITLAB_TOOL_POLICY_HIDDEN: "" } });
const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const done = (problem) => { console.log(problem ?? "ok"); child.kill(); process.exit(problem ? 1 : 0); };
setTimeout(() => done("no answer within 60 seconds"), 60_000);
const calls = [...withheld, "execute_graphql", "never_listed_tool"];
const answers = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\n")) >= 0) {
		const message = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		if (message.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/list" }); }
		if (message.id === 2) {
			const names = message.result.tools.map((tool) => tool.name);
			const seen = names.filter((name) => withheld.includes(name) || (/merge|approv/i.test(name) && !allowed.has(name)));
			if (seen.length > 0) return done(`it lists ${seen.join(", ")}`);
			calls.forEach((name, i) => send({ id: 10 + i, method: "tools/call", params: { name, arguments: {} } }));
		}
		if (message.id >= 10) {
			answers.set(message.id, message);
			// Refused as unknown, not failed: a server that runs the call fails it too, on its empty arguments.
			if (!/unknown tool/i.test(message.error?.message ?? "")) return done(`a call of ${calls[message.id - 10]} was not refused as unknown`);
			if (answers.size === calls.length) return done();
		}
	}
});
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } } });
PROBE
				chmod -R a+rX "$forge_dir"
				forge_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$forge_dir:/probe:ro" --entrypoint /usr/local/bin/node "$IMAGE_REF" \
					/probe/probe.mjs /usr/local/bin/forge-mcp-github merge_pull_request,pull_request_review_write,assign_copilot_to_issue,request_copilot_review "" 2>&1) && forge_gh_code=0 || forge_gh_code=$?
				forge_gh_out=$forge_out
				forge_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$forge_dir:/probe:ro" --entrypoint /usr/local/bin/node "$IMAGE_REF" \
					/probe/probe.mjs /usr/local/bin/forge-mcp-gitlab merge_merge_request,approve_merge_request,unapprove_merge_request,approve_deployment,discover_tools,execute_graphql \
					get_merge_request_approval_state,get_merge_request_conflicts,list_merge_request_pipelines,create_merge_request,get_merge_request,get_merge_request_diffs,list_merge_request_changed_files,list_merge_request_diffs,get_merge_request_file_diff,list_merge_request_versions,get_merge_request_version,update_merge_request,create_merge_request_thread,resolve_merge_request_thread,get_merge_request_discussion,delete_merge_request_discussion_note,update_merge_request_discussion_note,create_merge_request_discussion_note,create_merge_request_note,delete_merge_request_note,get_merge_request_note,get_merge_request_notes,update_merge_request_note,list_merge_request_emoji_reactions,list_merge_request_note_emoji_reactions,create_merge_request_emoji_reaction,delete_merge_request_emoji_reaction,create_merge_request_note_emoji_reaction,delete_merge_request_note_emoji_reaction,list_merge_requests,list_group_merge_requests 2>&1) && forge_gl_code=0 || forge_gl_code=$?
				rm -rf "$forge_dir"
				[ "$forge_gh_code" = 0 ] || fail "the image declares 'forgeMcp' but forge-mcp-github does not withhold its merge and approval tools offline ($forge_gh_out)"
				[ "$forge_gl_code" = 0 ] || fail "the image declares 'forgeMcp' but forge-mcp-gitlab does not withhold its merge and approval tools offline ($forge_out)"
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
				# real one, and starts a tool child (plain node) that finds every key holder BY ITS EXECUTABLE, every process
				# whose /proc/<pid>/cmdline names /opt/pi-dispatch/runner-node as argv[0] (cmdline stays readable for a
				# process that is not dumpable), pokes each, then pokes a plain node of its own as the control, which must
				# OPEN (else the probe proves nothing on this host). By executable, never by name or by parent (review round
				# 2): the first probe took the stand-in's parent as the supervisor only when its argv held "supervise", so an
				# entrypoint that ran a renamed copy, or a runner started through a shell that did not exec (its parent then a sh),
				# read `absent` and passed with the supervisor's inspector open. At least TWO holders must answer (the
				# supervisor and the runner), every one `closed`. The tool runs on plain node, so it is never one of them. Once
				# one process opens, the port stays taken and every later poke reads `open` too: any `open` fails, and the
				# FIRST names it.
				probe_dir=$(mktemp -d)
				cat >"$probe_dir/run-job.mjs" <<'PROBE'
import { spawn } from "node:child_process";
const tool = `
const { spawn } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const HOLDER = "/opt/pi-dispatch/runner-node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
async function poke(pid) {
	try { process._debugProcess(pid); } catch { return "unsignalled"; }
	for (let i = 0; i < 20; i++) { await sleep(100); if (await open()) return "open"; }
	return "closed";
}
function argv0(pid) {
	try { return readFileSync("/proc/" + pid + "/cmdline", "latin1").split("\\0")[0]; } catch { return ""; }
}
(async () => {
	const holders = readdirSync("/proc").filter((p) => /^[0-9]+$/.test(p)).map(Number).filter((p) => p !== process.pid && argv0(p) === HOLDER).sort((a, b) => a - b);
	const states = [];
	for (const pid of holders) states.push(pid + ":" + await poke(pid));
	const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
	await sleep(300);
	const c = await poke(control.pid);
	control.kill("SIGKILL");
	console.log("inspector-probe holders=" + (states.join(",") || "none") + " control=" + c);
})();
`;
// spawn, never spawnSync: a node whose main thread is blocked cannot start its inspector, so a stand-in waiting in
// spawnSync would read `closed` with or without the flag and prove nothing.
const child = spawn("node", ["-e", tool], { stdio: ["ignore", "inherit", "inherit"] });
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
				echo "$probe_line" | grep -Eq '^inspector-probe holders=[0-9]+:closed(,[0-9]+:closed)+ control=open$' \
					|| fail "the image declares 'exitAuth' but a tool's SIGUSR1 opens the Node inspector of a process holding the exit line's key, fewer than two key holders run under /opt/pi-dispatch/runner-node, or the probe could not run (${probe_line:-no probe line}): run the supervisor and the runner under /opt/pi-dispatch/runner-node, both with --disable-sigusr1"
				;;
			excludeTools)
				# Same evidence style as 'commands': the baked runner config must actually read the variable.
				# A runner that does not would run a "read-only" trigger's job with every tool it says to
				# remove and record a clean exit -- a permission quietly not enforced.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_EXCLUDE_TOOLS" /app/image/runner/src/config.mjs 2>/dev/null \
					|| fail "the image declares 'excludeTools' but its baked runner never reads PI_EXCLUDE_TOOLS -- a read-only trigger would run with every tool the file says to remove"
				;;
			awaitInput)
				# Same evidence style as 'excludeTools': the baked runner must read the variable and carry the tool.
				# A runner that does not would never offer the job the tool a parked run ends on.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_AWAIT_INPUT" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "await_human_input" /app/image/runner/src/await-input.mjs 2>/dev/null \
					|| fail "the image declares 'awaitInput' but its baked runner never reads PI_AWAIT_INPUT or carries the await_human_input tool"
				;;
			reportProgress)
				# Same evidence style as 'awaitInput': the baked runner must read the variable and carry the tool.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_REPORT_PROGRESS" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "report_progress" /app/image/runner/src/report-progress.mjs 2>/dev/null \
					|| fail "the image declares 'reportProgress' but its baked runner never reads PI_REPORT_PROGRESS or carries the report_progress tool"
				;;
			recover)
				# Same evidence style as 'reportProgress': the baked runner must read both variables and carry the module
				# that answers the interrupted calls. A runner that does not would resume a crashed run into pi's
				# "No result provided" and let the model repeat a push or a comment that may already have happened.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_RECOVERING" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "toolExecution = \"sequential\"" /app/image/runner/run-job.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "recoverSession" /app/image/runner/src/recover.mjs 2>/dev/null \
					|| fail "the image declares 'recover' but its baked runner never reads PI_RECOVERING, never runs its tools one at a time, or carries no recovery module"
				;;
			steer)
				# Same evidence style as 'recover': the baked runner must read the variable and carry the inbox module.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_STEER" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-inbox" /app/image/runner/src/inbox.mjs 2>/dev/null \
					|| fail "the image declares 'steer' but its baked runner never reads PI_STEER or carries the inbox module"
				# And the mount the worker gives it: /inbox read-only, so the agent cannot plant a message in its own inbox or
				# withdraw one. The /job:ro check's shape below: an every-uid fixture, a control write without :ro that must
				# succeed (else EACCES would pass the check having tested nothing), a read through :ro, then the refused write.
				inbox_dir=$(mktemp -d)
				echo '{}' >"$inbox_dir/000001-00000000000000000000000000000001.json"
				chmod 0777 "$inbox_dir"
				chmod 0666 "$inbox_dir/000001-00000000000000000000000000000001.json"
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox" --entrypoint sh "$IMAGE_REF" -c 'echo control > /inbox/control' 2>/dev/null \
					|| { rm -rf "$inbox_dir"; fail "the control write to a writable /inbox failed, so the :ro check would prove nothing -- check that this host can bind-mount $inbox_dir"; }
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox:ro" --entrypoint sh "$IMAGE_REF" -c 'ls /inbox/000001-00000000000000000000000000000001.json' >/dev/null 2>&1 \
					|| { rm -rf "$inbox_dir"; fail "/inbox:ro could not even be listed, so the write refusal would prove nothing"; }
				# Judged on the host, by what changed in the directory, not by the shell's exit status.
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox:ro" --entrypoint sh "$IMAGE_REF" \
					-c 'echo planted > /inbox/000002-00000000000000000000000000000002.json; rm -f /inbox/000001-00000000000000000000000000000001.json' >/dev/null 2>&1 || true
				if [ -e "$inbox_dir/000002-00000000000000000000000000000002.json" ] || [ ! -e "$inbox_dir/000001-00000000000000000000000000000001.json" ]; then
					rm -rf "$inbox_dir"
					fail "/inbox is writable from inside. The agent could plant or withdraw a message in its own inbox."
				fi
				rm -rf "$inbox_dir"
				;;
			sandboxLayout)
				# Issue #683. Two claims. First, the runner reads PI_JOB_LAYOUT and, under `sandbox`, finds its job under
				# /sandbox: proved by the costCap job above run on that layout, its prompt mounted at /sandbox/job and nothing
				# at /job, which must reach the same pre-call refusal (a runner reading /job would exit "missing job input").
				layout_job=$(mktemp -d)
				layout_ws=$(mktemp -d)
				echo "Reply with the single word ok." >"$layout_job/prompt.md"
				chmod -R a+rX "$layout_job"
				chmod 0777 "$layout_ws"
				layout_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$layout_job:/sandbox/job:ro" -v "$layout_ws:/sandbox/workspace" --workdir /sandbox/workspace \
					-e PI_JOB_LAYOUT=sandbox -e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_COST_MICROS=0 \
					"$IMAGE_REF" 2>&1) && layout_code=0 || layout_code=$?
				layout_exit=$(echo "$layout_out" | grep '"event":"exit"' | tail -1)
				# Issue #684: a copying venue's network policy names the image's binaries, so the claim needs the label.
				[ -n "$net_binaries" ] && [ "$net_binaries" != "<no value>" ] \
					|| { rm -rf "$layout_job" "$layout_ws"; fail "the image declares 'sandboxLayout' but no dev.pi-dispatch.net-binaries label: a copying venue's network policy would match no binary"; }
				[ "$layout_code" = 2 ] && echo "$layout_exit" | grep -q '"reason":"cost-cap"' \
					|| { rm -rf "$layout_job" "$layout_ws"; fail "the image declares 'sandboxLayout' but a job on PI_JOB_LAYOUT=sandbox did not find its prompt under /sandbox/job (exit $layout_code: $layout_exit)"; }
				# Second, /opt/pi-dispatch/pi-landlock confines every write of the tree it starts to the --rw paths. Where the
				# kernel has no Landlock (Docker Desktop's LinuxKit, measured) the helper must refuse to run anything (126,
				# "Landlock is unavailable"): fail closed, never start the runner unconfined. VERIFY_REQUIRE_LANDLOCK=1 (the
				# image job in CI) turns that host into a failure, because there the enforcement itself must be proved.
				ll_out=$(docker run --rm --cap-drop=ALL --security-opt no-new-privileges --entrypoint /opt/pi-dispatch/pi-landlock "$IMAGE_REF" \
					--rw /tmp -- /bin/sh -c 'exit 0' 2>&1) && ll_code=0 || ll_code=$?
				if [ "$ll_code" = 126 ] && echo "$ll_out" | grep -q "Landlock is unavailable"; then
					rm -rf "$layout_job" "$layout_ws"
					[ "${VERIFY_REQUIRE_LANDLOCK:-0}" = 1 ] && fail "VERIFY_REQUIRE_LANDLOCK=1 but this host's kernel has no Landlock, so pi-landlock's confinement cannot be proved here"
					echo "  note this host's kernel has no Landlock: pi-landlock refused to run anything (exit 126), which is the"
					echo "       fail-closed half; its confinement is proved on a host with Landlock (the image job in CI)."
				elif [ "$ll_code" = 0 ]; then
					chmod 0777 "$layout_job"
					# The control: the same write WITHOUT the helper must succeed, else the refusal below would prove nothing.
					docker run --rm --cap-drop=ALL -v "$layout_job:/sandbox/job" --entrypoint sh "$IMAGE_REF" -c 'echo control > /sandbox/job/control' 2>/dev/null \
						|| { rm -rf "$layout_job" "$layout_ws"; fail "the control write to a writable /sandbox/job failed, so the pi-landlock check would prove nothing"; }
					# Judged on the host, by what changed in the directories, not by the shell's exit status.
					docker run --rm --cap-drop=ALL --security-opt no-new-privileges -v "$layout_job:/sandbox/job" -v "$layout_ws:/sandbox/workspace" \
						--entrypoint /opt/pi-dispatch/pi-landlock "$IMAGE_REF" --rw /sandbox/workspace --rw /dev/null -- /bin/sh -c \
						'echo planted > /sandbox/job/planted; echo appended >> /sandbox/job/control; ( : > /sandbox/job/prompt.md ); rm -f /sandbox/job/prompt.md; mv /sandbox/job/control /sandbox/workspace/stolen; /opt/pi-dispatch/pi-landlock --rw / -- /bin/sh -c "echo widened > /sandbox/job/widened"; echo ok > /sandbox/workspace/ok' >/dev/null 2>&1 || true
					# The truncate runs in a subshell: `:` is a special builtin, and a POSIX sh EXITS when its redirection fails, which
					# would skip every step after it and read as the helper refusing a --rw write.
					# The overwrite and the truncate are the two rights (WRITE_FILE, TRUNCATE) a file the job's own uid owns is
					# protected by alone, which is every uploaded file on a copying venue: the content must be untouched.
					if [ -e "$layout_job/planted" ] || [ -e "$layout_job/widened" ] || [ ! -s "$layout_job/prompt.md" ] || [ "$(cat "$layout_job/control" 2>/dev/null)" != control ]; then
						rm -rf "$layout_job" "$layout_ws"
						fail "pi-landlock let the tree it starts write, remove or move a file under /sandbox/job. The agent could rewrite its own job inputs on a copying venue."
					fi
					[ -e "$layout_ws/ok" ] || { rm -rf "$layout_job" "$layout_ws"; fail "pi-landlock refused a write under a --rw path (/sandbox/workspace), so a job could not write its own workspace"; }
					rm -rf "$layout_job" "$layout_ws"
				else
					rm -rf "$layout_job" "$layout_ws"
					fail "pi-landlock neither ran a confined command nor refused for want of Landlock (exit $ll_code: $ll_out)"
				fi
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
