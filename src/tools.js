/**
 * The model-facing tools: six verbs, one window each.
 *
 * The interface is deliberately tiny, because the whole point of this server is
 * that a model stops composing `bash -c "ssh host \"...\""` with three levels of
 * quoting and starts doing what a person does: open a window, type, look.
 *
 *     ssh_open   → allocate a window and connect
 *     ssh_send   → type a command, get back what it printed
 *     ssh_read   → look up the screen without typing anything
 *     ssh_resize → change the window geometry
 *     ssh_list   → what windows exist
 *     ssh_close  → close a window
 *
 * Every tool returns text, and every result leads with the same header
 * `[session] exit N (…)` so a model can parse the outcome without reading the
 * body.
 *
 * @module ssh-mcp/tools
 */

import { randomBytes } from 'node:crypto'
import { SshSession } from './session.js'
import { MARKERS } from './session.js'
import { breakGluedPrompts, dropEcho, joinWrappedLines, renderResult, splitSpan, stripControl, tailLines } from './screen.js'
import { endsWithCmdPrompt } from './dialect.js'

/** Default wait for one command to finish before returning partial output. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** How long an interactive keystroke answer may take to echo back. */
const INTERACTIVE_SETTLE_MS = 1_500

/**
 * How long `ssh_open` waits for the connection to reach a decision.
 *
 * A fixed wait is wrong in both directions: on a fast LAN three seconds wastes
 * time, and on a slow or distant host it returns before ssh has even asked for a
 * password — which is what happened against a real VPS, leaving the caller to
 * "answer" a prompt that had not appeared yet. So the wait is a ceiling, and the
 * loop below stops early the moment the screen reaches a settled state.
 */
const CONNECT_TIMEOUT_MS = 15_000

/** How long the screen must be unchanged before `ssh_open` calls it settled. */
const SCREEN_QUIET_MS = 700

/** The number of lines a screen read keeps by default. */
const DEFAULT_SCREEN_LINES = 200

/**
 * Commands that end or reconfigure the session a user is relying on.
 *
 * This is a *warning* list, not a policy engine: it exists so `ssh_send` can tell
 * the model "this is the kind of command a human double-checks first". The actual
 * decision to run it belongs to the user, and the server never blocks on it.
 */
const DESTRUCTIVE_PATTERNS = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*)/, why: 'recursive delete of a system or home path' },
  { pattern: /\bmkfs(\.\w+)?\b/, why: 'formatting a filesystem' },
  { pattern: /\bdd\b[^|]*\bof=\/dev\/[sh]d/, why: 'raw write to a disk device' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, why: 'raw redirect onto a disk device' },
  { pattern: /\b(iptables|nft)\b[^|;]*(\s-F\b|\s--flush\b|-X\b)/, why: 'flushing firewall rules' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, why: 'taking the host down' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\b/, why: 'stopping a service' },
  { pattern: /\bchmod\s+-R\s+777\s+\/(?!\w)/, why: 'world-writable recursion on root' },
  { pattern: /\bchown\s+-R\s+\S+\s+\/(?!\w)/, why: 'taking ownership of root recursively' },
  { pattern: /\buserdel\b|\bpasswd\s+root\b/, why: 'changing the ability to log in' },
  { pattern: /\b:\(\)\s*\{.*\};:/, why: 'fork bomb' },
]

