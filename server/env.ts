/**
 * Read an environment variable with an optional legacy fallback name.
 * This supports the PROOF_* → AGENTDOC_* rename transition.
 */
export function env(name: string, legacy?: string): string | undefined {
  return process.env[name] ?? (legacy ? process.env[legacy] : undefined);
}
