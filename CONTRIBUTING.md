# Contributing

Thanks for helping improve this project.

This fork builds on azumag's original MIT-licensed work. Please keep attribution and license notices intact, and keep contributions respectful, focused, and easy to review.

## Development checks

Before opening a pull request, run the standard project checks:

```bash
npm run typecheck
npm test
npm run build
```

CI is expected to pass `npm run typecheck` and `npm test` before merge. A local build is also expected for changes that affect published output or developer workflow.

## Keep changes lean

- Prefer small, targeted pull requests.
- Carry only the fix or improvement needed for the change.
- Avoid unrelated refactors or formatting churn.
- Add or update tests when behavior changes.
- Keep documentation aligned when user-facing behavior changes.

## Pull request flow

1. Start from the latest `main` branch.
2. Make the smallest change that solves the problem.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Open a pull request with a clear summary, validation notes, and any tradeoffs.

## Bugs and feature requests

Please use the issue templates so reports include the context needed to reproduce bugs or evaluate feature ideas.

## Code of conduct

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
