#!/bin/bash
# In-container orchestrator for the entry-isolation probe. Runs as root:
# provisions the deployment manifest, executes the packaged install.sh with a
# stubbed systemctl, starts the broker daemon under _dsh_ssh, then hands the
# Host-side work to dshhost.
set -euo pipefail

INSTALL=/opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace
BROKER_JS="$INSTALL/lib/remote-broker.js"
export DSH_SSH_BROKER_JS="$BROKER_JS"
export DSH_SSH_BROKER_MANIFEST=/etc/dsh-ssh-broker/manifest.json
export DSH_SSH_BROKER_NODE
DSH_SSH_BROKER_NODE=$(command -v node)

# The manifest must exist before the installer runs; install.sh then takes
# /etc/dsh-ssh-broker to 0750 root:<client-group>.
mkdir -p /etc/dsh-ssh-broker
install -m 0644 -o root -g root /probe/manifest.json "$DSH_SSH_BROKER_MANIFEST"

# No init system: the unit file still gets written, the enable call is a
# no-op, and this script starts the daemon directly below.
printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/systemctl
chmod +x /usr/local/bin/systemctl

echo '[probe] running packaged install.sh as root (client user: dshhost)'
bash "$INSTALL/scripts/ssh-broker/install.sh" dshhost

BROKER_UID=$(id -u _dsh_ssh)
sed "s/__BROKER_UID__/$BROKER_UID/" /probe/profile-patch.yml > /home/dshhost/profile-patch.yml
chown dshhost:dshhost /home/dshhost/profile-patch.yml

echo "[probe] starting broker daemon as _dsh_ssh (uid $BROKER_UID)"
su -s /bin/sh _dsh_ssh -c "HOME=/var/lib/dsh-ssh-broker exec $DSH_SSH_BROKER_NODE $BROKER_JS --config /etc/dsh-ssh-broker/broker.json" &
for _ in $(seq 1 100); do [ -S /run/dsh-ssh-broker/broker.sock ] && break; sleep 0.2; done
[ -S /run/dsh-ssh-broker/broker.sock ] || { echo '[probe] broker socket never appeared' >&2; exit 1; }
echo '[probe] broker socket is up'

# Host side: install the plugin into the dedicated profile, lay the
# deployment patch, and run the probe — all as dshhost.
su -s /bin/bash dshhost -c '
  set -euo pipefail
  export DSH_HOME=/home/dshhost/.dsh
  export DSH_CLI=/opt/dsh-deploy/node_modules/@deepseek-ai/dsh/lib/bin.js
  export DSH_PROFILE=remote-exp
  export DSH_PROBE_PLUGIN_SOURCE=/opt/plugin.tgz
  export DSH_PROBE_PROFILE_PATCH=/home/dshhost/profile-patch.yml
  export PRIMARY=/home/dshhost/ws
  export CRED_ROOT=/var/lib/dsh-ssh-broker
  export BROKER_SOCK=/run/dsh-ssh-broker/broker.sock
  export REPORT=/probe-out/evidence.json
  export PATH="/opt/dsh-deploy/node_modules/.bin:$PATH"
  node /repo-scripts/probe-remote-entry-isolation.mjs
'
echo '[probe] evidence at /probe-out/evidence.json'
