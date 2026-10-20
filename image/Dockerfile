# The job container. One per job, ephemeral, non-root, cap-dropped.
#
# CONST-ISOLATION-CONTAINER-PER-JOB: pi has no permission system, the input is
# adversarial, and this container is therefore the ONLY real security control.
#
# Build context is the repo root:  docker build -f image/Dockerfile .

# Pinned by DIGEST, not tag. CONST-PI-VERSION-PINNED's reasoning is not about pi
# specifically -- a floating base tag is the identical silent break from a different
# vendor. This is the MANIFEST-LIST digest (pinning a per-arch manifest would break
# multi-arch); it resolves to node 22.23.1 and carries amd64 + arm64/v8, so Apple
# Silicon works. 22.23.1 clears pi's 22.19.0 floor.
# pi-landlock (issue #683, image/landlock/pi-landlock.c), built in a stage of its own so the compiler never reaches the job
# image. The SAME pinned base as the job image below, so this adds no second vendor pin; gcc and libc6-dev come from
# that base's own Debian release. Static, so the binary needs nothing from the image it lands in. `-Werror` because a
# warning in a forty-line security helper is a defect, not noise.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS landlock
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY image/landlock/pi-landlock.c /src/pi-landlock.c
RUN gcc -O2 -Wall -Wextra -Werror -static -o /pi-landlock /src/pi-landlock.c

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV DEBIAN_FRONTEND=noninteractive

# Fonts are not cosmetic. bookworm-slim ships none, so Chromium renders tofu boxes:
# screenshots that look plausible and contain no legible text. That would silently gut
# REQ-FRONTEND-VISUAL-VERIFY -- the requirement full Chromium is here for -- while every
# test still passed. fontconfig + a base font set + fc-cache is the fix.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      jq \
      ca-certificates \
      wget \
      fontconfig \
      fonts-liberation \
      fonts-dejavu-core \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# gh CLI, per cli/cli/docs/install_linux.md. No sudo: build stage is already root.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && mkdir -p -m 755 /etc/apt/sources.list.d \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# glab, the GitLab CLI, for gitlab jobs (issue #42). `gh` speaks the GitHub API and nothing else, so a
# gitlab job following the github envelope fails at its first `gh pr create` on every run.
#
# Pinned to an exact version AND verified against a per-architecture sha256 -- deliberately unlike the `gh`
# block above, which tracks an apt channel and is this image's one unpinned dependency. Repeating that for
# a second CLI would double the surface where an unattended upstream change lands inside a container that
# holds a repo credential (CONST-PI-VERSION-PINNED's reasoning, one layer out).
ARG GLAB_VERSION=1.110.0
ARG GLAB_SHA256_AMD64=978485e47c90b5c7d33638944838f28ddc5cb6833f01c9a0a80011a27d2766e3
ARG GLAB_SHA256_ARM64=0d5e7d75d9e1380827c2bb815d05b2835b0dbee18fceac123fd9f77e730c9ef2
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha="$GLAB_SHA256_AMD64" ;; \
      arm64) sha="$GLAB_SHA256_ARM64" ;; \
      *) echo "glab: unsupported architecture $arch" >&2; exit 1 ;; \
    esac; \
    wget -nv -O /tmp/glab.tgz "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz"; \
    echo "${sha}  /tmp/glab.tgz" | sha256sum -c -; \
    tar -xzf /tmp/glab.tgz -C /tmp bin/glab; \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab; \
    rm -rf /tmp/glab.tgz /tmp/bin; \
    glab --version

# glab checks for a newer release on invocation. Off, for two reasons that both matter here: it is an
# outbound call from a container running adversarial input (OQ-004), and its notice lands in the agent's
# own stdout, where a flow parsing command output has to know to ignore it. The pin is this repo's to
# move in a commit, not the container's to discover at run time (CONST-PI-VERSION-PINNED's reasoning).
ENV GLAB_CHECK_UPDATE=false
ENV GLAB_SEND_TELEMETRY=false

