# Verify CI Locally

Run the full CI pipeline locally using `act` before pushing or opening a pull request.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) is installed and running
- [act](https://github.com/nektos/act) is installed (`brew install act` or equivalent)

## Steps

1. Ensure the Docker daemon is running.
2. From the repository root, run:
   ```bash
   act push
   ```
   The `.actrc` file automatically loads `act-event.json`, so no extra flags are needed.
3. Confirm the `ci` job finishes successfully. It runs, in order:
   - format check, typecheck, and tests (`npm ci` first)
   - docker build, container smoke test (HTTP + Socket.IO)

## Troubleshooting

- If `act` complains about missing Docker, start Docker Desktop or your local Docker daemon.
- To run only the single CI job: `act push -j ci`
- The `act-event.json` payload sets `"act": true` so that future release jobs (Stage 2) are skipped during local runs.
