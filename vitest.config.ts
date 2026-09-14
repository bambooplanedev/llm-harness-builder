import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
// vue() lets a .test.ts import a .vue SFC directly (used by trace-vue.test.ts to catch
// prop-casting regressions without adding a component-testing dependency).
export default defineConfig({ plugins: [vue()], test: { include: ['tests/**/*.test.ts'] } })
