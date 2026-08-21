import { describe, expect, it } from 'vitest';
import { verifyPushAuth } from '../src/auth.js';

describe('verifyPushAuth', () => {
  it('accepts the correct bearer token', () => {
    expect(verifyPushAuth({ authorization: 'Bearer secret-123' }, 'secret-123')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(verifyPushAuth({ authorization: 'Bearer wrong' }, 'secret-123')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyPushAuth({}, 'secret-123')).toBe(false);
  });

  it('accepts everything when no token is configured (dev mode)', () => {
    expect(verifyPushAuth({}, '')).toBe(true);
  });
});