# SSH remote environments: guide for all three custody modes

中文: [ssh-remote-environments.md](./ssh-remote-environments.md)

SSH remote environments let the Agent access directories on remote hosts through the explicit `remote_copy` (file transfer) and `remote_bash` (command execution) tools. The feature is **experimental and off by default**, and offers three credential-custody modes with increasing isolation: **Personal (`personal`)**, **Team (`team`)**, and **Hardened (`hardened`)**.

> [!WARNING]
> **Platform and release prerequisites**:
> - Supported on **Linux** and **macOS** initiators only, targeting **Linux** or **macOS** remote hosts (Windows initiators and Windows targets are deferred / unsupported).
> - Requires a DSH runtime inside the SSH support matrix (currently `0.2.2-rc.1` through `0.2.2-rc.5`) with the four matching official SSH optional packages installed (`@deepseek-ai/dsh-ssh`, `dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`).

---

## 1. Comparing the three modes

| Dimension | Personal (`personal`, default) | Team (`team`) | Hardened (`hardened`) |
| --- | --- | --- | --- |
| **Who holds credentials** | The local DSH Host process | A Broker daemon under a dedicated OS account | A Broker daemon under a dedicated OS account |
| **Isolation guarantee** | **No promise** the Agent cannot reach the keys; same-UID processes can touch credentials | Relaxed deployment proof; the Broker protects keys from confined processes, though a `danger-full-access` process under the same UID can still connect to the Broker socket | **Full isolation proof**: the only mode claiming the Agent cannot reach keys; forbids `danger-full-access` and enforces `remote-profile-guard` |
| **Configuration source** | Interactive panel GUI (user-owned personal config file) | Root-protected deployment manifest + Broker fields entered in the UI (or profile config) | Root-protected deployment manifest and dedicated profile config only (read-only in the UI) |
| **Copy destination rule** | No chroot required; pull only or push to directories you own | `import` write destinations must be SFTP accounts declaring `destinationIsolation: "chroot-sftp"` (no independent-writer check) | Must satisfy `chroot-sftp` AND the destination account must not share `namespace + account` with any helper/exec environment |
| **Quotas / audit / revocation** | No Broker enforcement | Supports manifest `quotas`, `revocations`, and Broker audit logs | Full manifest `quotas`, `revocations`, Broker audit logs, and entry-isolation probe |
| **Suited to** | Personal machines, throwaway VMs, trusted Agents | Shared build machines with ops support without locking down every profile globally | Untrusted workloads or strict production isolation |

### Shared guardrails across all three modes

Regardless of which mode you choose:

1. Remote directories are **not** local additional roots: they are reachable only through explicit `remote_copy` / `remote_bash` calls and never enter the local file tree, LSP, or instruction injection.
2. Every call goes through two-phase Registry admission (preparation + pre-launch/pre-publish recheck).
3. In a `read-only` session, remote writes, remote commands, and transfers targeting a remote destination are refused.
4. A remote binding must be **registered** for the workspace before the model can use it; file publishing stages to a temporary file, verifies, and hardlinks without overwriting existing files.

---

## 2. Enabling the feature and switching modes

1. Open sidebar **Plugins** → **Multi-root Workspace** detail page.
2. On the settings card, turn on **SSH remote environments** (marked with a warning **Experimental** tag).
3. Read the risk confirmation dialog, check the acknowledgment box, and click **Confirm and enable** (cancelling keeps it off).
4. Open the management UI from either entry point:
   - **Plugin detail page**: once enabled, a **Remote SSH → Manage** button appears at the top of the card (works without an active session; manages global connections and mode, but cannot edit workspace bindings).
   - **Workspace Folders dialog**: click **Folders** at the bottom of the sidebar (or the New Session hero entry) → under **Remote working directories**, click **Manage SSH remotes…**.
5. Switch to the **Mode** tab and choose **Personal (default)**, **Team**, or **Hardened**.
   - **Note**: switching to a lower-isolation mode while the feature is enabled (e.g., `Hardened → Team` or `Team → Personal`) triggers another risk confirmation dialog.

---

## 3. Personal mode: setup and usage

Personal mode is configured entirely in the GUI and requires no root privileges, dedicated OS account, or deployment manifest.

### Step 1: Prepare credentials (pick one)

- **Option A: Use an existing `~/.ssh/config` host alias**
  - Ensure your `~/.ssh/config` has a `Host <alias>` block (`HostName`, `User`, `IdentityFile`, etc.) and that your `~/.ssh/known_hosts` contains **exactly one** matching host key entry.
