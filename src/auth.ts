import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Principal } from './domain.js';

export interface AuthConfig { issuer: string; audience: string; jwksUrl: string; requiredScope?: string; requiredRole?: string; entraTenantId?: string }
export type VerifyToken = (token: string) => Promise<Principal>;

export function authConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const issuer = env.MCP_TOKEN_ISSUER;
  const audience = env.MCP_TOKEN_AUDIENCE;
  const jwksUrl = env.MCP_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) throw new Error('Required JWT authentication configuration missing');
  for (const value of [issuer, jwksUrl]) {
    if (new URL(value).protocol !== 'https:') throw new Error('JWT issuer and JWKS URL must use HTTPS');
  }
  // Microsoft Entra access-token audiences may be an API application ID or api:// identifier.
  const guid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (!guid.test(audience) && !audience.startsWith('api://')) {
    if (new URL(audience).protocol !== 'https:') throw new Error('Invalid MCP_TOKEN_AUDIENCE');
  }
  if (env.MCP_REQUIRED_SCOPE && !/^[a-zA-Z0-9._:/-]{1,128}$/.test(env.MCP_REQUIRED_SCOPE)) {
    throw new Error('Invalid required OAuth scope');
  }
  const entraTenantId = env.MCP_ENTRA_TENANT_ID;
  if (entraTenantId && (!guid.test(entraTenantId) ||
      issuer !== `https://login.microsoftonline.com/${entraTenantId}/v2.0` ||
      jwksUrl !== `https://login.microsoftonline.com/${entraTenantId}/discovery/v2.0/keys`)) {
    throw new Error('Entra issuer and signing keys must match the configured home tenant');
  }
  return { issuer, audience, jwksUrl, requiredScope: env.MCP_REQUIRED_SCOPE,
    requiredRole: env.MCP_REQUIRED_ROLE, entraTenantId };
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
    if (config.entraTenantId && (payload.tid !== config.entraTenantId || payload.ver !== '2.0' ||
        typeof payload.oid !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.oid))) {
      throw new Error('Entra tenant, version or object identity missing');
    }
    if (config.requiredRole && (!Array.isArray(payload.roles) || !payload.roles.includes(config.requiredRole))) {
      throw new Error('Required reader role missing');
    }
    if (config.requiredScope) {
      const scp = typeof payload.scp === 'string' ? payload.scp :
        typeof payload.scope === 'string' ? payload.scope : '';
      if (!scp.split(/\s+/).includes(config.requiredScope)) {
        throw new Error('Required delegated OAuth scope missing');
      }
    }
    return { issuer: payload.iss, subject: payload.sub,
      ...(config.entraTenantId ? { objectId: payload.oid as string } : {}) };
  };
}

export async function authenticate(request: Request, verify: VerifyToken): Promise<Principal | null> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) return null;
  try { return await verify(match[1]); }
  catch { return null; }
}
