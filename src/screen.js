/**
 * Turning raw screen bytes into something a model can read.
 *
 * A PTY hands back exactly what a terminal would have drawn: carriage returns,
 * ANSI colour, `\r\n` line endings, spinner redraws and all. Handing that to a
 * model wastes tokens and hides the one thing it actually needs, which is "what
 * did my command print, and did it work".
 *
 * Everything here is a pure function over a string, which is the point: the
 * marker protocol, echo stripping and screen trimming are the parts most likely
 * to be wrong, so they are the parts testable without a network, a host, or a
 * terminal.
 *
 * @module ssh-mcp/screen
 */

/** ECMAScript-stable ANSI/VT escape sequences a terminal would interpret. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g

/**
 * Remove ANSI escapes and collapse carriage-return redraws.
 *
 * A progress bar redraws with `\r`; a terminal keeps only the last draw, so that
 * is what is kept here. `\r\n` stays a newline because it is a line ending, not a
 * redraw.
 * @param {string} text - raw screen text.
 * @returns {string} plain text.
 */
export function stripControl(text) {
  const withoutAnsi = text.replace(ANSI_PATTERN, '')
  // Normalise CRLF to LF *first*. A PTY (and every remote shell writing through
  // one) ends lines with `\r\n`; treating the `\r` as a redraw would delete the
  // whole line's content and leave only the newline.
  return withoutAnsi
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      const carriage = line.lastIndexOf('\r')
      return carriage === -1 ? line : line.slice(carriage + 1)
    })
    .join('\n')
}

/**
 * Split one command's screen span into its echoed line, output, and status.
 *
 * The span runs from the beginning marker to the end marker. Between them the
 * terminal echoed the wrapper we typed (which a human sees too, and which is
 * exactly how they know what is on the screen), then the command's own output,
 * then the end marker carrying the exit status.
 *
 * Marker keys are upper-case to match `SshSession`'s exported `MARKERS` exactly;
 * a casing mismatch here silently produced an empty result for every command, so
 * there is one spelling of the vocabulary and it is that one.
 *
 * @param {string} raw - the raw span, begin marker included, end marker included.
 * @param {{BEGIN: string, END: string}} markers - marker vocabulary.
 * @returns {{echo: string, output: string, exitStatus: string}} the parts.
 */
export function splitSpan(raw, markers) {
  const { BEGIN, END } = markers
  const withoutAnsi = stripControl(raw)
  // The terminal echoes the wrapper we typed, so both markers appear inside that
  // echo as well as in the shell's real output. The real ones are the last
  // occurrences that stand at the start of a line; the echo's copies sit in the
  // middle of one.
  // The begin marker needs no line-start test: its printed copy is always followed
  // by a line break, while the echo's copies are followed by `&`/`&&`/`||`. In a
  // cmd session whose prompt glues onto output, the echo and the first marker can
  // end up on one line, so requiring a clean line start would miss it.
  const beginAt = findPrintedMarker(withoutAnsi, BEGIN, /^[ \t]*(?:\r?\n|$)/, false)
  // The end marker is matched by what follows it rather than by line position.
  // A remote shell can emit its output and status with no newlines at all
  // (`helloze1234 0`), and the terminal then shows them fused; requiring a clean
  // line start made such a completion invisible and every call timed out even
  // though the marker was on screen.
  //
  // The echo's copies are safe to skip because a status token never follows the
  // marker inside our own wrapper — there it is followed by `||`, `&` or `%`.
  const endAt = findPrintedMarker(withoutAnsi, END, /^[ \t]*(?:-?\d+|OK|FAILED)/i, false)
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    return { echo: '', output: withoutAnsi.trim(), exitStatus: '' }
  }
  const body = withoutAnsi.slice(beginAt + BEGIN.length, endAt)
  const statusMatch = withoutAnsi.slice(endAt + END.length).match(/^\s*(-?\d+|OK|FAILED)/i)
  const lines = body.split('\n')
  // The first line is the tail of our own wrapper, echoed back by the terminal.
  const echo = lines.shift() ?? ''
  return {
    echo: echo.trim(),
    output: lines.join('\n').replace(/^\n+|\s+$/g, ''),
    // `OK`/`FAILED` (cmd) normalise to the numeric convention POSIX already uses.
    exitStatus: statusMatch?.[1] === undefined
      ? ''
      : /^ok$/i.test(statusMatch[1]) ? '0' : /^failed$/i.test(statusMatch[1]) ? '1' : statusMatch[1],
  }
}

/**
 * The last occurrence of `token` that the shell actually printed.
 *
 * The wrapper we type contains every marker literally and the terminal echoes it,
 * so the same token appears inside that echo too. Two facts separate the printed
 * copy from the echoed one:
 *
 * - it stands alone on its line (the echo continues with `&`, `&&` or `||`), and
 * - what follows it belongs to the shell's report, which the caller passes as
 *   `afterPattern` — a line break for the begin marker, an exit status for the
 *   end marker.
 *
 * @param {string} text - plain screen text.
 * @param {string} token - the marker to find.
 * @param {RegExp} afterPattern - what must follow a printed occurrence.
 * @param {boolean} requireLineStart - whether the occurrence must begin its line.
 * @returns {number} its offset, or -1.
 */
