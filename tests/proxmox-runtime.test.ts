import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const paths = {
  install: 'proxmox/install/testrail-mcp-install.sh',
  update: 'proxmox/ct/testrail-mcp.sh',
} as const;

const coreStub = String.raw`
STD=''
header_info() { :; }
variables() { :; }
color() { :; }
catch_errors() { set -e; }
check_container_storage() { :; }
check_container_resources() { :; }
start() { update_script; }
verb_ip6() { :; }
setting_up_container() { :; }
network_check() { :; }
update_os() { :; }
ensure_dependencies() { :; }
systemctl() { :; }
apt() { :; }
msg_info() { :; }
msg_ok() { :; }
msg_error() { printf '%s\n' "$*" >&2; }
useradd() { :; }
install() { :; }
chown() { :; }
chmod() { :; }
motd_ssh() { :; }
customize() { :; }
cleanup_lxc() { :; }
setup_nodejs() {
  printf 'setup %s\n' "$NODE_VERSION"
  test "$FIXTURE_SETUP" = success
}
node() {
  printf 'node %s\n' "$FIXTURE_NODE_VERSION"
  test "$1" = -e
  "$FIXTURE_NODE" -e '
    Object.defineProperty(process.versions, "node", { value: process.env.FIXTURE_NODE_VERSION });
    eval(process.argv[1]);
  ' -- "$2"
}
npm() { printf 'npm %s\n' "$*"; }
`;

async function run(path: string, nodeVersion: string, setup: 'success' | 'failure') {
  const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-proxmox-'));
  try {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    let output = 0;
    // Redirect only the container-owned paths. Core and every privileged command are stubs.
    const isolated = source
      .replace('[[ ! -f /usr/local/bin/testrail-mcp-ssh ]]', '[[ ! -f "$FIXTURE_ROOT/installed" ]]')
      .replace(/^cat <<'EOF' >.+$/gmu, () => `cat <<'EOF' >"$FIXTURE_ROOT/output-${String(output += 1)}"`);
    const script = join(directory, 'testrail-mcp.sh');
    await mkdir(join(directory, 'core'));
    await Promise.all([
      writeFile(script, isolated),
      writeFile(join(directory, 'installed'), ''),
      writeFile(join(directory, 'core', 'build.func'), coreStub),
    ]);
    return spawnSync('bash', [script], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5_000,
      env: {
        PATH: process.env.PATH, COMMUNITY_SCRIPTS_CORE_DIR: directory, FUNCTIONS_FILE_PATH: coreStub,
        FIXTURE_ROOT: directory, FIXTURE_NODE_VERSION: nodeVersion, FIXTURE_NODE: process.execPath, FIXTURE_SETUP: setup,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('the Proxmox runtime check', () => {
  describe.each(Object.entries(paths))('%s', (_path, path) => {
    it('installs under Node 26 with strict npm engine validation', async () => {
      const result = await run(path, '26.13.1', 'success');
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        'setup 26',
        'node 26.13.1',
        'npm install -g --ignore-scripts --engine-strict @dichovsky/testrail-mcp@latest',
      ]);
    });

    it('stops before npm if the setup leaves Node 24 on PATH', async () => {
      const result = await run(path, '24.19.0', 'success');
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain('Node.js 26 is required in PATH');
      expect(result.status).toBe(1);
      expect(result.stdout.trim().split('\n')).toEqual(['setup 26', 'node 24.19.0']);
    });

    it('stops before npm if Core fails provisioning', async () => {
      const result = await run(path, '26.13.1', 'failure');
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain('Node.js 26 setup failed');
      expect(result.status).toBe(1);
      expect(result.stdout.trim().split('\n')).toEqual(['setup 26']);
    });
  });
});
