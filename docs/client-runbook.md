# R02 runbook: Codex desktop, Codex CLI and Copilot CLI

These are step-by-step instructions for running scenarios C01 to C12 on the three hosts that have no record yet. The Claude Code record was made with the same prompts. You run the hosts and send the raw output back; the records in [`docs/evidence/clients/`](evidence/clients/) are then written from it. The whole run uses the [fixture stand-in](client-compatibility.md#the-fixture-backed-kit): no TestRail account and no real credentials. Expect about an hour per host.

| Host | Configuration it reads | How the variables reach the server |
| --- | --- | --- |
| Codex CLI | `~/.codex/config.toml` | `env_vars`, forwarded from the shell you start `codex` in, as the [guide](client-compatibility.md#codex-desktop-and-cli) documents |
| Codex desktop | the same `~/.codex/config.toml` | an `env` table with the stand-in's synthetic values, because a desktop app does not inherit a terminal's variables |
| Copilot CLI | `~/.copilot/mcp-config.json` | the `env` map with `${VAR}` references, as the [guide](client-compatibility.md#github-copilot-cli) documents |

## 1. Set up once

You need Node 24, git, and each host installed and signed in. The commands are for macOS or Linux; the Windows equivalents follow them.

```bash
export R2="$HOME/r02"                      # everything for this run lives here
git clone https://github.com/dichovsky/testrail-mcp.git "$R2/repo"
cd "$R2/repo"
node -v                                     # must print v24.x
npm ci
mkdir -p "$R2/prefix" "$R2/uploads" "$R2/downloads" "$R2/outside" "$R2/out"
npm pack --json --pack-destination "$R2" > "$R2/out/pack.json"   # builds, packs, records name and integrity
npm install -g --prefix "$R2/prefix" "$R2"/dichovsky-testrail-mcp-*.tgz
printf 'C08 evidence file\nline two\n' > "$R2/uploads/c08-evidence.txt"
printf 'outside\n' > "$R2/outside/secret.txt"
```

On Windows, in PowerShell, use `$env:R2 = "$HOME\r02"` and the same `npm` commands. The installed executable is then `$env:R2\prefix\testrail-mcp.cmd` instead of `$R2/prefix/bin/testrail-mcp`, and `New-Item -ItemType Directory` replaces `mkdir -p`.

Then set the stand-in's variables in every terminal you start a host from. All of these values are synthetic.

```bash
export PATH="$R2/prefix/bin:$PATH"
export TESTRAIL_BASE_URL="http://127.0.0.1:4199"
export TESTRAIL_EMAIL="fixture@example.invalid"
export TESTRAIL_API_KEY="fixture-api-key"
export TESTRAIL_ALLOW_INSECURE=true
export TESTRAIL_ALLOW_PRIVATE_HOSTS=true
export TESTRAIL_MCP_UPLOAD_ROOTS="[\"$R2/uploads\"]"
export TESTRAIL_MCP_DOWNLOAD_DIR="$R2/downloads"
```

## 2. Start the stand-in for each scenario

Keep it running in a terminal of its own. Restart it with a new log name before each scenario, so each scenario's requests stay in their own file. The port is fixed, so the host configuration never changes.

```bash
cd "$R2/repo"
node scripts/fixture-testrail.mjs --port 4199 --pages 3 --log "$R2/out/<host>-<scenario>.jsonl"
```

Use `codex-cli`, `codex-desktop` or `copilot-cli` for `<host>`, and the scenario ID in lower case for `<scenario>`, for example `codex-cli-c04.jsonl`.

## 3. Configure the host

**Codex CLI.** Add this to `~/.codex/config.toml` and keep any other entries. Replace `<R2>` with the absolute path of your run directory.

```toml
[mcp_servers.testrail]
command = "<R2>/prefix/bin/testrail-mcp"
args = []
env_vars = [
  "TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY",
  "TESTRAIL_MCP_UPLOAD_ROOTS", "TESTRAIL_MCP_DOWNLOAD_DIR",
  "TESTRAIL_ALLOW_INSECURE", "TESTRAIL_ALLOW_PRIVATE_HOSTS",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
```

**Codex desktop.** Run it after the Codex CLI. Replace the `env_vars` line with this table, then quit and reopen the app:

```toml
[mcp_servers.testrail.env]
TESTRAIL_BASE_URL = "http://127.0.0.1:4199"
TESTRAIL_EMAIL = "fixture@example.invalid"
TESTRAIL_API_KEY = "fixture-api-key"
TESTRAIL_ALLOW_INSECURE = "true"
TESTRAIL_ALLOW_PRIVATE_HOSTS = "true"
TESTRAIL_MCP_UPLOAD_ROOTS = "[\"<R2>/uploads\"]"
TESTRAIL_MCP_DOWNLOAD_DIR = "<R2>/downloads"
```

**Copilot CLI.** Add this to `~/.copilot/mcp-config.json`, and keep any other servers:

```json
{
  "mcpServers": {
    "testrail": {
      "type": "stdio",
      "command": "<R2>/prefix/bin/testrail-mcp",
      "args": [],
      "tools": ["*"],
      "deferTools": "auto",
      "timeout": 120000,
      "env": {
        "TESTRAIL_BASE_URL": "${TESTRAIL_BASE_URL}",
        "TESTRAIL_EMAIL": "${TESTRAIL_EMAIL}",
        "TESTRAIL_API_KEY": "${TESTRAIL_API_KEY}",
        "TESTRAIL_MCP_UPLOAD_ROOTS": "${TESTRAIL_MCP_UPLOAD_ROOTS}",
        "TESTRAIL_MCP_DOWNLOAD_DIR": "${TESTRAIL_MCP_DOWNLOAD_DIR}",
        "TESTRAIL_ALLOW_INSECURE": "${TESTRAIL_ALLOW_INSECURE}",
        "TESTRAIL_ALLOW_PRIVATE_HOSTS": "${TESTRAIL_ALLOW_PRIVATE_HOSTS}"
      }
    }
  }
}
```

Leave every other host setting at its default: tool approval, tool search and deferral, and output limits. When the host asks to approve a TestRail tool call, approve it, and note that it asked.

## 4. Record the versions

Run this once per host, in the terminal with the variables set, while a stand-in is running:

```bash
cd "$R2/repo"
{ date -u; uname -a; node -v; codex --version; copilot --version; } > "$R2/out/versions.txt" 2>&1
node scripts/catalog-hash.mjs --command "$R2/prefix/bin/testrail-mcp" > "$R2/out/catalog-hash.txt"
```

The catalog hash must show 133 tools and `a423193aa71240cb0cca5bd0ed54c30fdadfdadb3d61ac297a9afb4afd111724` for both eras. Also write down the model each host used (`/model` in both CLIs, the model picker in the desktop app) and the Codex desktop build, from its About window.

## 5. Run the scenarios

Start a new session for every prompt: `/new` in Codex, `/clear` in Copilot CLI, or a new conversation in the desktop app. After each one, save the whole transcript as text. Select everything in the terminal or window and paste it into `$R2/out/<host>-<scenario>.txt`, with a suffix such as `-2` when a scenario has several prompts. For Codex CLI, also keep the session files it writes under `~/.codex/sessions/` for that day. Paste each prompt exactly as written below, replacing `<R2>` with your run directory.

| ID | Do this | Prompt to paste |
| --- | --- | --- |
| C01 | Quit the host completely, then start it. Run `/mcp` and save what it shows. Then send the prompt. For Copilot CLI, do this from a clean configuration (section 6). | `Do not call any tools. Reply with the single word READY.` |
| C02 | Send the first prompt; in a new session, the second. | 1. `Using the TestRail tools, get the TestRail project with ID 1 and tell me its name.` 2. `List the name of every TestRail tool you can access. There should be 133. Do not call any of them; reply with the full list and its count.` |
| C03 | Run all 28 prompts, one session each. Print them with the command below this table. | each `prompt` from the corpus |
| C04 | Two prompts, two sessions. | 1. `Using the TestRail tools, read the first page of test cases in project 1, suite 1. Then tell me: the IDs on this page, the custom fields of the first case with their values, how many cases this page returned, whether TestRail has more cases after this page, and exactly how to get the next page. Quote the pagination information the tool returned.` 2. `Using the TestRail tools, read one page of the TestRail roles. Do not fetch everything. Tell me how many roles this page returned, whether more exist, and exactly how the tool says I can get the rest. Quote the pagination information the tool returned.` |
| C05 | Two prompts. The second takes about a minute. | 1. `Using the TestRail tools, fetch all test cases in project 1 (every page, not just the first). Tell me how many cases you got in total, the first and last case IDs, whether the result says it is complete, and quote its pagination information.` 2. `Using the TestRail tools, fetch all test cases in project 990045 in one call, every page, using the tool's own complete-read mode. Do not retry if it fails. Tell me exactly what the tool returned: whether it succeeded, any error code and reason, how many items or pages it fetched, and whether any partial data came back.` |
| C06 | Two prompts. | 1. `This is a compatibility test of the TestRail tools. Make exactly these three calls, one after another, and report each tool response verbatim (the full text), then say for each whether data came back and whether there was a warning or an error code. Do not retry any call. 1) testrail_get_project with project_id set to the string "seven" (deliberately invalid). 2) testrail_get_project with project_id 990001. 3) testrail_get_project with project_id 990002.` 2. `This is a validation test of the TestRail tools. Make exactly these two calls and report each tool response verbatim. Do not retry or correct them. 1) testrail_get_project with the JSON input {"project_id": "seven"} (project_id is a quoted JSON string on purpose). 2) testrail_get_project with the JSON input {"project_id": 1, "unexpected_flag": true}.` |
| C07 | One prompt. | `This is a compatibility test against a TestRail test fixture, so these writes are safe. Use the TestRail tools to do each of these once, in order, and for each one report the tool's response verbatim and whether it says the write was applied, rejected, or of unknown outcome: 1) add a test case titled "C07 create" to section 1; 2) update case 1 so its title is "C07 update"; 3) in suite 1 of project 1, bulk-update cases 1 and 2 to priority 2; 4) close test run 1; 5) delete test case 1; 6) add a test case titled "C07 rejected" to section 990400; 7) add a test case titled "C07 unknown" to section 990500. Make each call exactly once.` |
| C08 | Send the first prompt. Then quit the host completely, start it again and send the second. Afterwards, save a listing of the downloads: `ls -la "$R2/downloads" > "$R2/out/<host>-c08-downloads.txt"`. | 1. `This is a compatibility test against a TestRail test fixture. Use the TestRail tools for each step, once each, and report every tool response verbatim: 1) attach the file <R2>/uploads/c08-evidence.txt to test case 1; 2) attach the file <R2>/outside/secret.txt to test case 1 (this file is outside the allowed upload folder; report what happens); 3) download attachment 501; 4) download attachment 501 again; 5) download attachment 990404. For each download, say the local path, the attachment ID and the byte count the tool reported.` 2. `This is a compatibility test against a TestRail test fixture. Use the TestRail tools, once each, and report every tool response verbatim: 1) download attachment 501; 2) download attachment 990020 (it is expected to be slow; report whatever the tool returns).` |
| C09 | One prompt. Note what the host does with the large result: whether it truncates it, previews it or saves it to a file. If it saved one, ask in the same session: `Read the complete saved result and tell me the first and last case IDs and the pagination information.` | `This is a compatibility test against a TestRail test fixture. Use the TestRail tools, once each: 1) read one page of test cases in project 990900; 2) read one page of test cases in project 990901; 3) read all test cases in project 990901 using the tool's complete-read mode. For call 1, tell me how many cases came back, the first and last case IDs, and the full pagination information and any warnings, reading the complete result even if it is large. For calls 2 and 3, report the tool response verbatim.` |
| C10 | Three parts. (a) Send the first prompt. (b) Send the second prompt, which checks that capacity comes back. (c) Interrupt: send the third prompt and press Esc (or Ctrl+C once) about 3 seconds after the call starts. Then send `Call testrail_get_project with project_id 1.` in the same session. | (a) `This is a compatibility test against a TestRail test fixture. In ONE single step, issue five testrail_get_project calls in parallel, all with project_id 990020 (they are slow on purpose). Do not retry anything. Then report each of the five tool responses verbatim and how long the step took.` (b) `This is a compatibility test against a TestRail test fixture. Step 1: in ONE single step, issue five testrail_get_project calls in parallel, all with project_id 990020 (slow on purpose). Do not retry them. Step 2: after all five have returned, wait 12 seconds. Step 3: then call testrail_get_project once with project_id 1. Report every tool response verbatim.` (c) `Call testrail_get_project with project_id 990020 and report the response verbatim.` |
| C11 | Quit the host. Check that no server is left: `ps aux \| grep [t]estrail-mcp` (on Windows, `tasklist \| findstr testrail`), and save the output. Start the host, run `/mcp`, and send the C02 first prompt. Repeat once. For Copilot CLI, see section 6. | `Using the TestRail tools, get the TestRail project with ID 1 and tell me its name.` |
| C12 | Add a second server, below, restart the host and run `/mcp`. Then send the prompt. Remove the second server afterwards. | `Two MCP servers are connected. 1) Using the TestRail tools, get TestRail project 1 and tell me its name. 2) Using the filesystem tools, list the files in the allowed directory. 3) Tell me how many tools each MCP server provides and whether any tool names collide.` |

To print the 28 C03 prompts:

```bash
node -e "for (const t of require('./tests/fixtures/clients/c03-corpus.json').tasks) console.log(t.id + ': ' + t.prompt)"
```

Save each C03 transcript as `<host>-c03-<id>.txt`. One stand-in log, `<host>-c03.jsonl`, covers all 28 prompts.

The second server for C12 is the reference filesystem server, pointed at the uploads directory. For Codex:

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "<R2>/uploads"]
```

For Copilot CLI, add it beside `testrail` in `mcpServers`:

```json
"filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "<R2>/uploads"], "tools": ["*"] }
```

## 6. Copilot CLI only

- **C01 cold start.** Copilot CLI can start from a cached tool snapshot, so C01 has to begin with no cache. Move `~/.copilot` aside (`mv ~/.copilot ~/.copilot.r02-backup`), sign in again, and add only the `mcp-config.json` above. Restore your own directory once all scenarios are done.
- **C11 warm start.** Restart Copilot CLI with that configuration kept. Note whether the TestRail tools are listed before live discovery finishes and after it, for example with `/mcp` straight after start and again a few seconds later.
- **C09.** Copilot CLI can move a large tool result into a temporary file and show a preview. If it does, note the file's path and check that the model reads the whole result there.

## 7. Send it back

Your `$R2/out` folder now holds `pack.json`, `versions.txt`, `catalog-hash.txt`, a `.jsonl` stand-in log per scenario and a `.txt` transcript per prompt. Add the Codex CLI session files and any screenshots from Codex desktop. Zip the folder, without `prefix/` or the cloned repository. Then do either of these:

- Upload it to your Google Drive and post its file name here.
- Attach it to a comment on [#23](https://github.com/dichovsky/testrail-mcp/issues/23).

You don't need to redact anything. The credentials are synthetic. Local paths, user names and the stand-in's address are replaced with placeholders when the records are written, and the raw logs are not committed. The records then go through `tests/client-kit.test.ts`, which refuses a record that claims more than its evidence shows.