# pi's own switch, for the same two reasons (issue #509). From pi 0.99 an interactive `pi` reports an install
# ping, and PI_TELEMETRY also gates the attribution headers pi adds to OpenRouter, NVIDIA and Cloudflare
# requests. A job never runs pi interactively and the runner forces this to "0" itself, over whatever reached
# the container (image/runner/src/config.mjs, enforceTelemetryOff), so this line is for everything ELSE that
# runs pi in this image: `pi-dispatch sandbox` re-opening a run with bash, verify-image.sh's `pi -p --help`.
ENV PI_TELEMETRY=0


# tea, the Forgejo/Gitea CLI, for forgejo jobs (issue #61). Same reason glab is here: `gh` speaks the
# GitHub API and nothing else, so a forgejo job following the github envelope fails at its first
# `gh pr create` on every run -- and Forgejo's nouns being GitHub's is exactly what would make that
# failure look like a bad agent rather than a missing tool.
#
# Pinned like glab, not like gh: an exact version and a per-architecture sha256 over the release binary.
# Issue #61 asks for this by name -- "a second CLI should not repeat that" -- and it is right to: an
# unattended upstream change lands inside a container holding a repository credential.
ARG TEA_VERSION=0.15.0
ARG TEA_SHA256_AMD64=d7e47fbe7809e4db6a6d830989b0e1776ed5943bb08dccbe0ed166e2594126e2
ARG TEA_SHA256_ARM64=6bdb9a44e0263f104fd396b690e0376d2a27a183abae557452b31e39d6f35ba3
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha="$TEA_SHA256_AMD64" ;; \
      arm64) sha="$TEA_SHA256_ARM64" ;; \
      *) echo "tea: unsupported architecture $arch" >&2; exit 1 ;; \
    esac; \
    wget -nv -O /tmp/tea "https://gitea.com/gitea/tea/releases/download/v${TEA_VERSION}/tea-${TEA_VERSION}-linux-${arch}"; \
    echo "${sha}  /tmp/tea" | sha256sum -c -; \
    install -m 0755 /tmp/tea /usr/local/bin/tea; \
    rm -f /tmp/tea; \
    tea --version

# engine-strict is set explicitly because npm reads it from $HOME/.npmrc and
# $PREFIX/etc/npmrc but NEVER from a project .npmrc for installs outside a project root.
# Without this the node-floor guard silently does not cover the install that matters most.
ENV NPM_CONFIG_ENGINE_STRICT=true

# A LOCAL install from the lockfile -- deliberately not `npm i -g`.
#
# A global install puts binaries on PATH but does NOT make a package importable by a bare
# specifier: node's ESM resolver walks node_modules upward from the importing file and
# ignores the global prefix entirely. NODE_PATH does not help either -- it is CommonJS-only
# and the resolver ignores it for ESM. `import "@earendil-works/pi-coding-agent"` from
# /app/image/runner therefore only resolves against a real node_modules above it.
#
# Deps are copied before source so a source edit does not invalidate this layer.
WORKDIR /app
COPY package.json package-lock.json ./
COPY image/runner/package.json ./image/runner/
RUN npm ci --omit=dev --no-audit --no-fund

# The pi and playwright-cli binaries come from that same install: one pin, one copy on disk,
# no chance of the CLI and the imported library drifting to different versions.
ENV PATH="/app/node_modules/.bin:${PATH}"

