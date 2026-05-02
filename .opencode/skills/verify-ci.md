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
3. Confirm both jobs finish successfully:
   - `test` — installs dependencies, runs format check, typecheck, and tests
   - `docker` — builds the Docker image (only after `test` passes)

## Troubleshooting

- If `act` complains about missing Docker, start Docker Desktop or your local Docker daemon.
- To run only the `test` job: `act push -j test`
- To run only the `docker` job: `act push -j docker`
- The `act-event.json` payload sets `"act": true` so that future release jobs (Stage 2) are skipped during local runs.
