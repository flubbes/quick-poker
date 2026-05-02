# Validate Containerfile

Build the Docker image locally to verify the Containerfile (Dockerfile) compiles and produces a working image.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) is installed and running
- The project has been built locally at least once (so `dist/` and `node_modules/` exist and are up to date)

## Steps

1. Ensure the Docker daemon is running.
2. From the repository root, run:
   ```bash
   docker build -t quick-poker:latest .
   ```
3. Confirm the build completes without errors.
4. Optionally, verify the image runs correctly:
   ```bash
   docker run --rm -p 3000:3000 quick-poker:latest
   ```
   Then open http://localhost:3000 in a browser to confirm the app loads.

## Troubleshooting

- If the build fails during `npm run build`, ensure `npm install` and `npm run build` succeed locally first.
- If `npm install` fails in the container, check that `package-lock.json` is in sync with `package.json`.
- To build without cache (clean build): `docker build --no-cache -t quick-poker:latest .`
- To inspect the built image: `docker run --rm -it quick-poker:latest sh`

## Notes

- The Containerfile uses a multi-stage approach implicitly by copying built artifacts.
- The final image runs as the `node` user on port `3000`.
- Keep the image lean — avoid adding unnecessary layers or devDependencies to the final image.
