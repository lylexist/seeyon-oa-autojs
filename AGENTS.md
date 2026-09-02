# Repository Guidelines

## Project Structure & Module Organization

This repository is a focused Node.js command-line tool for automating Seeyon OA V9 approvals.

- `scripts/oa_approval.js`: executable entry point; contains environment loading, authentication, HTTP helpers, Playwright UI automation, output formatting, and CLI dispatch.
- `README.md`: user-facing setup and command reference.
- `SKILL.md`: automation workflow, verified OA endpoints, and implementation notes for agents.
- `.env`: local credentials only; it is ignored by Git and must never be committed.

Keep runtime code under `scripts/`. If the CLI grows, extract cohesive helpers into `scripts/lib/` and place future tests under `test/` with paths mirroring the source layout.

## Build, Test, and Development Commands

There is no build step or committed package manifest. Use Node.js 16 or newer and install the runtime browser dependency locally when needed:

```bash
npm install playwright
node --check scripts/oa_approval.js
node scripts/oa_approval.js list
node scripts/oa_approval.js detail <affairId>
```

`node --check` performs a credential-free syntax check. `list` and `detail` are read-only smoke tests but require valid `OA_URL`, `OA_USER`, and `OA_PASS` values in `.env` or the environment. Treat `approve` as a production-changing command.

## Coding Style & Naming Conventions

Follow the existing CommonJS JavaScript style: two-space indentation, semicolons, single quotes, `const` by default, `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for environment-backed constants. Keep async operations explicit with `async`/`await`, preserve concise Chinese operator messages, and include actionable context in thrown errors. No formatter or linter is configured, so match nearby code and run the syntax check before committing.

## Testing Guidelines

No automated test framework or coverage threshold currently exists. For logic changes, add focused tests before introducing broad refactors; name them `*.test.js`. At minimum, verify syntax and exercise `list` against a non-production or safely scoped account. Never use `OA_AUTO_CONFIRM=1` during exploratory testing.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:` with concise Chinese summaries. Keep commits narrowly scoped. Pull requests should explain behavior changes, verification commands, affected OA flows, and rollback considerations. Link relevant issues and include sanitized logs or screenshots for UI automation changes; remove credentials, session IDs, internal URLs, and personal data.

## Security & Operational Safety

Approval actions are irreversible. Always run `list`, confirm exact `affairId` values and task scope, then approve. Do not weaken TLS or authentication handling beyond existing compatibility requirements, and never commit `.env`, logs, screenshots, or API response captures containing sensitive data.
