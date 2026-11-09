#!/bin/sh
# Provision the credential broker account, directories, config and service
# (ADR-0036). Run as root on the Host machine, once per deployment:
#
#   sudo DSH_SSH_BROKER_JS=/path/to/plugin/lib/remote-broker.js \
#        DSH_SSH_BROKER_MANIFEST=/etc/dsh-ssh-broker/manifest.json \
#        ./install.sh <dsh-host-user>
#
# It creates a dedicated system account + client group, a 0700 credential
# home, a 0750 socket directory, /etc/dsh-ssh-broker/broker.json and the
# launchd/systemd unit. It does NOT create the deployment manifest and does
# NOT install the remote public key for you: those are the deployer's
# decisions, and the script prints exactly what remains.
set -eu

CLIENT_USER=${1:?usage: install.sh <dsh-host-user>}
BROKER_USER=${DSH_SSH_BROKER_USER:-_dsh_ssh}
CLIENT_GROUP=${DSH_SSH_BROKER_GROUP:-dsh-ssh-clients}
NODE_BIN=${DSH_SSH_BROKER_NODE:-$(command -v node || true)}
BROKER_JS=${DSH_SSH_BROKER_JS:?set DSH_SSH_BROKER_JS to the installed lib/remote-broker.js}
MANIFEST=${DSH_SSH_BROKER_MANIFEST:-/etc/dsh-ssh-broker/manifest.json}
CONFIG=/etc/dsh-ssh-broker/broker.json

[ "$(id -u)" -eq 0 ] || { echo "install.sh must run as root" >&2; exit 1; }
id "$CLIENT_USER" >/dev/null 2>&1 || { echo "no such Host user: $CLIENT_USER" >&2; exit 1; }
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "node is required (set DSH_SSH_BROKER_NODE)" >&2; exit 1; }
[ -f "$BROKER_JS" ] || { echo "broker entry not found: $BROKER_JS" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "deployment manifest not found: $MANIFEST" >&2; exit 1; }

CLIENT_UID=$(id -u "$CLIENT_USER")
[ "$CLIENT_UID" -ne 0 ] || { echo "the Host must run under a non-root account" >&2; exit 1; }
[ "$CLIENT_USER" != "$BROKER_USER" ] || { echo "the broker needs a separate account" >&2; exit 1; }

case "$(uname -s)" in
  Linux)
    HOME_DIR=/var/lib/dsh-ssh-broker
    RUN_DIR=/run/dsh-ssh-broker
    AUDIT=$HOME_DIR/audit.jsonl
    getent group "$CLIENT_GROUP" >/dev/null || groupadd --system "$CLIENT_GROUP"
    if ! id "$BROKER_USER" >/dev/null 2>&1; then
      useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$BROKER_USER"
    fi
    usermod -aG "$CLIENT_GROUP" "$BROKER_USER"
    usermod -aG "$CLIENT_GROUP" "$CLIENT_USER"
    ;;
  Darwin)
    HOME_DIR=/usr/local/var/dsh-ssh-broker
    RUN_DIR=/usr/local/var/run/dsh-ssh-broker
    AUDIT=$HOME_DIR/audit.jsonl
    next_id() {
      dscl . -list "$1" UniqueID 2>/dev/null | awk '{print $2+0}' | sort -n | tail -1 | \
        awk '{value = ($1 >= 400 ? $1 + 1 : 401); print value}'
    }
    if ! dscl . -read "/Groups/$CLIENT_GROUP" >/dev/null 2>&1; then
      GROUP_ID=$(next_id /Groups)
      dscl . -create "/Groups/$CLIENT_GROUP"
      dscl . -create "/Groups/$CLIENT_GROUP" PrimaryGroupID "$GROUP_ID"
      dscl . -create "/Groups/$CLIENT_GROUP" RealName "DSH SSH Broker Clients"
    fi
    if ! dscl . -read "/Users/$BROKER_USER" >/dev/null 2>&1; then
      USER_ID=$(next_id /Users)
      BROKER_GROUP_ID=$(next_id /Groups)
      dscl . -create "/Groups/$BROKER_USER"
      dscl . -create "/Groups/$BROKER_USER" PrimaryGroupID "$BROKER_GROUP_ID"
      dscl . -create "/Users/$BROKER_USER"
      dscl . -create "/Users/$BROKER_USER" UniqueID "$USER_ID"
      dscl . -create "/Users/$BROKER_USER" PrimaryGroupID "$BROKER_GROUP_ID"
      dscl . -create "/Users/$BROKER_USER" NFSHomeDirectory "$HOME_DIR"
      dscl . -create "/Users/$BROKER_USER" UserShell /usr/bin/false
      dscl . -create "/Users/$BROKER_USER" RealName "DSH SSH Broker"
    fi
    dseditgroup -o edit -a "$BROKER_USER" -t user "$CLIENT_GROUP" >/dev/null 2>&1 || true
    dseditgroup -o edit -a "$CLIENT_USER" -t user "$CLIENT_GROUP"
    ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