- **Option B: Use plugin-managed credentials**
  1. In **SSH remotes**, open the **SSH keys** tab (or click **Manage credentials** while adding a connection).
  2. Create a credential using one of three forms:
     - **Generate key**: enter a label; the plugin generates an ed25519 keypair. Click the copy-public-key icon on the row and append it to `~/.ssh/authorized_keys` on the remote host.
     - **Import private key**: enter a label and paste the private key (provide the passphrase if encrypted; it is stripped on import and stored mode `0600` inside the credential root). Ensure the corresponding public key is authorized on the remote host.
     - **Save password**: enter a label and password. In the next step, the plugin logs in once with the password to append a per-environment access key to the remote `authorized_keys`, after which all connections use key auth.

### Step 2: Add a connection

1. Open the **Connections** tab and click **Add connection**.
2. **Step 1 (Connection and host key)**:
   - Choose **SSH host alias** or **Managed credential**, fill in display name, remote platform (`Linux` / `macOS`), and `user@hostname:port` (when using an alias, host/port/user are resolved automatically by `ssh -G` during scanning).
   - Click **Scan and test connection**, inspect the fingerprint in the confirmation modal, and click **Confirm and save**.
3. **Step 2 (Connection setup)**:
   - **Password credentials**: click **Install access key** first so the plugin logs in once with the saved password and installs the access key.
   - **Linking managed config**: if prompted that the config is not linked, click **Link ~/.ssh/config**. The plugin backs up your existing `~/.ssh/config` and prepends a single `Include` line so the managed host alias resolves (required before connecting).
   - **Install helper** (recommended; required for command execution and object-identity verification): optionally click **Detect Node**, then click **Install helper**. The plugin installs the exact host-matching `@deepseek-ai/dsh-ssh` version under `~/.dsh-helper/<version>` and verifies the `helper.js` SHA-256 against the host copy (requires Node.js on the remote host with `command -v node` resolving to an absolute path).
   - Check **Allow command execution** (requires the helper) and/or **Allow file transfer**, then click **Finish**.

### Step 3: Bind a directory to the workspace and register

Connections are plugin-global, while directory bindings belong to each workspace. **This step requires the Workspace Folders panel with an active session**:

1. Open **Folders** from the sidebar and click **Manage remote Root bindings** in the **Remote working directories** section.
2. Click **Add binding**:
   - Pick an existing SSH connection.
   - Enter a normalized absolute POSIX path (for example `/srv/work/app`), or click **Browse…** to pick a directory over read-only SFTP.
   - Check **Allowed actions**: `read`, `write`, `execute` (`execute` requires a connection with the helper installed and exec enabled).
   - If using `remote_copy` between local and remote roots, check **Import from local root** / **Export to local root** for `primary` or any available additional root.
   - Click **Save binding**.
3. Back in the **Workspace folders** dialog under **Remote working directories**, open the row's **…** menu and click **Register**.
   - Registration connects to the remote host to verify the directory exists and is not redirected via symlinks. Once the status shows **Registered**, the endpoint is available to the model.

> [!TIP]
> Before deleting a connection, unbind all workspace bindings referencing it (`environment-in-use` otherwise). If editing permissions or updating the connection marks an endpoint **Withheld**, click **Register** again from the `…` menu.

---

## 4. Team mode: setup and usage

Team mode uses an administrator-provisioned **Credential Broker** daemon and a root-protected deployment manifest, while **relaxing** three hardened requirements: it does not require globally forbidding `danger-full-access` across profiles, does not require a `confinementProbe` record, and does not forbid sharing `namespace + account` between a `chroot-sftp` copy destination and an exec/helper environment.

> [!NOTE]
> Team and Hardened modes require **Linux** or **macOS** to run the Broker (POSIX hosts only).

### Step 1: Author the root-protected deployment manifest (admin)

Unlike Personal mode, Team mode does not create connections in the UI. An administrator writes the manifest as `root` (default `/etc/dsh-ssh-broker/manifest.json`; the file and **every ancestor directory** must be owned by `root`, not group/world-writable, not symlinks, and outside any bound local primary):

