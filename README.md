<p align="center">
  <a href="https://github.com/CorbinCald/pi-agents">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

# Pi Agents

**Canonical source:** [CorbinCald/pi-agents](https://github.com/CorbinCald/pi-agents)

Pi Agents is an independent Pi distribution with a built-in persistent Agents workspace. Bare startup opens the workspace, managed workers remain native Pi sessions, transcripts stay canonical, and supervisor state is isolated under `~/.pi/agent/agents`.

This repository descends from the Pi project, but its implementation, issues, releases, and development policy are maintained here. `earendil-works/pi` is upstream lineage, not the source of truth for this distribution. The existing `@earendil-works/*` package names are temporarily retained as compatibility identifiers and do not designate repository ownership or an approved update channel.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Pi Agents CLI and built-in workspace
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

Start with the repository [documentation](packages/coding-agent/docs/index.md). The inherited [pi.dev](https://pi.dev) site documents the upstream ecosystem and may differ from Pi Agents.

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI with the built-in [Agents workspace](packages/coding-agent/docs/agents.md) |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For upstream Slack/chat automation and workflows, see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules. File issues and pull requests against [CorbinCald/pi-agents](https://github.com/CorbinCald/pi-agents).

## Development

```bash
git clone https://github.com/CorbinCald/pi-agents.git
cd pi-agents
npm install --ignore-scripts  # Install dependencies without lifecycle scripts
npm run build                 # Build all packages
npm run check                 # Lint, format, and type check
./test.sh                     # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh                  # Run Pi Agents from sources
```

Keep globally installed development extensions under version control in `.pi/extensions/`. Symlink their `~/.pi/agent/extensions/` installations to the tracked files instead of maintaining untracked copies.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- Packaged CLI artifacts include `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive dependencies.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

Upstream project resources remain available at [pi.dev](https://pi.dev). They are external to the canonical Pi Agents repository.