BROKER_UID=$(id -u "$BROKER_USER")
BROKER_HOME=$(dscl . -read "/Users/$BROKER_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)
[ -n "${BROKER_HOME:-}" ] || BROKER_HOME=$HOME_DIR

# Credential custody: only the broker account may traverse/read its home.
install -d -m 0700 -o "$BROKER_USER" -g "$(id -gn "$BROKER_USER")" "$BROKER_HOME"
install -d -m 0700 -o "$BROKER_USER" -g "$(id -gn "$BROKER_USER")" "$BROKER_HOME/.ssh"
install -d -m 0750 -o "$BROKER_USER" -g "$CLIENT_GROUP" "$RUN_DIR"
install -d -m 0750 -o root -g "$CLIENT_GROUP" /etc/dsh-ssh-broker

# SSH material: generate only when absent; never overwrite.
if [ ! -f "$BROKER_HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "dsh-ssh-broker@$(hostname)" -f "$BROKER_HOME/.ssh/id_ed25519"
  chown "$BROKER_USER":"$(id -gn "$BROKER_USER")" "$BROKER_HOME/.ssh/id_ed25519" "$BROKER_HOME/.ssh/id_ed25519.pub"
  chmod 0600 "$BROKER_HOME/.ssh/id_ed25519"
fi

cat > "$CONFIG" <<EOF
{
  "manifestPath": "$MANIFEST",
  "socketPath": "$RUN_DIR/broker.sock",
  "clientUid": $CLIENT_UID,
  "brokerUid": $BROKER_UID,
  "auditPath": "$AUDIT"
}
EOF
chown root:"$BROKER_USER" "$CONFIG"
chmod 0640 "$CONFIG"
# The manifest carries paths/accounts, no secrets, but only root may edit it.
chown root:"$BROKER_USER" "$MANIFEST"
chmod 0644 "$MANIFEST"

if [ "$(uname -s)" = Linux ]; then
  cat > /etc/systemd/system/dsh-ssh-broker.service <<EOF
[Unit]
Description=DSH SSH credential broker (ADR-0036)
After=network.target

[Service]
Type=simple
User=$BROKER_USER
Group=$CLIENT_GROUP
SupplementaryGroups=$(id -gn "$BROKER_USER")
RuntimeDirectory=dsh-ssh-broker
RuntimeDirectoryMode=0750
ExecStart=$NODE_BIN $BROKER_JS --config $CONFIG
Restart=on-failure
# The broker owns its credentials; it must be able to read its home and write
# the socket/audit paths, and nothing else.
ReadWritePaths=$BROKER_HOME $RUN_DIR
ProtectSystem=strict
PrivateTmp=yes
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now dsh-ssh-broker.service
else
  cat > /Library/LaunchDaemons/com.dsh.ssh-broker.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.ssh-broker</string>
  <key>UserName</key><string>$BROKER_USER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$BROKER_JS</string>
    <string>--config</string>
    <string>$CONFIG</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
  chown root:wheel /Library/LaunchDaemons/com.dsh.ssh-broker.plist
  chmod 0644 /Library/LaunchDaemons/com.dsh.ssh-broker.plist
  launchctl bootout system/com.dsh.ssh-broker >/dev/null 2>&1 || true
  launchctl bootstrap system /Library/LaunchDaemons/com.dsh.ssh-broker.plist
fi

cat <<EOF

Broker provisioned.
  account:        $BROKER_USER (uid $BROKER_UID)
  credential home: $BROKER_HOME (0700, $BROKER_USER only)
  socket:         $RUN_DIR/broker.sock (0750 $CLIENT_GROUP)
  client uid:     $CLIENT_UID ($CLIENT_USER)
  manifest:       $MANIFEST

Still required (deployer):
  1. Authorize the broker's public key on the remote:
     $(cat "$BROKER_HOME/.ssh/id_ed25519.pub" 2>/dev/null || echo '<no key>')
  2. Fill $MANIFEST with the environments/bindings (credentialIsolation: attested).
  3. Run the Agent-sandbox probe from the DSH Host account: under the same
     sandbox mode the Agent uses, reading $BROKER_HOME and connecting to the
     socket must both FAIL. Record the evidence in the Host's broker config.
  4. Host plugin config (deployment):
       broker: { config: {
         socketPath: "$RUN_DIR/broker.sock",
         brokerUid: $BROKER_UID,
         credentialRoot: "$BROKER_HOME",
         fullAccessDisabled: true,
         confinementProbe: { verified: true, evidence: "<probe record>" }
       } }
  5. Keep danger-full-access sessions and these credentials mutually exclusive.
EOF
