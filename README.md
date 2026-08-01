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

Cycle membership and `Todo` are an eligibility gate only, not a ranking dimension — every candidate that reaches the ranking already satisfies one of them, so neither can break a tie between two of them.

Issues with at least one active blocker (Backlog/Todo/In Progress) are dropped before ranking.

## Install

Requires Node ≥ 24. The [`linear-cli`](https://github.com/Finesssee/linear-cli) binary must be on `$PATH` — the CLI surfaces install instructions and auto-triggers `linear-cli auth oauth` on first run if anything's missing (see [Preflight](#preflight)).

Not published to npm yet, so install from GitHub. As a dev dependency:

```sh
pnpm add -D github:0x80/pick-linear-ticket
```

Or globally, to get `pick-linear-ticket` on `$PATH`:

```sh
pnpm add -g github:0x80/pick-linear-ticket
```

To run your own build while iterating, install globally from a local clone:

```sh
git clone https://github.com/0x80/pick-linear-ticket
cd pick-linear-ticket
pnpm install
pnpm add -g .
```

`pnpm add -g .` symlinks the global entry at your clone, so after the first install a plain `pnpm build` is enough to pick up further changes — no reinstall. The flip side is that the global binary then tracks whatever is checked out there, so building on a feature branch changes what `pick-linear-ticket` runs. (`pnpm link --global` is deprecated; `pnpm add -g .` replaces it. To remove: `pnpm uninstall -g pick-linear-ticket`.)

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
- `--resume` — explicit picks only: accept a ticket that is already "In Progress" or whose branch already exists locally. Use it when you're deliberately resuming work you own. Auto-select ignores it (see [Local claims](#local-claims)).
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

| Code | Meaning                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Picked successfully; result on stdout.                                                                                                                                    |
| `1`  | Usage error — `--team` or `--workspace` missing. Usage text is printed.                                                                                                   |
| `2`  | No eligible candidate: either nothing survived the filters, or every eligible ticket is already claimed by a concurrent pick (see [Concurrent picks](#concurrent-picks)). |
| `3`  | Explicit pick failed gates (wrong team, terminal state, already In Progress, existing local branch/worktree, active blocker).                                             |
| `4`  | Workspace mismatch still present after the preflight OAuth retry — re-run `linear-cli auth oauth`.                                                                        |
| `5`  | `linear-cli` missing from `$PATH`, `linear-cli` error, incomplete pagination, or unknown error.                                                                           |
| `6`  | Timed out — a subprocess or filesystem operation wedged and the watchdog fired.                                                                                           |

## Filtering rules

Only issues that are **in the team's active cycle** OR whose `state.name` is `Todo` are considered, AND whose assignee is the current user (per `linear-cli whoami`) or `null`. Tickets in plain `Backlog`, `In Progress`, `Done`, `Canceled`, `Triage`, `Some Day`, or any other state are skipped — except `Backlog`-state tickets that have been added to the active cycle, which the cycle membership picks up.

Candidates whose branch already exists locally are then dropped, whatever Linear says about them. See [Local claims](#local-claims).

## Local claims

Every ticket maps to a deterministic branch name, so the local repository is itself a record of what has already been started. Before returning a pick, the CLI reads `git worktree list` and `git branch --list` in the working directory and treats a matching branch as a claim: auto-select skips those candidates, and an explicit pick exits `3` unless `--resume` is passed.

This exists because the Linear-side state checks are only as good as the read behind them. In the incident that motivated it, Linear was degraded — the run's `--start` came back `HTTP 503` — and the issue list served a stale state for a ticket that had been "In Progress" for two hours. It passed the eligibility filter, its 30-second lock had expired long before, and the explicit-pick retry only gated on `Done`/`Canceled`, so a second agent was launched into a worktree another agent was actively writing.

A branch on disk can't go stale that way, which is why it gets the final say. Two deliberate limits:

- **Local only.** Remote branches aren't consulted: `origin/*` reflects the last fetch, so it both misses fresh work and lingers after a merged branch is deleted.
- **Never fatal.** If the working directory isn't a git repository, git is missing, or either read fails, the probe reports no claims rather than throwing — the CLI is global and is legitimately run from non-repository directories.

## Concurrent picks

Two pickers started at once would otherwise both return the best ticket. To prevent that, a pick **claims** its ticket with a lock directory before returning: it walks the ranked list top-down and takes the highest-ranked ticket whose lock is free, so concurrent invocations fan out to distinct tickets instead of colliding.

When something better was already claimed, `reason` says so rather than inventing a ranking explanation:

```
next available (2 higher-ranked tickets claimed by concurrent picks)
```

If every eligible ticket is claimed, the CLI exits `2`. Claims are reclaimed after 30 seconds, so a crashed picker frees its ticket quickly.

That 30-second window covers a burst of simultaneous invocations and nothing more. It is **not** what stops a ticket already being worked from being picked again — a lock that old expired long ago, and if Linear serves a stale state the ticket looks eligible again. [Local claims](#local-claims) is the guard that holds over hours.

Locks live in `~/.pick-linear-ticket-locks` by default — deliberately in `$HOME` rather than the repo, so a single set of claims is shared across every clone and worktree a picker runs from.

## Environment variables

| Variable                 | Default                       | Effect                                                                                                       |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PICK_LINEAR_LOCK_DIR`   | `~/.pick-linear-ticket-locks` | Where claims are stored. Point it elsewhere to scope claims per project, or at a writable path in a sandbox. |
| `PICK_LINEAR_TIMEOUT_MS` | `60000`                       | Watchdog for the whole run. Exceeding it exits `6`. Raise it on slow links.                                  |
| `PICK_LINEAR_DEBUG`      | unset                         | Any non-empty value traces lock claims and the ranked list to stderr.                                        |

## Limits

- The relations query is capped at 50 issues per request by Linear's GraphQL complexity ceiling of 10000 (`first: 100` costs ~11200 and is rejected). It pages through the cursor until the active set is exhausted, so the page size only affects how many round-trips a pick costs, not what the pick can see.
- **A pick never ranks a partial blocker graph.** If a connection walk can't be exhausted — the API claims another page but returns no cursor, the cursor stops advancing, or the walk exceeds its 20-page bound (1000 issues at the relations page size) — the run fails with a `PaginationError` instead of returning what it gathered. The ranking can't tell a truncated graph from a complete one, so a silent partial result would let the picker hand back a blocked ticket while looking like it succeeded. Raise `MAX_ISSUE_PAGES` if a team genuinely outgrows the bound.
- One CLI, one team per invocation. If you work across teams, call it once per team.

## License

MIT — see [LICENSE](./LICENSE).
