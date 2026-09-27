import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "model",
          include: ["test/model/**/*.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
