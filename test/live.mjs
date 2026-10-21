/**
 * Exercise the server the way a real MCP client does: spawn it, handshake, then
 * drive a live SSH window through every tool. This is the "does it actually work
 * end to end" check, as opposed to the unit tests that only cover pure functions.
 *
 *   node test/live.mjs zmw@127.0.0.1 22223
 *
 * Needs a host reachable without a password prompt; see test/e2e.mjs.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js')
const host = process.argv[2] ?? 'localhost'
const port = process.argv[3] === undefined ? undefined : Number(process.argv[3])

const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map()
const sent = []
let buffer = ''
let stderr = ''
child.stderr.on('data', chunk => { stderr += String(chunk) })
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let at
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    sent.push(message)
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  }
})

let nextId = 1
/** @returns {Promise<any>} */
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000).unref?.()
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
/** @returns {void} */
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}
/** @returns {string} */
function textOf(response) {
  return (response.result?.content ?? []).map(part => part.text ?? '').join('\n')
}

const started = Date.now()
let session
try {
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'live-check', version: '0.0.0' },
  })
  notify('notifications/initialized')
  console.log(`initialize     ${init.result.protocolVersion}  (${init.result.serverInfo.name})`)

  const list = await request('tools/list', {})
  console.log(`tools/list     ${list.result.tools.map(tool => tool.name).join(', ')}`)

  const opened = await request('tools/call', {
    name: 'ssh_open',
    arguments: { host, ...(port === undefined ? {} : { port }), name: 'live' },
  })
  console.log(`\n--- ssh_open ---\n${textOf(opened)}`)
  session = textOf(opened).match(/session (ssh_[0-9a-z]+)/)?.[1]
  if (!session) throw new Error('ssh_open returned no session id')

  const steps = [
    ['echo', { line: 'echo hello-from-mcp' }],
    ['failing command', { line: 'cmd /c exit 7' }],
    ['pipe', { line: 'echo abc | findstr abc' }],
    ['state kept across calls', { line: 'cd C:\\Windows & cd' }],
  ]
  for (const [label, args] of steps) {
    const result = await request('tools/call', { name: 'ssh_send', arguments: { session, ...args } })
    console.log(`\n--- ${label} ---\n${textOf(result)}`)
  }

  const screen = await request('tools/call', { name: 'ssh_read', arguments: { session, lines: 15 } })
  console.log(`\n--- ssh_read ---\n${textOf(screen)}`)

  const windows = await request('tools/call', { name: 'ssh_list', arguments: {} })
  console.log(`\n--- ssh_list ---\n${textOf(windows)}`)

  const closed = await request('tools/call', { name: 'ssh_close', arguments: { session } })
  console.log(`\n--- ssh_close ---\n${textOf(closed)}`)
  session = undefined

  console.log(`\nstderr: ${stderr.trim() === '' ? '(clean)' : stderr.trim()}`)
  console.log(`elapsed: ${Date.now() - started}ms`)
  child.stdin.end()
  process.exit(0)
} catch (error) {
  if (session) {
    await request('tools/call', { name: 'ssh_close', arguments: { session } }).catch(() => {})
  }
  console.error(`\nFAILED: ${error?.message ?? error}`)
  if (stderr.trim()) console.error(`server stderr:\n${stderr}`)
  child.kill()
  process.exit(1)
}
