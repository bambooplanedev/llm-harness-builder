// The `dom` project's environment: .vue files compiled for the browser, not for SSR, so a test can mount a component on
// its own renderer (no DOM, no component-testing dependency). The stubs are for runtime-dom's vModelText, whose
// beforeUpdate tests `el.getRootNode() instanceof Document || ... instanceof ShadowRoot`: a ReferenceError without them.
export default {
  name: 'dom', viteEnvironment: 'client',
  setup() {
    const g = globalThis as Record<string, unknown>
    g.Document ??= class {}; g.ShadowRoot ??= class {}
    return { teardown() { delete g.Document; delete g.ShadowRoot } }
  },
}
