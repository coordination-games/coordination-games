const TRUSTED_KEY_HOSTS: Readonly<Record<string, readonly string[]>> = {
  OPENAI_API_KEY: ['api.openai.com'],
  OPENROUTER_API_KEY: ['openrouter.ai'],
  MINIMAX_API_KEY: ['api.minimax.io'],
};

export function safeBaseUrl(raw: unknown, where: string): string {
  const value = requiredString(raw, where);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`model profiles: ${where} must be an absolute URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `model profiles: ${where} must use HTTPS (or loopback HTTP) without credentials, query, or fragment`,
    );
  }
  return url.toString().replace(/\/$/, '');
}

export function safeApiKeyEnv(raw: unknown, baseUrl: string | undefined, where: string): string {
  const name = requiredString(raw, where);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    throw new Error(`model profiles: ${where} must be an environment variable name`);
  const trustedHosts = TRUSTED_KEY_HOSTS[name];
  if (trustedHosts) {
    const host = baseUrl ? new URL(baseUrl).hostname : '';
    if (!trustedHosts.includes(host))
      throw new Error(`model profiles: ${where} is only allowed for its trusted host`);
  } else if (!name.startsWith('HARNESS_')) {
    throw new Error(`model profiles: ${where} must use HARNESS_*_API_KEY for a custom host`);
  }
  return name;
}

export function safeReasoningEffort(raw: unknown, where: string): string {
  const value = requiredString(raw, where);
  if (!/^[a-z][a-z0-9_-]*$/i.test(value))
    throw new Error(`model profiles: ${where} has an invalid shape`);
  return value;
}

function requiredString(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw.trim())
    throw new Error(`model profiles: ${where} must be a non-empty string`);
  return raw.trim();
}
