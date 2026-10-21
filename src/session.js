/**
 * One live SSH terminal window, seen the way a human sees it.
 *
 * The whole module is one idea: an SSH session is NOT a command executor, it is a
 * screen you are sitting in front of. So this file owns
 *
 *   1. a real PTY (node-pty / ConPTY) running `ssh <host>`,
 *   2. the exact bytes the remote shell puts on that screen, verbatim, in a
 *      bounded scrollback, and
 *   3. the marker protocol that turns "where does one command's output end" from
 *      a guess into a fact.
 *
 * ## The marker protocol, and why it exists
 *
 * A pipe-style tool answers "did it finish?" by silence, which is wrong half the
 * time (`sleep`, a pager, a build with no output, a password prompt). Here every
 * command is wrapped into ONE physical line sent to the remote shell:
 *
 *     printf '\n<BEGIN>\n'; <command>; printf '\n<END>%d\n' $?
 *
 * The remote shell echoes nothing we did not type (echo is left on deliberately —
 * stripping it ourselves is more reliable than fighting PTY echo semantics), and
 * when the trailing marker appears in the stream we know three facts at once: the
 * command finished, its exit status, and the byte offset its output occupies. That
 * is what makes `until: marker` the default and `until: silence` the fallback for
 * a session whose shell we cannot instrument.
 *
 * ## What this module deliberately does NOT do
 *
 * - No host discovery, no inventory: `ssh_open` connects to exactly one host the
 *   caller named.
 * - No credential storage: passwords, key passphrases and fingerprint answers go
 *   straight into the PTY's stdin and are never persisted, logged, or echoed back
 *   into a tool result.
 * - No command policy: a destructive command is the user's call, not ours. The
 *   server layer asks the human; this layer just reports what the screen said.
 *
 * @module ssh-mcp/session
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { sshExtraOptions } from './ssh-options.js'
import { instrumentationLine, marker, wrapCommand } from './dialect.js'

const pty = await loadPty()

/**
 * Resolve node-pty lazily and with a useful failure line.
 *
 * A missing native build is the single most likely deployment fault for this
 * package, and a bare `ERR_DLOPEN_FAILED` from a top-level await tells an
 * operator nothing about what to install.
 * @returns {Promise<typeof import('node-pty')>} the module.
 */
async function loadPty() {
  try {
    return await import('node-pty')
  } catch (error) {
    throw new Error(
      'node-pty could not be loaded, so no real terminal can be allocated. '
      + `Run \`npm install\` in this package first. (${String(error?.message ?? error)})`,
    )
  }
}

/**
 * Marker tokens for this process, generated fresh so a command that happens to
 * print ordinary output cannot collide with them, and so nothing about the marker
 * is a name a shell might expand.
 */
const BEGIN_MARKER = marker('begin')
const END_MARKER = marker('end')

/** Scrollback ceiling per session. Oldest bytes are dropped past this. */
const MAX_SCROLLBACK_BYTES = 4 * 1024 * 1024

/** How long a session may sit idle before it is eligible for reaping. */
const IDLE_REAP_MS = 30 * 60 * 1000

/**
 * One live terminal window.
 *
 * The emitter's `data` event carries raw screen bytes exactly as the PTY produced
 * them, including CR characters and ANSI escapes; nothing here interprets them.
 * Interpretation (marker scanning, echo stripping) happens in `readSince`, so a
 * caller that only wants the screen can read `scrollback` and a caller that wants
 * one command's slice uses the same bytes.
 */
