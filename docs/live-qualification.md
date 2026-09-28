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

A guard checks every write before it is sent. Each ID the write names, in the path, the query or the body, must be an entity of that kind the run created, or the call is not made. That includes the group and user IDs in a project's access rows. Status, priority, type, template, role and user references choose among the instance's settings and change nothing, so the guard allows them. The exception is `add_case_field`'s `template_ids`, which adds the field to the templates it names. The run creates no templates, so the guard refuses any.

A read whose answer later steps use is checked the same way, since what it returns can become the run's own. The run's tests, for example, are read from the run it created. A refused call is a failure: it means a fault in the plan, or an answer the plan did not expect.

The last step deletes the project and everything in it. If the run stops early, because a call fails, the MCP session breaks or you press Ctrl-C, the runner still deletes the project, and the group when there is one, on the way out. Closing the terminal (SIGHUP) and SIGTERM stop the run the same way.

Ctrl-C at a terminal stops the server as well as the runner, so the runner starts a fresh server to clean up through. It also stops a `| tee` that keeps the log; output that can no longer be written does not stop the cleanup.

A second Ctrl-C abandons that cleanup. The runner removes its temporary files, names what may be left, and exits with 2 without writing evidence.

TestRail's API cannot delete users or case fields. With `--instance-writes`, one inactive user and one case field stay behind, and the evidence lists them. When TestRail's answer to creating one is unknown, it lists it as possible, and so it does for the project and the group. A request the driver gave up waiting on counts as unknown, although its status is 408, since TestRail may still have acted on it. The user's name and the case field's label start with `testrail-mcp qualification`; the case field's system name is `tmq_<id>_f`, and the user's address ends in `@example.invalid`.

## Running it

1. Build, and rehearse against the fixture stand-in, which needs no account:

   ```sh
   npm ci && npm run build
   node scripts/fixture-testrail.mjs
   ```

   In a second terminal, export the five `TESTRAIL_` variables it prints, then run the command in step 3 with `--instance-writes --report-template-id 1 --cross-project-report-template-id 2`; the runner makes its own upload and download directories. Every tool passes against the stand-in. Without those options, the six writes outside the project and the two reports are `not_run`.

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
| `--out <file>` | Required. Where the evidence goes; its directory is created if needed. A directory, or a path that cannot be written, is refused before anything is sent. An existing file is checked without being changed. |
| `--instance-writes` | Also run the writes outside the project. Disposable instances only. |
| `--report-template-id <id>` | A single-project report template configured for the test. |
| `--cross-project-report-template-id <id>` | A cross-project report template configured for the test. |
| `--command <cmd>` and repeated `--arg <arg>` | The server to drive, such as an installed `testrail-mcp`. By default the runner drives `node dist/cli.js`. Write an argument that starts with a dash as `--arg=-y`. |

The runner starts the server itself, gives it a temporary upload root holding the two files it uploads and a temporary download directory, and removes both afterwards. The server's driver allows 100 TestRail requests a minute. The runner keeps under that pace and retries a rate-limited call after the window has moved on, since a 429 means TestRail did not handle the request. A full run takes about two minutes.

Before it sends anything, it refuses a configured value that the evidence's own words contain, such as an API key that is also a status, since evidence that names it could never be checked. The host is checked as a whole name, so a host such as `testrail` does not match `testrail_add_case`.

It prints one line per step, with the error code and the server's message for any failure, then what cleanup did and a summary. What cleanup did is printed even when the evidence cannot be written. A server that will not start is reported with its own reason.

| Exit code | When |
| --- | --- |
| 0 | The run reached its end, no tool failed, and nothing that should have been deleted was left behind. |
| 1 | A tool failed, the project or group was left behind, or the run stopped early. |
| 2 | The run could not start, the evidence could not be written, or a second Ctrl-C abandoned cleanup. |

## Statuses

| Status | Meaning |
| --- | --- |
| `pass` | Every step of the tool that ran succeeded. |
| `fail` | TestRail or the server returned an error, other than a missing licence or permission, the reply lacked what the next steps need, or the guard refused the call. On the 10.7.0 baseline, a failure is a finding. |
| `blocked` | The instance lacks a licensed feature (`LICENSE_REQUIRED`) or the user a permission (`PERMISSION_DENIED`). A step whose prerequisite was blocked or failed is blocked too, and names what it needed. A blocked tool is never counted as a pass. |
| `not_run` | Left out, with the reason: an option not given, nothing in the instance to act on (a group read where there are no groups), or the run stopped, including a step Ctrl-C cut short. |

A tool with several steps takes its worst status, except that a step left out does not outweigh a pass. `testrail_get_group`, for example, reads an existing group, when the instance has one, and, with `--instance-writes`, the run's own.

## The evidence

The record holds statuses, error codes, HTTP statuses, warning codes and the reasons above, and why the run stopped early, if it did. It holds no TestRail data, no names or IDs, no address and no credentials. Before writing, the runner checks the text for:
- the configured address, and its host as a whole name;
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
  "stopped": null,
  "summary": { "pass": 0, "not_run": 0, "blocked": 0, "fail": 0 },
  "tools": { "testrail_add_case": { "status": "pass", "steps": [{ "label": null, "status": "pass", "warnings": [] }] } },
  "cleanup": { "project": "deleted", "group": "not_created", "residue": [] }
}
```

`driver_version` is the driver installed beside the runner, which its own server loads. With `--command` it is `null`: the runner cannot see which driver another server loads, and `package_version` names the release, which pins one driver.

`tests/live-qualification.test.ts` holds the runner offline. It checks that:
- the plan calls every registered tool;
- each step's scope matches the tool's effect;
- only the six instance writes need `--instance-writes`;
- the project comes first and is deleted last.

It checks the guard against:
- foreign, nested, differently-kinded and parent IDs;
- GUID entry and attachment IDs;
- the IDs in a project's access rows;
- every target kind;
- reads whose answers later steps use.

Every ID-like argument any tool accepts is either a target or a named reference to the instance's settings. Inside a run, a refused write is never sent, and it fails its tool and the run.

It runs the whole plan through the registered tools and the real driver against the stand-in, where every tool passes and nothing is refused. In that run, every entity the run creates gets an ID of its own, so a write aimed at anything else is refused. It also runs by default, where the instance writes and reports are not run and never reach the stand-in. Further runs cover:
- a project TestRail refuses to create;
- a missing licence;
- a session that fails part-way;
- a session that dies, after which cleanup deletes the project through a fresh one;
- Ctrl-C, in-process and at a real terminal, after which cleanup deletes the project and the group;
- a closed terminal, with the output's reader gone, after which cleanup still deletes the project;
- a second Ctrl-C, which removes the temporary files and exits with 2;
- a run that throws part-way, which still says what cleanup did;
- a project or group that could not be deleted;
- a project, group, user or case field whose creation's outcome is unknown, including a request the driver timed out;
- refused credentials;
- a rate-limited call;
- an instance with no groups;
- evidence that would carry any configured or personal value.

It also covers:
- the pace against the server's rate limit, and what is repeated;
- the tool statuses and exit codes;
- the command line's refusals, including an evidence file it cannot overwrite, and a server that will not start;
- the driver version, recorded only for the runner's own server;
- the stdio connection to the built server.
