# Pi Agents

[![CI](https://github.com/CorbinCald/pi-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/CorbinCald/pi-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Unofficial community package.** This project is not affiliated with or endorsed by the maintainers of [Pi](https://github.com/earendil-works/pi).

A native Agents workspace for [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Dispatch multiple persistent sessions, let them work concurrently in isolated Git worktrees, and move between them without interrupting their work.

## Features

- Persistent background Pi sessions that survive detaching, closing the host Pi process, and terminal disconnection
- Native Pi UI when attached—slash commands, autocomplete, configured keybindings, `Shift+Tab`, double-`Escape`, tools, images, and extensions keep working
- **Needs Input**, **Working**, and **Complete** session groups
- Automatic completion classification and concise recaps
- Isolated Git worktree and branch for each dispatched session
- Pinning, renaming, reordering, stopping, and deletion
- Mouse/trackpad scrollback with a 100,000-line history
- Source directory and isolated worktree shown inside each native Pi session
- Empty-prompt **Left Arrow** or `/agents` to open the workspace and detach back to it

## Requirements

- Pi `0.80.6` (the currently tested release; later versions may require compatibility updates)
- Node.js `22.19.0` or newer
- tmux `3.5` or newer
- Git for worktree isolation
- Linux, macOS, or WSL; native Windows is not currently supported
- Access to `openai/gpt-5.6-luna` for completion recaps

The worker session uses whichever model is selected in the host Pi session. Classification and recap generation use `openai/gpt-5.6-luna` at medium reasoning effort and therefore incur normal provider usage.

## Install

Pi packages execute with your full user permissions. Review the source before installing any third-party extension.

```bash
pi install git:github.com/CorbinCald/pi-agents
```

Restart Pi, or run `/reload` in an existing process. Update later with:

```bash
pi update git:github.com/CorbinCald/pi-agents
```

To uninstall:

```bash
pi remove git:github.com/CorbinCald/pi-agents
```

## Use

- Press **Left Arrow** on an empty native Pi prompt, or run `/agents`, to open the workspace.
- Type a task and press **Enter** to dispatch it.
- Select a session and press **Enter** or **Right Arrow** to hand the terminal directly to its native Pi session.
- Press **Left Arrow** on an empty attached prompt, or run `/agents`, to detach without interrupting it.
- Use the **mouse wheel or trackpad** to scroll through an attached conversation. Scroll back to the bottom, or press `q`, to return to the live view.

Each agent is one persistent interactive Pi process, not a transcript emulation or parallel session UI. On attach, the host UI stops and the terminal is handed directly to that Pi process. Native slash commands, `/new`, `/resume`, model controls, bash mode, external editor support, custom extensions, configured keybindings, and normal Pi shortcuts remain available; Agents only claims Left Arrow when the editor is empty.

Typing `/` in an empty Agents workspace returns immediately to Pi's native slash-command editor. `Shift+Tab` in the workspace changes the reasoning effort used for newly dispatched sessions.

### Workspace controls

Press `?` in the workspace to show the current controls.

| Key | Action |
| --- | --- |
| `Up` / `Down` | Select a session |
| `Enter` / `Right` | Open the selected native Pi session |
| `Alt+1` … `Alt+9` | Open session 1–9 |
| `Ctrl+T` | Pin or unpin |
| `Ctrl+R` | Rename |
| `Shift+Up` / `Shift+Down` | Reorder |
| `Shift+Tab` | Cycle dispatch reasoning effort |
| `Ctrl+X` | Stop; press again within two seconds to delete |
| `/` | Return to native Pi slash commands |
| `Escape` | Clear the task editor or close the workspace |

## Session states

- **Needs Input** — the agent is waiting for a decision or missing information.
- **Working** — the agent is generating, using tools, retrying, or processing queued input.
- **Complete** — the turn finished, stopped, or failed.

When a turn settles, the recap model classifies its state and writes a short summary. The recap appears as a native Pi widget when the session is opened.

## Isolation and deletion

A session dispatched from a Git repository gets a dedicated worktree and branch:

- Worktrees: `~/.pi/agent/agents/worktrees/`
- Branches: `pi-agent/<session-id>-<task-slug>`

A task dispatched outside Git is visibly marked as **not isolated** and operates directly in that directory.

`Ctrl+X` stops a session. Pressing it again within two seconds deletes the Agents entry and force-removes its managed worktree and branch, including uncommitted worktree changes. The Pi JSONL transcript is retained under `~/.pi/agent/agents/sessions/`.

## Persistence and storage

A detached per-user supervisor owns each managed Pi process inside a private tmux server. Attaching temporarily gives the terminal to that process; detaching restores the host Pi workspace. Completed, unpinned Pi processes are released after one idle hour while their transcript and metadata remain available.

Runtime data is stored separately from this package:

```text
~/.pi/agent/agents/
├── jobs/
├── sessions/
├── worktrees/
├── supervisor.log
└── supervisor.sock
```

The package has no telemetry. Prompts and transcripts are sent only to the model providers selected in Pi and to the configured recap model.

## Development

```bash
git clone https://github.com/CorbinCald/pi-agents.git
cd pi-agents
npm install
npm test
npm run lint
```

The integration suite uses fake native Pi processes and temporary Git repositories. It covers concurrent worktree isolation, state classification, recaps, direct terminal follow-ups, client disconnection, persistent native tmux sessions, attach preparation, scrollback configuration, and cleanup.

To try a checkout without installing it permanently:

```bash
pi -e ./index.ts
```

## License

[MIT](LICENSE)
