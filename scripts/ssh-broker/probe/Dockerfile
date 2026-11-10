# Deployment-side credential-isolation forensics rig (ADR-0039).
#
# Reproduces the documented Linux deployment inside one container:
#   root          runs install.sh (systemd unit written, systemctl stubbed —
#                 the daemon is started by run.sh because the container has
#                 no init system)
#   _dsh_ssh      dedicated broker account created by install.sh; owns the
#                 credential root and the broker socket
#   dshhost       the Host UID: runs `dsh plugin add` for the dedicated
#                 remote-exp profile, drops the deployment patch layer, and
#                 boots the real composed tree through the probe
#
# Build context is staged by build-and-run.sh into .build/ (the packed
# plugin tarball plus the repo's scripts/ helpers the probe imports).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates openssh-client procps xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@11.25.0 --activate

# The Host user, its workspace (the manifest's bound local primary), and the
# evidence output directory the probe writes as that user.
RUN useradd -m -s /bin/bash dshhost \
 && mkdir -p /home/dshhost/ws /probe-out \
 && chown -R dshhost:dshhost /home/dshhost/ws /probe-out

# Deployment dsh install (root-owned; the Host reads/executes only) with the
# SSH peer set the compatibility gate requires.
WORKDIR /opt/dsh-deploy
RUN npm init -y >/dev/null \
 && npm i @deepseek-ai/dsh@0.2.2-rc.1 \
    @deepseek-ai/dsh-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-fs-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-sandbox-ssh@0.2.2-rc.1

# Broker-side install: its own node_modules so the packaged broker entry's
# imports resolve independently of the Host deployment.
WORKDIR /opt/dsh-broker
RUN npm init -y >/dev/null \
 && npm i @deepseek-ai/dsh@0.2.2-rc.1 \
    @deepseek-ai/dsh-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-fs-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.1 \
    @deepseek-ai/dsh-sandbox-ssh@0.2.2-rc.1
COPY .build/plugin.tgz /opt/plugin.tgz
RUN npm i /opt/plugin.tgz \
 && node -e "require('node:fs').accessSync('/opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/lib/remote-broker.js')"

COPY .build/scripts /repo-scripts
# The probe helpers are the repo's own scripts: they resolve `yaml` +
# `typescript` directly, and the add recovery path reads the plugin's
# package.json. npm's peer auto-install deadlocks on the plugin's
# multi-release peer ranges, so the package lands as a plain tarball
# extraction — only its manifest is ever required from this tree.
WORKDIR /repo-scripts
RUN npm init -y >/dev/null \
 && npm i yaml typescript \
 && mkdir -p node_modules/@dsh-electron/dsh-plugin-multi-root-workspace \
 && tar -xzf /opt/plugin.tgz -C node_modules/@dsh-electron/dsh-plugin-multi-root-workspace --strip-components=1
COPY run.sh manifest.json profile-patch.yml /probe/
RUN chmod +x /probe/run.sh

ENTRYPOINT ["/probe/run.sh"]
