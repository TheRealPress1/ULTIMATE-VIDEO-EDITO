import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@desktop": fileURLToPath(new URL("../desktop/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests of what needs the reactive build of Solid run under vitest.solid.config.ts.
    exclude: [...configDefaults.exclude, "src/**/*.solid.test.ts"],
  },
});
