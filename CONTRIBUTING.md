# Contributing to Job Duck

The code lives in [`framework/`](framework/README.md) (the `jobduck` CLI) and [`integrations/`](integrations/). See [framework/README.md](framework/README.md#development) for building and testing.

## Branches

- Branch from `dev`, open a pull request into `dev`, and merge once the required `ci` check passes.
- `dev` reaches `main` through a pull request when a release is ready.

## Commits

Emoji-prefixed [Conventional Commits](https://www.conventionalcommits.org/): `<emoji> <type>(<scope>): <summary>`, for example `✨ feat(dashboard): add a profile view`, `🐛 fix(sync): ...`, `📝 docs(...)`, `♻️ refactor(...)`, `👷 ci(...)`.

## Release channels

| Channel | Built from | Versions |
|---|---|---|
| `stable` | a `vX.Y.Z` tag on `main` | `0.2.0` |
| `rc` | a `vX.Y.Z-rc.N` tag on `dev`, published as a prerelease | `0.2.0-rc.1` |
| `dev` | `dev`, as the rolling `dev-latest` prerelease | `0.2.0-dev.7.gh17` |

## Dev builds

`.github/workflows/dev-channel.yml` rebuilds `dev-latest` daily when `dev` moved, or on demand. A dev build is versioned `X.Y.Z-dev.<n>.gh<PR>` and its release is titled `vX.Y.Z-dev.<n>.gh<PR>`, for example `0.2.0-dev.7.gh17`:

- **X.Y.Z** is the version in the making: the core of a prerelease `package.json` version (`0.2.0-rc.1` gives `0.2.0`), else the next patch (`0.1.1` gives `0.1.2`).
- **n** counts the first-parent commits on `dev` since the highest stable `vX.Y.Z` tag (all of them when there is none). It orders builds and restarts after each stable release.
- **gh\<PR>** names the pull request whose merge produced the build. It is a label only and is left out when there is none.

The release notes name the exact commit, and `scripts/dev-version.ts` computes the version.

**Is a fix in my build?** Compare `n` within the same X.Y.Z: once a build carrying the fix's PR shipped as `n`, every build of that X.Y.Z with the same or a higher `n` has it. Across X.Y.Z, the higher version is newer. `jobduck --version` shows the installed version.

**Getting one:** `jobduck upgrade --channel dev` installs the current `dev-latest`, and `jobduck upgrade <version>` pins a tagged version. For a build right away, run `gh workflow run dev-channel.yml`.

## Releasing

Never tag stable without a release candidate people have run: tag `vX.Y.Z-rc.N` on `dev` first, test it, then tag `vX.Y.Z` on `main`. The release workflow runs `framework/scripts/release-gate.ts` first: an rc tag must be on `dev`; a stable tag must be on `main`, its `vX.Y.Z-rc.N` must already be published, and nothing but the `package.json` version may differ from the newest rc. The steps are in [framework/README.md](framework/README.md#releasing).
