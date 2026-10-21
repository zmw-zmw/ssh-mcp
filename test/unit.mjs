/**
 * Unit tests for the pure pieces: marker spans, echo dropping, screen trimming,
 * dialect detection, and the two shell wrappers. These run without a network or a
 * terminal, which is why they come first.
 *
 * Run: node test/unit.mjs
 */

import assert from 'node:assert/strict'
import { breakGluedPrompts, dropEcho, renderResult, splitSpan, stripControl, tailLines } from '../src/screen.js'
import { endsWithCmdPrompt, instrumentationLine, marker, wrapCommand } from '../src/dialect.js'
import { awaitingInput, looksFailed, redact } from '../src/tools.js'

const markers = { BEGIN: 'zb', END: 'ze' }
let checks = 0
/** @param {string} label @param {() => void} fn */
function check(label, fn) {
  fn()
  checks += 1
  console.log(`ok  ${label}`)
}

check('collapses a carriage-return redraw to its last draw', () => {
  assert.equal(stripControl('10%\r50%\r100%'), '100%')
})

check('keeps CRLF as a line ending', () => {
  assert.equal(stripControl('a\r\nb\r\n'), 'a\nb\n')
})

check('removes ANSI colour', () => {
  assert.equal(stripControl('\u001b[32mok\u001b[0m'), 'ok')
})

check('splits a POSIX marker span into output and status', () => {
  const raw = 'printf \'\\nzb\\n\'; ls; printf \'\\nze%d\\n\' $?\r\n\r\nzb\r\n\r\nfile1  file2\r\n\r\nze0\r\n'
  const parsed = splitSpan(raw, markers)
  assert.equal(parsed.output, 'file1  file2')
  assert.equal(parsed.exitStatus, '0')
})

check('splits a cmd marker span into output and a normalised status', () => {
  const ok = splitSpan('echo.&echo zb&echo hi&&echo ze OK||echo ze FAILED&echo.\r\n\r\nzb\r\nhi\r\nze OK\r\n\r\nC:\\Users\\m>\r\n', markers)
  assert.equal(ok.output, 'hi')
  assert.equal(ok.exitStatus, '0')
  const failed = splitSpan('echo.&echo zb&cmd /c exit 1&&echo ze OK||echo ze FAILED&echo.\r\n\r\nzb\r\nze FAILED\r\n', markers)
  assert.equal(failed.exitStatus, '1')
})

check('reports a non-zero status', () => {
  const parsed = splitSpan('zb\n\nze2\n', markers)
  assert.equal(parsed.exitStatus, '2')
  assert.equal(parsed.output, '')
})

check('uses the last end marker, so an echoed marker cannot end the span early', () => {
  const parsed = splitSpan('zb\nhit ze here\nze7\n', markers)
  assert.equal(parsed.exitStatus, '7')
  assert.match(parsed.output, /hit ze here/)
})

check('returns the whole span when markers are missing', () => {
  const parsed = splitSpan('just some output', markers)
  assert.equal(parsed.output, 'just some output')
  assert.equal(parsed.exitStatus, '')
})

check('drops only the last echo of the typed line', () => {
  assert.equal(dropEcho('a\nb\na\n', 'a'), 'a\nb\n\n')
})

check('breaks a prompt glued onto a marker status', () => {
  const fused = 'ze OKzmw@ZMW C:\\Users\\me>echo.&echo zb'
  assert.equal(breakGluedPrompts(fused, markers), 'ze OK\nzmw@ZMW C:\\Users\\me>echo.&echo zb')
})

check('leaves an already-separated line alone', () => {
  assert.equal(breakGluedPrompts('ze OK\nzmw@ZMW C:\\me>', markers), 'ze OK\nzmw@ZMW C:\\me>')
})

check('does not touch ordinary output', () => {
  assert.equal(breakGluedPrompts('root@vps:~#ls', markers), 'root@vps:~#ls')
})

check('keeps the tail and counts the omission', () => {
  const { text, dropped } = tailLines('1\n2\n3\n4', 2)
  assert.equal(text, '3\n4')
  assert.equal(dropped, 2)
})

