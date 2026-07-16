# Agents Workspace

Agents is Pi's built-in workspace for running multiple persistent interactive sessions. A bare `pi` invocation opens Agents directly without creating a host transcript. Invocations with a prompt, `--session`, `--resume`, or a non-interactive mode continue to use the normal Pi startup flow.

## Requirements

- Node.js 22.19.0 or newer
- tmux 3.5 or newer
- Git for worktree isolation
- Linux, macOS, or WSL; native Windows is not currently supported
- Access to `openai/gpt-5.6-luna` for context compaction and automatic completion recaps

Agents is included in `@earendil-works/pi-coding-agent`; it does not require a separate extension install.

## Using Agents

- Run bare `pi` to open the fullscreen workspace.
- Type a task and press Enter to dispatch it.
- Select a session and press Enter or Right Arrow to open its native Pi process.
- Press Left Arrow on an empty attached prompt, or run `/agents`, to detach back to the workspace.
- Press Ctrl+C once to exit the host. Managed sessions continue running.

Each managed session is a real interactive Pi process. When attached, native commands, configured keybindings, model controls, tools, images, external editors, and extensions continue to work normally.

All canonical sessions that `/resume` can discover are also listed in Agents. Opening an existing session starts or reconnects its managed native Pi process. Pressing `/` in Agents returns to Pi's native command editor, including from the central bare-startup workspace; `/agents` opens Agents again.

## Workspace Controls

All application actions can be remapped in `~/.pi/agent/keybindings.json`; see [Keybindings](keybindings.md#agents-workspace).

| Default | Action |
| --- | --- |
| Up / Down | Select a session |
| Enter / Right | Open the selected native Pi session |
| Alt+1 … Alt+9 | Open session 1–9 |
| Shift+C | Set or clear the selected session's color label |
| Ctrl+T | Pin or unpin |
| Ctrl+R | Rename |
| Shift+Up / Shift+Down | Reorder within a status group |
| Shift+Tab | Cycle dispatch reasoning effort |
| Ctrl+X | Stop; press again within two seconds to hide |
| `/` | Return to Pi's native command editor |
| Ctrl+C | Exit the host; managed sessions keep running |
| Ctrl+Shift+C | Preserve the terminal copy gesture |
| Escape | Clear the task editor or close Agents |
| `?` | Show workspace help |

Direct OpenAI GPT-5.6 Responses models add **Max Pro** after `max`. It combines `reasoning.effort: "max"` with `reasoning.mode: "pro"` and is not shown for unsupported models.

Context compaction uses `openai/gpt-5.6-luna` at high reasoning effort regardless of the active session model or reasoning level. This policy is built into Pi Agents and does not require a global compaction extension. After a successful compaction, a persistent transcript entry identifies the model and reasoning effort used.

## Session States

- **Needs Input** — the session is waiting for a decision or missing information.
- **Working** — the session is generating, using tools, retrying, or processing queued input.
- **Complete** — the turn finished, stopped, or failed.

When a turn settles, Agents uses `openai/gpt-5.6-luna` at medium reasoning effort to classify the state and write a concise recap. This incurs normal provider usage. The recap appears as a native Pi widget when the session is opened.

## Isolation and Deletion

A task dispatched from a Git repository receives a dedicated worktree and branch:

- Worktrees: `~/.pi/agent/agents/worktrees/`
- Branches: `pi-agent/<session-id>-<task-slug>`

A task dispatched outside Git is marked as not isolated and works directly in that directory.

Ctrl+X stops a session. Pressing it again within two seconds hides the Agents entry and force-removes its managed worktree and branch, including uncommitted worktree changes. The canonical Pi transcript is retained.

## Persistence and Storage

A detached per-user supervisor owns managed Pi processes inside a private tmux server. Closing the host, detaching, or losing the terminal does not stop them. Completed, unpinned processes are released after one idle hour while transcripts and metadata remain available.

Canonical transcripts remain under Pi's standard per-project namespace:

```text
~/.pi/agent/sessions/
```

Agents, `/resume`, and `--session` therefore use one session inventory. On first startup after migration from the historical extension, transcripts under `~/.pi/agent/agents/sessions/` move into the canonical namespace. Filename collisions never overwrite either transcript.

Agents-specific runtime state remains under:

```text
~/.pi/agent/agents/
├── jobs/
├── worktrees/
├── supervisor.log
└── supervisor.sock
```

The supervisor scripts ship with `@earendil-works/pi-coding-agent`. Agents has no additional telemetry.
