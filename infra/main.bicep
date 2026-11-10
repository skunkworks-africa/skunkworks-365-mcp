targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'skunkworks-365-mcp'
@description('An approved public container image pinned to sha256 digest. No credentials may be baked into it.')
param containerImage string
param homeTenantId string
param apiClientId string
param graphClientId string
@description('Public single-tenant SPA client ID for the private read-only dashboard.')
param dashboardClientId string = ''
@secure()
@description('Explicit issuer + objectId/subject to tenant grants; stored as a Container Apps secret.')
param accessRegistryJson string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-runtime'
  location: location
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
// This runtime intentionally validates only the global Microsoft cloud.
#disable-next-line no-hardcoded-env-urls
var issuer = 'https://login.microsoftonline.com/${homeTenantId}/v2.0'
var origin = 'https://${appName}.${environment.properties.defaultDomain}'
resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false }
      secrets: [{ name: 'access-registry', value: accessRegistryJson }]
    }
    template: {
      containers: [{
        name: 'mcp'
        image: containerImage
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'MCP_MODE', value: 'remote' }
          { name: 'MCP_BIND_HOST', value: '0.0.0.0' }
          { name: 'PORT', value: '3000' }
          { name: 'MCP_PUBLIC_URL', value: '${origin}/mcp' }
          { name: 'MCP_AUTHORIZATION_SERVER', value: issuer }
          { name: 'MCP_TOKEN_ISSUER', value: issuer }
          #disable-next-line no-hardcoded-env-urls
          { name: 'MCP_JWKS_URL', value: 'https://login.microsoftonline.com/${homeTenantId}/discovery/v2.0/keys' }
          { name: 'MCP_TOKEN_AUDIENCE', value: apiClientId }
          { name: 'MCP_ENTRA_TENANT_ID', value: homeTenantId }
          { name: 'MCP_REQUIRED_SCOPE', value: 'access_as_user' }
          { name: 'MCP_REQUIRED_ROLE', value: 'M365.Read' }
          { name: 'MCP_OAUTH_SCOPE', value: 'api://${apiClientId}/access_as_user' }
          { name: 'MCP_DASHBOARD_CLIENT_ID', value: dashboardClientId }
          { name: 'MCP_ACCESS_REGISTRY_JSON', secretRef: 'access-registry' }
          { name: 'GRAPH_ENABLED', value: 'true' }
          { name: 'GRAPH_CLIENT_ID', value: graphClientId }
          { name: 'GRAPH_CREDENTIAL_MODE', value: 'managed-identity' }
          { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        ]
        probes: [
          { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 15, periodSeconds: 30 }
          { type: 'Readiness', httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 5, periodSeconds: 10 }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '10' } } }]
      }
    }
  }
}

output mcpUrl string = '${origin}/mcp'
output managedIdentityPrincipalId string = identity.properties.principalId
output managedIdentityClientId string = identity.properties.clientId
output containerAppResourceId string = app.id
