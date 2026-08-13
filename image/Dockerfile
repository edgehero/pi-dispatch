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

# Non-root. CONST-ISOLATION-CONTAINER-PER-JOB.
RUN useradd --create-home --shell /bin/bash --uid 1001 pi

# ONLY these two are chowned to pi, because they are the only things the runtime user must
# WRITE. Everything else it merely reads or executes, and code the agent can rewrite is not a
# boundary -- see the guardrails/runner COPYs below.
#
# ~/.pi/agent is the ONLY thing chowned to pi here: pi lazily creates it (0700) and writes
# auth.json (0600) on the FIRST credential operation (ensureParentDir/ensureFileExists inside
# withLock). Root-owned means the job dies EACCES at runtime, on a path nothing here hints at.
# `COPY --chown` would not fix this anyway: it does not apply to parent dirs COPY auto-creates,
# so /home/pi/.pi would still be root:root.
#
# /ms-playwright is deliberately NOT chowned. The browsers install root-owned and 0755
# (world-readable/executable), which is all the non-root runtime user needs -- and root ownership
# means the agent cannot tamper with its own browser binary. Chowning ~1GB of browser in a
# separate layer also cost 687MB of overlay2 copy-up for a metadata-only change.
RUN mkdir -p /home/pi/.pi/agent && chown -R pi:pi /home/pi/.pi

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
ARG PI_VERSION=0.80.7
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
LABEL dev.pi-dispatch.capabilities="replicas,commands"

USER pi
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