# Set BEFORE the browser install so root-time install and non-root-time lookup agree.
# Root installs would otherwise land in /root/.cache/ms-playwright, which the non-root
# runtime user cannot see -- a direct collision between two of our own constraints.
# @playwright/cli does NOT install browsers; it is a thin wrapper. The standard installer,
# pinned transitively by @playwright/cli and resolved from the lockfile, does.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Baked because they are facts about THIS IMAGE, not choices a job makes. Leaving them to the
# worker means every caller has to remember them and a frontend job fails when one forgets.
#
# PLAYWRIGHT_MCP_BROWSER: playwright-cli defaults to the branded `chrome` CHANNEL and looks for
# /opt/google/chrome/chrome, which does not exist here and must not -- a system Chrome with a
# persistent profile is precisely what DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS rejected. Without
# this, every frontend job dies with "Chromium distribution 'chrome' is not found" and
# REQ-FRONTEND-VISUAL-VERIFY is dead on arrival.
#
# PLAYWRIGHT_MCP_SANDBOX: Chromium's own sandbox needs user-namespace syscalls or CAP_SYS_ADMIN.
# --cap-drop=ALL denies both, deliberately -- the container IS the boundary
# (CONST-ISOLATION-CONTAINER-PER-JOB). Disabling the inner sandbox skips the code path that needs
# the privilege rather than granting it. Never "fix" a launch error by re-adding SYS_ADMIN.
ENV PLAYWRIGHT_MCP_BROWSER=chromium \
    PLAYWRIGHT_MCP_SANDBOX=false

# The forge's own MCP servers (DES-FORGE-MCP), which a github or gitlab trigger names in run.mcp as `forge`. Baked
# here rather than fetched by the job (a package runner at start runs whatever version the registry holds that day),
# and pinned like glab and tea: each is a program inside a container holding a repository credential, so an
# unattended upstream change must never reach one. The worker starts each with the job's own forge token and nothing
# else (worker/src/mcp-config.mjs, forgeMcpServer).
#
# github-mcp-server, GitHub's own, from its release tarball: an exact version and a per-architecture sha256 over the
# release asset (github-mcp-server_Linux_x86_64.tar.gz, github-mcp-server_Linux_arm64.tar.gz). A static Go binary.
# The version check runs it offline, as verify-image.sh does again.
ARG GITHUB_MCP_SERVER_VERSION=2.0.2
ARG GITHUB_MCP_SERVER_SHA256_AMD64=815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0
ARG GITHUB_MCP_SERVER_SHA256_ARM64=73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset=x86_64; sha="$GITHUB_MCP_SERVER_SHA256_AMD64" ;; \
      arm64) asset=arm64; sha="$GITHUB_MCP_SERVER_SHA256_ARM64" ;; \
      *) echo "github-mcp-server: unsupported architecture $arch" >&2; exit 1 ;; \
    esac; \
    wget -nv -O /tmp/github-mcp-server.tgz "https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_SERVER_VERSION}/github-mcp-server_Linux_${asset}.tar.gz"; \
    echo "${sha}  /tmp/github-mcp-server.tgz" | sha256sum -c -; \
    mkdir /tmp/github-mcp-server; \
    tar -xzf /tmp/github-mcp-server.tgz -C /tmp/github-mcp-server github-mcp-server; \
    install -m 0755 /tmp/github-mcp-server/github-mcp-server /usr/local/bin/github-mcp-server; \
    rm -rf /tmp/github-mcp-server.tgz /tmp/github-mcp-server; \
    github-mcp-server --version | grep -qxF "Version: ${GITHUB_MCP_SERVER_VERSION}"

# @zereight/mcp-gitlab for a gitlab job, at exactly the version image/forge-mcp/gitlab/package.json names and from that
# folder's committed lockfile, so every package under it is the one the lockfile's integrity hash names. Its own
# folder, not a workspace of the root: its tree is the server's, and a pi bump must not move it. No install script
# runs (`--ignore-scripts`; none of its packages declares one, and none needs a build).
COPY image/forge-mcp/gitlab/package.json image/forge-mcp/gitlab/package-lock.json /opt/forge-mcp/gitlab/
RUN cd /opt/forge-mcp/gitlab \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && test "$(node -p 'require("./node_modules/@zereight/mcp-gitlab/package.json").version')" = "2.1.67"

# What a job runs is never the server itself but its wrapper (CONST-MERGE-NEVER-AUTOMATIC): each one forces the list of
# its server's merge and approval tools, which withhold.mjs drops from every tool list and refuses every call to, along
# with a call to any tool the server did not list. The worker's `forge` entries name these two commands, and
# verify-image.sh runs each offline and fails on a merge or approval tool it can see or call.
COPY image/forge-mcp/withhold.mjs /opt/forge-mcp/withhold.mjs
COPY image/forge-mcp/forge-mcp-github.sh /usr/local/bin/forge-mcp-github
COPY image/forge-mcp/forge-mcp-gitlab.sh /usr/local/bin/forge-mcp-gitlab
RUN chmod 0644 /opt/forge-mcp/withhold.mjs \
    && chmod 0755 /usr/local/bin/forge-mcp-github /usr/local/bin/forge-mcp-gitlab

