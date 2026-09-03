export type SettingProvider = 'local' | 'circuit';

export const DEFAULT_PROVIDER: SettingProvider = 'local';
export const FILE_UPLOAD_BETA_STORAGE_KEY = 'fileUploadBetaEnabled';

export function storedProvider(value: unknown): SettingProvider {
  return value === 'circuit' ? 'circuit' : DEFAULT_PROVIDER;
}

export function isFileUploadBetaEnabled(value: unknown): boolean {
  return value === true;
}

export function circuitTokenHint(token: string, now = Date.now(), formatDate = (date: Date) => date.toLocaleString()): string {
  if (!token.trim()) return 'Paste a current one-hour token. It stays in this side panel and is never saved.';
  try {
    const encoded = token.trim().split('.')[1];
    if (!encoded) throw new Error('Missing token payload');
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    if (typeof payload.exp !== 'number') throw new Error('Missing expiry');
    const expires = new Date(payload.exp * 1000);
    return expires.valueOf() <= now
      ? 'This token has expired. Generate and paste a new CircuIT token.'
      : `Token expires ${formatDate(expires)}. It is not saved.`;
  } catch {
    return 'This token does not look valid. Paste the complete CircuIT access token.';
  }
}
