/** RFC9728 protected-resource discovery and remote configuration. */
export interface RemoteConfig { publicUrl: string; authorizationServer: string; scope: string }
function secureUrl(value: string | undefined, key: string): URL {
  if (!value) throw new Error(key + ' is required in remote mode');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(key + ' must be an HTTPS URL without credentials, query or fragment');
  }
  return url;
}
export function remoteConfig(env: NodeJS.ProcessEnv): RemoteConfig {
  const resource = secureUrl(env.MCP_PUBLIC_URL, 'MCP_PUBLIC_URL');
  const server = secureUrl(env.MCP_AUTHORIZATION_SERVER, 'MCP_AUTHORIZATION_SERVER');
  if (resource.pathname !== '/mcp' || resource.hostname === 'localhost' ||
      resource.hostname.endsWith('.invalid') || resource.hostname === '127.0.0.1') {
    throw new Error('MCP_PUBLIC_URL must be a public HTTPS URL ending in /mcp');
  }
  const scope = env.MCP_REQUIRED_SCOPE;
  if (!scope || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(scope)) {
    throw new Error('MCP_REQUIRED_SCOPE must be one valid OAuth scope');
  }
  return { publicUrl: resource.toString(), authorizationServer: server.toString(), scope };
}
export function metadataUrl(remote: RemoteConfig): string {
  return new URL('/.well-known/oauth-protected-resource', remote.publicUrl).toString();
}
export function protectedResourceMetadata(remote: RemoteConfig) {
  return { resource: remote.publicUrl, authorization_servers: [remote.authorizationServer],
    scopes_supported: [remote.scope], bearer_methods_supported: ['header'] };
}
export function authenticationChallenge(remote?: RemoteConfig): string {
  if (!remote) return 'Bearer';
  return 'Bearer resource_metadata="' + metadataUrl(remote) +
    '", error="invalid_token", error_description="An MCP-scoped access token is required"';
}
