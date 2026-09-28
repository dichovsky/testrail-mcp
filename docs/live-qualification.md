# Live TestRail qualification

`scripts/live-qualification.mjs` drives every one of the 133 tools against a real TestRail instance and writes one evidence record. It is R03's live qualification: offline fixtures show what the server sends, and this run shows what TestRail does with it. It has not yet been run against a live instance.

## What it touches

The run must not change or delete data that existed before it.

| Kind of call | What the run does |
| --- | --- |
| Reads | May read existing data, such as the project list, users, groups, statuses and fields. |
| Writes inside the project | The run creates one project, named `testrail-mcp qualification <stamp> project`, and makes every other write inside it, to entities it created. |
| Writes outside the project | `add_user`, `update_user`, `add_group`, `update_group`, `delete_group` and `add_case_field` run only with `--instance-writes`. Use it only on a disposable instance. |
| Report generation | `run_report` and `run_cross_project_report` run only from templates you name, because each run generates a report and may email it. |

A guard checks every write before it is sent. Each ID the write names, in the path, the query or the body, must be an entity of that kind the run created, or the call is not made. Status, priority, type, template, role and user references choose among the instance's settings and change nothing, so the guard allows them.

The last step deletes the project and everything in it. If the run stops early, because a call fails, the MCP session breaks or you press Ctrl-C, the runner still deletes the project, and the group when there is one, on the way out. TestRail's API cannot delete users or case fields. With `--instance-writes`, one inactive user and one case field stay behind, and the evidence lists them. Both names start with `testrail-mcp qualification`, and the user's address ends in `@example.invalid`.

## Running it

1. Build, and rehearse against the fixture stand-in, which needs no account:

   ```sh
   npm ci && npm run build
   node scripts/fixture-testrail.mjs
   ```

   In a second terminal, export the five `TESTRAIL_` variables it prints, then run the command in step 3; the runner makes its own upload and download directories. Every tool passes against the stand-in.

2. Give the runner the instance through the environment only; it never takes credentials as arguments:

   ```sh
   export TESTRAIL_BASE_URL=https://example.testrail.io
   export TESTRAIL_EMAIL=...
   export TESTRAIL_API_KEY=...
   ```

3. Run it:

   ```sh
   node scripts/live-qualification.mjs --create-qualification-project --out docs/evidence/live/testrail-10.7.json
   ```

| Option | Effect |
| --- | --- |
| `--create-qualification-project` | Required. Confirms that the run may create, use and delete a project. |
| `--out <file>` | Required. Where the evidence goes; its directory is created if needed. |
| `--instance-writes` | Also run the writes outside the project. Disposable instances only. |
| `--report-template-id <id>` | A single-project report template configured for the test. |
| `--cross-project-report-template-id <id>` | A cross-project report template configured for the test. |
| `--command <cmd>` and repeated `--arg <arg>` | The server to drive, such as an installed `testrail-mcp`. By default the runner drives `node dist/cli.js`. |

The runner starts the server itself, gives it a temporary upload root holding the two files it uploads and a temporary download directory, and removes both afterwards. The server's driver allows 100 TestRail requests a minute. The runner keeps under that pace and retries a rate-limited call after the window has moved on, since a 429 means TestRail did not handle the request. A full run takes about two minutes.

It prints one line per step, with the error code and the server's message for any failure, then a summary. It exits with 0 when no tool failed and the project was deleted, with 1 when a tool failed or the project was left behind, and with 2 when it could not start or could not write the evidence.

## Statuses

| Status | Meaning |
| --- | --- |
| `pass` | Every step of the tool that ran succeeded. |
| `fail` | TestRail or the server returned an error, other than a missing licence or permission, or the reply lacked what the next steps need. On the 10.7.0 baseline, a failure is a finding. |
| `blocked` | The instance lacks a licensed feature (`LICENSE_REQUIRED`) or the user a permission (`PERMISSION_DENIED`). A step whose prerequisite was blocked or failed is blocked too, and names what it needed. A blocked tool is never counted as a pass. |
| `not_run` | Left out on purpose, with the reason: an option not given, or the run stopped. |

A tool with several steps takes its worst status, except that a step left out on purpose does not outweigh a pass. `testrail_get_group`, for example, reads an existing group and, with `--instance-writes`, the run's own.

## The evidence

The record holds statuses, error codes, HTTP statuses, warning codes and the reasons above. It holds no TestRail data, no names or IDs, no address and no credentials. Before writing, the runner checks the text for:
- the configured address and its host;
- the email and the API key;
- the Basic credential;
- the signed-in user's address.

If any of them appears, it refuses to write the file.

```json
{
  "schema_version": 1,
  "provenance": "live_testrail",
  "tested_on": "YYYY-MM-DD",
  "testrail_version": "from testrail_get_version",
  "server": { "package_version": "...", "protocol": "negotiated MCP revision", "driver_version": "7.2.0" },
  "options": { "instance_writes": false, "report_template": false, "cross_project_report_template": false },
  "summary": { "pass": 0, "not_run": 0, "blocked": 0, "fail": 0 },
  "tools": { "testrail_add_case": { "status": "pass", "steps": [{ "label": null, "status": "pass", "warnings": [] }] } },
  "cleanup": { "project": "deleted", "group": "not_created", "residue": [] }
}
```

`tests/live-qualification.test.ts` holds the runner offline. It checks that:
- the plan calls every registered tool;
- each step's scope matches the tool's effect;
- only the six instance writes need `--instance-writes`;
- the project comes first and is deleted last.

It checks the guard against foreign, nested, differently-kinded and parent IDs.

It runs the whole plan through the registered tools and the real driver against the stand-in, where every tool passes and nothing is refused. It also runs by default, where the instance writes and reports are not run and never reach the stand-in. Further runs cover:
- a project TestRail refuses to create;
- a missing licence;
- a session that fails part-way, after which cleanup deletes the project;
- a project that could not be deleted;
- refused credentials;
- a rate-limited call;
- evidence that would carry the address.

It also covers the command line's refusals, and the stdio connection to the built server.
