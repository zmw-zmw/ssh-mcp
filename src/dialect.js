/**
 * The marker protocol, expressed in the remote shell's own dialect.
 *
 * A remote shell is not always POSIX. Logging into a Windows host over OpenSSH
 * lands in `cmd.exe`, where `printf` and `export` are not commands at all — a
 * real failure caught by the end-to-end test, not a hypothetical. So the wrapper
 * and its exit-status probe are chosen per dialect:
 *
 *     posix   printf '\n<B>\n'; <cmd>; printf '\n<E>%d\n' $?
 *     cmd     echo.& echo <B>& <cmd>& call echo <E>%%errorlevel%%
 *
 * Both forms are one physical line, because a newline inside the wrapper would
 * end the command early and strand the trailing marker at the next prompt.
 *
 * ## Why the prefix is quoted away from the shell
 *
 * A bare token in `cmd.exe`'s command line is subject to percent-expansion only
 * when written as `%NAME%`. The earlier version of this module used a token full
 * of underscores and then a bare alphanumeric one, and both printed as
 * `undefined` against a real Windows host: the token was being treated as an
 * environment reference before `echo` ever saw it. The fix is to make the marker
 * text something no shell will rewrite — see {@link marker} — and to keep the
 * exit code behind `call`, so `errorlevel` is the wrapped command's status.
 *
 * Dialect detection is a one-shot probe on a fresh session: ask the screen what
 * shell answered. Guessing from the hostname would be wrong for any host running
 * WSL, Git Bash or an SSHd that forces a POSIX shell.
 *
 * @module ssh-mcp/dialect
 */

/** The dialects this server can instrument. */
export const DIALECTS = Object.freeze(['posix', 'cmd'])

/** How long a marker token is, before its prefix. */
const TOKEN_LENGTH = 8

/**
 * Build one marker token that neither shell will expand or special-case.
 *
 * Lower-case letters and digits only: `cmd.exe` never expands them, POSIX shells
 * never expand unquoted plain words, and no glob meta-character is involved.
 * @param {'begin'|'end'} kind - which marker.
 * @returns {string} the token.
 */
export function marker(kind) {
  const seed = kind === 'begin' ? 'zb' : 'ze'
  let token = seed
  while (token.length < TOKEN_LENGTH) {
    token += Math.random().toString(36).slice(2, 3)
  }
  return token.slice(0, TOKEN_LENGTH)
}

/**
 * Whether a screen's end carries a Windows `cmd.exe` prompt.
 *
 * The prompt is often glued to the end of a banner line rather than starting its
 * own (`(c) Microsoft Corporation.所有权利…) zmw@ZMW C:\Users\me>`), so the test is
 * anchored at the end of the text instead of on a whole line.
 * @param {string} text - plain screen text.
 * @returns {boolean} whether a cmd.exe prompt ends the screen.
 */
export function endsWithCmdPrompt(text) {
  const compact = text.replace(/[ \t]+/g, ' ').trimEnd()
  return /(?:^|\s)[A-Za-z]:\\[^>\n]{0,300}>\s*$/.test(compact)
}

/**
 * Wrap one command in the marker protocol for a dialect.
 *
 * @param {string} command - the command as the user would type it.
 * @param {string} dialect - one of {@link DIALECTS}.
 * @param {{BEGIN: string, END: string}} markers - the marker vocabulary, keyed
 *   exactly as the session exports it.
 * @returns {string} one physical line to type into the session.
 */
export function wrapCommand(command, dialect, markers) {
  const { BEGIN, END } = markers
  if (dialect === 'cmd') {
    // `%errorlevel%` is useless here. cmd expands every `%VAR%` across a command
    // line *before* running it, and at an interactive prompt it reports 0 for the
    // status the line started with no matter what ran in between — measured, not
    // assumed: `cmd /c exit 1&echo %errorlevel%` prints 0. `call` re-expands and
    // works, but only when typed as `%^ERRORLEVEL%`, whose caret is itself echoed.
    //
    // So the status is carried by cmd's own conditional operator instead. The
    // marker line prints `OK` when the middle command succeeded and `FAILED` when
    // it did not, which is both reliable and readable:
    //
    //     <cmd> && echo <END> OK || echo <END> FAILED
    //
    // `echo.` before the begin marker and after the end marker keep both markers
    // on their own lines; otherwise the status glues onto the prompt.
    return `echo.&echo ${BEGIN}&${command}&&echo ${END} OK||echo ${END} FAILED&echo.`
  }
  return `printf '\\n${BEGIN}\\n'; ${command}; printf '\\n${END}%d\\n' $?`
}

/**
 * The status line to type, used to probe whether a shell emits markers at all.
 * @param {string} dialect - one of {@link DIALECTS}.
 * @param {{begin: string, end: string}} markers - the marker vocabulary.
 * @returns {string} the probe line.
 */
export function probeLine(dialect, markers) {
  return wrapCommand(dialect === 'cmd' ? 'echo ok' : 'echo ok', dialect, markers)
}

/**
 * The setup a POSIX shell needs so that every command can be marker-delimited.
 *
 * Three separate problems are solved here, all observed against real hosts:
 *
 * 1. **History expansion.** An interactive bash expands `!` before running
 *    anything, so a command such as `echo "a!b"` dies with `!b: event not found`
 *    and the trailing marker never prints — the whole call then times out on a
 *    command that a human would have seen fail instantly. `set +H` turns that off.
 * 2. **Prompt shape.** A prompt containing a newline would split the wrapper, so
 *    the prompt is rewritten to one predictable line.
 * 3. **Echo of control characters.** `stty -echo` is deliberately *not* used: the
 *    echo is how a human knows what was typed, and the parser relies on the same
 *    evidence rather than fighting the terminal.
 *
 * Best-effort by design: a shell that ignores the line simply produces no markers,
 * which the caller treats as "not instrumented" rather than as success.
 * `cmd.exe` needs no setup.
 * @returns {string} the setup line, or '' when the dialect needs none.
 */
export function instrumentationLine(dialect) {
  return dialect === 'cmd' ? '' : "set +H; export PS1='\\u@\\h:\\w\\$ '"
}
