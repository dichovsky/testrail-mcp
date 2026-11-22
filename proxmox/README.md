# Proxmox VE container

A self-hosted [community-scripts](https://community-scripts.org/docs) CT script that creates a Debian 13 LXC running the TestRail MCP server. The server stays a stdio server. MCP clients start it over SSH, one process for each connection. The TestRail credentials are in the container instead of on each workstation.

This script is not part of the community-scripts catalog. It loads the [Core](https://github.com/community-scripts/core) engine of community-scripts from `core@main`, as their own scripts do.

## Create the container

Run on the Proxmox VE host shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dichovsky/testrail-mcp/main/proxmox/ct/testrail-mcp.sh)"
```

Defaults: 1 CPU, 1 GB RAM, 4 GB disk, unprivileged. Core's wizard can change them. Each connection runs its own server process of about 140 MB. If more than a few clients connect at the same time, raise the RAM. Core asks once for each host whether to send install diagnostics. Core keeps the answer in `/usr/local/community-scripts/diagnostics` on the host.

To try a branch, set both the script and Core's script root to that branch. The container's `update` keeps using that branch.

```bash
B=my-branch; COMMUNITY_SCRIPTS_URL="https://raw.githubusercontent.com/dichovsky/testrail-mcp/$B/proxmox" bash -c "$(curl -fsSL "https://raw.githubusercontent.com/dichovsky/testrail-mcp/$B/proxmox/ct/testrail-mcp.sh")"
```

## Configure it

In the container (`pct enter <ctid>`):

1. Set the variables in `/etc/testrail-mcp/env`. They are the variables in [Configure](../README.md#configure). Keep each value in single quotes. An empty required value stops the server. The message names the variable.
2. Add one public key for each client to `/etc/testrail-mcp/authorized_keys`. Use a key that you made only for this. Whoever holds the key can call every tool, deletes included.
3. Note the host key fingerprint: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

The `testrail-mcp` account accepts public keys only. It cannot open a shell, a TTY or a forwarded port. Every SSH session runs the server. To connect once and check the configuration, run this command on the client machine. Accept the host key only if its fingerprint matches:

```bash
ssh -T -o IdentitiesOnly=yes -i ~/.ssh/testrail-mcp testrail-mcp@<container-ip> </dev/null
```

If every setting is present and well formed, the command exits 0 after a few JSON diagnostic lines on stderr. Otherwise, the command names the missing or invalid variable on stderr. The command does not contact TestRail. Thus, a wrong API key appears only on the first tool call.

## Connect a client

Use `ssh` as the server command. No `env` block is needed, because the container supplies the settings. `BatchMode=yes` makes a missing key or unknown host fail instead of waiting for a prompt that the client cannot show. Thus, the key needs no passphrase, or you must load the key in `ssh-agent`. `IdentitiesOnly=yes` stops ssh from offering other agent keys first and running out of attempts.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "testrail": {
      "type": "stdio",
      "command": "ssh",
      "args": ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", "~/.ssh/testrail-mcp", "testrail-mcp@<container-ip>"],
      "timeout": 120000
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.testrail]
command = "ssh"
args = ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", "~/.ssh/testrail-mcp", "testrail-mcp@<container-ip>"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

## What changes compared with a local server

- **One TestRail identity.** Everyone whose key is listed acts as the TestRail user in the env file, with that user's permissions. Give that user only the permissions the clients need.
- **Files are the container's.** Upload tools read container directories. Thus, uploads are off (`[]`) until you create a dedicated directory and list it. Never list `/`, `/etc`, `/proc` or `/var/lib/testrail-mcp`. Anything under an upload root can be sent to TestRail, the env file included. The server writes downloads to `/var/lib/testrail-mcp/downloads`, and nothing removes them.
- **Disconnects end the server.** Closing the SSH connection closes stdin. The server shuts down as it does locally. sshd drops a client that stops answering within about three minutes. A write that the server already sent when the connection drops may still be applied.

## Update

Debian's security updates install automatically every day through `unattended-upgrades`. Run `update` in the container to provision Node.js 26 and install the latest npm release of `@dichovsky/testrail-mcp`. Before they invoke npm, the installer and the updater check the Node executable on their PATH. They also enforce the Node engine requirement of the package. Open sessions keep their old server process until they reconnect.

To roll back the package, run `npm install -g --ignore-scripts --engine-strict @dichovsky/testrail-mcp@1.0.0` inside the container. Then reconnect. The 1.0.0 package runs on Node 26 as well as Node 24. Use the current bootstrap script when installing or upgrading a container for 2.0.0.

### Release rehearsal

Before you publish 2.0.0, use disposable Debian 13 containers to exercise these operations:

- a fresh install;
- an update from Node 24 and TestRail MCP 1.0.0;
- the exact 1.0.0 rollback.

Use a disposable registry that serves the qualified 2.0.0 tarball as `latest` until public npm has the release. After each operation, open a new forced-SSH MCP session against the fixture. Check the advertised server version of the session. Verify the Node executable that the running process uses. Confirm that the authorized keys, the environment configuration and an existing completed download survive the upgrade and the rollback.
