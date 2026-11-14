#!/usr/bin/env bash

# Copyright (c) 2026 Igor Magdich
# Author: Igor Magdich (dichovsky)
# License: MIT | https://github.com/dichovsky/testrail-mcp/raw/main/LICENSE
# Source: https://github.com/dichovsky/testrail-mcp

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt install -y openssh-server
msg_ok "Installed Dependencies"

NODE_VERSION="24" setup_nodejs

msg_info "Installing TestRail MCP"
$STD npm install -g --ignore-scripts @dichovsky/testrail-mcp@latest
msg_ok "Installed TestRail MCP"

msg_info "Configuring TestRail MCP"
# A key-only account: '*' matches no password, and sshd forces every session
# into the server, so the account never gets a shell. /bin/sh (dash) reads no
# startup files for `sh -c`, so nothing but protocol messages reaches stdout.
useradd --system --no-create-home --home-dir /var/lib/testrail-mcp --shell /bin/sh --password '*' testrail-mcp
# Root owns the home and the key file, so the server process cannot add keys.
install -d -m 0755 /var/lib/testrail-mcp
install -d -m 0750 -o testrail-mcp -g testrail-mcp /var/lib/testrail-mcp/downloads
install -d -m 0750 -g testrail-mcp /etc/testrail-mcp
install -m 0640 -g testrail-mcp /dev/null /etc/testrail-mcp/authorized_keys

cat <<'EOF' >/etc/testrail-mcp/env
# TestRail MCP settings, loaded for every SSH session by /usr/local/bin/testrail-mcp-ssh.
# Shell syntax: keep each value in single quotes. Variable reference:
# https://github.com/dichovsky/testrail-mcp#configure
TESTRAIL_BASE_URL=''
TESTRAIL_EMAIL=''
TESTRAIL_API_KEY=''
# Clients' files are not visible in this container, so uploads are off. To allow
# them, create a dedicated directory first and list it: '["/srv/testrail-uploads"]'.
# Never list /, /etc, /proc or /var/lib/testrail-mcp: anything under a root can be
# uploaded to TestRail, this file included.
TESTRAIL_MCP_UPLOAD_ROOTS='[]'
TESTRAIL_MCP_DOWNLOAD_DIR='/var/lib/testrail-mcp/downloads'
# TESTRAIL_ALLOW_PRIVATE_HOSTS='true'
# TESTRAIL_ALLOW_INSECURE='true'
# TESTRAIL_MCP_LIMITS='{"max_all_items": 5000}'
EOF
chown root:testrail-mcp /etc/testrail-mcp/env
chmod 0640 /etc/testrail-mcp/env

cat <<'EOF' >/usr/local/bin/testrail-mcp-ssh
#!/bin/sh
set -eu
set -a
. /etc/testrail-mcp/env
set +a
exec testrail-mcp
EOF
chmod 0755 /usr/local/bin/testrail-mcp-ssh

cat <<'EOF' >/etc/ssh/sshd_config.d/testrail-mcp.conf
# The testrail-mcp account can only run the TestRail MCP server over stdio.
Match User testrail-mcp
	AuthorizedKeysFile /etc/testrail-mcp/authorized_keys
	AuthenticationMethods publickey
	ForceCommand /usr/local/bin/testrail-mcp-ssh
	DisableForwarding yes
	PermitTTY no
	PermitTunnel no
	PermitUserRC no
	ClientAliveInterval 60
EOF
# ssh.service validates the configuration (sshd -t) before it starts.
systemctl enable -q ssh
systemctl restart ssh
msg_ok "Configured TestRail MCP"

motd_ssh
customize
cleanup_lxc
