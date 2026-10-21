/**
 * The MCP stdio server: JSON-RPC over stdin/stdout, nothing else on those pipes.
 *
 * This deliberately implements the protocol by hand instead of pulling in an SDK.
 * The surface an MCP client actually uses for a tool server is small — initialize,
 * tools/list, tools/call, ping, and the shutdown notifications — and writing it
 * here keeps the dependency list at exactly one native module (node-pty) and makes
 * the framing rules visible in one place.
 *
 * ## The framing rules this file must never break
 *
 * stdout carries protocol bytes and nothing else; one unexpected `console.log`
 * corrupts the stream in a way no client can recover from. Diagnostics therefore
 * go to stderr, which is also where a crash's stack trace should land.
 *
 * @module ssh-mcp/server
 */

import { createInterface } from 'node:readline'
import { TOOL_DEFINITIONS, SessionRegistry } from './tools.js'

/**
 * Protocol versions this server can speak, newest first.
 *
 * These are the revisions MCP clients actually ship today; an unknown version in
 * the client's `initialize` is answered with our newest, which the spec requires
 * and which clients handle by downgrading. The SDK that DeepSeek Harness builds on
 * (2025-11-25 and older) rejects anything it does not recognise outright, so
 * advertising a speculative future revision breaks the handshake instead of
 * negotiating — which it did, and is why this list is conservative.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']

/** The version reported when a client asks for something newer than we know. */
const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/** Server identity reported in `initialize`. */
const SERVER_INFO = { name: 'ssh-mcp', version: '0.1.0' }

/** The registry lives for the process, because sessions outlive individual calls. */
const registry = new SessionRegistry()

/**
 * Write one JSON-RPC message as a single line.
 * @param {object} message - the message.
 * @returns {void}
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Answer one request.
 * @param {string|number} id - the request id.
 * @param {unknown} result - the successful result.
 * @returns {void}
 */
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

/**
 * Answer one request with an error.
 * @param {string|number} id - the request id.
 * @param {number} code - JSON-RPC error code.
 * @param {string} message - the human-readable message.
 * @returns {void}
 */
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/**
 * Render one tool result.
 *
 * Tool failures are reported as `isError: true` content rather than JSON-RPC
 * errors, so a model sees the reason in its own conversation instead of the
 * client turning it into a transport failure.
 * @param {string} text - the result body.
 * @param {boolean} [isError] - whether this is a failure.
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}} the result.
 */
function toolResult(text, isError = false) {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

/**
 * Handle one JSON-RPC message.
 * @param {any} message - the parsed message.
 * @returns {Promise<void>} resolves once any reply has been written.
 */
async function handle(message) {
  const { id, method, params } = message ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      // Echo the client's version when we support it; otherwise advertise ours,
      // which the spec requires and which clients handle by downgrading.
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PREFERRED_PROTOCOL_VERSION
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'These tools drive live SSH terminal windows. A window persists across calls, so '
          + 'directory changes and exported variables behave as they do in a human terminal. '
          + 'Type one line at a time with ssh_send; use raw=true for passwords, y/n answers and '
          + 'keystrokes. Always ssh_close when finished.',
      })
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: TOOL_DEFINITIONS.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return
    case 'tools/call': {
      const name = String(params?.name ?? '')
      const args = params?.arguments ?? {}
      try {
        const text = await registry.call(name, args)
        reply(id, toolResult(text))
      } catch (error) {
        reply(id, toolResult(`${name} failed: ${String(error?.message ?? error)}`, true))
      }
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      if (isNotification) return
      replyError(id, -32601, `Method not found: ${String(method)}`)
  }
}

/**
 * Shut everything down: close windows, then the process.
 * @param {number} code - exit code.
 * @returns {Promise<void>} resolves after the sessions are gone.
 */
async function shutdown(code = 0) {
  await Promise.all([...registry.sessions.values()].map(session => session.close().catch(() => {})))
  registry.sessions.clear()
  process.exit(code)
}

/** Start the read loop. */
export function start() {
  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })
  process.on('uncaughtException', (error) => {
    process.stderr.write(`ssh-mcp: uncaught ${error?.stack ?? error}\n`)
    void shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`ssh-mcp: unhandled rejection ${String(reason)}\n`)
  })

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  lines.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      replyError(null, -32700, 'Parse error: expected one JSON object per line.')
      return
    }
    void handle(message).catch((error) => {
      const id = message?.id
      if (id === undefined || id === null) {
        process.stderr.write(`ssh-mcp: notification failed: ${String(error?.stack ?? error)}\n`)
        return
      }
      replyError(id, -32603, String(error?.message ?? error))
    })
  })
  lines.on('close', () => { void shutdown(0) })
}

start()
