export class CircuitAuthenticationError extends Error {}
export class CircuitConfigurationError extends Error {}

export function configuredCircuitAppKey(value = process.env.CIRCUIT_APP_KEY): string {
  const appKey = value?.trim();
  if (!appKey) throw new CircuitConfigurationError('CircuIT is not configured. Set CIRCUIT_APP_KEY before starting the companion.');
  return appKey;
}

export function assertCurrentCircuitToken(token: string, now = Date.now()): void {
  if (!token.trim()) throw new CircuitAuthenticationError('CircuIT access token is required. Paste a current token in Settings.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new CircuitAuthenticationError('CircuIT access token is invalid. Paste a new token in Settings.');
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number') throw new Error('Missing expiry');
    if (payload.exp * 1000 <= now) throw new CircuitAuthenticationError('CircuIT access token expired. Generate a new token and paste it in Settings.');
  } catch (error) {
    if (error instanceof CircuitAuthenticationError) throw error;
    throw new CircuitAuthenticationError('CircuIT access token is invalid. Generate a new token and paste it in Settings.');
  }
}
