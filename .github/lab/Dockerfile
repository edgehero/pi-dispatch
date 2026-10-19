FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN useradd --uid 1001 --create-home pi && mkdir -p /sandbox /opt/lab && chown pi:pi /sandbox && echo baked > /opt/lab/baked
COPY .github/lab/keyprobe.mjs /opt/lab/keyprobe.mjs
USER pi
WORKDIR /sandbox