/**
 * The JSON Schemas a model is shown, and the single implementation of each.
 *
 * One array means the schema and its handler cannot drift apart, which is this
 * file's only real invariant: `tools/list` and `tools/call` are two views of the
 * same data structure.
 * @type {ReadonlyArray<{name: string, description: string, inputSchema: object, run: Function}>}
 */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'ssh_open',
    description:
      'Open a live SSH terminal window to one host. Returns a session id and whatever the '
      + 'screen showed while connecting — a login banner, a password prompt, or a host-key '
      + 'question. If a password or a yes/no question is on screen, answer it with ssh_send. '
      + 'The window stays open across calls until ssh_close, so directory changes and exported '
      + 'variables persist exactly as they would in a human terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'SSH target: "user@host" or a ~/.ssh/config alias.' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'SSH port, when it is not 22.' },
        name: { type: 'string', description: 'A short label for this window, e.g. "vps". Defaults to the host.' },
        cols: { type: 'integer', minimum: 20, maximum: 1000, description: 'Terminal width, default 200.' },
        rows: { type: 'integer', minimum: 5, maximum: 500, description: 'Terminal height, default 50.' },
      },
      required: ['host'],
      additionalProperties: false,
    },
  },
  {
    name: 'ssh_send',
    description:
      'Type one line into a window and return what it printed. The line runs in the remote '
      + 'shell exactly as typed, so quotes, pipes and && behave as they would at a prompt — '
      + 'no extra escaping layer. Completion is detected by a marker the remote shell prints '
      + 'after the command, so the exit status is real rather than inferred. Use raw=true for '
      + 'keystrokes that are not commands (a "y", a Control-C as "\\u0003"); use secret=true for '
      + 'a password or passphrase, which only works while the screen is actually asking for one '
      + 'and is never echoed back into the result.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id from ssh_open.' },
        line: { type: 'string', description: 'The text to type. Include no trailing newline; it is added.' },
        raw: {
          type: 'boolean',
          description:
            'Type the line verbatim without marker wrapping: y/n answers, Ctrl-C, or keystrokes for '
            + 'an interactive program. Default false. Do not use this for passwords — use secret.',
        },
        secret: {
          type: 'boolean',
          description:
            'Type a password or passphrase verbatim. Rejected unless the screen is showing a '
            + 'password/passphrase/host-key question, and the value is redacted from the result. '
            + 'Default false.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'How long to wait for the command to finish before returning partial output. Default 30000.',
        },
        lines: {
          type: 'integer',
          minimum: 10,
          maximum: 2000,
          description: 'Maximum output lines returned; the tail is kept. Default 200.',
        },
      },
      required: ['session', 'line'],
      additionalProperties: false,
    },
  },
  {
    name: 'ssh_read',
    description:
      'Look at a window without typing anything: the last N lines currently on screen, with '
      + 'control sequences removed. Use it after a long-running command, to re-read output '
      + 'that scrolled away, or to check whether a prompt is waiting for input.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id from ssh_open.' },
        lines: {
          type: 'integer',
          minimum: 10,
          maximum: 2000,
          description: 'How many lines from the bottom to return. Default 200.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'ssh_resize',
    description: 'Change a window\'s geometry, which matters for full-screen programs like top, vim or less.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id from ssh_open.' },
        cols: { type: 'integer', minimum: 20, maximum: 1000 },
        rows: { type: 'integer', minimum: 5, maximum: 500 },
      },
      required: ['session', 'cols', 'rows'],
      additionalProperties: false,
    },
  },
  {
    name: 'ssh_list',
    description: 'List the open windows: label, host, state, and how long each has been idle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ssh_close',
    description: 'Close a window and end its connection. Always do this when finished so no ssh process lingers.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Session id from ssh_open.' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
])

/** The registry of live windows, one process-wide map. */
export class SessionRegistry {
  constructor({ commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    /** @type {Map<string, SshSession>} sessions by id. */
    this.sessions = new Map()
    this.commandTimeoutMs = commandTimeoutMs
    /** @type {Set<string>} sessions whose marker instrumentation is confirmed. */
    this.instrumented = new Set()
  }

  /** @param {string} id - a session id. @returns {SshSession} */
  require(id) {
    const session = this.sessions.get(id)
    if (!session) {
      const known = [...this.sessions.keys()]
      throw new Error(
        `No such session: ${JSON.stringify(id)}. `
        + (known.length ? `Open sessions: ${known.join(', ')}.` : 'No sessions are open; call ssh_open first.'),
      )
    }
    return session
  }

  /**
   * Execute one tool call.
   * @param {string} name - the tool name.
   * @param {Record<string, unknown>} args - validated-by-the-tool arguments.
   * @returns {Promise<string>} model-facing text.
   */
  async call(name, args) {
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === name)
    if (!definition) throw new Error(`Unknown tool: ${name}`)
    assertArguments(definition, args)
    return definition.run(this, args)
  }
}

/**
 * Reject arguments the schema does not declare, and missing required ones.
 *
 * Strictness here is a feature: a model that invents `host_path` or passes `cwd`
 * learns immediately instead of silently operating on the wrong thing.
 * @param {{inputSchema: object}} definition - the tool being called.
 * @param {unknown} args - raw arguments.
 * @returns {void}
 */