```json
{
  "schemaVersion": 1,
  "configVersion": "2026-11-21.1",
  "environments": [
    {
      "environmentId": "team-build-01",
      "displayName": "Shared Build VM",
      "platform": "linux",
      "account": "dshbuild",
      "hostKey": "SHA256:<43-char-base64-host-key-fingerprint>",
      "namespace": "team-build-01",
      "transport": "helper",
      "helper": {
        "sha256": "<64-hex-sha256-of-remote-helper.js>",
        "protocol": 3
      },
      "connection": {
        "host": "team-build-alias",
        "nodePath": "/opt/node-v24/bin/node",
        "helperPath": "/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
        "workspace": "/srv/work/project"
      },
      "exec": {
        "shell": ["/bin/bash", "-c"],
        "env": { "PATH": "/usr/local/bin:/usr/bin:/bin" },
        "maxTimeoutMs": 60000,
        "stdoutLimit": 65536,
        "stderrLimit": 65536,
        "terminateGraceMs": 2000
      },
      "transfer": {
        "maxBytes": 268435456,
        "timeoutMs": 600000
      },
      "credentialIsolation": "attested"
    },
    {
      "environmentId": "team-sftp-dest",
      "displayName": "Chroot SFTP Drop",
      "platform": "linux",
      "account": "dshxfer",
      "hostKey": "SHA256:<43-char-base64-host-key-fingerprint>",
      "namespace": "team-sftp-dest",
      "transport": "sftp",
      "helper": null,
      "connection": { "host": "team-sftp-alias" },
      "transfer": {
        "maxBytes": 268435456,
        "timeoutMs": 600000,
        "destinationIsolation": "chroot-sftp"
      },
      "credentialIsolation": "attested"
    }
  ],
  "bindings": [
    {
      "primary": "/path/to/local/workspace",
      "environmentId": "team-build-01",
      "rootId": "app",
      "path": "/srv/work/project/app",
      "actions": ["read", "write", "exec"],
      "transfers": [
        { "direction": "export", "peer": { "environmentId": "local", "rootId": "primary" } },
        { "direction": "export", "peer": { "environmentId": "team-sftp-dest", "rootId": "out" } }
      ]
    },
    {
      "primary": "/path/to/local/workspace",
      "environmentId": "team-sftp-dest",
      "rootId": "out",
      "path": "/out",
      "actions": ["read", "write"],
      "transfers": [
        { "direction": "import", "peer": { "environmentId": "team-build-01", "rootId": "app" } }
      ]
    }
  ]
}
```

**Team manifest rules to note**:

- **Copy destination isolation**: any binding that includes `write` and has an `import` transfer pair (pushing files into that remote directory) **must** use `"transport": "sftp"` with `"destinationIsolation": "chroot-sftp"` (backed by real SSH `ChrootDirectory` + `internal-sftp` on the server).
- **Team relaxation**: if `team-sftp-dest` shares `namespace` and `account` with an exec/helper environment, Team mode allows it (though separate accounts are still recommended). If you only need remote execution or exporting (`export`) from the remote host to local, only the `helper` environment is required.
- **Output limit**: under Broker custody, `exec.stdoutLimit` and `exec.stderrLimit` must be at most `131072` (128 KiB).
- **`credentialIsolation`**: every Broker-served environment must declare `"attested"`.

### Step 2: Install a standalone dependency tree and provision the Broker (admin)

The Broker must run from its own root-protected dependency tree (never shared with the DSH Host or Agent), then be provisioned via the packaged `install.sh`:

```sh
# 1. Install an isolated root-owned tree (exact DSH release match, e.g. 0.2.2-rc.5)
mkdir -p /opt/dsh-broker && cd /opt/dsh-broker
pnpm init
pnpm add --save-exact /path/to/dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz \
  @deepseek-ai/dsh@0.2.2-rc.5 @deepseek-ai/cordis@4.1.0 \
  @deepseek-ai/dsh-ssh@0.2.2-rc.5 @deepseek-ai/dsh-fs-ssh@0.2.2-rc.5 \
  @deepseek-ai/dsh-subprocess-ssh@0.2.2-rc.5 @deepseek-ai/dsh-sandbox-ssh@0.2.2-rc.5
chown -R root:root /opt/dsh-broker && chmod -R a-w /opt/dsh-broker

# 2. Provision the dedicated account (_dsh_ssh), client group, 0700 credential root, and systemd/launchd service
#    Replace <dsh-host-user> with the non-root user running DSH; on macOS, Node must not sit under /Users/*
sudo DSH_SSH_BROKER_JS=/opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/lib/remote-broker.js \
     DSH_SSH_BROKER_MANIFEST=/etc/dsh-ssh-broker/manifest.json \
     DSH_SSH_BROKER_NODE=/usr/local/bin/node \
     /opt/dsh-broker/node_modules/@dsh-electron/dsh-plugin-multi-root-workspace/scripts/ssh-broker/install.sh <dsh-host-user>
```

> [!TIP]
> Record the **broker UID**, **credential root** (default `/var/lib/dsh-ssh-broker` on Linux, `/usr/local/var/dsh-ssh-broker` on macOS), **socket path** (default `/run/dsh-ssh-broker/broker.sock` on Linux, `/usr/local/var/run/dsh-ssh-broker/broker.sock` on macOS), and the printed public key. If `install.sh` added your Host user to a new group (`dsh-ssh-clients`), **re-login or restart DSH** so the group membership takes effect.

