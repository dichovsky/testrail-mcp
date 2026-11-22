#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/dichovsky/testrail-mcp/main/proxmox"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

# Copyright (c) 2026 Igor Magdich
# Author: Igor Magdich (dichovsky)
# License: MIT | https://github.com/dichovsky/testrail-mcp/raw/main/LICENSE
# Source: https://github.com/dichovsky/testrail-mcp

APP="TestRail-MCP"
var_tags="${var_tags:-mcp;testrail}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -f /usr/local/bin/testrail-mcp-ssh ]]; then
    msg_error "No TestRail MCP Installation Found!"
    exit
  fi

  # Only the install script writes the system setup (SSH wrapper, sshd drop-in,
  # security upgrades). Repeat any change to it here, or existing containers keep
  # the old setup.
  ensure_dependencies unattended-upgrades
  systemctl enable -q --now apt-daily.timer apt-daily-upgrade.timer

  if ! NODE_VERSION="26" setup_nodejs; then
    msg_error "Node.js 26 setup failed."
    exit 1
  fi
  hash -r
  if ! node -e 'if (process.versions.node.split(".")[0] !== "26") process.exit(1)'; then
    msg_error "Node.js 26 is required in PATH before updating TestRail MCP."
    exit 1
  fi

  msg_info "Updating TestRail MCP"
  $STD npm install -g --ignore-scripts --engine-strict @dichovsky/testrail-mcp@latest
  msg_ok "Updated TestRail MCP"
  msg_ok "Updated successfully! Open SSH sessions keep the old version until they reconnect."
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}TestRail MCP setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Inside the container, set the TestRail credentials in /etc/testrail-mcp/env${CL}"
echo -e "${INFO}${YW}and add each client's SSH public key to /etc/testrail-mcp/authorized_keys.${CL}"
echo -e "${INFO}${YW}MCP clients then start the server with:${CL}"
echo -e "${GATEWAY}${BGN}ssh -T testrail-mcp@${IP}${CL}"