export class SshSession extends EventEmitter {
  /**
   * @param {object} options - session inputs.
   * @param {string} options.host - the SSH target, e.g. `user@1.2.3.4`.
   * @param {string} [options.name] - human label; defaults to the host.
   * @param {number} [options.port] - SSH port.
   * @param {number} [options.cols] - initial terminal width.
   * @param {number} [options.rows] - initial terminal height.
   * @param {string} [options.cwd] - local working directory for the ssh process.
   */
  constructor({ host, name, port, cols = 200, rows = 50, cwd }) {
    super()
    /** @type {string} the SSH target as the caller spelled it. */
    this.host = host
    /** @type {string} a human-facing label for this window. */
    this.name = name && String(name).trim() !== '' ? String(name) : host
    /** @type {number|undefined} the SSH port, when the caller gave one. */
    this.port = port
    this.cols = cols
    this.rows = rows
    this.cwd = cwd
    /** @type {string} opaque id handed back to the model. */
    this.id = `ssh_${Math.random().toString(36).slice(2, 10)}`
    /** @type {number} epoch ms of creation. */
    this.createdAt = Date.now()
    /** @type {number} epoch ms of the last screen byte or command. */
    this.lastActivityAt = this.createdAt
    /** @type {'connecting'|'live'|'closed'} coarse lifecycle state. */
    this.state = 'connecting'
    /** @type {number} how many bytes of scrollback exist. */
    this.scrollbackBytes = 0
    /** @type {boolean} whether the remote shell accepted marker instrumentation. */
    this.instrumented = false
    /** @type {'posix'|'cmd'} the remote shell dialect this session speaks. */
    this.dialect = 'posix'
    /** @type {string} the shell prompt tail we last saw, for `until: prompt`. */
    this.promptTail = ''

    /** @type {string} the bounded screen contents. */
    this.scrollback = ''
    /** @type {string} the last marker's exit status text, or '' when none. */
    this.lastExitStatus = ''
    /** @type {string|undefined} why the session ended, for close diagnostics. */
    this.endReason = undefined

    /** @type {Map<number, (chunk: Buffer) => void>} stdout waiters, by offset. */
    this.waiters = new Map()
    /** @type {number} monotonic waiter key source. */
    this.waiterSeq = 0

    /** @type {import('node-pty').IPty|undefined} the local terminal process. */
    this.ptyProcess = undefined
    /** @type {string} the local executable backing this session, for reports. */
    this.executor = ''
    /** @type {NodeJS.Timeout|undefined} the idle reaper timer. */
    this.reapTimer = undefined
    /** @type {number} epoch ms of the last stdin write, a floor for waits. */
    this.lastWriteAt = 0
  }

