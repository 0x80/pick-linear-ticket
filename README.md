# pick-linear-ticket

A small CLI that picks the next eligible Linear ticket from a team's active cycle or `Todo` column and prints the ticket id + a ready-to-use git branch name. Wraps the [`linear-cli`](https://github.com/Finesssee/linear-cli) binary, so authentication and caching are already handled.

## Why

Picking "what should I work on next?" through the Linear web UI is fine; picking it from an agent or a shell script is awkward. The official MCP server exposes the data but not the ranking. `linear-cli` exposes the data but you still have to compose 5–8 calls (plus parse the responses, handle workspace cache mismatches, and slugify the branch name) to get a usable answer.

This CLI does that composition once. Output is either a single human-readable line or JSON, so it's easy to consume from either a terminal or a script.

Eligibility: an issue is considered only if it is in the team's active cycle, or its `state.name` is `Todo`. Plain `Backlog` is intentionally excluded — Backlog is a parking lot for "we might do this someday," and the user signals "actually pick this up" by either pulling the ticket into the active cycle or moving it to `Todo`. (Backlog tickets that have been added to the active cycle remain eligible via the cycle.)

The ranking is fixed:

1. **Unblocks count** — issues that unblock other still-active issues sort higher. The rationale is to clear the team's dependency chain ahead of standalone work.
2. **Priority** — Urgent → High → Medium → Low → No priority.
3. **Created date** — older tickets win ties.

Issues with at least one active blocker (Backlog/Todo/In Progress) are dropped before ranking.

## Install

Requires Node ≥ 24. The [`linear-cli`](https://github.com/Finesssee/linear-cli) binary must be on `$PATH` — the CLI surfaces install instructions and auto-triggers `linear-cli auth oauth` on first run if anything's missing (see [Preflight](#preflight)).

Run without installing:

```sh
pnpm dlx pick-linear-ticket --team RAN --workspace emberengineering
```

Install from GitHub as a dev dependency (npm publish pending):

```sh
pnpm add -D github:0x80/pick-linear-ticket
```

Or install globally from a local clone while iterating:

```sh
git clone https://github.com/0x80/pick-linear-ticket
cd pick-linear-ticket
pnpm install
pnpm add -g "$(pwd)"
```

The `prepare` script runs `tsdown` and writes the bundled entry to `dist/cli.mjs`, which is what `bin` points at.

## Usage

```
pick-linear-ticket [TICKET_ID] --team <key> --workspace <slug> [options]
```

**Required**

- `--team <key>` — the Linear team key (e.g. `RAN`).
- `--workspace <slug>` — the workspace URL slug (e.g. `emberengineering` for `https://linear.app/emberengineering/...`).

**Options**

- `--start` — also transition the chosen ticket to "In Progress" after picking it.
- `--json` — emit the result as a single-line JSON object on stdout instead of a human line.
- `--verbose` — write the full ranking table to stderr before the result.
- `--help`, `-h` — show usage.

**Examples**

```sh
# auto-pick from the active cycle / Todo
pick-linear-ticket --team RAN --workspace emberengineering

# auto-pick and start the ticket
pick-linear-ticket --team RAN --workspace emberengineering --start --json

# pick a specific ticket (validates state + blockers)
pick-linear-ticket RAN-22 --team RAN --workspace emberengineering --start
```

## JSON output

```json
{
  "id": "RAN-30",
  "title": "Roulator fall-through to past-maybes bucket",
  "url": "https://linear.app/emberengineering/issue/RAN-30/...",
  "branchName": "ran-30-roulator-fall-through-to-past-maybes-bucket",
  "reason": "blocks RAN-32",
  "started": true
}
```

## Preflight

Before any Linear call, the CLI runs three checks in order:

1. **`linear-cli` is installed.** If the binary is missing from `$PATH`, the CLI prints the install URL and exits with code `5`.
2. **`linear-cli` is authenticated.** Determined via `linear-cli auth status -o json`. If not, `linear-cli auth oauth` runs interactively — your browser opens for the handshake.
3. **The authenticated workspace contains the requested team.** Determined by checking `linear-cli teams list` for the team key, with one automatic cache-clear retry. If the team still isn't visible, `linear-cli auth oauth` runs again so you can pick the right workspace, and the team lookup is retried once more.

Steps 2 and 3 mean a fresh-laptop run can complete the whole OAuth dance without leaving the CLI invocation. If you're scripting this and want hard failures instead of an interactive prompt, run `linear-cli auth status` and `linear-cli teams list` yourself first.

## Exit codes

| Code | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | Picked successfully; result on stdout.                                                             |
| `2`  | No eligible candidate (active cycle and `Todo` both empty after filters).                          |
| `3`  | Explicit pick failed gates (wrong team, terminal state, active blocker).                           |
| `4`  | Workspace mismatch still present after the preflight OAuth retry — re-run `linear-cli auth oauth`. |
| `5`  | `linear-cli` missing from `$PATH`, `linear-cli` error, or unknown error.                           |

## Filtering rules

Only issues that are **in the team's active cycle** OR whose `state.name` is `Todo` are considered, AND whose assignee is the current user (per `linear-cli whoami`) or `null`. Tickets in plain `Backlog`, `In Progress`, `Done`, `Canceled`, `Triage`, `Some Day`, or any other state are skipped — except `Backlog`-state tickets that have been added to the active cycle, which the cycle membership picks up.

## Limits

- Hardcoded to the first 50 active issues for the relations query (Linear's GraphQL complexity ceiling of 10000 forbids more without splitting the query). If your team has more than ~50 active issues in `Backlog`/`Todo`/`In Progress` at once, you'll need to widen the query or paginate — file an issue.
- One CLI, one team per invocation. If you work across teams, call it once per team.

## License

MIT — see [LICENSE](./LICENSE).