check('leaves short text untouched', () => {
  const { text, dropped } = tailLines('1\n2', 5)
  assert.equal(text, '1\n2')
  assert.equal(dropped, 0)
})

check('renders a header with session, status and note', () => {
  const text = renderResult({ session: 'vps', output: 'hi', exitStatus: '0', dropped: 3, note: '(partial)' })
  assert.equal(text, '[vps] exit 0 (3 earlier lines omitted) (partial)\nhi')
})

check('says so when a command printed nothing', () => {
  assert.equal(renderResult({ session: 'vps', output: '  ' }), '[vps]\n(no output)')
})

check('recognises a cmd.exe prompt glued to a banner line', () => {
  assert.equal(endsWithCmdPrompt('(c) Microsoft Corporation.\r\nzmw@ZMW C:\\Users\\zmw>'), true)
})

check('does not mistake a POSIX prompt for cmd.exe', () => {
  assert.equal(endsWithCmdPrompt('root@vps:~#'), false)
  assert.equal(endsWithCmdPrompt('C:\\Users\\me>'), true)
})

check('wraps a POSIX command with printf and $?', () => {
  assert.equal(wrapCommand('ls', 'posix', markers), "printf '\\nzb\\n'; ls; printf '\\nze%d\\n' $?")
})

check('wraps a cmd command with && / || status markers', () => {
  const wrapped = wrapCommand('dir', 'cmd', markers)
  assert.equal(wrapped, 'echo.&echo zb&dir&&echo ze OK||echo ze FAILED&echo.')
  // `%errorlevel%` is unusable at an interactive prompt: cmd expands it before
  // the command runs, so a failing command would report 0.
  assert.ok(!wrapped.includes('errorlevel'))
  assert.ok(!wrapped.includes('%%'))
})

check('markers are lower-case alphanumerics that no shell expands', () => {
  for (let i = 0; i < 50; i += 1) {
    const token = marker('begin')
    assert.match(token, /^[a-z][a-z0-9]{7}$/)
    assert.ok(!token.includes('_'))
    assert.ok(!token.includes('%'))
  }
})

check('only POSIX sessions need a shell setup line', () => {
  assert.match(instrumentationLine('posix'), /PS1/)
  assert.equal(instrumentationLine('cmd'), '')
})

// The checks below cover the guard that was missing when a password got typed into
// a live shell: the caller answered a prompt that had not arrived yet.
check('recognises a password prompt', () => {
  assert.equal(awaitingInput('zmw@host\'s password: '), true)
  assert.equal(awaitingInput('Enter passphrase for key \'/home/me/.ssh/id_ed25519\': '), true)
})

check('recognises a host-key question', () => {
  assert.equal(awaitingInput('Are you sure you want to continue connecting (yes/no/[fingerprint])? '), true)
})

check('does not treat a normal shell prompt as a question', () => {
  assert.equal(awaitingInput('zmw@vps:~$ '), false)
  assert.equal(awaitingInput('Welcome to Ubuntu\r\nzmw@vps:~$ '), false)
})

check('does not treat ordinary output mentioning password as a prompt', () => {
  // A completed login banner or a document that merely says "password:" is not a
  // question being asked right now; these must not unlock a secret.
  assert.equal(awaitingInput('Last failed login: wrong password\nzmw@vps:~$ '), false)
})

check('recognises an SSH-level failure', () => {
  assert.equal(looksFailed('Permission denied (publickey,password).'), true)
  assert.equal(looksFailed('ssh: connect to host 1.2.3.4 port 22: Connection refused'), true)
  assert.equal(looksFailed('zmw@vps:~$ '), false)
})

check('redacts a secret wherever it appears', () => {
  assert.equal(redact('pw=abc123 done abc123', 'abc123'), 'pw=<redacted> done <redacted>')
  assert.equal(redact('no secret here', ''), 'no secret here')
})

console.log(`\n${checks} unit checks passed`)
