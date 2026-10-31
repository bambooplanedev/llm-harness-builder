// What the web shows about evolve's edits. Its own file: evolve.ts pulls in node:crypto, which the page cannot load.

/** The only leaves an edit may touch: knobs whose effect is general. Commands (untilBash), tools, the backend and
 *  notes stay the user's. */
export const ALLOWED = ['systemPrompt', 'loop.maxTurns', 'loop.maxRepeats', 'loop.freshContext', 'loop.repeatTemperature', 'loop.repeatThinkTokens', 'context.maxToolOutputChars', 'context.budgetTokens']

/** What a paragraph may not hold: an address, a path, a backtick, a substitution, a pipe into a shell, a fetch. */
export const DANGER = [/[a-z][a-z0-9+.-]*:\/\//i, /\bwww\./i, /\b[a-z0-9-]+\.(?:com|net|org|io|dev|sh|app|ai|xyz|ru|cn)\b/i, /(?:^|\s)[\/~]/i, /`/, /\$\(/, /\|\s*(?:ba|z)?sh\b/i, /\b(?:curl|wget|nc|ssh|scp)\b/i]

/** Plain names for the allowed fields, for someone who never opened the form's Advanced. */
export const FIELD_LABEL: Record<string, string> = {
  systemPrompt: 'system prompt (a paragraph added)',
  'loop.maxTurns': 'turns a run may take (at most twice the original)',
  'loop.maxRepeats': 'repeats before the loop guard steps in',
  'loop.freshContext': 'fresh context after a repeat',
  'loop.repeatTemperature': 'temperature after a repeat',
  'loop.repeatThinkTokens': 'thinking tokens after a repeat',
  'context.maxToolOutputChars': 'longest tool output kept',
  'context.budgetTokens': 'context budget',
}

/** The report's last line, from the same `better` as its apply step: what the tab offers. The last line is the template's, never the proposer's text. */
export const outcomeOf = (report: string): 'use' | 'try' | 'keep' | undefined => /(?:^|\n)outcome: (use|try|keep)\n?$/.exec(report)?.[1] as 'use' | 'try' | 'keep' | undefined

const TESTS = /\b(tests?|check(s|ed)?|assert\w*|skip\w*|pytest|vitest|jest|npm test)\b/i
/** Each line of a paragraph, flagged when it looks like a command or talks about the tests a change is judged by. */
export const flagLines = (text: string): { line: string; flag?: 'command' | 'tests' }[] =>
  text.split('\n').map(line => DANGER.some(re => re.test(line)) ? { line, flag: 'command' } : TESTS.test(line) ? { line, flag: 'tests' } : { line })
