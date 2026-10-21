/**
 * End-to-end test: spawn the real server, speak MCP to it over pipes, and drive a
 * real SSH window against a host.
 *
 * The host is the caller's choice, because there is no safe default: point it at a
 * machine this process can already log in to without a password prompt. On Windows
 * with OpenSSH Server running, `localhost` is usually right.
 *
 *   node test/e2e.mjs                       # localhost
 *   node test/e2e.mjs user@192.168.1.35     # any host with a key already loaded
 *
 * Every window opened here is closed before the script exits.
 *
 * @module ssh-mcp/test/e2e
 */

import assert from 'node:assert/strict'
import { McpTestClient } from './client.mjs'

const target = process.argv[2] ?? 'localhost'
const port = process.argv[3] === undefined ? undefined : Number(process.argv[3])
console.log(`e2e target: ${target}${port === undefined ? '' : ` port ${port}`}\n`)

/** @param {string} label @param {() => Promise<void>} fn */
async function step(label, fn) {
  const started = Date.now()
  await fn()
  console.log(`ok  ${label} (${Date.now() - started}ms)`)
}

const client = new McpTestClient()
let session
/** @type {string} the ssh_open result, used to learn the remote dialect. */
let openedText = ''

try {
  await step('handshake advertises tools capability', async () => {
    const result = await client.initialize()
    assert.equal(result.serverInfo.name, 'ssh-mcp')
    assert.ok(result.capabilities.tools)
    assert.match(result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/)
  })

  await step('tools/list publishes exactly the six verbs', async () => {
    const { tools } = await client.request('tools/list')
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      ['ssh_close', 'ssh_list', 'ssh_open', 'ssh_read', 'ssh_resize', 'ssh_send'],
    )
    for (const tool of tools) assert.equal(tool.inputSchema.type, 'object')
  })

  await step('unknown tool is rejected without killing the server', async () => {
    const result = await client.callTool('ssh_nope', {})
    assert.equal(result.isError, true)
    assert.match(result.text, /Unknown tool/)
    await client.request('ping')
  })

  await step('strict arguments reject an undeclared field', async () => {
    const result = await client.callTool('ssh_open', { host: 'x', nope: 1 })
    assert.equal(result.isError, true)
    assert.match(result.text, /does not accept "nope"/)
  })

  await step(`ssh_open connects to ${target}${port === undefined ? '' : `:${port}`}`, async () => {
    const result = await client.callTool('ssh_open', {
      host: target,
      ...(port === undefined ? {} : { port }),
      name: 'e2e',
      cols: 160,
      rows: 40,
    })
    assert.equal(result.isError, false, result.text)
    openedText = result.text
    const match = result.text.match(/session (ssh_[0-9a-z]+)/)
    assert.ok(match, `no session id in:\n${result.text}`)
    session = match[1]
  })

  await step('a command returns its real output and exit status', async () => {
    const result = await client.callTool('ssh_send', { session, line: 'echo ssh-mcp-alive' })
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /ssh-mcp-alive/)
    assert.match(result.text, /exit 0/)
  })

  // The remote shell decides how a failure and a variable are spelled.
  const isCmd = /cmd\.exe \(Windows\)/.test(openedText)

  await step('a failing command reports its non-zero status', async () => {
    // The wrapper ends with a `call`-delimited status precisely so cmd reports the
    // middle command's code; `cmd /c exit 1` is the shortest failure that cannot
    // close the interactive session.
    const line = isCmd ? 'cmd /c exit 1' : 'false'
    const result = await client.callTool('ssh_send', { session, line })
    assert.match(result.text, /exit [1-9]/, result.text)
  })

  await step('the window keeps state between calls like a human terminal', async () => {
    if (isCmd) {
      await client.callTool('ssh_send', { session, line: 'set SSHMCPMARK=kept' })
      const result = await client.callTool('ssh_send', { session, line: 'echo %SSHMCPMARK%' })
      assert.match(result.text, /kept/)
    } else {
      await client.callTool('ssh_send', { session, line: 'export SSHMCPMARK=kept' })
      const result = await client.callTool('ssh_send', { session, line: 'echo $SSHMCPMARK' })
      assert.match(result.text, /kept/)
    }
  })

  await step('quotes are not nested as they would be through a shell -c wrapper', async () => {
    if (isCmd) {
      // cmd has no single-quote syntax; the point here is that the outer layer
      // adds no escaping of its own.
      const result = await client.callTool('ssh_send', { session, line: 'echo he said "hi" and \'that\'' })
      assert.match(result.text, /he said "hi" and 'that'/)
    } else {
      const result = await client.callTool('ssh_send', { session, line: `echo "he said \\"hi\\" and 'that'"` })
      assert.match(result.text, /he said "hi" and 'that'/)
    }
  })

  await step('stdout and stderr arrive in the order they were written', async () => {
    const line = isCmd ? 'echo one& echo two 1>&2& echo three' : 'echo one; echo two >&2; echo three'
    const result = await client.callTool('ssh_send', { session, line })
    const body = result.text
    assert.ok(body.indexOf('one') < body.indexOf('two'), body)
    assert.ok(body.indexOf('two') < body.indexOf('three'), body)
  })

  await step('a small shell loop is handled in one line', async () => {
    // cmd has no one-line loop: it expands `%i` once for the whole line, and
    // delayed expansion needs a nested `cmd /v:on` whose `!` survives another
    // expansion. Powershell exists on every Windows host and loops on one line,
    // which is exactly what this test is about: a loop reaching the shell intact.
    const line = isCmd
      ? 'powershell -NoProfile -Command "1..3 | ForEach-Object { \\"n=$_\\" }"'
      : 'for i in 1 2 3; do echo "n=$i"; done'
    const result = await client.callTool('ssh_send', { session, line })
    assert.match(result.text, /n=1[\s\S]*n=2[\s\S]*n=3/, result.text)
  })

  await step('long output is trimmed to the tail with an omission count', async () => {
    // 500 lines from one command, in whichever shell can express that cleanly.
    const line = isCmd
      ? 'powershell -NoProfile -Command "1..500 | ForEach-Object { \\"row $_\\" }"'
      : 'for i in $(seq 1 500); do echo "row $i"; done'
    const result = await client.callTool('ssh_send', { session, line, lines: 20 })
    assert.match(result.text, /row 500/, result.text)
    assert.match(result.text, /earlier lines omitted/)
  })

  await step('ssh_read shows the screen without typing', async () => {
    const result = await client.callTool('ssh_read', { session, lines: 30 })
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /\[e2e\]/)
    assert.match(result.text, /row 500/)
  })

  await step('ssh_resize changes the geometry', async () => {
    const result = await client.callTool('ssh_resize', { session, cols: 120, rows: 30 })
    assert.match(result.text, /120x30/)
  })

  await step('ssh_list reports the open window', async () => {
    const result = await client.callTool('ssh_list', {})
    assert.match(result.text, new RegExp(session))
    assert.match(result.text, /live/)
  })

  await step('an interactive answer can be typed with raw=true', async () => {
    // A bare Enter at the prompt is the cheapest interactive keystroke: it proves
    // raw input reaches the shell without wrapping and without being reported as
    // command output.
    const result = await client.callTool('ssh_send', { session, line: '', raw: true })
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /typed/)
  })

  await step('a destructive command is annotated', async () => {
    // Harmless by construction: it targets a path that does not exist.
    const result = await client.callTool('ssh_send', { session, line: 'rm -rf /nonexistent-ssh-mcp-probe' })
    assert.match(result.text, /This looks destructive/)
  })

  await step('ssh_close ends the window, and a later call says so', async () => {
    const closed = await client.callTool('ssh_close', { session })
    assert.match(closed.text, /closed/)
    const after = await client.callTool('ssh_read', { session })
    assert.equal(after.isError, true)
    assert.match(after.text, /No such session/)
  })
} catch (error) {
  if (session) await client.callTool('ssh_close', { session }).catch(() => {})
  await client.close()
  if (client.stderr.trim() !== '') console.error(`\nserver stderr:\n${client.stderr}`)
  console.error(`\nFAILED: ${error?.message ?? error}`)
  process.exit(1)
}

const leftovers = await client.callTool('ssh_list', {})
if (!leftovers.text.includes('No windows are open')) {
  console.error(`\nleaked windows:\n${leftovers.text}`)
  await client.close()
  process.exit(1)
}
await client.close()
if (client.stderr.trim() !== '') {
  console.error(`\nserver wrote to stderr:\n${client.stderr}`)
  process.exit(1)
}
console.log('\nall end-to-end checks passed; no windows left open')

