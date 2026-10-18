# Job Duck

Agent-run job search: a local SQLite store and CLI that your coding agent drives, plus a Gmail Apps Script that
sorts application mail and queues rejections for it.

```bash
curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/main/install.sh | sh
jobduck init
```

`jobduck` is a single binary; builds for macOS, Linux and Windows are on [Releases](https://github.com/ZaxShen/JobDuck/releases).

- [`framework/`](framework/README.md): the `jobduck` CLI, MCP server, skills and dashboard.
- [`integrations/gmail-apps-script/`](integrations/gmail-apps-script/README.md): the Gmail automation script.

## License

MIT. See [LICENSE](LICENSE).
