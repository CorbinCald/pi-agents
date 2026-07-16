# Pi Agents

**Canonical source:** [CorbinCald/pi-agents](https://github.com/CorbinCald/pi-agents)

Pi Agents is an independent Pi distribution with a built-in persistent Agents workspace. Bare startup opens the workspace, managed workers remain native Pi sessions, transcripts stay canonical, and supervisor state is isolated under `~/.pi/agent/agents`.

The existing `@earendil-works/*` package names are compatibility identifiers. They do not designate repository ownership or an approved release or update channel.

Start with the Pi Agents, noting that they may diverge from the current state of pi-agents [documentation](packages/coding-agent/docs/index.md).

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI with the built-in [Agents workspace](packages/coding-agent/docs/agents.md) |
| **[@earendil-works/pi-orchestrator](packages/orchestrator)** | Experimental orchestration package under active development |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

## Permissions & Containerization

Pi Agents does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

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

## License

MIT
