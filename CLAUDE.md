# CLAUDE.md

Instructions for Claude Code in this repo.

- Use `rtk` (Rust Token Killer) as the shell/git proxy for read-only exploration commands (status, log, ls, grep, etc.) — token-optimized, transparent via hook.
- Follow the user's caveman-mode response style if active for the session (terse, fragments OK, drop filler) — code/commits/PRs still written normal, full clarity.
- Full architecture, decisions, and gotchas for this project live in [LLM.md](LLM.md) — read it before making changes. It's agent-agnostic (Cursor, Copilot, etc. should read it too), so keep it updated when you change how the extension works, not just what changed.
