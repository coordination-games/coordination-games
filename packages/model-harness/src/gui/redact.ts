/**
 * Secret redaction for everything the GUI emits: child stdout/stderr, error
 * messages, and artifact previews. Pure string/value transforms — no I/O.
 *
 * Redacted classes:
 *   - Bearer tokens and Basic credentials in header-shaped text
 *   - provider-style keys (sk-…, sk-ant-…, sk-or-…, ghp_…, xoxb-…, AKIA…)
 *   - URL userinfo credentials and sensitive query params (?token=…, ?key=…)
 *   - assignment-shaped secrets: apiKey=…, API_KEY: …, "secret": "…", token=…
 */

const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|apikey|secret|passwd|password|credential|authorization|(?<![a-z])token(?!s))/i;

const PROVIDER_KEY_RE =
  /\b(?:sk|sk-ant|sk-or|sk-proj|ghp|gho|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{12,}\b/g;

const URL_RE = /https?:\/\/[^\s"'<>`\\)\]}]+/gi;

const ASSIGNMENT_RE =
  /([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|passwd|password|credential|token(?!s))[A-Za-z0-9_.-]*"?\s*[:=]\s*"?)([^"'\s,;&}\]]+)/gi;

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Redact one URL: strip userinfo, mask sensitive query params. */
export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_RE.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

/** Redact free-form text (log lines, error messages, file previews). */
export function redactText(value: string): string {
  return value
    .replace(URL_RE, (url) => redactUrl(url))
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(ASSIGNMENT_RE, '$1[REDACTED]')
    .replace(PROVIDER_KEY_RE, '[REDACTED]');
}

const MAX_REDACT_DEPTH = 12;

/**
 * Deep-redact a parsed JSON value: values under sensitive keys are replaced
 * wholesale; every other string still passes through redactText.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key) && typeof v === 'string' && v.trim() !== '') {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
