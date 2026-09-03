import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER, circuitTokenHint, isFileUploadBetaEnabled, storedProvider } from '../packages/extension/src/provider-settings.js';

const tokenWithExpiry = (exp: number): string => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;

describe('provider settings', () => {
  it('defaults new or invalid settings to Local Ollama while preserving an explicit CircuIT choice', () => {
    expect(DEFAULT_PROVIDER).toBe('local');
    expect(storedProvider(undefined)).toBe('local');
    expect(storedProvider('unexpected')).toBe('local');
    expect(storedProvider('local')).toBe('local');
    expect(storedProvider('circuit')).toBe('circuit');
  });

  it('keeps beta file upload disabled unless the user explicitly enables it', () => {
    expect(isFileUploadBetaEnabled(undefined)).toBe(false);
    expect(isFileUploadBetaEnabled(false)).toBe(false);
    expect(isFileUploadBetaEnabled('true')).toBe(false);
    expect(isFileUploadBetaEnabled(true)).toBe(true);
  });

  it('explains blank and malformed CircuIT tokens without exposing them', () => {
    expect(circuitTokenHint('')).toContain('never saved');
    expect(circuitTokenHint('not-a-token')).toContain('does not look valid');
  });

  it('distinguishes expired and current CircuIT tokens', () => {
    expect(circuitTokenHint(tokenWithExpiry(1_000), 1_000_001)).toContain('expired');
    expect(circuitTokenHint(tokenWithExpiry(2_000), 1_000_000, () => 'TEST DATE')).toBe('Token expires TEST DATE. It is not saved.');
  });
});
