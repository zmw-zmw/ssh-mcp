/**
 * A spawn-time ssh option extension point, so a caller can point the SSH window
 * at a specific identity or known-hosts file.
 *
 * This exists for exactly one reason: an SSH client's own public-key search is
 * not something a tool should reinvent, but a test (or a user with several keys)
 * must be able to say "use this one" without editing `~/.ssh/config`. Options
 * here are passed to `ssh` before the target, so they cannot override the
 * connection's real arguments.
 *
 * Set `SSH_MCP_SSH_OPTIONS` to a JSON array of strings, for example:
 *
 *   SSH_MCP_SSH_OPTIONS='["-i","C:/Users/me/.ssh/id_ed25519","-o","IdentitiesOnly=yes"]'
 *
 * Unset by default, which leaves the client's normal configuration in charge.
 *
 * @module ssh-mcp/ssh-options
 */

/** @returns {string[]} extra arguments placed before the SSH target. */
export function sshExtraOptions() {
  const raw = process.env.SSH_MCP_SSH_OPTIONS
  if (raw === undefined || raw.trim() === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('SSH_MCP_SSH_OPTIONS must be a JSON array of strings.')
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('SSH_MCP_SSH_OPTIONS must be a JSON array of strings.')
  }
  return parsed
}
