# Use Oxfmt for Code Formatting

This project uses **oxfmt** (the OXC JavaScript/TypeScript formatter) for all code formatting.

## Rules

1. **After modifying any `.ts`, `.js`, `.json`, `.css`, or `.html` file**, run formatting before considering the change complete.
2. **Always run the format check** (`npm run format:check`) after making code changes and before running tests. If formatting issues are found, fix them first.
3. **Do not mix formatting changes with functional changes** in the same commit unless the functional change is tiny (≤5 lines). When formatting a large file, make a dedicated `style:` or `chore:` commit.
4. Oxfmt respects `.gitignore` and skips `node_modules` by default.
5. No custom `.oxfmtrc.json` is used — we rely on oxfmt defaults for consistency.

## Commands

```bash
npm run format          # Format all files in place
npm run format:check    # Check if all files are formatted (CI uses this)
```

## Notes

- Oxfmt is extremely fast; formatting the entire project takes well under one second.
- If oxfmt is not installed, run `npm install` to get it as a devDependency.
