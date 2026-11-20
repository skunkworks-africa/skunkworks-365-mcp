/**
 * Per-request Microsoft Entra on-behalf-of exchange prototype.
 *
 * A host must provide a verifier that cryptographically validates the *same*
 * incoming delegated API bearer token (signature, issuer, audience, lifetime,
 * scope and allowed calling client). It must also apply its own principal,
 * tenant and subscription authorization before using the resulting credential.
 * This module is neither a bearer verifier nor an authorization policy.
 * It stores no incoming, downstream or refresh tokens.
 */

export type VerifiedBearer = {
  issuer: string;
  subject: string;
  tenantId: string;
  objectId: string;
  clientId: string;
};

type Options = {
  clientId: string;
  clientSecret: string;
  verifyBearer: (assertion: string) => Promise<VerifiedBearer>;
  fetch?: typeof fetch;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORITY = 'https://login.microsoftonline.com';
// The ARM resource URI itself has a trailing slash. See Microsoft scopes docs.
const ARM_SCOPE = 'https://management.azure.com//.default';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ASSERTION_LENGTH = 32 * 1024;
const TIMEOUT_MS = 10_000;

export class OboError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function validAssertion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ASSERTION_LENGTH && !/[\s\x00-\x1f\x7f]/.test(value);
}

function canonicalTenant(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new OboError('invalid_tenant', 'A valid customer tenant is required.');
  return value.toLowerCase();
}

function checkContext(raw: VerifiedBearer, tenant: string): VerifiedBearer {
  if (!raw || canonicalTenant(raw.tenantId) !== tenant ||
      (raw.issuer !== `${AUTHORITY}/${tenant}/v2.0` && raw.issuer !== `https://sts.windows.net/${tenant}/`) ||
      typeof raw.subject !== 'string' || !raw.subject.trim() || raw.subject.length > 1024 ||
      typeof raw.objectId !== 'string' || !UUID.test(raw.objectId) ||
      typeof raw.clientId !== 'string' || !UUID.test(raw.clientId)) {
    throw new OboError('invalid_context', 'The verified identity does not match the customer tenant.');
  }
  return { issuer: raw.issuer, subject: raw.subject, tenantId: tenant, objectId: raw.objectId.toLowerCase(), clientId: raw.clientId.toLowerCase() };
}

async function boundedJson(response: Response): Promise<any> {
  const value = response.headers.get('content-length');
  if (value !== null && (!/^\d+$/.test(value) || Number(value) > MAX_RESPONSE_BYTES)) throw new OboError('identity_unavailable', 'The identity service response was invalid.');
  if (!response.body) throw new OboError('identity_unavailable', 'The identity service response was invalid.');
  const reader = response.body.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      count += chunk.byteLength;
      if (count > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new OboError('identity_unavailable', 'The identity service response was invalid.'); }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new OboError('identity_unavailable', 'The identity service response was invalid.'); }
}

/**
 * Exchange only a delegated API access token verified by the supplied verifier.
 * Never supply an ID token, an app-only token, or a token for another audience.
 * A successful token exchange does not imply Azure RBAC or subscription access.
 */
export function createOboExchange(options: Options) {
  if (!options || typeof options.clientId !== 'string' || !UUID.test(options.clientId) ||
      typeof options.clientSecret !== 'string' || !options.clientSecret.trim() ||
      options.clientSecret.length > 4096 || /[\x00-\x1f\x7f]/.test(options.clientSecret) ||
      typeof options.verifyBearer !== 'function' || (options.fetch !== undefined && typeof options.fetch !== 'function')) {
    throw new OboError('not_configured', 'The identity client is not configured.');
  }
  // Capture only configuration; credentials are never included in errors.
  const clientId = options.clientId.toLowerCase();
  const secret = options.clientSecret;
  const verify = options.verifyBearer;
  const fetcher = options.fetch ?? fetch;
  return async function exchange(assertion: string, requestedTenant: string): Promise<{ token: string; principal: VerifiedBearer }> {
    const tenant = canonicalTenant(requestedTenant);
    if (!validAssertion(assertion)) throw new OboError('invalid_assertion', 'A valid API access token is required.');
    let principal: VerifiedBearer;
    try { principal = checkContext(await verify(assertion), tenant); }
    catch { throw new OboError('invalid_context', 'The incoming identity could not be verified for this tenant.'); }
    const endpoint = `${AUTHORITY}/${tenant}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      requested_token_use: 'on_behalf_of',
      assertion,
      scope: ARM_SCOPE,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      if (!response.ok) throw new OboError('exchange_failed', 'The identity service could not issue a delegated credential.');
      const result = await boundedJson(response);
      if (!validAssertion(result?.access_token) || typeof result?.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' ||
          typeof result?.expires_in !== 'number' || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0)
        throw new OboError('identity_unavailable', 'The identity service response was invalid.');
      return { token: result.access_token, principal };
    } catch {
      // Do not trust thrown errors from injected fetch or response streams.
      throw new OboError('identity_unavailable', 'The identity service request failed or timed out.');
    } finally { clearTimeout(timer); }
  };
}

