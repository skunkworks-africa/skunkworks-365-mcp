import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Principal } from './domain.js';

export interface AuthConfig { issuer: string; audience: string; jwksUrl: string }
export type VerifyToken = (token: string) => Promise<Principal>;

export function authConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const issuer = env.MCP_TOKEN_ISSUER;
  const audience = env.MCP_TOKEN_AUDIENCE;
  const jwksUrl = env.MCP_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) throw new Error('Required JWT authentication configuration missing');
  for (const value of [issuer, audience, jwksUrl]) {
    if (new URL(value).protocol !== 'https:') throw new Error('Authentication URLs must use HTTPS');
  }
  return { issuer, audience, jwksUrl };
}

export function jwtVerifier(
  config: AuthConfig, keys: Parameters<typeof jwtVerify>[1] = createRemoteJWKSet(new URL(config.jwksUrl))
): VerifyToken {
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer, audience: config.audience,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'],
      clockTolerance: 5
    });
    if (!payload.sub || !payload.iss) throw new Error('Token identity missing');
    return { issuer: payload.iss, subject: payload.sub };
  };
}

export async function authenticate(request: Request, verify: VerifyToken): Promise<Principal | null> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) return null;
  try { return await verify(match[1]); }
  catch { return null; }
}
