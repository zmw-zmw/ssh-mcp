/**
 * A minimal MCP stdio client, for testing the server the way a client really
 * talks to it: newline-delimited JSON over pipes, in order, with no in-process
 * shortcut that could hide a framing bug.
 *
 * @module ssh-mcp/test/client
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js')

/**
 * A spawned server plus its request/response bookkeeping.
 */
export class McpTestClient {
  constructor() {
    this.nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function}>} pending requests. */
    this.pending = new Map()
    /** @type {Array<object>} every raw message received, for assertions. */
    this.received = []
    this.stderr = ''
    this.child = spawn(process.execPath, [SERVER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk) })
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const message = JSON.parse(line)
      this.received.push(message)
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }

  /**
   * Send a request and await its result.
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - request parameters.
   * @returns {Promise<any>} the result.
   */
  request(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`timed out waiting for ${method}`))
      }, 120_000).unref?.()
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }

  /** Perform the MCP handshake. @returns {Promise<any>} the initialize result. */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'ssh-mcp-test', version: '0.0.0' },
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return result
  }

  /**
   * Call one tool.
   * @param {string} name - tool name.
   * @param {object} [args] - arguments.
   * @returns {Promise<{text: string, isError: boolean}>} flattened result.
   */
  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    const text = (result.content ?? []).map(part => part.text ?? '').join('\n')
    return { text, isError: result.isError === true }
  }

  /** Terminate the server and fail loudly if it complained. @returns {Promise<void>} */
  async close() {
    this.child.stdin.end()
    await new Promise(resolve => {
      if (this.child.exitCode !== null) return resolve()
      this.child.once('exit', resolve)
      setTimeout(() => { this.child.kill(); resolve() }, 5000).unref?.()
    })
  }
}