export function assertArguments(definition, args) {
  const schema = definition.inputSchema
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Arguments for ${definition.name} must be an object.`)
  }
  const known = new Set(Object.keys(schema.properties ?? {}))
  const unknown = Object.keys(args).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `${definition.name} does not accept ${unknown.map(key => JSON.stringify(key)).join(', ')}; `
      + `accepted: ${[...known].map(key => JSON.stringify(key)).join(', ') || '(none)'}.`,
    )
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`${definition.name} requires ${JSON.stringify(key)}.`)
  }
}

/** Attach the handlers, one per definition, in one place. @type {Record<string, Function>} */
const HANDLERS = {
  /** Open a window, connect, and return the first screen. */
  async ssh_open(registry, args) {
    const host = String(args.host ?? '').trim()
    if (host === '') throw new Error('host must be a non-empty SSH target.')
    if (/\s/.test(host)) throw new Error('host must not contain whitespace; pass a single target like user@example.com.')
    const session = new SshSession({
      host,
      name: args.name === undefined ? undefined : String(args.name),
      port: args.port === undefined ? undefined : Number(args.port),
      cols: args.cols === undefined ? undefined : Number(args.cols),
      rows: args.rows === undefined ? undefined : Number(args.rows),
    })
    registry.sessions.set(session.id, session)
    session.start()

    // Wait for the connection to reach a *decision* rather than for a fixed span.
    // Three outcomes matter to the caller: a shell prompt (logged in), a password
    // or host-key question (needs an answer), or an error (refused, timed out).
    // Waiting on "the screen stopped changing" covers all three and cannot return
    // before ssh has spoken, which a fixed timeout did.
    await settleConnection(session, CONNECT_TIMEOUT_MS, SCREEN_QUIET_MS)
    // A login is visible as a shell prompt on screen. Detecting it from the
    // screen is honest: it is the same evidence a human uses, and it keeps a
    // password prompt correctly classified as "not logged in yet".
    if (looksLoggedIn(session.scrollback)) session.state = 'live'
    // Which shell is on the other end decides how a command is delimited. Ask the
    // screen first; only a login with a recognizable prompt can be decided this way.
    if (session.state === 'live') session.dialect = detectDialect(session.scrollback)
    const screen = tidyScreen(stripControl(session.scrollback))
    if (session.state === 'live') {
      const armedAt = session.scrollback.length
      session.armMarkers()
      registry.instrumented.add(session.id)
      // The setup line or a consumed newline prints a prompt; wait for it here so
      // the first ssh_send result is not preceded by unrelated output. Note the
      // offset is captured *before* arming: reading the length at call time would
      // read the already-grown screen and return instantly.
      await session.waitForData(armedAt, 600)
      await sleep(150)
    }

    const header = `[${session.name}] session ${session.id} — ${host} — ${session.state}`
    // Say exactly what the screen is waiting for. A caller that has to infer this
    // from a banner is how a password once ended up typed into a live shell.
    const hint = session.state === 'live'
      ? `You are logged in to a ${session.dialect === 'cmd' ? 'cmd.exe (Windows)' : 'POSIX'} shell. `
        + 'Type commands with ssh_send.'
      : diagnoseConnect(session)
    return `${header}\n${hint}\n--- screen ---\n${screen || '(empty)'}`
  },

  /** Type one line and return what came back. */
  async ssh_send(registry, args) {
    const session = registry.require(String(args.session))
    if (!session.alive) {
      throw new Error(`Session ${session.id} is closed (${session.endReason ?? 'unknown reason'}); call ssh_open again.`)
    }
    const line = String(args.line ?? '')
    const raw = args.raw === true
    const secret = args.secret === true
    const timeoutMs = args.timeoutMs === undefined ? registry.commandTimeoutMs : Number(args.timeoutMs)
    const lineLimit = args.lines === undefined ? DEFAULT_SCREEN_LINES : Number(args.lines)

    // A secret is only accepted while the screen is actually asking for one. This is
    // the guard that was missing when a password got typed into a live shell: the
    // caller answered a prompt that had not arrived yet. Refusing here turns that
    // mistake into an error instead of an executed command.
    if (secret && !awaitingInput(session.scrollback)) {
      throw new Error(
        'A secret can only be sent while the screen is waiting for one (a password, '
        + 'passphrase or host-key question). Nothing was typed. Call ssh_read and check '
        + 'the screen first.',
      )
    }

    if (raw || secret) {
      const before = session.scrollback.length
      session.write(`${line}\r`)
      await session.waitForData(before, INTERACTIVE_SETTLE_MS)
      await sleep(150)
      const screen = breakGluedPrompts(stripControl(session.scrollback.slice(before)), MARKERS)
      // Typing a secret must never echo it back into the conversation, and a secret
      // prompt usually echoes nothing at all, which is why this is redacted rather
      // than merely dropped.
      const visible = secret ? redact(screen, line) : dropEcho(screen, line)
      const trimmed = visible.trim()
      return `[${session.name}] ${secret ? 'answered (secret not shown)' : 'typed'}\n${trimmed === '' ? '(no echo)' : trimmed}`
    }

    const warning = destructiveWarning(line)
    const offset = session.scrollback.length
    session.sendLine(line)
    const outcome = await waitForMarker(session, offset, timeoutMs)
    const span = session.scrollback.slice(offset)
    const parsed = splitSpan(span, MARKERS)
    // The echoed wrapper wraps at the terminal width; one command's result should
    // read as one logical line per printed line, not as screen rows.
    const logical = joinWrappedLines(parsed.output, session.cols).join('\n')
    const tail = tailLines(logical, lineLimit)
    const note = outcome.kind === 'timeout'
      ? `(still running after ${Math.round(timeoutMs / 1000)}s; use ssh_read or send raw=true to interrupt)`
      : outcome.kind === 'closed' ? `(connection closed: ${session.endReason ?? 'unknown'})` : undefined
    const rendered = renderResult({
      session: session.name,
      output: tail.text,
      exitStatus: outcome.kind === 'marker' ? parsed.exitStatus : '',
      dropped: tail.dropped,
      note,
    })
    return warning === undefined ? rendered : `${rendered}\n\n! ${warning}`
  },

  /** Read the screen without typing. */
  async ssh_read(registry, args) {
    const session = registry.require(String(args.session))
    const limit = args.lines === undefined ? DEFAULT_SCREEN_LINES : Number(args.lines)
    const screen = tidyScreen(breakGluedPrompts(stripControl(session.scrollback), MARKERS)).replace(/\s+$/, '')
    const tail = tailLines(screen, limit)
    const header = `[${session.name}] ${session.state}`
      + (session.alive ? '' : ` (${session.endReason ?? 'closed'})`)
      + (tail.dropped > 0 ? ` (${tail.dropped} lines above omitted)` : '')
    return `${header}\n${tail.text === '' ? '(empty)' : tail.text}`
  },

  /** Change the window geometry. */
  async ssh_resize(registry, args) {
    const session = registry.require(String(args.session))
    const cols = Number(args.cols)
    const rows = Number(args.rows)
    if (!Number.isInteger(cols) || cols < 20 || cols > 1000) throw new Error('cols must be an integer between 20 and 1000.')
    if (!Number.isInteger(rows) || rows < 5 || rows > 500) throw new Error('rows must be an integer between 5 and 500.')
    session.resize(cols, rows)
    return `[${session.name}] resized to ${cols}x${rows}`
  },

  /** List the open windows. */
  async ssh_list(registry) {
    if (registry.sessions.size === 0) return 'No windows are open.'
    const now = Date.now()
    const rows = [...registry.sessions.values()].map(session => {
      const idle = Math.round((now - session.lastActivityAt) / 1000)
      return `${session.id}  ${session.name}  ${session.host}  ${session.state}  idle ${idle}s`
    })
    return `${rows.length} open window(s):\n${rows.join('\n')}`
  },

  /** Close a window. */
  async ssh_close(registry, args) {
    const session = registry.require(String(args.session))
    await session.close()
    registry.sessions.delete(session.id)
    registry.instrumented.delete(session.id)
    return `[${session.name}] closed (${session.endReason ?? 'closed'})`
  },
}

for (const definition of TOOL_DEFINITIONS) {
  const handler = HANDLERS[definition.name]
  if (typeof handler !== 'function') throw new Error(`ssh-mcp: tool ${definition.name} has no handler`)
  Object.defineProperty(definition, 'run', { value: handler, enumerable: false })
}

/**
 * Wait for either the end marker or the connection to go away.
 * @param {SshSession} session - the window.
 * @param {number} offset - where this command's output starts.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<{kind: 'marker'|'timeout'|'closed'}>} how the wait ended.
 */
/**
 * Wait for either the end marker or the connection to go away.
 *
 * The first poll is deliberately not trusted: ConPTY delivers the echo of what we
 * typed asynchronously, so for a few milliseconds after `sendLine` the scrollback
 * is unchanged and still carries the previous command's markers. Reading it there
 * would find a *stale* end marker above our own wrapper and report success against
 * the wrong span. Waiting for the screen to actually grow fixes that at the source.
 *
 * @param {SshSession} session - the window.
 * @param {number} offset - where this command's output starts.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<{kind: 'marker'|'timeout'|'closed'}>} how the wait ended.
 */
async function waitForMarker(session, offset, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (!session.alive) return { kind: 'closed' }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { kind: 'timeout' }
    if (session.scrollback.length <= offset) {
      await session.waitForData(offset, Math.min(250, remaining))
      continue
    }
    const span = session.scrollback.slice(offset)
    // The end marker appears twice: once inside the echo of the line we typed and
    // once when the shell actually runs it. Only the second one carries a status
    // immediately after it, so that is what completion means. Requiring the
    // status is what stops an echo that arrived a few milliseconds early from
    // being read as "command finished, no output".
    if (markerCompleted(span)) return { kind: 'marker' }
    // Short polls keep the screen bounded: waiting on the whole span would grow
    // the loop's own memory with the command's output.
    await session.waitForData(session.scrollback.length, Math.min(250, remaining))
  }
}

/**
 * Whether the span contains a *completed* end marker: the marker followed by an
 * exit status, as the shell prints after it, rather than the marker as typed.
 * @param {string} span - the raw screen span for one command.
 * @returns {boolean} whether a real status line is present.
 */
export function markerCompleted(span, markers = MARKERS) {
  // The single definition of "done" is: the screen parses into a span whose status
  // is known. `splitSpan` already knows which marker occurrences are the shell's
  // (a status follows) and which are our echoed wrapper, so completion cannot
  // disagree with what is then reported.
  return splitSpan(span, markers).exitStatus !== ''
}

/**
 * Wait until the connection stops producing output, or the ceiling is reached.
 *
 * "Quiet" is not "finished" in general — a slow host can pause between the banner
 * and the prompt — so this also stops as soon as a decision is visible: a prompt,
 * a password question, a host-key question, or an error. That combination is what
 * makes the wait long enough on a distant host and instant on a LAN.
 *
 * @param {SshSession} session - the connecting window.
 * @param {number} timeoutMs - overall ceiling.
 * @param {number} quietMs - how long a silent screen counts as settled.
 * @returns {Promise<void>} resolves once settled, actionable, or timed out.
 */
async function settleConnection(session, timeoutMs, quietMs) {
  const deadline = Date.now() + timeoutMs
  let lastLength = session.scrollback.length
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const raw = session.scrollback
    if (raw.length !== lastLength) {
      lastLength = raw.length
      quietSince = Date.now()
    }
    // A decision on screen ends the wait immediately.
    if (hasVisibleContent(raw) && (looksLoggedIn(raw) || awaitingInput(raw) || looksFailed(raw))) return
    if (!session.alive) return
    // "Settled" only means something once the connection has said something a human
    // could read. The first bytes a PTY emits are terminal setup escapes
    // (`\e[?9001h\e[?1004h`) with no content at all; treating those as "the screen
    // has content, and it has stopped changing" is what made `ssh_open` return in
    // under a second with a blank screen while ssh was still negotiating.
    if (hasVisibleContent(raw) && Date.now() - quietSince >= quietMs) return
    await session.waitForData(session.scrollback.length, 120)
  }
}

/**
 * Whether a screen holds anything besides terminal control sequences.
 *
 * A PTY emits cursor and mode escapes before the program prints a single
 * character, so `scrollback.length > 0` is not evidence of nothing to report.
 * @param {string} raw - the raw screen.
 * @returns {boolean} whether any printable, non-whitespace text is present.
 */
export function hasVisibleContent(raw) {
  return stripControl(raw).trim() !== ''
}

/**
 * Explain, in one line, why `ssh_open` returned without a usable session.
 *
 * "Still connecting" is useless to a caller: it cannot tell a slow host from a
 * misconfigured one. The distinctions below are the ones that change what a caller
 * should do next — wait, read the screen, or give up on this host.
 *
 * @param {SshSession} session - the window that did not reach a decision.
 * @returns {string} an actionable sentence.
 */
export function diagnoseConnect(session) {
  if (!session.alive) return `The ssh process exited (${session.endReason ?? 'no reason given'}).`
  const raw = session.scrollback
  if (raw.trim() === '') {
    return 'No output from ssh yet, which usually means the host is slow to answer or the '
      + 'connection is being throttled. Call ssh_read; if the screen stays empty, treat this '
      + 'host as unreachable rather than retrying in a loop.'
  }
  if (awaitingInput(raw)) return 'The screen is waiting for input: answer it with ssh_send secret=true (or raw=true).'
  if (looksFailed(raw)) return 'The connection failed; the reason is on screen.'
  return 'Connecting has not finished. Call ssh_read to see the current screen.'
}

/**
 * Replace every occurrence of a secret with a marker.
 *
 * A secret prompt normally echoes nothing, but a mistyped or mishandled one can —
 * and a paste or a shell that echoes input would put it on screen. Nothing that
 * came from a `secret` call is ever allowed back into a tool result.
 * @param {string} text - the screen text.
 * @param {string} secret - the value to hide.
 * @returns {string} the text with the secret removed.
 */
export function redact(text, secret) {
  if (secret === '') return text
  return text.split(secret).join('<redacted>')
}

/**
 * Whether the screen is asking the user something that typing can answer.
 *
 * This is the signal a caller needs before it sends a secret: a password prompt, a
 * passphrase prompt, or the host-key `yes/no` question. Without it, a caller that
 * "answers" too early types the password into a shell that is not yet listening —
 * which is exactly how a password once got executed as a command.
 * @param {string} raw - the raw screen.
 * @returns {boolean} whether input is being requested.
 */
export function awaitingInput(raw) {
  const text = stripControl(raw)
  return /(?:password|passphrase)[^\n]*:\s*$/im.test(text)
    || /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/im.test(text)
    || /are you sure you want to continue connecting[^\n]*\?\s*$/im.test(text)
}

/**
 * Whether the connection failed outright, so the caller should not answer anything.
 * @param {string} raw - the raw screen.
 * @returns {boolean} whether an SSH-level failure is on screen.
 */
export function looksFailed(raw) {
  const text = stripControl(raw)
  return /permission denied|connection refused|connection timed out|could not resolve hostname|no route to host|host key verification failed|too many authentication failures/i.test(text)
}

/**
 * Choose the remote shell dialect from what the login screen showed.
 *
 * A Windows `cmd.exe` prompt is `D:\path>`; anything else is treated as POSIX,
 * which is the overwhelming majority and the safer assumption: a POSIX wrapper
 * typed into a POSIX shell is always valid, whereas the reverse is not.
 * @param {string} raw - the raw screen text.
 * @returns {'posix'|'cmd'} the dialect.
 */
export function detectDialect(raw) {
  return endsWithCmdPrompt(stripControl(raw)) ? 'cmd' : 'posix'
}

/**
 * Clean the screen a human would actually see.
 * @param {string} text - plain screen text.
 * @returns {string} trimmed text.
 */
export function tidyScreen(text) {
  // A full-screen terminal clear emits a cursor-position escape followed by one
  // blank line per row, so a fresh login arrives as dozens of empty lines. They
  // carry no information and would waste a model's context.
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Decide whether a screen shows a logged-in shell prompt.
 *
 * Deliberately conservative: a password prompt, a host-key question and a bare
 * banner all read as "not logged in", because acting on a half-open connection is
 * worse than asking the model to look again.
 * @param {string} raw - the raw screen.
 * @returns {boolean} whether a prompt tail is present.
 */
export function looksLoggedIn(raw) {
  const text = stripControl(raw)
  if (/password[^\n]*:|yes\/no|Are you sure you want to continue connecting/i.test(text)) return false
  const tail = text.trimEnd().split('\n').pop() ?? ''
  // A prompt is a short trailing line ending in a shell sigil: `$`, `#`, `>`, `%`.
  return /[\$#%>]\s*$/.test(tail) && tail.length <= 200
}

/** @param {number} ms - delay. @returns {Promise<void>} */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Report a command that a human would double-check before pressing Enter.
 * @param {string} line - the command text.
 * @returns {string|undefined} the warning, or undefined.
 */
export function destructiveWarning(line) {
  for (const { pattern, why } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(line)) {
      return `This looks destructive (${why}). It ran; if that was not intended, say so now.`
    }
  }
  return undefined
}

/** A fresh opaque id, for callers that create sessions outside the registry. */
export function newSessionId() {
  return `ssh_${randomBytes(4).toString('hex')}`
}
