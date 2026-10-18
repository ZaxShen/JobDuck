# jobduck

Status: pre-release.

Job Duck for your coding agent. Job Duck keeps your job search (postings, applications, status history, rejection outcomes) in a local SQLite database and lets the agent you already use — Claude Code, Codex CLI or Gemini CLI — work with it. No server, no account, no telemetry.

## Install

`jobduck` is a single self-contained binary; nothing else needs to be installed.

macOS and Linux (arm64 or x64):

```bash
curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/main/install.sh | sh
jobduck init
```

The installer downloads the binary for your platform from [GitHub Releases](https://github.com/ZaxShen/JobDuck/releases), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` without root. `JOBDUCK_VERSION=0.1.0` pins a version; `JOBDUCK_INSTALL_DIR=<dir>` picks another directory.

Windows (x64): download `jobduck-windows-x64.exe` from [Releases](https://github.com/ZaxShen/JobDuck/releases), rename it to `jobduck.exe`, and put it in a directory on your `PATH`.

Then:

```bash
jobduck init --dry-run   # preview the plan, one line per file, without writing anything
jobduck init             # apply (asks first; use --yes in scripts)
jobduck doctor           # check the runtime, PATH, ~/.jobduck, the database and host registration
```

`init` options:

- `--workspace <dir>`: project directory that gets `.mcp.json`, `AGENTS.md`, `CLAUDE.md` / `GEMINI.md` pointers (default: current directory).
- `--hosts claude,codex,gemini`: hosts to register (default: those detected by config file or binary on `PATH`).
- `--dry-run`: print the plan, write nothing.
- `--diff`: also print a unified diff of every file the plan touches (`init --dry-run --diff` previews everything).
- `--yes`: skip the confirmation prompt (required when not in a terminal).

`doctor` reports the jobduck and runtime versions, whether `jobduck` is on your `PATH` (hosts start it by name), `~/.jobduck` and its mode, the database, `permissions.toml`, `profile.md`, the installed skills and each host's registration. `doctor --json` prints a machine-readable report and exits 1 when a check fails. `jobduck mcp` runs the MCP server over stdio; your agent host starts it, you don't.

## Upgrade

```bash
jobduck upgrade --check   # print the current and latest versions, download nothing
jobduck upgrade           # replace this binary with the latest release
jobduck upgrade 0.1.0     # install a specific version
```

`upgrade` downloads the release asset for your platform from GitHub, refuses it unless its SHA-256 matches the release's `SHA256SUMS`, and swaps it in place. Run `jobduck init` afterwards to refresh the skills.

## What `init` writes

| Host | File | Change |
|---|---|---|
| Claude Code | `<workspace>/.mcp.json` | adds `mcpServers.jobduck` |
| Claude Code | `<workspace>/AGENTS.md`, `<workspace>/CLAUDE.md` | creates `AGENTS.md` if missing, adds `@AGENTS.md` to `CLAUDE.md` |
| Claude Code | `<workspace>/.claude/skills/jobduck-<name>/SKILL.md` | one pointer per skill |
| Codex CLI | `~/.codex/config.toml` | adds `[mcp_servers.jobduck]`, other sections untouched |
| Codex CLI | `<workspace>/.agents/skills/jobduck-<name>/SKILL.md` | one pointer per skill |
| Gemini CLI | `~/.gemini/settings.json`, `<workspace>/GEMINI.md` | adds `mcpServers.jobduck`, creates `GEMINI.md` pointing at `AGENTS.md` |

Every server entry runs `jobduck mcp`, so `jobduck` must be on the `PATH` your agent host sees. For every host, `init` also copies the skills to `~/.jobduck/skills/` (see [Skills](#skills)).

To register by hand instead of through `init`:

Claude Code (`<workspace>/.mcp.json`):

```json
{
  "mcpServers": {
    "jobduck": { "command": "jobduck", "args": ["mcp"] }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.jobduck]
command = "jobduck"
args = ["mcp"]
```

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "jobduck": { "command": "jobduck", "args": ["mcp"] }
  }
}
```

## Skills

Skills are plain markdown workflows any agent can follow. `init` copies them to `~/.jobduck/skills/<name>.md` (overwritten on every `init`, with a `.version` stamp) and lists them in `AGENTS.md`; Claude Code and Codex also get a `SKILL.md` pointer per skill so they show up as native skills. Gemini CLI reaches them through `AGENTS.md`.

| Skill | Ask your agent | What it does |
|---|---|---|
| `setup` | "set up Job Duck" | One questionnaire, gated by the modules you pick (`cv`, `find`, `track`, `apply`, `interview`); writes `profile.md` and `permissions.toml`, then runs `doctor`. `setup --module <name>` re-runs one part. |
| `find` | "find jobs" | `search_jobs` with your profile's filters, hard filters, a fit score, and a shortlist that marks postings you already track. |
| `apply` | "apply to jobs" / "apply to <url>" | Dedupes, picks your CV, fills the form with your browser tool, stops at the approval gate set by `[apply] autonomy`, submits, and records the application. CAPTCHAs and verification codes always stop for you. |
| `track` | "show my applications" | Lists applications, updates statuses when you report news, and runs `jobduck sync` for rejection emails. No mail access. |
| `cv` | "tailor my CV for <role>" | Writes `~/.jobduck/cv/<slug>.md` strictly from `profile.md`, within `[cv] page_limit`, with a fact-check list. |
| `interview` | "prep me for my interview at <company>" | Prep pack from the posting and your profile, mock interview, outcome via `update_status`. |

Skills are owned by the package; your answers live in `profile.md` and `permissions.toml`, so upgrading never loses them. Questions the `apply` skill meets on a form and cannot answer from your profile are asked once and saved under `[apply.answers]`.

## Tools

Every tool returns compact JSON. Writes (`record_application`, `update_status`) are refused until `track = true` in `permissions.toml`.

| Tool | Arguments | Returns |
|---|---|---|
| `get_profile` | none | `{ frontMatter, body }` from `profile.md` |
| `get_permissions` | `module?` | the whole `permissions.toml`, or `{ module, enabled, settings }` |
| `search_jobs` | `q?`, `countries?` (default `["US"]`), `posted_within_days?` (default 7), `company_slug?`, `skills?`, `is_tech?`, `seniority?`, `employment_type?`, `sort?` (`posted_at` or `created_at`), `max_results?` (default 50, max 500) | `{ total, returned, jobs[] }`; each job (with `location`, `work_mode`, `pay_min`, `pay_max`, `currency` when the source states them) is saved to `postings` and flagged `known` and with any live `application_id` / `application_status` |
| `find_application` | `url?`, or `company?` / `title?` (exact, case-insensitive); `with_text?` (default false) | `{ found, application?, posting? }`; `posting` omits `description` and `raw`; with `with_text: true` it adds `text` (plain text, at most 12 000 chars) and `truncated` |
| `record_application` | `url`, `title`, `company`, `location?`, `status?` (default `applied`), `applied_at?`, `note?`, `extracted?`, `source?` | `{ application, posting, marker }`, or `{ duplicate: true, application }` when the posting already has one |
| `update_status` | `id`, `status`, `note?`, `source?` | `{ application }`; every change is logged in `application_events`, and `note` is also appended to the application's note |
| `list_applications` | `status?` (one status or an array), `since?` (ISO date `YYYY-MM-DD` or timestamp), `limit?` (default 50, max 200) | `{ applications[] }` with title, company, location and URL from the posting |

`search_jobs` uses the public [freehire.me](https://freehire.me) API (no key; 50 results per page, at most 10 000 deep). It, [`jobduck sync`](#sync) (your own Apps Script URL) and [`jobduck upgrade`](#upgrade) (GitHub Releases) are the only network calls Job Duck makes.

## Dashboard

```bash
jobduck dashboard             # serves http://127.0.0.1:4848 and opens your browser
jobduck dashboard --port 0 --no-open
```

A local page over the same SQLite store: the applications board with status filters and search, a detail drawer (timeline, status, notes, title/company/location overrides, delete) and a "Needs a match" queue for rejection emails that could not be matched automatically. Status changes made here are recorded with source `dashboard`; matching a rejection closes the application as `deny_by_employer`.

- `--port <n>`: port to listen on (default 4848; `0` picks a free one).
- `--no-open`: do not open a browser.
- `--print-url`: print only the URL.

The server listens on `127.0.0.1` only, loads nothing from the internet, and refuses changes that do not come from its own page. Stop it with Ctrl+C.

## Sync

```bash
jobduck sync --dry-run   # fetch and print what would match, change nothing
jobduck sync             # store, match, close, acknowledge
jobduck sync --json      # same, as JSON
```

Rejection emails reach Job Duck through the Job Duck Gmail Apps Script running in your own Google account, deployed as a web app (its README, "Serve mode"). Set `[track] sync_url` to the `/exec` URL and `sync_token` to the token `generateSyncToken` logged; the `setup` skill's track module walks you through it. Job Duck never gets mail access: the script sorts your mail and queues one small record per rejection (date, sender domain, subject, company, title, job URL or reference, and the application marker when there is one).

`sync` POSTs `{ token, action }` to that URL (the token is in the body, never in a URL or log line), stores each queued rejection once per message id, and matches it to an open application, in this order:

1. **marker**: the application id from the confirmation email's marker;
2. **url**: the job URL, compared after the same normalization `postings` uses;
3. **ref**: the job reference, equal to the posting's source id or a path/query token of its URL;
4. **company_title**: same company after normalization (case, punctuation and suffixes such as Inc or Labs ignored; your company override wins), when it is the only open application there or its title is clearly the closest (token overlap of at least 0.6, seniority words ignored), and the email is not older than the application date minus one day.

A match closes the application as `deny_by_employer` with an event from source `sync`. Closed applications are never reopened. Rejections that match nothing land in the dashboard's "Needs a match" queue with up to three suggested applications; match or dismiss them there, or ask your agent to propose one. Every stored rejection, matched or not, is then acknowledged so the script deletes it from its queue; one already stored on an earlier run is counted as `known` and acknowledged again.

The output lists date, company, title and result per email, then `fetched / matched (marker, url, ref, company_title) / needs_match / known`. `--dry-run` fetches and prints the plan without writing to the database or acknowledging anything.

Exit codes: `0` done; `1` network error, rejected token (`sync_token rejected; run generateSyncToken in the Apps Script and update permissions.toml`) or a rejection that could not be stored; `2` the track module is off or `sync_url` / `sync_token` is empty.

## Layout

```
~/.jobduck/            (override with JOBDUCK_HOME; mode 0700)
  jobduck.db           SQLite: postings, applications, application_events, outcomes, settings
  profile.md           TOML front matter (contact, links, work authorization, search preferences,
                       [[cv_files]]) and sections: Summary, Experience, Projects, Education,
                       Writing style, Facts never to change
  permissions.toml     [modules] switches (all off by default), the [apply] manifest,
                       [track] and [cv] settings
  skills/              the six skills and a .version stamp (package-owned)
  cv/                  CVs written by the cv skill
```

Nothing is enabled until you turn a module on in `permissions.toml`; the `setup` skill does that for you. The `[apply]` defaults are the safe ones: confirm every submit, every consent off, decline demographic questions, no ATS accounts, salary left blank, no CV tailoring, free text drafted for your approval.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build && ./dist/jobduck doctor   # binary for this machine
bun run build:all                         # every platform plus dist/SHA256SUMS
```

## Releasing

Pushing a `v<version>` tag that matches `package.json` runs the release workflow: it tests, builds `jobduck-darwin-arm64`, `jobduck-darwin-x64`, `jobduck-linux-x64`, `jobduck-linux-arm64`, `jobduck-windows-x64.exe` and `SHA256SUMS`, and publishes them as a GitHub Release.

## License

MIT. See [LICENSE](LICENSE).
