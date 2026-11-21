# Personal SSH remote environments

中文: [ssh-remote-environments.md](./ssh-remote-environments.md)

Personal SSH is experimental and off by default. Once enabled, the Agent can use `remote_copy` and `remote_bash` on registered remote directories. The local DSH Host holds the SSH credentials, which processes running as the same OS user may be able to access.

> [!WARNING]
> **Platform and release prerequisites**:
> - Supported on **Linux** and **macOS** initiators only, targeting **Linux** or **macOS** remote hosts (Windows initiators and Windows targets are deferred / unsupported).
> - Requires a DSH runtime inside the SSH support matrix (currently `0.2.2-rc.1` through `0.2.2-rc.5`) with the four matching official SSH optional packages installed (`@deepseek-ai/dsh-ssh`, `dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`).

## Remote access boundaries

1. The model accesses remote directories through explicit `remote_copy` and `remote_bash` calls.
2. Every call goes through two-phase Registry admission (preparation + pre-launch/pre-publish recheck).
3. In a `read-only` session, remote writes, remote commands, and transfers targeting a remote destination are refused.
4. A remote binding must be **registered** for the workspace before the model can use it; file publishing stages to a temporary file, verifies, and hardlinks without overwriting existing files.

## Enabling personal SSH

1. Open sidebar **Plugins** → **Multi-root Workspace** detail page.
2. On the settings card, turn on **SSH remote environments** (marked with a warning **Experimental** tag).
3. Read the risk confirmation dialog, check the acknowledgment box, and click **Confirm and enable** (cancelling keeps it off).
4. Open the management UI from either entry point:
   - **Plugin detail page**: once enabled, a **Remote SSH → Manage** button appears at the top of the card (manages global connections without an active session).
   - **Workspace Folders dialog**: click **Folders** at the bottom of the sidebar (or the New Session hero entry) → under **Remote working directories**, click **Manage SSH remotes…**.

## Setting up connections and bindings

Personal mode is configured entirely in the GUI and requires no root privileges, dedicated OS account, or deployment manifest.

### Step 1: Prepare credentials (pick one)

- **Option A: Use an existing `~/.ssh/config` host alias**
  - Ensure your `~/.ssh/config` has a `Host <alias>` block (`HostName`, `User`, `IdentityFile`, etc.) and that your `~/.ssh/known_hosts` contains **exactly one** matching host key entry.
- **Option B: Use plugin-managed credentials**
  1. In **SSH settings**, select **SSH keys** in the sidebar (or click **Manage credentials** while adding a connection).
  2. Click **Add credential** and choose a method:
     - **Generate key**: enter a label; the plugin generates an ed25519 keypair. Click the **Copy public key** icon on the credential card and append it to `~/.ssh/authorized_keys` on the remote host.
     - **Import private key**: enter a label and paste the private key (provide the passphrase if encrypted; it is stripped on import and stored mode `0600` inside the credential root). Ensure the corresponding public key is authorized on the remote host.
     - **Save password**: enter a label and password. In the next step, the plugin logs in once with the password to append a per-environment access key to the remote `authorized_keys`, after which all connections use key auth.

### Step 2: Add a connection

1. Select **Remote connections** in the sidebar and click **Add connection** below the list.
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
   - If using `remote_copy` between local and remote roots, check **Allow copying files to the remote host** / **Allow copying files to the local machine** for `primary` or any available additional root.
   - Click **Save binding**.
3. Back in the **Workspace folders** dialog under **Remote working directories**, open the row's **…** menu and click **Register**.
   - Registration connects to the remote host to verify the directory exists and is not redirected via symlinks. Once the status shows **Registered**, the endpoint is available to the model.

> [!TIP]
> Before deleting a connection, unbind all workspace bindings referencing it (`environment-in-use` otherwise). If editing permissions or updating the connection marks an endpoint **Withheld**, click **Register** again from the `…` menu.

## Disabling SSH and troubleshooting

Turn off **SSH remote environments** in the plugin settings to shut down the remote tools and control plane. To reuse a profile from an earlier broker experiment, see the [configuration migration notes](../../reference/ssh-remote-environments.md#停用的旧配置).

### Common errors and diagnostics

- **`owner-without-remote-protocol`**: another DSH instance without the SSH remote plane enabled (for example, an unpatched Desktop instance) holds the `$DSH_HOME` storage lease. Quit that instance and refresh.
- **`endpoint-unverifiable`** — Check that the Host uses a supported DSH release and has all four matching SSH packages installed.
- **`ssh-config-not-linked`** (Personal mode): a managed credential environment exists, but the generated config is not yet linked into `~/.ssh/config`. Click **Link ~/.ssh/config** under **Remote connections**.
- **`unknown` result with `reconcileId`**: connection dropped after a remote command started or after sending a file publish request. Tools never auto-retry to avoid duplicate execution or overwrites; reconcile on the remote host or in the Broker audit log using `reconcileId`.

For protocol schemas, full refusal codes, and architectural invariants, see the [SSH remote environments reference](../../reference/ssh-remote-environments.md) and the [control plane reference](../../reference/multi-environment-control-plane.md).