### Step 3: Configure Broker SSH files and authorize keys

1. Authorize the Broker's public key in the remote target account's `~/.ssh/authorized_keys`.
2. For `helper` environments, pre-install the exact Host-matching `@deepseek-ai/dsh-ssh` at `connection.helperPath` on the remote host and record its `helper.js` SHA-256 in the manifest.
3. Configure `~/.ssh/config` (`0600`, owned by the Broker user) and out-of-band verified `known_hosts` (`0600`) under the Broker home directory. All of the security directives below are strictly enforced by `ssh -G` checks:

```sshconfig
Host team-build-alias
  HostName <fixed-hostname>
  User dshbuild
  IdentityFile <broker-owned-key-path>
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
  ForwardAgent no
  UpdateHostKeys no
  UserKnownHostsFile <broker-owned-known_hosts>
  GlobalKnownHostsFile /dev/null
  KnownHostsCommand none
```

### Step 4: Enter Team settings in the UI and use

Unlike Hardened mode, Team mode can be wired directly through the DSH UI without editing profile YAML:

1. Ensure **SSH remote environments** is enabled on the plugin detail page.
2. Open **Folders** → **Manage SSH remotes…** → **Mode** (or **Remote SSH → Manage** on the plugin detail card).
3. Select the **Team** radio button.
4. Fill in the four fields shown below:
   - **Deployment manifest path** (`manifestPath`): e.g. `/etc/dsh-ssh-broker/manifest.json`
   - **Broker socket path** (`socketPath`): e.g. `/run/dsh-ssh-broker/broker.sock` (`/usr/local/var/run/dsh-ssh-broker/broker.sock` on macOS)
   - **Broker user UID** (`brokerUid`): numeric UID printed by `install.sh` (e.g. `996`)
   - **Credential directory** (`credentialRoot`): e.g. `/var/lib/dsh-ssh-broker` (`/usr/local/var/dsh-ssh-broker` on macOS)
5. Click **Save team configuration**.
   - Alternatively, an administrator can set `mode: team` and `team: { manifestPath, socketPath, brokerUid, credentialRoot }` directly in the profile's `cordis.patch.yml` under `multi-root-remote-tools`.
6. Check the **Connections** tab (read-only view of the manifest), then return to **Workspace folders** → **Remote working directories**, open the row's **…** menu, and click **Register**. Once registered, `remote_copy` and `remote_bash` become available to the session's Agent.

---

## 5. Hardened mode: setup and usage

Hardened mode is the only mode that strictly guarantees the **Agent cannot reach SSH credentials or bypass the sandbox to talk to the Broker**. Broker parameters **cannot** be edited from the GUI; they must come from a dedicated, restricted DSH profile accompanied by entry-isolation verification evidence.

### Step 1: Provision Broker and manifest (with independent writers, quotas, audit, and revocations)

1. Complete Steps 1–3 from Team mode (isolated dependency tree, `install.sh`, Broker `~/.ssh/config`, and out-of-band `known_hosts`).
2. **Independent-writer enforcement**: in `manifest.json`, any `sftp` environment serving as an `import` write destination **must not** share `namespace + account` with any `transport: "helper"` or `exec`-capable environment (otherwise `attestBroker` refuses with `destination-isolation-required`).
3. **Optional hardening controls** (recommended for Hardened deployments):
   - `quotas` (top-level global budget and/or `environments[].quotas`): bounds `maxOperations` and `maxBytes` per rolling `windowMs`.
   - `revocations`: explicit deny list `[{ "environmentId": "...", "reason": "..." }]`; once deployed and restarted, all calls to revoked environments fail with `environment-revoked`.
   - Audit logging (`auditPath`, `auditMaxBytes` defaulting to 8 MiB, `auditKeep` defaulting to 4 rotated files) is enabled by default in `/etc/dsh-ssh-broker/broker.json` via `install.sh`.

### Step 2: Eliminate unconfined Agent entry points and run the isolation probe

Under the Host OS user running DSH, **every profile that can host an Agent entry point must exclude `danger-full-access`**, so an Agent cannot switch sessions or spawn unconfined processes to read the credential root or connect to the Broker socket.

