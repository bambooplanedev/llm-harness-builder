import { test, expect } from 'vitest'
import { approvalPrompt, mcpApprovalName, showable, showableText, isShowable, UNTIL_BASH } from '../src/core/events.js'

const bash = (args: Record<string, unknown>) => approvalPrompt({ callId: 'c1', name: 'bash', args })

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

test('the C1 controls, DEL and the format characters are escaped too: JSON.stringify leaves them, and a terminal acts on some', () => {
  // U+009B is an 8-bit CSI: xterm.js and other terminals redraw the line on it just like on ESC [
  expect(bash({ command: 'echo \u009b1G\u009b2K' })).toBe('run bash: "echo \\u009b1G\\u009b2K"')
  expect(bash({ command: 'a\u007fb' })).toBe('run bash: "a\\u007fb"')
  expect(bash({ command: 'ls \u202e' })).toBe('run bash: "ls \\u202e"')
  // every kind of character the escape is for, one by one: C1 (NEL), bidi isolate, line and paragraph separator, zero width, BOM, soft hyphen
  for (const [raw, shown] of [['\u0085', '\\u0085'], ['\u2067', '\\u2067'], ['\u2028', '\\u2028'], ['\u2029', '\\u2029'],
    ['\u200b', '\\u200b'], ['\u200d', '\\u200d'], ['\ufeff', '\\ufeff'], ['\u00ad', '\\u00ad']]) {
    expect(bash({ command: `a${raw}b` })).toBe(`run bash: "a${shown}b"`)
  }
  // an astral format character (a tag character) is shown as its two code units
  expect(bash({ command: 'a\u{e0041}b' })).toBe('run bash: "a\\udb40\\udc41b"')
  // the server name goes through the same escape
  expect(approvalPrompt({ callId: 'm0', name: mcpApprovalName('a\u009b2Kb'), args: { command: 'x' } })).toBe('start mcp server "a\\u009b2Kb": "x"')
  expect(approvalPrompt({ callId: 'u0', name: UNTIL_BASH, args: { command: 'x\u009b1G' } })).toBe('run each time the model says it is done, on files the model has written: "x\\u009b1G"')
})

test('showable leaves no C0 control, DEL or C1 control in what it returns', () => {
  const codes = [...Array(0x20).keys(), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)] // U+0000..U+001F, U+007F..U+009F
  for (const code of codes) expect(showable(String.fromCharCode(code))).toBe('\\u' + code.toString(16).padStart(4, '0'))
})

test('a quote and a backslash in the command stay what they are in JSON, and a missing command is an empty one', () => {
  expect(bash({ command: 'echo "hi" \\ there' })).toBe('run bash: "echo \\"hi\\" \\\\ there"')
  // a backslash-u typed out is not an escaped character: the two are told apart by the doubled backslash
  expect(bash({ command: 'echo \\u009b' })).toBe('run bash: "echo \\\\u009b"')
  expect(bash({})).toBe('run bash: ""')
  expect(approvalPrompt({ callId: 'u0', name: UNTIL_BASH, args: {} })).toBe('run each time the model says it is done, on files the model has written: ""')
})

test('letters, combining accents and emoji stay as they are; only the joiner between emoji is escaped', () => {
  // Cyrillic (as escapes: the repo keeps non-English text out of its sources), accented Latin, a combining accent, CJK, an emoji, an emoji with its variation selector
  for (const kept of ['\u043f\u0440\u0438\u0432\u0456\u0442, \u0441\u0432\u0456\u0442\u0435', 'résumé', 'e\u0301', 'a日本語b', '👍', '❤\ufe0f']) expect(bash({ command: kept })).toBe(`run bash: "${kept}"`)
  expect(bash({ command: '👨\u200d👩' })).toBe('run bash: "👨\\u200d👩"')
})

test('showableText keeps a newline and a tab and escapes everything else showable escapes', () => {
  expect(showableText('one\n\ttwo\n')).toBe('one\n\ttwo\n')
  // a carriage return puts the cursor at the start of the line, and what follows overwrites it
  expect(showableText('a\r\nb')).toBe('a\\u000d\nb')
  expect(showableText('ok\u001b[2K')).toBe('ok\\u001b[2K')
  expect(showableText('a\u009b2Kb')).toBe('a\\u009b2Kb')
  expect(showableText('a\u007fb')).toBe('a\\u007fb')
  expect(showableText('a\u202eb')).toBe('a\\u202eb')
  expect(showableText('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c')
  expect(showableText('a\u{e0041}b')).toBe('a\\udb40\\udc41b')
  // every other C0 control, DEL and every C1 control, by number: escaped exactly as showable escapes it
  const codes = [...Array(0x20).keys(), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)].filter(c => c !== 0x09 && c !== 0x0a)
  for (const code of codes) expect(showableText(String.fromCharCode(code))).toBe(showable(String.fromCharCode(code)))
})

test('showableText leaves text that needs no escape as it is: Cyrillic (as escapes), accented Latin, CJK, emoji', () => {
  for (const kept of ['\u043f\u0440\u0438\u0432\u0456\u0442\n\u0441\u0432\u0456\u0442', 'r\u00e9sum\u00e9\tr\u00e9sum\u00e9', 'e\u0301', 'a\u65e5\u672c\u8a9eb', '\u{1f44d}\n\u{1f44d}', '\u2764\ufe0f']) expect(showableText(kept)).toBe(kept)
})

test('isShowable: true when showable would change nothing, false at the first character it would escape', () => {
  for (const ok of ['', 'plain', 'a b-c_d', 'caf\u00e9', '\u043f\u0440\u0438\u0432\u0456\u0442', 'a\u65e5\u672c\u8a9eb', '\u{1f44d}']) expect(isShowable(ok)).toBe(true)
  for (const bad of ['\n', '\t', 'a\u001b[8mb', 'a\u009bb', 'a\u007fb', 'a\u202eb', 'a\u200bb', 'a\u2028b', 'a\u2029b', '\ufeff', '\u{e0041}']) expect(isShowable(bad)).toBe(false)
})