# Non-root. CONST-ISOLATION-CONTAINER-PER-JOB.
RUN useradd --create-home --shell /bin/bash --uid 1001 pi

# The home is the ONLY thing the runtime user must WRITE. Everything else it merely reads or
# executes, and code the agent can rewrite is not a boundary -- see the guardrails/runner COPYs below.
#
# pi lazily creates ~/.pi/agent (0700) and writes auth.json (0600) on the first credential operation
# (ensureParentDir/ensureFileExists inside withLock), and playwright, npm and gh write their caches
# and config under the same home. A home the runtime user cannot write does NOT stop the job: pi's
# AuthStorage swallows the lock failure and an env-keyed job carries on (measured), so the breakage
# lands later, inside whichever tool wrote first, on a path nothing here hints at. The runner logs
# `home_not_writable` for exactly that reason. `COPY --chown` would not fix a root-owned home anyway:
# it does not apply to parent dirs COPY auto-creates.
#
# 0777 (world-writable, NOT sticky) on the home and the agent dir, so the runtime user does not have
# to be `pi` (issue #341). On a daemon that enforces bind-mount ownership, a job can only read its 0700
# job dir, and leave files the host can clean up, when it runs as the uid that owns them: that is a
# `--user` with no passwd entry here, whose home must therefore be writable by an arbitrary non-root
# uid. No sticky bit, on purpose: a job container runs exactly one uid, so there is no other user's
# file to protect, and a sticky world-writable dir makes the kernel refuse to follow a symlink that
# neither the follower nor the dir's owner owns (fs.protected_symlinks, measured): a derived layer's
# root-owned link under /home/pi would stop resolving even for uid 1001. uid 1001 still owns the tree.
#
# There is deliberately NO `ENV HOME` here. Images built FROM this one (image/Dockerfile.azure,
# docs/job-image.md) run root build steps, and with HOME pointed at /home/pi those steps would
# leave root-owned .cache/.npm/.azure dirs in it that no runtime user could write. A container
# started with `--user` must be given HOME=/home/pi on its own command line instead.
#
# /ms-playwright is deliberately NOT chowned. The browsers install root-owned and 0755
# (world-readable/executable), which is all the non-root runtime user needs -- and root ownership
# means the agent cannot tamper with its own browser binary. Chowning ~1GB of browser in a
# separate layer also cost 687MB of overlay2 copy-up for a metadata-only change.
RUN mkdir -p /home/pi/.pi/agent && chown -R pi:pi /home/pi \
    && chmod 0777 /home/pi /home/pi/.pi /home/pi/.pi/agent

# The image's WORKDIR is /sandbox (issue #683), not /workspace, because a copying venue (OpenShell) makes the WORKDIR
# its sandbox's writable tree and uploads and downloads nothing outside it: the `sandbox` layout
# (image/runner/src/layout.mjs) puts the job, workspace and session there. A binding venue is not moved by it: the
# worker's argv carries `--workdir=/workspace` (worker/src/docker-run.mjs), so a job there starts where it always did,
# and an older image under a newer worker too. Owned by pi and not world-writable: OpenShell runs the image's own USER
# there, and on a binding venue nothing is mounted at /sandbox at all.
# /workspace stays in the image, root-owned and empty, exactly as `WORKDIR /workspace` used to leave it: a container
# started without a workspace mount (verify-image.sh's offline jobs, an operator's hand-run one) still has the
# directory the runner names as its cwd.
RUN mkdir -p /sandbox /workspace && chown pi:pi /sandbox && chmod 0755 /sandbox /workspace

