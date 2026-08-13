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
			*) fail "dev.pi-dispatch.capabilities names an unknown capability '$capability'" ;;
		esac
	done
	ok "dev.pi-dispatch.capabilities ($capabilities) matches what the image actually bakes"
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
fixture=$(mktemp -d)
mkdir -p "$fixture/pi"
echo "x" >"$fixture/pi/APPEND_SYSTEM.md"
if docker run --rm --cap-drop=ALL -v "$fixture:/job:ro" --entrypoint sh "$IMAGE_REF" \
	-c 'echo pwned > /job/pi/APPEND_SYSTEM.md' 2>/dev/null; then
	rm -rf "$fixture"
	fail "/job is writable from inside. The agent can rewrite its own instructions."
fi
rm -rf "$fixture"
ok "/job:ro is enforced by the kernel"

# pi lazily creates ~/.pi/agent and writes auth.json on the FIRST credential operation. A root-owned dir
# kills the job with EACCES at run time, on a path nothing in a Dockerfile hints at.
docker run --rm --entrypoint sh "$IMAGE_REF" -c 'touch "$HOME/.pi/agent/auth.json" && rm "$HOME/.pi/agent/auth.json"' >/dev/null 2>&1 \
	|| fail "\$HOME/.pi/agent is not writable by the runtime user. pi dies EACCES on its first credential write."
ok "the agent dir is writable by the runtime user"

# An agent that can rewrite its own safety floor has none, and an absent floor raises no error at all.
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-guardrails-v1" /opt/pi-dispatch/HARD_RULES.md 2>/dev/null \
	|| fail "the guardrails sentinel is missing from /opt/pi-dispatch/HARD_RULES.md -- the runner reads its safety floor from there."
ok "guardrails are baked where the runner reads them"

# Root-owned and NOT writable by the runtime user, or the floor is advisory.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'echo x >> /opt/pi-dispatch/HARD_RULES.md' 2>/dev/null; then
	fail "the runtime user can WRITE /opt/pi-dispatch/HARD_RULES.md. A safety floor the agent can edit is not a floor."
fi
ok "guardrails are not writable by the runtime user"

# The frontend half. Both are only meaningful for flows that do visual work, but neither failure announces
# itself: a fontless Chromium renders tofu, and screenshots look plausible while containing no legible text.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'command -v playwright-cli' >/dev/null 2>&1; then
	docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --shm-size=1g \
		-e PAGE='<html><body style="background:#f00"><h1 style="color:#fff">RENDER-CHECK-MARKER</h1></body></html>' \
		--entrypoint sh "$IMAGE_REF" -c \
		'node -e "require(\"http\").createServer((_,r)=>{r.writeHead(200,{\"content-type\":\"text/html\"});r.end(process.env.PAGE)}).listen(8099)" & sleep 1;
		 playwright-cli open http://localhost:8099 >/dev/null 2>&1;
		 playwright-cli snapshot 2>&1 | grep -q RENDER-CHECK-MARKER || exit 1;
		 playwright-cli screenshot --filename /tmp/s.png >/dev/null 2>&1;
		 test -s /tmp/s.png' >/dev/null 2>&1 \
		|| fail "Chromium did not render a real page. Check PLAYWRIGHT_BROWSERS_PATH (set at BOTH build and run), PLAYWRIGHT_MCP_BROWSER, PLAYWRIGHT_MCP_SANDBOX, and fonts."
	ok "Chromium renders a real page as non-root"

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
