# pick-linear-ticket

A small CLI that picks the next eligible Linear ticket from a team's backlog and prints the ticket id + a ready-to-use git branch name. Wraps the [`linear-cli`](https://github.com/Finesssee/linear-cli) binary, so authentication and caching are already handled.

## Why

Picking "what should I work on next?" through the Linear web UI is fine; picking it from an agent or a shell script is awkward. The official MCP server exposes the data but not the ranking. `linear-cli` exposes the data but you still have to compose 5–8 calls (plus parse the responses, handle workspace cache mismatches, and slugify the branch name) to get a usable answer.

This CLI does that composition once. Output is either a single human-readable line or JSON, so it's easy to consume from either a terminal or a script.

The ranking is fixed:

1. **Promoted** — issues that are in the team's active cycle _or_ have been moved from `Backlog` to `Todo` sort above plain backlog work. Both signals mean "the user wants this soon," so they are treated as a single tier rather than two separate dimensions.
2. **Unblocks count** — inside the tier, issues that unblock other still-active issues sort higher. The rationale is to clear the team's dependency chain ahead of standalone work.
3. **Priority** — Urgent → High → Medium → Low → No priority.
4. **Created date** — older tickets win ties.

Issues with at least one active blocker (Backlog/Todo/In Progress) are dropped before ranking.

## Install

Requires Node ≥ 24 (uses Node's native TypeScript type-stripping; no build step) and the `linear-cli` binary on `PATH`, authenticated to a Linear workspace.

Run without installing:

```sh
pnpm dlx pick-linear-ticket --team RAN --workspace emberengineering
```

Or install from GitHub as a dev dependency (npm publish pending):

```sh
pnpm add -D github:0x80/pick-linear-ticket
```

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
# auto-pick from the backlog
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

## Exit codes

| Code | Meaning                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Picked successfully; result on stdout.                                                                                        |
| `2`  | No eligible candidate (active cycle + backlog both empty after filters).                                                      |
| `3`  | Explicit pick failed gates (wrong team, terminal state, active blocker).                                                      |
| `4`  | Workspace mismatch — `linear-cli` does not see the requested team. Sign into the right workspace via `linear-cli auth oauth`. |
| `5`  | `linear-cli` error or unknown error.                                                                                          |

## Filtering rules

Only issues whose `state.name` is `Backlog` or `Todo` and whose assignee is the current user (per `linear-cli whoami`) or `null` are considered. Tickets in `In Progress`, `Done`, `Canceled`, `Triage`, `Some Day`, or any other state are skipped.

Workspace recovery: if the requested team isn't visible to `linear-cli`, the CLI runs `linear-cli cache clear` and retries once. If it's still missing, it exits with code 4 and a hint to run `linear-cli auth oauth`.

## Limits

- Hardcoded to the first 50 active issues for the relations query (Linear's GraphQL complexity ceiling of 10000 forbids more without splitting the query). If your team has more than ~50 active issues in `Backlog`/`Todo`/`In Progress` at once, you'll need to widen the query or paginate — file an issue.
- One CLI, one team per invocation. If you work across teams, call it once per team.

## License

MIT — see [LICENSE](./LICENSE).