  /**
   * Allocate the terminal and start ssh.
   *
   * Resolves as soon as the process exists; it does NOT wait for authentication,
   * because a password prompt or a host-key question is exactly what the caller
   * must read off the screen and answer through `send`. Waiting for a "connected"
   * signal here would deadlock the very case this tool exists for.
   * @returns {void}
   */
  start() {
    const args = ['-tt']
    if (this.port !== undefined) args.push('-p', String(this.port))
    // Operator-supplied client options (identity, known-hosts) come before the
    // target so they cannot replace it.
    args.push(...sshExtraOptions())
    // No BatchMode: this tool's whole point is that a password prompt is answerable.
    args.push(this.host)
    const env = { ...process.env }
    delete env.SSH_ASKPASS
    delete env.SSH_ASKPASS_REQUIRE

    const spawnOptions = {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd && fs.existsSync(this.cwd) ? this.cwd : process.cwd(),
      env,
    }

    const localSsh = resolveLocalExecutable('ssh')
    this.ptyProcess = pty.spawn(localSsh, args, spawnOptions)
    this.executor = `pty:${localSsh}`
    this.state = 'connecting'
    this.ptyProcess.onData((chunk) => this.#ingest(chunk))
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.state = 'closed'
      this.endReason = `ssh exited with code ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
      this.#wakeAll()
      this.emit('end', { code: exitCode, signal })
    })
    this.#armReaper()
  }

  /** Whether the terminal process is still alive. @returns {boolean} */
  get alive() {
    return this.state !== 'closed'
  }

  /** Mark activity so the idle reaper does not collect a window in use. @returns {void} */
  touch() {
    this.lastActivityAt = Date.now()
    if (this.reapTimer !== undefined) {
      clearTimeout(this.reapTimer)
      this.reapTimer = undefined
    }
    this.#armReaper()
  }

  /** Resize the terminal without reallocating the process. @returns {void} */
  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    try {
      this.ptyProcess?.resize(cols, rows)
    } catch {
      // A dead or wedged terminal keeps its recorded size; the call is advisory.
    }
  }

  /**
   * Write raw bytes to the terminal's stdin.
   *
   * Everything the model wants the remote shell to see goes through here, which
   * means a password or a host-key answer is written to the PTY and to nothing
   * else. The caller is responsible for the trailing newline.
   * @param {string} text - the literal text to type.
   * @returns {void}
   */
  write(text) {
    this.touch()
    this.ptyProcess?.write(text)
    // ConPTY hands input to the child asynchronously, so a caller that slices the
    // scrollback on the very next line can observe an unchanged screen and wrongly
    // conclude the command already produced nothing. Recording the moment of the
    // write gives `waitForData` a floor that cannot be satisfied by history.
    this.lastWriteAt = Date.now()
  }

  /**
   * Send one command line, wrapped in the marker protocol.
   *
   * The wrapper is one physical line on purpose: an embedded newline would end
   * the command early and leave the trailing marker running in the next prompt,
   * where it would be misread as the previous command's completion.
   * @param {string} command - the command to run on the remote host.
   * @returns {void}
   */
  sendLine(command) {
    this.write(`${wrapCommand(command, this.dialect, MARKERS)}\r`)
    this.state = 'live'
  }

  /**
   * Arm the remote shell so every command can be marker-delimited.
   *
   * A prompt that already ends in a newline is fine; one that does not would glue
   * the first wrapper onto the prompt text, so a bare newline is sent first. This
   * is best-effort by design: a shell that ignores it simply never produces
   * markers, and reads fall back to `until: silence`.
   * @returns {void}
   */
  armMarkers() {
    const setup = instrumentationLine(this.dialect)
    this.write('\r')
    if (setup !== '') this.write(`${setup}\r`)
  }

  /**
   * Wait until the screen grows past `offset`, or `timeoutMs` elapses.
   *
   * `offset` is a JavaScript string length, the same unit `scrollback` and every
   * caller's slice use. Mixing that with a UTF-8 byte count would leave the wait
   * pending forever once a line contained non-ASCII text, which is exactly what a
   * Chinese Windows login banner does.
   * @param {number} offset - string length to wait past.
   * @param {number} timeoutMs - deadline in milliseconds.
   * @returns {Promise<void>} resolves when data arrives or the deadline passes.
   */
  waitForData(offset, timeoutMs) {
    if (this.scrollback.length > offset) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        resolve()
      }, Math.max(1, timeoutMs))
      const key = ++this.waiterSeq
      this.waiters.set(key, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Terminate the session and stop the local ssh process.
   * @returns {Promise<void>} resolves once the process is gone.
   */
  async close() {
    if (this.reapTimer !== undefined) {
      clearTimeout(this.reapTimer)
      this.reapTimer = undefined
    }
    for (const waiter of this.waiters.values()) waiter()
    this.waiters.clear()
    const child = this.ptyProcess
    this.state = 'closed'
    if (this.endReason === undefined) this.endReason = 'closed by caller'
    await new Promise((resolve) => {
      if (!child) return resolve()
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        child.onExit?.(({ exitCode }) => {
          void exitCode
          done()
        })
      } catch {}
      try {
        child.kill()
      } catch {}
      setTimeout(done, 3000).unref?.()
    })
    this.#wakeAll()
    this.removeAllListeners()
  }

  /** @param {string|Buffer} chunk - raw screen bytes. @returns {void} */
  #ingest(chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    this.scrollback += text
    this.scrollbackBytes += Buffer.byteLength(text)
    if (this.scrollbackBytes > MAX_SCROLLBACK_BYTES) {
      // Keep the tail: an old command's output is history, a live prompt is not.
      const excess = this.scrollbackBytes - MAX_SCROLLBACK_BYTES
      this.scrollback = this.scrollback.slice(excess)
      this.scrollbackBytes = MAX_SCROLLBACK_BYTES
    }
    this.lastActivityAt = Date.now()
    this.#wakeAll()
    this.emit('data', text)
  }

  /** Release every waiter, because new data exists. @returns {void} */
  #wakeAll() {
    if (this.waiters.size === 0) return
    const pending = [...this.waiters.values()]
    this.waiters.clear()
    for (const wake of pending) wake()
  }

  /** @returns {void} */
  #armReaper() {
    this.reapTimer = setTimeout(() => {
      this.reapTimer = undefined
      if (!this.alive) return
      if (Date.now() - this.lastActivityAt >= IDLE_REAP_MS) {
        this.endReason = `reaped after ${Math.round(IDLE_REAP_MS / 60000)} minutes idle`
        void this.close()
        this.emit('end', { code: null, signal: null })
      } else {
        this.#armReaper()
      }
    }, IDLE_REAP_MS)
    this.reapTimer.unref?.()
  }
}

/**
 * Resolve a local executable from PATH without shelling out.
 *
 * `spawnTerminal`-style providers resolve their own binaries; a plugin-owned
 * spawn has to do it, and doing it by hand keeps the credential-shaped and
 * `DSH_*` environment rules in one place instead of inheriting a shell.
 * @param {string} name - the executable name.
 * @returns {string} the resolved path, or the bare name when unresolvable.
 */
export function resolveLocalExecutable(name) {
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue
    for (const candidate of candidates) {
      const file = path.join(directory.trim(), candidate)
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {}
    }
  }
  return name
}

/** Marker constants, exported so the tool layer can scan the same bytes. */
export const MARKERS = Object.freeze({ BEGIN: BEGIN_MARKER, END: END_MARKER })

/** The home directory ssh reads `known_hosts` and keys from, for reports. */
export const SSH_HOME = path.join(os.homedir(), '.ssh')
