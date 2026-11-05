# Job Duck

Agent-run job search: a local SQLite store and CLI that your coding agent drives, plus a Gmail Apps Script that
sorts application mail and queues rejections for it.

```bash
curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/dev/framework/scripts/install.ts | bun run -
mkdir ~/JobDuck && cd ~/JobDuck
jobduck init
```

On Windows, run `irm https://raw.githubusercontent.com/ZaxShen/JobDuck/dev/framework/scripts/install.ts | bun run -` in PowerShell. The installer needs [Bun](https://bun.sh); without it, download the binary for your platform from [Releases](https://github.com/ZaxShen/JobDuck/releases) instead.

Then open your agent (Claude Code, Codex CLI or Gemini CLI) in that folder and say "set up Job Duck". Drop your resume or LinkedIn PDF into `inbox/` to have it imported, or fill in the form at `jobduck dashboard --view profile`. A dedicated folder keeps your CVs, cover letters and the agent's notes together, away from your code; see [Use a dedicated folder](framework/README.md#use-a-dedicated-folder).

## Try A Dev Build

You need [Bun](https://bun.sh) and one agent host: Claude Code, Codex CLI or Gemini CLI.

```bash
curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/dev/framework/scripts/install.ts | JOBDUCK_CHANNEL=dev bun run -
mkdir ~/JobDuck && cd ~/JobDuck && jobduck init
```

In PowerShell, run `$env:JOBDUCK_CHANNEL='dev'; irm https://raw.githubusercontent.com/ZaxShen/JobDuck/dev/framework/scripts/install.ts | bun run -`, then the same `mkdir` and `jobduck init`.

Open your agent in `~/JobDuck` and say "set up Job Duck". Run `jobduck upgrade` to stay current; it stays on the dev channel. `jobduck --version` prints the version to put in a report. Gmail sorting (the Apps Script and the `sort-mail` skill) is optional; skip it if you like.

Found a bug or have feedback? [Open an issue](https://github.com/ZaxShen/JobDuck/issues/new/choose) with the Bug report or Feedback form. Issues are public: never paste real emails, CVs or personal details.

`jobduck` is a single binary; builds for macOS, Linux and Windows are on [Releases](https://github.com/ZaxShen/JobDuck/releases).

- [`framework/`](framework/README.md): the `jobduck` CLI, MCP server, skills and dashboard.
- [`integrations/gmail-apps-script/`](integrations/gmail-apps-script/README.md): the Gmail automation script.

## License

MIT. See [LICENSE](LICENSE).
