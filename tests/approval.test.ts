import { test, expect } from 'vitest'
import { approvalPrompt, mcpApprovalName, UNTIL_BASH } from '../src/core/events.js'

test('three kinds of question, each naming what will run', () => {
  expect(approvalPrompt({ callId: 'm0', name: mcpApprovalName('fs'), args: { command: 'npx -y server .' } })).toBe('start mcp server "fs": "npx -y server ."')
  expect(approvalPrompt({ callId: 'u0', name: UNTIL_BASH, args: { command: 'npm test' } })).toBe('run each time the model says it is done, on files the model has written: "npm test"')
  expect(approvalPrompt({ callId: 'c1', name: 'bash', args: { command: 'ls -la' } })).toBe('run bash: "ls -la"')
})

test('a command or a server name cannot redraw the question: control characters come out escaped', () => {
  const q = approvalPrompt({ callId: 'c1', name: 'bash', args: { command: 'rm -rf ~\r\u001b[2Kls -la\nmore' } })
  expect(q).toBe('run bash: "rm -rf ~\\r\\u001b[2Kls -la\\nmore"')
  expect(q).not.toMatch(/[\u0000-\u001f]/)
  expect(approvalPrompt({ callId: 'm0', name: mcpApprovalName('a\u001b[2Kb'), args: { command: 'x' } })).toBe('start mcp server "a\\u001b[2Kb": "x"')
})
