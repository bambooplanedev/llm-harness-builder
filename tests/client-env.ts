// The `dom` project's environment: .vue files compiled for the browser, not for SSR, so a test can mount a component on
// its own renderer (no DOM, no component-testing dependency). Vue's v-model checks `instanceof Document`, hence the stubs.
export default {
  name: 'dom', viteEnvironment: 'client',
  setup() {
    const g = globalThis as Record<string, unknown>
    g.Document ??= class {}; g.ShadowRoot ??= class {}
    return { teardown() { delete g.Document; delete g.ShadowRoot } }
  },
}