function findPrintedMarker(text, token, afterPattern, requireLineStart) {
  let at = text.lastIndexOf(token)
  while (at !== -1) {
    const prefix = text.slice(text.lastIndexOf('\n', at - 1) + 1, at)
    const suffix = text.slice(at + token.length, at + token.length + 40)
    if ((!requireLineStart || /^[ \t]*$/.test(prefix)) && afterPattern.test(suffix)) return at
    at = text.lastIndexOf(token, at - 1)
  }
  return -1
}

/**
 * Rejoin lines that the terminal wrapped, so a long echoed command survives.
 *
 * A terminal does not store a logical line; it stores screen rows. When a prompt
 * plus a long command exceeds the width, the shell moves to a new row and the
 * captured stream contains a hard break in the middle of a token. A human sees
 * this as wrapping and reads it as one line. Rejoining is the same trick: a row
 * that is exactly `width` characters was wrapped, not ended.
 *
 * @param {string} text - plain text, one entry per printed line.
 * @param {number} width - the terminal width in columns.
 * @returns {string[]} logical lines.
 */
export function joinWrappedLines(text, width) {
  if (!Number.isInteger(width) || width < 20) return text.split('\n')
  const out = []
  for (const line of text.split('\n')) {
    const previous = out.at(-1)
    // `\t` and CJK glyphs occupy several columns, so `length` is only a lower
    // bound; a row at or near the width is treated as wrapped.
    if (previous !== undefined && [...previous].length >= width - 1) {
      out[out.length - 1] = previous + line
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * Drop the echo of a sent line from the tail of a screen.
 *
 * When a command's output cannot be delimited (a shell that ignored the marker
 * instrumentation, or an interactive answer), the honest thing to report is the
 * screen minus our own typing. The echo is found by its literal text, which is why
 * this takes the sent line rather than guessing.
 * @param {string} screen - the plain screen text.
 * @param {string} sent - the literal characters we typed.
 * @returns {string} the screen with the last occurrence of `sent` removed.
 */
export function dropEcho(screen, sent) {
  if (sent === '') return screen
  const at = screen.lastIndexOf(sent)
  if (at === -1) return screen
  return (screen.slice(0, at) + screen.slice(at + sent.length))
}

/**
 * Start a new line wherever a prompt follows a marker status directly.
 *
 * Some SSH servers glue their prompt onto the previous line — `…ze1234abc OKC:\
 * Users\me>echo.&…` — because the shell wrote its prompt without a preceding
 * newline. The bytes are faithful, but several logical lines then fuse into one
 * unreadable row.
 *
 * Rather than guessing every prompt shape (labels, drive paths and POSIX sigils all
 * vary, and a naive pattern splits ordinary output), this splits exactly where the
 * wrapper guarantees a boundary: right after a status token. Splitting at the echo
 * instead was tried and rejected — the echo contains the markers verbatim, so the
 * rule shredded the wrapper text itself.
 *
 * @param {string} text - plain screen text.
 * @param {{BEGIN: string, END: string}} markers - the session's marker vocabulary.
 * @returns {string} text with fused lines separated.
 */
export function breakGluedPrompts(text, markers) {
  const escapedEnd = markers.END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(${escapedEnd}\\s*(?:OK|FAILED|-?\\d+))(?=\\S)`, 'g'), '$1\n')
}

/**
 * Keep the last `limit` lines, and say how many were dropped.
 *
 * A screen is not a list: only the bottom matters, and a model reading a build
 * log wants the tail with an explicit statement that the top was cut rather than
 * a silent lie about completeness.
 * @param {string} text - plain text.
 * @param {number} limit - maximum lines to keep.
 * @returns {{text: string, dropped: number}} the tail and its omission count.
 */
export function tailLines(text, limit) {
  const lines = text.split('\n')
  if (lines.length <= limit) return { text, dropped: 0 }
  return { text: lines.slice(-limit).join('\n'), dropped: lines.length - limit }
}

/**
 * Render one command result the way the tool layer shows it.
 *
 * @param {object} input - rendered facts.
 * @param {string} input.session - the session label.
 * @param {string} input.output - command output, already stripped.
 * @param {string} [input.exitStatus] - remote `$?`, when the marker reported one.
 * @param {number} [input.dropped] - output lines omitted from the top.
 * @param {string} [input.note] - why this is not a delimited result, if it is not.
 * @returns {string} the model-facing text.
 */
export function renderResult({ session, output, exitStatus, dropped = 0, note }) {
  const head = [`[${session}]`]
  if (exitStatus !== undefined && exitStatus !== '') head.push(`exit ${exitStatus}`)
  if (dropped > 0) head.push(`(${dropped} earlier lines omitted)`)
  if (note) head.push(note)
  const body = output.trim() === '' ? '(no output)' : output.replace(/\s+$/, '')
  return `${head.join(' ')}\n${body}`
}
