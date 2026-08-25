# Weaver — one image for the runner and stateless HTTP surfaces:
#   docker run … ghcr.io/niallbrickell/weaver run --interval 5     (resident runner)
#   docker run … ghcr.io/niallbrickell/weaver serve --host 0.0.0.0 (bot ingress)
#   docker run … ghcr.io/niallbrickell/weaver ui --host 0.0.0.0    (operator workspace)
#
# The image carries the harness only. Model credentials arrive as env at run
# time (see docs-public/hosting.md); the durable fleet lives in Postgres via
# WEAVER_STORE — a container is exactly as disposable as the thesis demands.
#
# Substrate note: local-sdk / codex-sdk / pi workers run inside this container.
# The openhands executor needs a Docker daemon and is a host-level substrate —
# run that on a VM runner, not in here.

FROM node:22-slim

RUN apt-get update -q \
  && apt-get install -qy --no-install-recommends git openssh-client gh curl ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /opt/weaver

# Dependency layer first so source edits don't re-fetch 1GB of node_modules
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install

COPY . .

# Runner state (pid lock, heartbeat, secret files) — a volume in compose
ENV WEAVER_HOME=/var/lib/weaver
ENV WEAVER_WORKSPACE_ROOT=/var/lib/weaver/workspaces
RUN mkdir -p /var/lib/weaver/workspaces

# Keep Weaver itself as PID 1 so Railway/Docker SIGTERM reaches the runner
# directly and its in-flight work can stop without a package-manager shim.
ENTRYPOINT ["node", "bin/weaver.mjs"]
CMD ["run", "--interval", "5"]
