import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native speech sources and staged runtime dependencies are build inputs,
    // not the desktop application's tests.
    include: ['src/**/*.test.ts'],
    // Source/compiler tests are memory-heavy and filesystem watchers need a
    // responsive event loop. Keep parallel workers bounded on developer Macs.
    maxWorkers: 2,
  },
});
