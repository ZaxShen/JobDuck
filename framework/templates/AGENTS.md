# Job Duck

This workspace is connected to Job Duck, a local job-search store at `~/.jobduck/`.

- Your profile lives in `~/.jobduck/profile.md` and your permissions in `~/.jobduck/permissions.toml`.
- Only use a Job Duck module when it is enabled under `[modules]` in `permissions.toml`. If it is off, run the setup skill instead.
- Run `npx jobduck doctor` to check the setup.

## Skills

When a request matches a trigger, read the skill file and follow it.

| Skill | Use when the user says | File |
|---|---|---|
| setup | "set up Job Duck", "change my job search settings", "re-run setup for apply" | `~/.jobduck/skills/setup.md` |
| find | "find jobs", "search for roles", "what should I apply to" | `~/.jobduck/skills/find.md` |
| apply | "apply to jobs", "submit applications", "apply to this posting <url>" | `~/.jobduck/skills/apply.md` |
| track | "show my applications", "mark <company> as rejected", "what's my pipeline" | `~/.jobduck/skills/track.md` |
| cv | "write my CV", "tailor my resume for <role>" | `~/.jobduck/skills/cv.md` |
| interview | "prep me for my interview at <company>", "I got an offer", "record the outcome" | `~/.jobduck/skills/interview.md` |
