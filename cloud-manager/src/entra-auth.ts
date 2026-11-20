/**
 * Experimental Microsoft Entra v2 access-token verifier for the public cloud.
 * This validates identity, not tenant onboarding, subscription grants or OBO.
 * Production integration and external security review remain mandatory.
 */
import { importJWK, jwtVerify } from 'jose';

type Principal = { issuer: string; subject: string; tenantId: string; objectId: string; clientId: string };
type Options = {
  audience: string;
  tenantIds: string[];
  requiredScope: string;
  allowedClientIds: string[];
  fetch?: typeof fetch;
  now?: () => number;
};
type Key = { kid: string; kty: string; use?: string; alg?: string; n: string; e: string; issuer: string };
type Cache = { keys: Key[]; expiresAt: number; attemptedAt: number; pending?: Promise<void> };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN = 'https://login.microsoftonline.com';
const MAX_TOKEN = 16384;
const MAX_DOCUMENT = 512 * 1024;
const TTL = 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 5000;
// Unverified token claims select a configured tenant before signature checking.
// Bound concurrent outbound discovery requests per authenticator instance.
const MAX_CONCURRENT_REFRESHES = 4;

export class AuthenticationError extends Error {
  constructor() { super('Authentication failed.'); this.name = 'AuthenticationError'; }
}
function reject(): never { throw new AuthenticationError(); }
function decode(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return reject();
  const out = Buffer.from(value, 'base64url');
  if (out.toString('base64url') !== value) return reject();
  return out;
}
function object(value: Buffer): any {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject();
    return parsed;
  } catch { return reject(); }
}

async function readJson(response: Response): Promise<any> {
  if (!response.ok || !response.body) return reject();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT) return reject();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_DOCUMENT) { await reader.cancel(); return reject(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return object(Buffer.concat(chunks));
}

export class EntraAuthenticator {
  private readonly audience: string;
  private readonly requiredScope: string;
  private readonly tenants: Set<string>;
  private readonly clients: Set<string>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, Cache>();
  private activeRefreshes = 0;
  constructor(options: Options) {
    if (!options || !GUID.test(options.audience) || !options.requiredScope || /\s/.test(options.requiredScope)
      || !Array.isArray(options.tenantIds) || options.tenantIds.length < 1 || options.tenantIds.length > 1000
      || !options.tenantIds.every(t => typeof t === 'string' && GUID.test(t))
      || !Array.isArray(options.allowedClientIds) || options.allowedClientIds.length < 1
      || !options.allowedClientIds.every(c => typeof c === 'string' && GUID.test(c))) throw new AuthenticationError();
    this.audience = options.audience.toLowerCase();
    this.requiredScope = options.requiredScope;
    this.tenants = new Set(options.tenantIds.map(t => t.toLowerCase()));
    this.clients = new Set(options.allowedClientIds.map(c => c.toLowerCase()));
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async document(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await this.fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      return await readJson(response);
    } catch { return reject(); }
    finally { clearTimeout(timer); }
  }

  private async refresh(tenant: string, entry: Cache): Promise<void> {
    const now = this.now();
    if (entry.pending) return entry.pending;
    if (entry.attemptedAt && now - entry.attemptedAt < RETRY_DELAY) return;
    // Do not consume this tenant's retry window when the instance budget is full.
    if (this.activeRefreshes >= MAX_CONCURRENT_REFRESHES) return reject();
    this.activeRefreshes++;
    entry.attemptedAt = now;
    entry.pending = (async () => {
      const issuer = `${ORIGIN}/${tenant}/v2.0`;
      const metadata = await this.document(`${issuer}/.well-known/openid-configuration`);
      const expectedKeys = `${ORIGIN}/${tenant}/discovery/v2.0/keys`;
      if (metadata.issuer !== issuer || metadata.jwks_uri !== expectedKeys) return reject();
      const keys = (await this.document(expectedKeys)).keys;
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > 1000) return reject();
      entry.keys = keys.filter((k: any) => k && k.kty === 'RSA' && k.use === 'sig'
        && (k.alg === undefined || k.alg === 'RS256') && typeof k.kid === 'string' && k.kid.length <= 128
        && typeof k.n === 'string' && typeof k.e === 'string' && typeof k.issuer === 'string');
      entry.expiresAt = this.now() + TTL;
    })();
    try { await entry.pending; } finally { delete entry.pending; this.activeRefreshes--; }
  }

  async authenticate(token: string): Promise<Principal> {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN) return reject();
      const parts = token.split('.');
      if (parts.length !== 3) return reject();
      const [headerSegment, payloadSegment, signatureSegment] = parts;
      if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) return reject();
      const header = object(decode(headerSegment)), claims = object(decode(payloadSegment));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 128
        || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return reject();
      if (claims.ver !== '2.0' || typeof claims.tid !== 'string' || !GUID.test(claims.tid)) return reject();
      const tenant = claims.tid.toLowerCase(), issuer = `${ORIGIN}/${tenant}/v2.0`;
      if (!this.tenants.has(tenant) || claims.iss !== issuer || typeof claims.aud !== 'string'
        || claims.aud.toLowerCase() !== this.audience || typeof claims.oid !== 'string' || !GUID.test(claims.oid)
        || typeof claims.azp !== 'string' || !GUID.test(claims.azp) || !this.clients.has(claims.azp.toLowerCase())
        || typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 256
        || typeof claims.scp !== 'string' || !claims.scp.split(' ').includes(this.requiredScope)) return reject();
      const nowSeconds = Math.floor(this.now() / 1000);
      if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds
        || !Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds) return reject();
      let entry = this.cache.get(tenant);
      if (!entry) { entry = { keys: [], expiresAt: 0, attemptedAt: 0 }; this.cache.set(tenant, entry); }
      if (this.now() >= entry.expiresAt || !entry.keys.some(k => k.kid === header.kid)) await this.refresh(tenant, entry);
      if (this.now() >= entry.expiresAt) return reject();
      const keys = entry.keys.filter(k => k.kid === header.kid && (k.issuer === issuer || k.issuer === `${ORIGIN}/{tenantid}/v2.0`));
      const [key] = keys;
      if (keys.length !== 1 || !key) return reject();
      // Entra publishes a non-standard issuer property on signing keys. It is
      // checked above before the key reaches jose; jose does not enforce it.
      // jose enforces algorithm and RSA modulus size and validates standard
      // JWT claims. Keep unverified header/claims solely for key selection.
      decode(signatureSegment); // Require canonical base64url for the signature.
      const publicKey = await importJWK({ kty: 'RSA', n: key.n, e: key.e, alg: 'RS256' }, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        algorithms: ['RS256'], issuer, audience: this.audience,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'nbf'],
        currentDate: new Date(this.now()),
      });
      // Check Entra-specific fields on the authenticated claims, not just the
      // untrusted values used to choose the key above.
      if (payload.ver !== '2.0' || typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== tenant ||
          typeof payload.oid !== 'string' || !GUID.test(payload.oid) ||
          typeof payload.azp !== 'string' || !GUID.test(payload.azp) || !this.clients.has(payload.azp.toLowerCase()) ||
          typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 256 ||
          typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(this.requiredScope)) return reject();
      return { issuer, subject: payload.sub, tenantId: tenant, objectId: payload.oid.toLowerCase(), clientId: payload.azp.toLowerCase() };
    } catch { return reject(); }
  }
}

