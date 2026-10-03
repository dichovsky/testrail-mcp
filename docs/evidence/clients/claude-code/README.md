# Claude Code: fixture run, 2026-10-03

The record is [`../claude-code.json`](../claude-code.json). The files here hold its evidence, one file per scenario. Each was built from that run's logs: the client's stream-json transcripts, a recording of the server's stdio, and the stand-in's request log. Local paths are replaced with `<run>`, `<scratch>` or `<host-saved-result>`, and long tool results are cut short with `…`. The raw logs are not committed.

## How it ran

- **Client.** Claude Code 2.1.288 on Linux x86_64, in a cloud container, run headless: `claude -p` with `--output-format stream-json --verbose`. It started each session in a clean environment holding only the stand-in's synthetic variables. Tool use was allowed with `--allowedTools mcp__testrail`. C09's second session also allowed `Bash(jq:*)`, and C12 also allowed `mcp__filesystem`. Each prompt was a fresh session.
- **Configuration.** The server entry was a `--mcp-config` file used with `--strict-mcp-config`. Its `env` map references the variables, as the guide's example does, with the two stand-in options added, and its `timeout` is 120000.
- **Server.** The development package `0.1.0-dev.0` was packed from commit `6b6021a` and installed from its tarball into a scratch prefix, with driver 7.2.0. Its `testrail-mcp` ran under a small recorder that passes stdio through unchanged and writes each line to a log. That recorder is how the negotiated revision was read.
- **TestRail.** The R02 stand-in, `node scripts/fixture-testrail.mjs --pages 3 --log …`, ran on the loopback interface. No live TestRail was contacted.
- **Negotiation.** Run by default and with `MCP_PROTOCOL_NEGOTIATION=auto`, the client opened each server with a `server/discover` probe at 2026-07-28 and stayed on that revision.

## What the run found about the host

- Discovery is deferred. All 133 names are listed when the session starts, and the model loads a tool's schema through `ToolSearch` before calling it.
- Claude Code moves an MCP result of more than 25,000 tokens out of the conversation into a file and gives the model its path. Setting `MAX_MCP_OUTPUT_TOKENS` to 100000 did not bring a 54 KB result back inline.
  - The server's result is one line of JSON, and the client's `Read` tool pages by line, so it cannot read a large saved result in parts.
  - With `jq` allowed, the model read a 717 KB page completely. Without it, `jq` needed approval that a headless session cannot give.
- When the model wrote malformed JSON arguments, the client refused them before they reached the server. Well-formed arguments that break the tool's contract reached the server and got `INVALID_ARGUMENT`.
- On an interrupt, the client sent `notifications/cancelled` for the call, and the server recorded it as `CANCELLED`. Headless, the client then ended the session at once, before the server's drain finished; no process remained.

The stand-in answers with canned records whose IDs and titles differ from the ones asked for. In several sessions the model noticed and made an extra read to check. Those reads are counted, not treated as wrong selections.
