import { test, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Trace from '../web/src/Trace.vue'
import type { HarnessEvent } from '../src/core/events.js'

const events: HarnessEvent[] = [
  { seq: 0, turn: 0, ts: 0, type: 'approval_required', call: { callId: 'mcp1', name: 'mcp:fs', args: { command: 'npx server' } } },
]
const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp(Trace, { events, live: {}, task: 'x', ...props }))

// App.vue's live Workbench never passes :approvable at all (only Bench.vue/Diff.vue pass
// :approvable="false" for a finished, replayed trace). A plain `approvable?: boolean` prop
// is a Boolean-typed prop to Vue, and Vue casts an ABSENT Boolean-typed prop to `false` --
// so omitting the prop must behave like "live and approvable", not like Bench's `false`.
test('omitting approvable renders live Run/Deny buttons, not the bench auto-approved text', async () => {
  const html = await render({})
  expect(html).toContain('<button>Run</button>')
  expect(html).not.toContain('auto-approved')
})

test('approvable=false (Bench/Diff replay) still renders the auto-approved text', async () => {
  const html = await render({ approvable: false })
  expect(html).toContain('auto-approved')
  expect(html).not.toContain('<button>Run</button>')
})