1. Audit all profiles and permissions under the Host UID to ensure none permit `danger-full-access`.
2. Run the repository's isolation probe (or equivalent deployment verification) against the provisioned environment:
   - Verify that Agent shell, Agent PTY (`DSH_PTY_SESSION_ID`), and PTC under both `read-only` and `workspace-write` receive `EACCES`/`EPERM` on `credentialRoot` and are refused at `socketPath`.
   - Verify the unconfined Host process itself can connect to `socketPath` and complete the hello handshake.
   - Record the verification reference ID / report (see `scripts/probe-remote-entry-isolation.mjs` and `scripts/ssh-broker/probe/`).

### Step 3: Configure the dedicated restricted profile (`cordis.patch.yml`)

Create a dedicated profile (e.g. `remote-exp`) with its own session store, add the plugin, and configure its `cordis.patch.yml`:

> [!IMPORTANT]
> Profile patch layers replace a row's entire `config` object rather than merging keys. Always restate `sharedStorageRoot` and `leasePath` inside `multi-root-registry`, and provide the complete `broker.config` inside `multi-root-remote-tools`.

```yaml
# 1. Restricted permission presets — never include danger-full-access
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask

# 2. Enable the remote control plane while keeping shared-registry storage config
- id: multi-root-registry
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
    backgroundRecovery: true
    remoteEnvironments:
      enabled: true
      manifestPath: /etc/dsh-ssh-broker/manifest.json

# 3. Explicitly configure hardened mode and attested broker facts
- id: multi-root-remote-tools
  config:
    mode: hardened
    broker:
      config:
        socketPath: /run/dsh-ssh-broker/broker.sock
        brokerUid: 996 # replace with the UID printed by install.sh
        credentialRoot: /var/lib/dsh-ssh-broker
        fullAccessDisabled: true
        confinementProbe:
          verified: true
          evidence: 'deploy-probe-20261121' # replace with your probe record ID
```

- Inspect the composed output to confirm no `danger-full-access` preset exists and the rows resolve properly:
  ```sh
  dsh --profile remote-exp --dump-config
  ```

### Step 4: Launch and use

1. Start DSH with that dedicated profile (ensure it is the only Host holding the `$DSH_HOME` storage lease; if another DSH instance such as Desktop without SSH enabled holds the lease, the UI reports `owner-without-remote-protocol` and that other instance must be quit first).
2. Confirm **SSH remote environments** is enabled on the plugin detail page (if not defaulted on, toggle and confirm the risk prompt); in the **Mode** tab, verify it displays **Hardened** with a read-only notice.
3. Open **Workspace folders** → **Remote working directories**, open the **…** menu on the project's bound row, and click **Register**.
4. Once registered, the model prompt lists the available remote endpoints, and the Agent can invoke:
   - `remote_bash`: run confined commands on registered endpoints authorized for `exec`.
   - `remote_copy`: copy single files without overwriting between a local root and a registered SFTP endpoint, or between two registered SFTP endpoints.

---

## 6. Disabling, manifest updates, and troubleshooting

### Updating manifests or switching modes

- **Personal mode**: edit directly in the GUI; the Host performs CAS (`revision`) atomic writes and reloads in place without disrupting unrelated workspaces. Changes to connection identity or binding permissions mark the binding **Withheld** — click **Register** again in the `…` menu.
- **Team / Hardened mode**: before editing `manifest.json`, rotating keys, or updating `revocations`, turn off **SSH remote environments** in the plugin detail page, wait for in-flight operations to drain, then restart both the Broker service and the DSH Host (Host and Broker verify `manifestDigest` at handshake and reject mismatches).

### Common errors and diagnostics

- **`owner-without-remote-protocol`**: another DSH instance without the SSH remote plane enabled (for example, an unpatched Desktop instance) holds the `$DSH_HOME` storage lease. Quit that instance and refresh.
- **`endpoint-unverifiable`**: `multi-root-remote-tools` did not mount the verifier and tools. In Team/Hardened modes, check the Host logs for `credential broker is unavailable (<code>)` (common codes: `credentials-readable`, `broker-same-uid`, `confinement-unproven`, `destination-isolation-required`, `manifest-mismatch`, `socket-missing`).
- **`ssh-config-not-linked`** (Personal mode): a managed credential environment exists, but the generated config is not yet linked into `~/.ssh/config`. Click **Link ~/.ssh/config** in the **Connections** tab.
- **`unknown` result with `reconcileId`**: connection dropped after a remote command started or after sending a file publish request. Tools never auto-retry to avoid duplicate execution or overwrites; reconcile on the remote host or in the Broker audit log using `reconcileId`.

For protocol schemas, full refusal codes, and architectural invariants, see the [SSH remote environments reference](../../reference/ssh-remote-environments.md) and the [control plane reference](../../reference/multi-environment-control-plane.md).