# The safety floor and the runner are ROOT-OWNED and NOT writable by pi. The agent runs AS pi;
# if it could overwrite /opt/pi-dispatch/HARD_RULES.md it would own its own constraints, and if
# it could overwrite /app it would own the runner and pi itself. `/job:ro` exists precisely so
# the agent cannot rewrite its instructions -- leaving its code agent-writable is the identical
# hole through a different door. Root owns it; pi reads it (npm's 0644/0755 defaults suffice).
#
# The guardrails path is deliberately NOT ~/.pi/agent/APPEND_SYSTEM.md: a trusted project's
# .pi/APPEND_SYSTEM.md shadows that via an early return in discoverAppendSystemPromptFile, which
# would delete the floor from the prompt with no error. The runner reads this path explicitly.
COPY guardrails/HARD_RULES.md /opt/pi-dispatch/HARD_RULES.md
COPY guardrails/OUTBOX_PROTOCOL.md /opt/pi-dispatch/OUTBOX_PROTOCOL.md
COPY guardrails/PORTFOLIO_PROTOCOL.md /opt/pi-dispatch/PORTFOLIO_PROTOCOL.md

# The runner's own node: an EXEC-ONLY, root-owned copy (issue #545). The kernel marks a process that exec'd a binary its
# user cannot read as not dumpable, and a non-dumpable process's /proc/<pid>/mem, environ and fd are refused to the
# same uid without CAP_SYS_PTRACE, which --cap-drop=ALL removes. That is what keeps the per-job exit-line key, read
# from stdin into the runner's memory, out of reach of the job's own tools: measured, a tool child read the key out of
# a plain node runner's memory on Docker Desktop (no Yama) and on Fedora (Yama ptrace_scope 0), and got EACCES from
# this copy on every venue. A COPY, not a chmod of /usr/local/bin/node: every tool's node stays an ordinary readable
# binary, and both cost the same one 120MB layer. The entrypoint execs this one.
RUN install -o root -g root -m 0711 /usr/local/bin/node /opt/pi-dispatch/runner-node

# The write confinement a copying venue starts the runner through (issue #683): root-owned, so the agent cannot replace
# the helper that confines it (COPY keeps root:root and the 0755 gcc gave it; the chmod below takes the write bit), and
# readable, because it holds no secret. Only the worker's own exec argv on such a venue names it; a binding venue's
# `:ro` mounts do the same job there.
COPY --from=landlock /pi-landlock /opt/pi-dispatch/pi-landlock

# Source last: everything above is cacheable and this layer changes on every commit.
COPY image/runner /app/image/runner
COPY image/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && chmod -R a-w /opt/pi-dispatch /app/image/runner /app/node_modules

# The pi this image ships, declared where the WORKER can read it without starting a container
# (REQ-RESUMABLE-SESSION, INT-CONTAINER-RUNTIME-CONTRACT). The image preflight already runs
# `docker image inspect`, so this rides that call and costs no extra spawn.
#
# It is needed BEFORE the container starts because a persisted transcript can outlive the pi that wrote
# it, and pi's own docs record what then breaks: an older session's stored tool-call arguments may no
# longer match the current tool schema. The repair hook is an extension-author API and we do not own
# pi's built-in schemas, so the only available answer is to refuse the resume -- which requires knowing
# the version first. An image that declares nothing never resumes: null is the safe direction, not
# "assume it matches".
#
# It must track the runner's pin in image/runner/package.json. The CI pin-check greps both, so they
# cannot drift silently -- the same discipline the glab and gh pins get.
ARG PI_VERSION=1.2.0
LABEL dev.pi-dispatch.pi-version="${PI_VERSION}"

# Which forges this image can actually SERVE -- read by the worker's pre-spend image preflight, on the same
# `docker image inspect` that reads the pin above.
#
# `run.image` is optional, so a trigger for a forge whose CLI this image does not ship would run on the
# deployment default, find no such command, and fail INSIDE a paid container on every single delivery, with
# nothing to distinguish it from a bad agent run. Declaring the list moves that to a pre-spend refusal.
#
# An image that declares NOTHING is allowed everything, deliberately: every operator-built image predating
# this label (OQ-012) declares nothing, and refusing those would break working deployments with no warning.
# `verify-image.sh` asserts this list matches the CLIs actually installed, so the label cannot lie.
LABEL dev.pi-dispatch.forges="github,gitlab,forgejo"

