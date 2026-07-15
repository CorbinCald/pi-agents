# Security Policy

Pi Agents is a local coding agent that runs with the permissions of the user who launches it. It does not provide a security boundary between the model, trusted repository content, installed extensions or skills, and files accessible to that user. Use a container, virtual machine, or other sandbox when stronger isolation is required.

## Canonical Project Scope

This policy applies to code and release artifacts maintained in [CorbinCald/pi-agents](https://github.com/CorbinCald/pi-agents). Upstream Pi services, `pi.dev`, and `@earendil-works/*` registry packages are outside this repository's security scope unless a report demonstrates a vulnerability in code shipped directly from Pi Agents.

## Reporting a Vulnerability

Open a private report through [GitHub Security Advisories](https://github.com/CorbinCald/pi-agents/security/advisories/new). Do not open a public issue for security-sensitive reports.

Include:

- a description of the issue and impact
- reproducible steps or relevant logs
- affected commit, artifact, configuration, or path
- known mitigations

## In Scope

- privilege-boundary violations caused by Pi Agents
- vulnerabilities reachable in Pi Agents release artifacts or repository code
- unintended disclosure of credentials owned by this repository
- dependency vulnerabilities demonstrably reachable through shipped Pi Agents behavior

## Out of Scope

- expected command execution by a coding agent running as the local user
- prompt injection from trusted repository files, `AGENTS.md`, comments, model output, extensions, or skills
- behavior requiring prior ability to modify the user's files, shell environment, Pi configuration, or installed packages
- malicious or untrusted extensions, skills, tools, models, proxies, or repositories
- public exposure created by user configuration
- denial-of-service claims requiring trusted local input
- upstream infrastructure or packages not published by `CorbinCald/pi-agents`

Reports should demonstrate a current, reproducible security-boundary crossing rather than expected local-agent behavior.
