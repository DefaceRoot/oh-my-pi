/**
 * Redacts sensitive data from text content using regex patterns.
 *
 * @param text - The text content to filter
 * @returns The filtered text with sensitive data redacted
 */
export function filterSecrets(text: string): string {
  const patterns: Array<[RegExp, string]> = [
    // API keys
    [/api[_-]?key['"]?\s*[:=]\s*['"]?[a-zA-Z0-9]{16,}['"]?/gi, '[REDACTED]'],
    // Bearer tokens
    [/bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, 'bearer [REDACTED]'],
    // JWTs
    [/eyJ[a-zA-Z0-9_\-]*\.eyJ[a-zA-Z0-9_\-]*\.[a-zA-Z0-9_\-]*/g, '[REDACTED]'],
    // Passwords
    [/password['"]?\s*[:=]\s*['"]?[^'"]{4,}['"]?/gi, 'password="[REDACTED]"'],
    // AWS keys
    [/AKIA[0-9A-Z]{16}/g, '[REDACTED]'],
    // GitHub tokens
    [/gh[pousr]_[a-zA-Z0-9_]{36}/g, '[REDACTED]'],
    // Private keys
    [/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, '-----BEGIN [REDACTED] PRIVATE KEY-----'],
    // Database URLs
    [/(mongodb|postgres|mysql):\/\/[^:]+:[^@]+@/gi, '$1://[REDACTED]@[REDACTED]'],
  ];

  let filtered = text;
  for (const [pattern, replacement] of patterns) {
    filtered = filtered.replace(pattern, replacement);
  }
  return filtered;
}
