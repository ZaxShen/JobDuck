# Job Duck

Agent-run job search: a local SQLite store and CLI that your coding agent drives, plus a Gmail Apps Script that
sorts application mail and queues rejections for it.

```bash
curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/main/install.sh | sh
mkdir ~/JobDuck && cd ~/JobDuck
jobduck init
```

Then open your agent (Claude Code, Codex CLI or Gemini CLI) in that folder and say "set up Job Duck". Drop your resume or LinkedIn PDF into `inbox/` to have it imported, or fill in the form at `jobduck dashboard --view profile`. A dedicated folder keeps your CVs, cover letters and the agent's notes together, away from your code; see [Use a dedicated folder](framework/README.md#use-a-dedicated-folder).

`jobduck` is a single binary; builds for macOS, Linux and Windows are on [Releases](https://github.com/ZaxShen/JobDuck/releases).

- [`framework/`](framework/README.md): the `jobduck` CLI, MCP server, skills and dashboard.
- [`integrations/gmail-apps-script/`](integrations/gmail-apps-script/README.md): the Gmail automation script.

## License

MIT. See [LICENSE](LICENSE).
