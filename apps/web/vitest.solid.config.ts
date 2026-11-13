import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The reactive build of Solid, for the tests that need signals to track and
// effects to re-run. Under node, `solid-js` resolves to its server build,
// where neither happens (see vitest.config.ts for the rest).
const solid = fileURLToPath(new URL("../../node_modules/solid-js/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: `${solid}dist/solid.js` },
      { find: /^solid-js\/store$/, replacement: `${solid}store/dist/store.js` },
      { find: /^solid-js\/universal$/, replacement: `${solid}universal/dist/universal.js` },
      { find: "@desktop", replacement: fileURLToPath(new URL("../desktop/src", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    // The differential suite for in-place updates runs on both builds: the app runs the reactive one.
    include: ["src/**/*.solid.test.ts", "src/engine/external-edit.test.ts"],
    server: { deps: { inline: [/solid-js/] } },
  },
});
