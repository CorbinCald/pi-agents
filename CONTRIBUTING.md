# Contributing to Pi Agents

`https://github.com/CorbinCald/pi-agents` is the canonical repository for this independent Pi distribution. It descends from Pi, but issues, pull requests, releases, and design decisions for this project belong here—not in `earendil-works/pi`.

## Project Direction

The built-in Agents workspace is intentional core functionality. Changes may modify Pi internals when that produces a simpler, more reliable integrated system. Do not move Agents back into a separately installed extension or restore compatibility code for the former two-tree deployment.

The `@earendil-works/*` package names are retained temporarily for import compatibility. They are not the publication channel or source-of-truth identity for this repository.

## Contributions

Before opening a pull request:

1. Explain the problem and the intended behavior.
2. Keep the change scoped and include meaningful regression coverage.
3. Run `npm run check` and the relevant focused tests.
4. Update the applicable package changelog under `## [Unreleased]` for user-visible changes.
5. Do not include unrelated generated files, formatting, or refactors.

AI-assisted work is allowed, but contributors remain responsible for understanding and validating every change.

## Repository Safety

Multiple Agents sessions may work in the checkout concurrently. Stage explicit paths, preserve unrelated changes, and never use destructive cleanup or force-push commands. See [AGENTS.md](AGENTS.md) for the full development rules.

## Issues and Pull Requests

Issues and pull requests are reviewed in this repository without the upstream contributor-approval gate. Keep reports concise, reproducible, and specific. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
