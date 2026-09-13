// Minimal MCP stdio server for tests. A real child process, not a mock.
//   --die-after=N   exit(1) instead of answering the (N+1)-th tools/call
//   --hang          never answer initialize (for the handshake-timeout test)
// Everything else is selected by the tool NAME the client calls, so one process covers every case.
import { createInterface } from 'node:readline'

const num = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d }
const dieAfter = num('die-after', Infinity)
const hang = process.argv.includes('--hang')

const TOOLS = [
  { name: 'echo', description: 'Echo text back.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'picture', description: 'Returns an image block after some text.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'silent', description: 'Returns no content at all.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'rpcfail', description: 'Answers with a JSON-RPC error.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'noisy', description: 'Writes an unparseable line before its answer.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'weird', description: 'Its schema is not an object.', inputSchema: { type: 'string' } },
  { name: 'stall', description: 'Never answers.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'flood', description: 'Writes stdout with no newline, forever, and never answers.', inputSchema: { type: 'object', properties: {}, required: [] } },
]

const out = o => process.stdout.write(JSON.stringify(o) + '\n')
const ok = (id, result) => out({ jsonrpc: '2.0', id, result })
const text = (id, s) => ok(id, { content: [{ type: 'text', text: s }] })

let calls = 0
createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    if (hang) return
    return ok(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
  }
  if (m.method === 'notifications/initialized') return
  if (m.method === 'tools/list') return ok(m.id, { tools: TOOLS })
  if (m.method === 'tools/call') {
    if (++calls > dieAfter) process.exit(1)
    const n = m.params?.name
    if (n === 'boom') return ok(m.id, { isError: true, content: [{ type: 'text', text: 'it failed' }] })
    if (n === 'picture') return ok(m.id, { content: [{ type: 'text', text: 'before' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] })
    if (n === 'silent') return ok(m.id, { content: [] })
    if (n === 'rpcfail') return out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'bad arguments' } })
    if (n === 'noisy') { process.stdout.write('this is not json\n'); return text(m.id, 'noisy ok') }
    if (n === 'stall') return   // never answer
    if (n === 'flood') { setInterval(() => process.stdout.write('x'.repeat(1 << 18)), 5); return }
    return text(m.id, `echo: ${m.params?.arguments?.text ?? ''}`)
  }
})
process.stderr.write('fake mcp server up\n')
