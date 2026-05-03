# Write Semantic Commits

All commits **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) format.

## Rules

1. **Every commit message must start with a semantic prefix**.
2. **Format**: `<type>: <description>` (no scope, no body required unless it helps).
3. **Only create commits when explicitly requested by the user**.
4. **If unsure which type to use, default to `chore:`**.
5. **Focus on the "why", not the "what"** in the description.

## Allowed Types

| Type        | Use when…                                                |
| ----------- | -------------------------------------------------------- |
| `feat:`     | Adding a new feature or behavior.                        |
| `fix:`      | Fixing a bug.                                            |
| `docs:`     | Documentation-only changes.                              |
| `test:`     | Adding or updating tests.                                |
| `refactor:` | Code change that neither fixes a bug nor adds a feature. |
| `chore:`    | Tooling, dependency updates, or other maintenance tasks. |

## Examples

```
feat: add heartbeat rate limiting to socket events
fix: prevent PO from submitting estimates
docs: document TRUST_PROXY runtime opt-in
```

## Forbidden

- Commits without a type prefix.
- Commits that mix large formatting changes with functional changes (use `style:` or `chore:` for pure formatting).
- Creating commits without explicit user request.
