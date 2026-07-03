/**
 * Redaction for anything the console streams or returns. Secrets only ever
 * enter runs as child-process env, but every log line passes through here
 * anyway (belt and suspenders — same posture as Djimo's console).
 */

const PATTERNS: [RegExp, string][] = [
  // API keys: OpenRouter/OpenAI (sk-or-..., sk-...), Anthropic (sk-ant-...).
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***'],
  // Bearer tokens in headers or prose.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // key=value / "apiKey":"..." style assignments.
  [/\b(api[-_]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, '$1$2***'],
  // Credentials embedded in URLs (http://user:pass@host).
  [/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1***:***@'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}
