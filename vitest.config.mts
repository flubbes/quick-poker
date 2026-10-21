import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["tests/server.test.ts"],
          pool: "forks",
          testTimeout: 10000,
          hookTimeout: 10000,
          env: {
            AUTO_START: "false",
          },
        },
      },
      {
        test: {
          name: "frontend",
          environment: "jsdom",
          include: ["tests/frontend.test.ts"],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
    ],
  },
});