# Which OPTIONAL harness features this image's baked contents can actually honour -- read by the same
# pre-spend preflight, on the same `docker image inspect`.
#
# `replicas` (REQ-REPLICA-RUNS) is here because the feature is half prompt and half safety floor. A replica's
# user prompt names `pi/issue-<n>-r2`, while an image built before this commit bakes a HARD_RULES.md whose
# rule 3 hard-codes `pi/issue-<n>` -- and that is the SYSTEM prompt, which the model treats as authoritative
# over the user one. Both replicas would converge on one branch and the feature would silently become a push
# race. The label is how the worker refuses that image pre-spend instead of discovering it afterwards.
#
# ITS POLARITY IS THE OPPOSITE OF `forges` ABOVE, deliberately, and stating that here is the point: `forges`
# is an EXCLUSION list, so no claim excludes nothing and an unlabelled image is allowed every forge;
# `capabilities` is an INCLUSION list, so no claim includes nothing and an unlabelled image is refused every
# replica job. Both follow one rule -- an image that declares nothing gets no benefit of the doubt about what
# it contains -- and both leave an UNFLAGGED job reading no label at all. `verify-image.sh` asserts this list
# against the baked guardrails, so it cannot lie any more than `forges` can.
# `commands` (issue #189) tells the worker this runner understands PI_COMMAND: it dispatches the
# registered extension command, refuses an unregistered one pre-spend, and classifies a headless
# command run as command-completed. An older runner handed PI_COMMAND would ignore the variable, read
# prompt.md, and either feed "/name args" to the model as prose or exit 1 no-terminal-message and be
# retried as infra -- paid retries of a job that can never classify. The label is how the worker
# refuses that pairing pre-spend (image-preflight.mjs), which is what makes shipping the runner ahead
# of the trigger field safe in both directions.
# `excludeTools` (issue #291) tells the worker this runner reads PI_EXCLUDE_TOOLS and withholds those
# tools from createAgentSession. An older runner handed the variable would ignore it and run the job
# with every tool the trigger says to remove -- a "read-only" trigger with a working editor and shell,
# recording a clean exit: a PERMISSION quietly not enforced, the worst-outcome class. The label is how
# the worker refuses that pairing pre-spend instead of letting the container fail open.
# `anyUid` (issue #341) tells the worker this image runs correctly under an ARBITRARY non-root uid with
# HOME=/home/pi: the home above is writable by any uid, and Chromium renders under one (verify-image.sh
# runs both as uid 4242). An older image run with `--user` gets HOME=/ (Docker) or HOME=/workspace
# (Podman, measured), so auth.json lands nowhere or in the operator's repository, and Chromium does not
# start. The label is how the worker can tell the two apart before it spends anything.
# `costCap` (issue #501) tells the worker this runner reads PI_MAX_COST_MICROS and refuses, before each provider
# call, a call whose worst-case cost would take the job past it. An older runner handed the variable would ignore
# it and spend without a cap, reporting a clean exit: a MONEY limit quietly not enforced. The worker refuses that
# pairing pre-spend by this token (its `costCap` capability row, reason job-image-cost-cap-unsupported); verify-image.sh runs an offline job with a fake key under a cap of 0 to prove the claim.
# `modelPolicy` (issue #502) tells the worker this runner reads PI_ALLOWED_MODELS and refuses, before each provider call,
# a call to a model the list does not name. An older runner handed the variable would ignore it and call any model,
# reporting a clean exit: a model choice quietly not enforced. The worker sends the list only to an image declaring this
# token; verify-image.sh runs an offline job with a fake key and a list that lacks its model to prove the claim.
# `exitAuth` (issue #545) tells the worker this runner reads a per-job key from stdin (PI_EXIT_AUTH=stdin), signs its exit
# line with it, writes a real exit line on SIGTERM, and runs under the exec-only node above, so the job's own tools can
# neither read the key nor sign a line. The worker hands a key only to an image declaring it, and then reads only a
# signed line; an image without it is read as before. verify-image.sh runs a job with a key and checks the MAC, checks
# from a tool child that the runner's memory is closed, and checks that a tool's SIGUSR1 opens no inspector in the
# supervisor or the runner (both start with --disable-sigusr1, issue #596).
# `mcp` (REQ-MCP-OPERATOR-SERVERS) tells the worker this runner reads /job/mcp.json and PI_MCP_SERVERS and connects the
# servers they name through pi's MCP, codemode and tool_search (image/runner/src/mcp.mjs). An older runner handed them
# would ignore both and run the job without the servers its trigger names; the worker refuses that pairing pre-spend
# (its `mcp` capability row, reason job-image-mcp-unsupported). verify-image.sh runs an offline job with a stub stdio
# server to prove the claim.
# `forgeMcp` (DES-FORGE-MCP) tells the worker this image carries the forge's own MCP servers above behind their
# wrappers, forge-mcp-github and forge-mcp-gitlab, at the paths the worker's `forge` entry names, with the forges'
# dedicated merge and approval tools withheld (a tool not handed out, not a boundary: the token's role and branch
# protection are). An image with `mcp` and without them would start a job whose run.mcp names `forge` and refuse it at
# the container's start (mcp-command-missing), after the budget was reserved; the worker refuses that pairing
# pre-spend instead (its `forgeMcp` capability row, reason job-image-forge-mcp-unsupported). verify-image.sh runs both
# wrappers as the job user with no network: each must answer, list no withheld tool and no other merge or approval
# name outside its known list, and refuse a call to each withheld one.
# `awaitInput` (REQ-AWAIT-INPUT, issue #625) tells the worker this runner reads PI_AWAIT_INPUT, offers the job the
# await_human_input tool, and ends a run on it as exit 0 / awaiting-input. An older runner handed the variable would
# ignore it: the agent is never offered the tool, guesses or gives up, and the key is never marked parked. The worker
# refuses that pairing pre-spend (its `awaitInput` capability row, reason job-image-await-input-unsupported).
# verify-image.sh checks the baked runner reads the variable.
# `reportProgress` (issue #644) tells the worker this runner reads PI_REPORT_PROGRESS and offers the job the
# report_progress tool. An older runner handed the variable would ignore it: the job runs without the tool and the
# trigger's phases never appear. The worker refuses that pairing pre-spend (its `reportProgress` capability row,
# reason job-image-progress-unsupported). verify-image.sh checks the baked runner reads the variable.
# `recover` (issue #645) tells the worker this runner reads PI_RECOVER and PI_RECOVERING: with PI_RECOVER it runs the
# job's tools one at a time, so a crash leaves at most one call whose effect is unknown, and with PI_RECOVERING it
# answers the interrupted calls of the staged checkpoint (re-running only the builtin file tools and the job's own
# report_progress) and continues with a fixed recovery prompt (image/runner/src/recover.mjs). An older runner handed
# the variables would ignore both: the interrupted run would resume into pi's "No result provided" for a push or a
# comment that may have happened, and the model would repeat it. The worker sends them only to an image declaring
# this token. verify-image.sh checks the baked runner reads the variables and carries the recovery module.
# `steer` (issue #646) tells the worker this runner reads PI_STEER: it reads the messages the worker relays into the
# read-only /inbox mount and hands each to the running agent once, as framed data, with an ack MACed under the exit
# key (image/runner/src/inbox.mjs). An older runner handed the variable would ignore it: every message an operator or
# a collaborator sent would wait unread while the run reported success. The worker refuses that pairing pre-spend (its
# `steer` capability row, reason job-image-steer-unsupported). verify-image.sh checks the baked runner reads the
# variable and carries the inbox module, and that an /inbox mounted read-only is read-only inside the container.
# `sandboxLayout` (issue #683) tells the worker this runner reads PI_JOB_LAYOUT and, under `sandbox`, finds every job
# path under /sandbox (image/runner/src/layout.mjs), and that the image carries /opt/pi-dispatch/pi-landlock, the write
# confinement a copying venue starts it through. An older runner on such a venue would read /job, find nothing, and
# exit "missing job input" after the sandbox was made and the budget reserved; without the helper its /job would be
# writable by the agent. The worker refuses that pairing pre-spend on a copying venue only (its `sandboxLayout`
# capability row, reason job-image-sandbox-layout-unsupported). verify-image.sh runs an offline job on the sandbox
# layout and proves the helper refuses a write under /sandbox/job while allowing one under /sandbox/workspace.
# `transcriptStderr` (issue #686) tells the worker this runner reads PI_TRANSCRIPT=stderr and mirrors its session file's
# lines over stderr as records signed with the exit key (image/runner/src/transcript-mirror.mjs), which is how a copying
# venue serves the live transcript, run progress and the status comment. Not a gate: an image without it runs there
# without them (`live_transcript_skipped`, reason no-capability). verify-image.sh runs an offline keyed job with the
# variable set and checks a record's HMAC under the key it handed over, and that another key does not verify it.
# `steerStdin` (issue #686, part 2) tells the worker this runner reads PI_EXIT_AUTH=stdin-frames: the exit key as frame 1
# of a length-prefixed frame stream on stdin, read before pi loads, then steer messages as frames MAC'd under that key
# (image/runner/src/steer-frames.mjs), the stream moved off fd 0 so a tool child inherits /dev/null. It is how a copying
# venue steers a running job. Not a gate: an image without it runs there unsteered (`steerSkipped: "venue-copies"`).
# verify-image.sh feeds an offline steered job a key frame and one message frame on a held-open stdin, and checks that
# the key read took exactly frame 1, that pi's bash tool child and an inheriting child see /dev/null on fd 0, and that
# the message came back acked under the key on the signed exit line.
# `bundleEnvFile` (issue #704 part 3) tells the worker this runner reads PI_BUNDLE_ENV=1: a project secret bundle's plain
# variables as one JSON object in the job directory's bundle-env.json, put into the runner's own environment before pi's
# runtime exists (image/runner/src/bundle-env.mjs). It is how an OpenShell venue hands those values to a job without its
# exec's argv, which the gateway logs. A gate on those venues only: a job there that would carry plain bundle variables
# on an image without it is refused before spend (openshell-bundle-image-too-old). verify-image.sh runs an offline job
# with such a file and checks a workspace extension sees the variable, a multi-line one intact.
LABEL dev.pi-dispatch.capabilities="replicas,commands,excludeTools,anyUid,costCap,modelPolicy,exitAuth,mcp,forgeMcp,awaitInput,reportProgress,recover,steer,sandboxLayout,transcriptStderr,steerStdin,bundleEnvFile"

