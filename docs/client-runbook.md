# R02 runbook: Codex desktop, Codex CLI and Copilot CLI

Step-by-step instructions for running scenarios C01 to C12 on the three hosts that have no record yet. The prompts are the ones the Claude Code run used. You run each host and send the raw output back; the records in [`docs/evidence/clients/`](evidence/clients/) are then written from it and checked by `tests/client-kit.test.ts`.

The whole run uses the [fixture stand-in](client-compatibility.md#the-fixture-backed-kit): no TestRail account and no real credentials. It is written for macOS and Linux. Expect about an hour per host.

**Which build to test.** R03 needs client records for the final release candidate. Run this on `main` once it pins the release's driver, and record the commit; section 4 shows how.

| Host | Configuration it reads | How the variables reach the server |
| --- | --- | --- |
| Codex CLI | `~/.codex/config.toml` | `env_vars`, forwarded from the shell you start `codex` in, as the [guide](client-compatibility.md#codex-desktop-and-cli) documents |
| Codex desktop | the same `~/.codex/config.toml` | an `env` table with the stand-in's synthetic values, because a desktop app does not inherit a terminal's variables |
| Copilot CLI | `mcp-config.json` in its configuration directory | the `env` map with `${VAR}` references, as the [guide](client-compatibility.md#github-copilot-cli) documents |

Each host starts the server through `scripts/record-stdio.mjs`. The recorder passes stdio through unchanged and logs every line. That log is the only place the negotiated protocol revision, the host's cancellations and the server's stderr can be read, and each record needs them.

## 1. Set up once

You need Node 24, git, and each host installed and signed in. Paste this block into a terminal:

```bash
export R2="$HOME/r02"                       # everything for this run lives here
git clone https://github.com/dichovsky/testrail-mcp.git "$R2/repo"
cd "$R2/repo"
git checkout main && git pull
node -v                                      # must print v24.x
npm ci
mkdir -p "$R2/prefix" "$R2/uploads" "$R2/downloads" "$R2/outside" "$R2/out" "$R2/work"
npm pack --json --pack-destination "$R2" > "$R2/out/pack.json"    # builds, packs, records name and integrity
npm install -g --prefix "$R2/prefix" "$R2"/dichovsky-testrail-mcp-*.tgz
printf 'C08 evidence file\nline two\n' > "$R2/uploads/c08-evidence.txt"
printf 'outside\n' > "$R2/outside/secret.txt"
touch "$R2/out/.start"                       # marks when the run began, for section 7
echo "NODE=$(command -v node)"
echo "SERVER=$R2/prefix/lib/node_modules/@dichovsky/testrail-mcp/dist/cli.js"
echo "RECORDER=$R2/repo/scripts/record-stdio.mjs"
```

Keep the three paths it prints. The configurations below call them `<NODE>`, `<SERVER>` and `<RECORDER>`, and use `<R2>` for the run directory. Write them in full, without `~` or `$HOME`.

Every terminal you start a host from needs these variables. All of the values are synthetic. Paste the block at the top of each new terminal:

```bash
export R2="$HOME/r02"
export TESTRAIL_BASE_URL="http://127.0.0.1:4199"
export TESTRAIL_EMAIL="fixture@example.invalid"
export TESTRAIL_API_KEY="fixture-api-key"
export TESTRAIL_ALLOW_INSECURE=true
export TESTRAIL_ALLOW_PRIVATE_HOSTS=true
export TESTRAIL_MCP_UPLOAD_ROOTS="[\"$R2/uploads\"]"
export TESTRAIL_MCP_DOWNLOAD_DIR="$R2/downloads"
cd "$R2/work"
```

Always start a host from `$R2/work`. It is empty on purpose: the repository holds the C03 answer key, and an agent that can read files must not find it.

## 2. Start the stand-in for each scenario

Keep the stand-in running in a terminal of its own. Before each scenario, restart it with a new log name, so each scenario's requests stay in their own file. The port is fixed, so the host configuration never changes.

```bash
export R2="$HOME/r02"; cd "$R2/repo"
node scripts/fixture-testrail.mjs --port 4199 --pages 3 --log "$R2/out/<host>-<scenario>.jsonl"
```

For `<host>`, use `codex-cli`, `codex-desktop` or `copilot-cli`. For `<scenario>`, use the scenario ID in lower case, for example `codex-cli-c04.jsonl`.

## 3. Configure the host

Disable every other MCP server the host has, so it sees only the stand-in's server. In Codex, set `enabled = false` on each other `[mcp_servers.*]` table. Copilot CLI has servers built in; section 6 shows how to note them.

**Codex CLI.** Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.testrail]
command = "<NODE>"
args = ["<RECORDER>", "--log", "<R2>/out/codex-cli-stdio.jsonl", "--server", "<SERVER>"]
env_vars = [
  "TESTRAIL_BASE_URL", "TESTRAIL_EMAIL", "TESTRAIL_API_KEY",
  "TESTRAIL_MCP_UPLOAD_ROOTS", "TESTRAIL_MCP_DOWNLOAD_DIR",
  "TESTRAIL_ALLOW_INSECURE", "TESTRAIL_ALLOW_PRIVATE_HOSTS",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
```

**Codex desktop.** Do this after the Codex CLI run is finished. Replace the whole `[mcp_servers.testrail]` entry above with this one. The `env` table must stay last, so the keys above it stay in the server's own table. Then quit and reopen the app.

```toml
[mcp_servers.testrail]
command = "<NODE>"
args = ["<RECORDER>", "--log", "<R2>/out/codex-desktop-stdio.jsonl", "--server", "<SERVER>"]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true

[mcp_servers.testrail.env]
TESTRAIL_BASE_URL = "http://127.0.0.1:4199"
TESTRAIL_EMAIL = "fixture@example.invalid"
TESTRAIL_API_KEY = "fixture-api-key"
TESTRAIL_ALLOW_INSECURE = "true"
TESTRAIL_ALLOW_PRIVATE_HOSTS = "true"
TESTRAIL_MCP_UPLOAD_ROOTS = "[\"<R2>/uploads\"]"
TESTRAIL_MCP_DOWNLOAD_DIR = "<R2>/downloads"
```

**Copilot CLI.** Use a configuration directory of its own for the run, so your usual one is untouched. Set it in every Copilot terminal, then sign in once with `copilot` and `/login`:

```bash
export COPILOT_HOME="$R2/copilot-home"; mkdir -p "$COPILOT_HOME"
```

Write `$COPILOT_HOME/mcp-config.json`:

```json
{
  "mcpServers": {
    "testrail": {
      "type": "stdio",
      "command": "<NODE>",
      "args": ["<RECORDER>", "--log", "<R2>/out/copilot-cli-stdio.jsonl", "--server", "<SERVER>"],
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

For all hosts, leave every other setting at its default: tool approval, tool search and deferral, and output limits. When the host asks to approve a TestRail tool call, approve it and note that it asked. Approve a shell command only where a scenario below says so.

## 4. Record the versions and notes

Run this once per host, replacing `<host>`:

```bash
export R2="$HOME/r02"; cd "$R2/repo"
{ date -u; uname -sm; sw_vers 2>/dev/null || cat /etc/os-release; node -v
  echo "commit $(git rev-parse HEAD)"
  echo "driver $(node -p "require('$R2/prefix/lib/node_modules/@dichovsky/testrail-mcp/node_modules/@dichovsky/testrail-api-client/package.json').version")"
  codex --version 2>/dev/null; copilot --version 2>/dev/null; } > "$R2/out/<host>-versions.txt" 2>&1
node scripts/catalog-hash.mjs --command "$R2/prefix/bin/testrail-mcp" > "$R2/out/catalog-hash.txt"
```

The catalog check starts its own stand-in, so nothing else needs to run. It must show 133 tools and `a423193aa71240cb0cca5bd0ed54c30fdadfdadb3d61ac297a9afb4afd111724` for both eras.

Then create `$R2/out/<host>-notes.txt` and fill in these lines as you go:

```text
Tester name for the record:
Client build (Codex desktop: About window):
Model, as /model or the model picker shows it:
Provider / sign-in (ChatGPT account, API key, GitHub Copilot plan):
Discovery: were TestRail tools all loaded at start, or found by search when needed?
Approvals the host asked for:
Other MCP servers the host showed as connected:
Anything unexpected:
```

## 5. Run the scenarios

Start a new session for every prompt: `/new` in Codex, `/clear` in Copilot CLI, or a new conversation in the desktop app. After each session, save its transcript as `$R2/out/<host>-<scenario>.txt`. When a scenario has several prompts, add a suffix such as `-2`.
- **Copilot CLI:** run `/share file $R2/out/<host>-<scenario>.txt`.
- **Codex CLI:** its session files are collected in section 7, so a short copy of the terminal is enough.
- **Codex desktop:** copy the conversation, or take screenshots.

Paste each prompt exactly as written, replacing `<R2>` with your run directory.

| ID | Do this | Prompt to paste |
| --- | --- | --- |
| C01 | Quit the host completely, then start it. Run `/mcp` and save what it shows. Then send the prompt. For Copilot CLI, use the cold start in section 6. | `Do not call any tools. Reply with the single word READY.` |
| C02 | Send the first prompt. Then send the second in a new session. | 1. `Using the TestRail tools, get the TestRail project with ID 1 and tell me its name.` 2. `List the name of every TestRail tool you can access, then give their count. Do not call any of them.` |
| C03 | Run all 28 prompts, one session each. Print them with the command below this table. | each `prompt` from the corpus |
| C04 | Two prompts, two sessions. | 1. `Using the TestRail tools, read the first page of test cases in project 1, suite 1. Then tell me: the IDs on this page, the custom fields of the first case with their values, how many cases this page returned, whether TestRail has more cases after this page, and exactly how to get the next page. Quote the pagination information the tool returned.` 2. `Using the TestRail tools, read one page of the TestRail roles. Do not fetch everything. Tell me how many roles this page returned, whether more exist, and exactly how the tool says I can get the rest. Quote the pagination information the tool returned.` |
| C05 | Two prompts. The second takes about a minute. | 1. `Using the TestRail tools, fetch all test cases in project 1 (every page, not just the first). Tell me how many cases you got in total, the first and last case IDs, whether the result says it is complete, and quote its pagination information.` 2. `Using the TestRail tools, fetch all test cases in project 990045 in one call, every page, using the tool's own complete-read mode. Do not retry if it fails. Tell me exactly what the tool returned: whether it succeeded, any error code and reason, how many items or pages it fetched, and whether any partial data came back.` |
| C06 | Two prompts. | 1. `This is a compatibility test of the TestRail tools. Make exactly these three calls, one after another, and report each tool response verbatim (the full text), then say for each whether data came back and whether there was a warning or an error code. Do not retry any call. 1) testrail_get_project with project_id set to the string "seven" (deliberately invalid). 2) testrail_get_project with project_id 990001. 3) testrail_get_project with project_id 990002.` 2. `This is a validation test of the TestRail tools. Make exactly these two calls and report each tool response verbatim. Do not retry or correct them. 1) testrail_get_project with the JSON input {"project_id": "seven"} (project_id is a quoted JSON string on purpose). 2) testrail_get_project with the JSON input {"project_id": 1, "unexpected_flag": true}.` |
| C07 | One prompt. | `This is a compatibility test against a TestRail test fixture, so these writes are safe. Use the TestRail tools to do each of these once, in order, and for each one report the tool's response verbatim and whether it says the write was applied, rejected, or of unknown outcome: 1) add a test case titled "C07 create" to section 1; 2) update case 1 so its title is "C07 update"; 3) in suite 1 of project 1, bulk-update cases 1 and 2 to priority 2; 4) close test run 1; 5) delete test case 1; 6) add a test case titled "C07 rejected" to section 990400; 7) add a test case titled "C07 unknown" to section 990500. Make each call exactly once.` |
| C08 | Send the first prompt, and approve the host reading the downloaded file. Then quit the host completely, start it again and send the second prompt. Afterwards run `ls -la "$R2/downloads" > "$R2/out/<host>-c08-downloads.txt"`. | 1. `This is a compatibility test against a TestRail test fixture. Use the TestRail tools for each step, once each, and report every tool response verbatim: 1) attach the file <R2>/uploads/c08-evidence.txt to test case 1; 2) attach the file <R2>/outside/secret.txt to test case 1 (this file is outside the allowed upload folder; report what happens); 3) download attachment 501; 4) download attachment 501 again; 5) download attachment 990404. For each download, say the local path, the attachment ID and the byte count the tool reported. Then open the file downloaded in step 3 and tell me how many bytes it holds.` 2. `This is a compatibility test against a TestRail test fixture. Use the TestRail tools, once each, and report every tool response verbatim: 1) download attachment 501; 2) download attachment 990020 (it is expected to be slow; report whatever the tool returns).` |
| C09 | One prompt. Note what the host does with the large result: whether it truncates it, previews it or saves it to a file. If it saved one, ask in the same session: `Read the complete saved result and tell me the first and last case IDs and the pagination information.` Approve the file read or shell command it needs, and note which. | `This is a compatibility test against a TestRail test fixture. Use the TestRail tools, once each: 1) read one page of test cases in project 990900; 2) read one page of test cases in project 990901; 3) read all test cases in project 990901 using the tool's complete-read mode. For call 1, tell me how many cases came back, the first and last case IDs, and the full pagination information and any warnings, reading the complete result even if it is large. For calls 2 and 3, report the tool response verbatim.` |
| C10 | Three parts. (a) Send the first prompt. (b) When it has finished, wait 15 seconds yourself, then send `Call testrail_get_project with project_id 1 and report the response verbatim.` in the same session; this shows the slots came back. (c) In a new session, send the second prompt and press Esc about 3 seconds after the call starts. Then send `Call testrail_get_project with project_id 1.` in the same session. | (a) `This is a compatibility test against a TestRail test fixture. In ONE single step, issue five testrail_get_project calls in parallel, all with project_id 990020 (they are slow on purpose). Do not retry anything. Then report each of the five tool responses verbatim and how long the step took.` (c) `Call testrail_get_project with project_id 990020 and report the response verbatim.` |
| C11 | Quit the host, then run `pgrep -fl testrail-mcp || echo "no server left"` and save the output. Start the host, run `/mcp`, and send the prompt. Repeat once. For Copilot CLI, also follow section 6. | `Using the TestRail tools, get the TestRail project with ID 1 and tell me its name.` |
| C12 | Add the second server below, restart the host and run `/mcp`. Send the prompt, then remove the second server again. | `Several MCP servers may be connected. 1) Using the TestRail tools, get TestRail project 1 and tell me its name. 2) Using the filesystem tools, list the files in the allowed directory. 3) Tell me which MCP servers are connected, how many tools each provides, and whether any tool names collide.` |

To print the 28 C03 prompts, run this in the repository, not in `$R2/work`:

```bash
cd "$R2/repo" && node -e "for (const t of require('./tests/fixtures/clients/c03-corpus.json').tasks) console.log(t.id + ': ' + t.prompt)"
```

Save each C03 transcript as `<host>-c03-<id>.txt`. One stand-in log, `<host>-c03.jsonl`, covers all 28 prompts.

The second server for C12 is the reference filesystem server, pinned to the version the Claude Code run used and pointed at the uploads directory. For Codex:

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "<R2>/uploads"]
startup_timeout_sec = 60
```

For Copilot CLI, add it beside `testrail` in `mcpServers`:

```json
"filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "<R2>/uploads"], "tools": ["*"] }
```

## 6. Copilot CLI only

- **Built-in servers.** Copilot CLI connects some servers of its own. Write the ones `/mcp` lists into the notes file, and leave them as they are.
- **C01 cold start.** Copilot CLI can start from a cached tool list, so C01 must start without one. Start that session with `COPILOT_MCP_TOOL_CACHE=false copilot`. If your version ignores the variable, add `"disableToolCache": true` to the `testrail` entry for C01, then remove it.
- **C11 warm start.** Restart Copilot CLI normally, with the cache allowed. Run `/mcp` straight after start, and again a few seconds later. Note whether the TestRail tools are listed before live discovery finishes, and after it.
- **C09.** Copilot CLI can move a large tool result into a temporary file and show a preview. If it does, note the file's path, and check that the model reads the whole result there.

## 7. Send it back

Copy only this run's Codex CLI session files, then zip the output folder:

```bash
export R2="$HOME/r02"; mkdir -p "$R2/out/codex-sessions"
find ~/.codex/sessions -name '*.jsonl' -newer "$R2/out/.start" -exec cp {} "$R2/out/codex-sessions/" \;
cd "$R2" && zip -r r02-out.zip out
```

Before you share the zip, open `out/codex-sessions`. Remove any session that is not part of this run.

**Do not attach the zip to a GitHub issue, because the repository is public.** Upload it to your Google Drive, and tell Claude, in the session that is driving R02, the file's name.

The credentials in it are synthetic, so nothing needs redacting for them. Local paths, user names and the stand-in's address are replaced with placeholders when the records are written, and the raw files are not committed.
