import { defineConfig, configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
// vue() lets a .test.ts import a .vue SFC directly (used by trace-vue.test.ts to catch
// prop-casting regressions without adding a component-testing dependency).
// The `dom` project gets .vue files compiled for the browser, so a test can mount App with its own renderer.
const DOM = ['tests/app-vue.test.ts']
export default defineConfig({ plugins: [vue()], test: { projects: [
  { extends: true, test: { name: 'node', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...DOM] } },
  { extends: true, test: { name: 'dom', include: DOM, environment: './tests/client-env.ts' } },
] } })
