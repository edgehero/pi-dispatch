FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY landlock-ro.c /src/landlock-ro.c
RUN gcc -O2 -static -o /landlock-ro /src/landlock-ro.c
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN useradd --uid 1001 --create-home pi && mkdir -p /sandbox /usr/local/lib/lab && chown pi:pi /sandbox && echo baked > /usr/local/lib/lab/baked
COPY keyprobe.mjs /usr/local/lib/lab/keyprobe.mjs
COPY --from=build /landlock-ro /usr/local/bin/landlock-ro
USER pi
WORKDIR /sandbox
