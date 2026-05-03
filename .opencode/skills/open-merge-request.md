# Open or Update Merge Request with GitHub CLI

Open a new pull request or update an existing one using the `gh` CLI. Always ensure a clean commit history, verified author, and wait for CI to pass before considering the change complete.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) is installed and authenticated
- The repository has an `origin` remote pointing to GitHub

## Steps

1. **Ensure a clean commit history rebased on latest `origin/main`**
   - Fetch the latest state from the remote:
     ```bash
     git fetch origin
     ```
   - Rebase the current branch onto `origin/main`:
     ```bash
     git rebase origin/main
     ```
   - If conflicts arise, resolve them and continue the rebase. Ask the user for help if you are unsure how to resolve a conflict.
   - Verify the commit history is linear and clean:
     ```bash
     git log --oneline origin/main..HEAD
     ```

2. **Check the commit author is correct**
   - Inspect the author name and email for all new commits:
     ```bash
     git log --format='%h %an <%ae>' origin/main..HEAD
     ```
   - If the author is incorrect, amend the commits (e.g., with `git commit --amend --author="..."` or an interactive rebase). Ask the user what the correct author should be if it is missing or wrong.

3. **Push the branch to the remote**
   - Push the current branch, setting the upstream if needed:
     ```bash
     git push -u origin HEAD
     ```
   - If the push is rejected because the rebase rewrote history, force-push safely:
     ```bash
     git push --force-with-lease
     ```

4. **Draft a concise title and LEAN description**
   - **Title**: Summarize the change in one imperative sentence (50–72 characters), using a semantic prefix if the repo follows Conventional Commits (e.g., `feat: add dark mode toggle`).
   - **Description**: Keep it **LEAN**:
     - **L**imited: One short paragraph or 2–3 bullet points max.
     - **E**xplicit: State what changed and why, not just "fix bug".
     - **A**ctionable: Mention anything the reviewer needs to do (e.g., run migrations, test on mobile).
     - **N**o fluff: Omit "This PR...", checklist items the CI already covers, or unrelated changes.
   - Reference any related issues with `Fixes #123` or `Relates to #456` at the end.

5. **Open the PR with `gh`**
   - Create the pull request using the title and body you drafted:
     ```bash
     gh pr create --title "<title>" --body "<body>"
     ```
   - If you want to open it in the browser for final edits:
     ```bash
     gh pr create --title "<title>" --body "<body>" --web
     ```
   - Capture the PR URL from the output for the next step.

6. **If updating an existing PR**
   - Steps 1–4 still apply (rebase, author check, push).
   - After pushing new commits, the existing PR is automatically updated.
   - Retrieve the PR URL if you do not already have it:
     ```bash
     gh pr view --json url --jq '.url'
     ```
   - Proceed directly to the CI pipeline wait step below.

7. **Wait for the CI pipeline to finish**
   - Poll the PR checks using generous sleep intervals to avoid excessive tool-call usage:
     ```bash
     gh pr checks <pr-url> --watch --interval 60
     ```
     _If `--watch` is unavailable in your `gh` version, poll manually:_
     ```bash
     while true; do
       gh pr checks <pr-url>
       if [ $? -eq 0 ]; then
         echo "Pipeline passed."
         break
       fi
       # Check if any check has actually completed (fail or pass)
       # If failed, gh exits non-zero and prints failures.
       echo "Still waiting..."
       sleep 120
     done
     ```
   - **If the pipeline fails**:
     1. Inspect the failing jobs/logs via `gh run view` or the GitHub web UI.
     2. Make the minimal fix required (formatting, test update, code change, etc.).
     3. Amend or add a fixup commit, rebase if needed, and push again.
     4. Return to the waiting step above and repeat until the pipeline passes.
   - **Do not proceed** (merge, request review, etc.) until the pipeline is green.

## Troubleshooting

- **Rebase fails with merge conflicts**: Pause and ask the user how they want the conflict resolved.
- **Commit author is a bot or generic CI user**: Ask the user for the correct name/email before rewriting history.
- **Push rejected after rebase**: Use `--force-with-lease` only. Never use `--force` unless the user explicitly requests it.
- **Pipeline keeps failing**: After five fix attempts, summarize the remaining errors and ask the user for guidance rather than blindly retrying.
- **No CI configured**: Skip the pipeline wait step and inform the user that no checks were found.