# The binaries in this image that may need the network, at their real paths (issue #683). A venue whose egress policy
# names binaries rather than hosts alone (OpenShell decides every connection per executable) needs the paths before it
# can write a rule; issue #684 generates that policy from this list. Real paths, not PATH names or symlinks, because
# such a policy matches the executable the kernel ran. verify-image.sh holds every entry to an existing regular file
# that is its own realpath, so a moved binary fails the image job rather than a policy silently matching nothing.
# /opt/pi-dispatch/runner-node FIRST: it is the binary the runner and pi run as (the exec-only copy above), so every
# provider call leaves through it, not through /usr/local/bin/node. Playwright's Chromium is deliberately NOT listed:
# its path carries a build number and the architecture, and a job's browser reaches its own dev server on loopback,
# which no egress rule governs; a trigger that needs it to reach the internet is #684's to decide.
LABEL dev.pi-dispatch.net-binaries="/opt/pi-dispatch/runner-node,/usr/local/bin/node,/usr/bin/git,/usr/lib/git-core/git-remote-http,/usr/bin/gh,/usr/local/bin/glab,/usr/local/bin/tea,/usr/local/bin/github-mcp-server,/usr/bin/wget"

USER pi
WORKDIR /sandbox

ENTRYPOINT ["/entrypoint.sh"]
