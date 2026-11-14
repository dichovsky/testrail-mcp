# Proxmox VE container

A self-hosted [community-scripts](https://community-scripts.org/docs) CT script that creates a Debian 13 LXC running the TestRail MCP server. The server stays a stdio server: MCP clients start it over SSH, one process per connection, and the TestRail credentials live in the container instead of on each workstation.

This script is not part of the community-scripts catalogue. It loads their [Core](https://github.com/community-scripts/core) engine from `core@main`, the same as their own scripts.

## Create the container

Run on the Proxmox VE host shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dichovsky/testrail-mcp/main/proxmox/ct/testrail-mcp.sh)"
```

Defaults: 1 CPU, 1 GB RAM, 4 GB disk, unprivileged. Core's wizard can change them. Each connection runs its own server process of about 140 MB, so raise the RAM for more than a handful of concurrent clients. Core asks once per host whether to send install diagnostics; the answer is kept in `/usr/local/community-scripts/diagnostics` on the host.

To try a branch, point both the script and Core's script root at it. The container's `update` keeps using that branch.

```bash
B=my-branch; COMMUNITY_SCRIPTS_URL="https://raw.githubusercontent.com/dichovsky/testrail-mcp/$B/proxmox" bash -c "$(curl -fsSL "https://raw.githubusercontent.com/dichovsky/testrail-mcp/$B/proxmox/ct/testrail-mcp.sh")"
```

## Configure it

In the container (`pct enter <ctid>`):

1. Fill in `/etc/testrail-mcp/env`. The variables are the ones in [Configure](../README.md#configure); keep each value in single quotes. An empty required value stops the server with a message naming it.
2. Add one public key per client to `/etc/testrail-mcp/authorized_keys`. Use a key made only for this: whoever holds it can call every tool, deletes included.
3. Note the host key fingerprint: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

The `testrail-mcp` account accepts public keys only and cannot open a shell, a TTY or a forwarded port: every SSH session runs the server. From the client machine, connect once, accept the host key only if its fingerprint matches, and check the configuration:

```bash
ssh -T -o IdentitiesOnly=yes -i ~/.ssh/testrail-mcp testrail-mcp@<container-ip> </dev/null
```

It exits 0 when every setting is present and well formed, after a few JSON diagnostic lines on stderr, and otherwise names the missing or invalid variable there. It does not contact TestRail, so a wrong API key shows up only on the first tool call.

## Connect a client

Use `ssh` as the server command. No `env` block is needed: the container supplies the settings. `BatchMode=yes` makes a missing key or unknown host fail instead of waiting for a prompt the client cannot show, so the key needs no passphrase or must be loaded in `ssh-agent`. `IdentitiesOnly=yes` stops ssh offering other agent keys first and running out of attempts.

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
- **Files are the container's.** Upload tools read container directories, so uploads are off (`[]`) until you create a dedicated directory and list it. Never list `/`, `/etc`, `/proc` or `/var/lib/testrail-mcp`: anything under an upload root can be sent to TestRail, the env file included. Downloads are written to `/var/lib/testrail-mcp/downloads`, and nothing removes them.
- **Disconnects end the server.** Closing the SSH connection closes stdin, and the server shuts down as it does locally. sshd drops a client that stops answering within about three minutes. A write already sent when the connection drops may still be applied.

## Update

Run `update` in the container. It installs the latest npm release of `@dichovsky/testrail-mcp`; open sessions keep the old version until they reconnect.
