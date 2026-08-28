import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The content script's whole job is reading someone else's DOM, so its
    // tests need a DOM to read.
    environment: "jsdom",
  },
});
