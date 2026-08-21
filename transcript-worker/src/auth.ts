import type { IncomingHttpHeaders } from 'node:http';

// Pub/Sub push deliveries authenticate with an `Authorization: Bearer <token>`
// header, where the token is the push subscription's configured auth token.
// We verify it here. When no token is configured (local dev), auth is disabled.

export function verifyPushAuth(
  headers: IncomingHttpHeaders,
  expectedToken: string,
): boolean {
  if (!expectedToken) return true;
  const authorization = headers['authorization'] ?? '';
  return authorization === `Bearer ${expectedToken}`;
}