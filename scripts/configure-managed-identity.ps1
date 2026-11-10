#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][guid]$HomeTenantId,
  [Parameter(Mandatory)][guid]$GraphApplicationObjectId,
  [Parameter(Mandatory)][guid]$ManagedIdentityPrincipalId
)
$ErrorActionPreference = 'Stop'
$token = az account get-access-token --tenant $HomeTenantId --resource https://graph.microsoft.com -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $token.tenant -ne $HomeTenantId.ToString()) { throw 'Authenticate in the expected home tenant.' }
$headers = @{ Authorization="Bearer $($token.accessToken)" }
try {
  $uri = "https://graph.microsoft.com/v1.0/applications/$GraphApplicationObjectId/federatedIdentityCredentials"
  $desired = @{ name='skunkworks365-runtime'; issuer="https://login.microsoftonline.com/$HomeTenantId/v2.0";
    subject=$ManagedIdentityPrincipalId.ToString(); audiences=@('api://AzureADTokenExchange'); description='Dedicated Skunkworks 365 MCP managed identity' }
  $existing = @((Invoke-RestMethod -Uri $uri -Headers $headers).value | Where-Object name -EQ $desired.name)
  if ($existing.Count -gt 1) { throw 'Ambiguous federated credential.' }
  if ($existing.Count -eq 1) {
    if ($existing[0].issuer -ne $desired.issuer -or $existing[0].subject -ne $desired.subject -or
        (Compare-Object @($existing[0].audiences) $desired.audiences)) { throw 'Existing credential differs; review before changing trust.' }
    Write-Output 'Existing managed identity trust matches.'
  } else {
    Invoke-RestMethod -Method POST -Uri $uri -Headers $headers -ContentType 'application/json' -Body ($desired | ConvertTo-Json) | Out-Null
    $verified = @((Invoke-RestMethod -Uri $uri -Headers $headers).value | Where-Object name -EQ $desired.name)
    if ($verified.Count -ne 1 -or $verified[0].subject -ne $desired.subject) { throw 'Trust verification failed.' }
    Write-Output 'Managed identity trust created and verified. Verify actual Graph reads separately.'
  }
} finally { $headers.Clear(); $token = $null }
