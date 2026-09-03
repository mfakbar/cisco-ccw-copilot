import { describe, expect, it } from 'vitest';
import { assertCurrentCircuitToken, CircuitAuthenticationError } from '../packages/companion/src/circuit-auth.js';
import { CIRCUIT_MODELS, CIRCUIT_MODEL_OPTIONS, isCircuitModel } from '../packages/shared/src/provider-config.js';

const tokenWithExpiry = (exp: number): string => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;

describe('CircuIT authentication policy', () => {
  it('accepts only the configured CircuIT deployments', () => {
    expect(isCircuitModel('gemini-3.1-flash-lite')).toBe(true);
    expect(isCircuitModel('gpt-5-nano')).toBe(true);
    expect(isCircuitModel('unknown-model')).toBe(false);
    expect(CIRCUIT_MODEL_OPTIONS.map(({ value }) => value)).toEqual(CIRCUIT_MODELS);
  });

  it('rejects blank, malformed, and expired tokens with actionable errors', () => {
    expect(() => assertCurrentCircuitToken('')).toThrow('CircuIT access token is required');
    expect(() => assertCurrentCircuitToken('invalid')).toThrow('CircuIT access token is invalid');
    expect(() => assertCurrentCircuitToken(tokenWithExpiry(1_000), 1_000_001)).toThrow('CircuIT access token expired');
  });

  it('accepts a structurally valid token whose expiry is in the future', () => {
    expect(() => assertCurrentCircuitToken(tokenWithExpiry(2_000), 1_000_000)).not.toThrow();
    expect(new CircuitAuthenticationError('test')).toBeInstanceOf(Error);
  });
});
