// A made-up API with no `messages`: the request is { model, prompt, history: string[] }, the reply { text }.
// The test of own dialect files records it; nothing here comes from the package.
export default {
  id: 'no-messages',
  label: 'POST /complete',
  matches: (method, pathname) => method === 'POST' && pathname.endsWith('/complete'),
  keyOf: p => ({ key: String(p.prompt ?? ''), taskText: String(p.prompt ?? ''), len: Array.isArray(p.history) ? p.history.length : 0, model: String(p.model ?? '') }),
  toolResults: () => [],
  async readReply(chunks) {
    const r = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return { content: String(r.text ?? ''), toolCalls: [] }
  },
  partial: async chunks => Buffer.concat(chunks).toString('utf8'),
}
