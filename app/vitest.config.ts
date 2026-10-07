import { configDefaults, defineConfig } from 'vitest/config'

// Upstream's `ui` project, minus its Electron-native project (no electron/ here).
export default defineConfig({
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'ui',
          environment: 'jsdom',
          // Keep padding regressions observable instead of mocking the stylesheet away.
          css: { include: [/status-stack\.css$/] },
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [
            ...configDefaults.exclude,
            // Reads hermes_cli/config_defaults.py from the hermes-agent monorepo root.
            'src/plugins/hermes-bots/relay-deliver-budget.test.ts'
          ],
          globals: true,
          testTimeout: 15_000,
          hookTimeout: 30_000
        }
      }
    ]
  }
})
