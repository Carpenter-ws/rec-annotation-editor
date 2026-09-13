import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { datasetServerPlugin } from "./plugins/datasetServer";

export default defineConfig({
  plugins: [react(), datasetServerPlugin()],
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "plugins/**/*.test.{ts,tsx}",
    ],
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
