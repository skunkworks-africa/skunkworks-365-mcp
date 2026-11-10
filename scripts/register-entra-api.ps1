#Requires -Version 7.2
<#
.SYNOPSIS
  Register the single-tenant Skunkworks 365 MCP API application in Microsoft Entra ID.
.DESCRIPTION
  Administrator-operated bootstrap. Defaults to a read-only plan and DOES NOT
  create any OAuth client registration, client secret, consent grant or Graph
  customer connector. Run -Execute only after checking the tenant and permissions.
  Microsoft Graph delegated Application.ReadWrite.All is broad and may require
  tenant-admin consent; use a temporary privileged admin session.
.EXAMPLE
  ./scripts/register-entra-api.ps1 -TenantId '<your-tenant-guid>'
.EXAMPLE
  ./scripts/register-entra-api.ps1 -TenantId '<your-tenant-guid>' -Execute
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')]
  [string] $TenantId,

  [switch] $Execute
)

$ErrorActionPreference = 'Stop'
$DisplayName = 'Skunkworks 365 MCP'
$Scope = 'access_as_user'

Write-Host 'Proposed Entra resource API registration:' -ForegroundColor Cyan
Write-Host "  Tenant: $TenantId"
Write-Host "  Display name: $DisplayName"
Write-Host "  Audience: AzureADMyOrg (single-tenant)"
Write-Host "  Delegated scope: $Scope (admin consent required)"
Write-Host '  Token version: v2'
Write-Host '  No app secret or OAuth client will be generated.'
if (-not $Execute) {
  Write-Host 'No changes made. Review and re-run with -Execute to create.' -ForegroundColor Yellow
  return
}
if (-not $PSCmdlet.ShouldProcess("Entra tenant $TenantId", "Create $DisplayName API application and service principal")) {
  Write-Host 'Cancelled. No changes made.'
  return
}

$commands = @(
  'Connect-MgGraph', 'Get-MgContext', 'Get-MgApplication',
  'New-MgApplication', 'Update-MgApplication',
  'Get-MgServicePrincipal', 'New-MgServicePrincipal'
)
foreach ($cmd in $commands) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing $cmd. Install Microsoft.Graph.Authentication and Microsoft.Graph.Applications first."
  }
}

# Interactive sign-in. The delegated Graph permission is high impact; do not
# request it through an unattended pipeline or store authentication artifacts.
Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All' -NoWelcome -ErrorAction Stop
$context = Get-MgContext -ErrorAction Stop
if ($context.TenantId -ne $TenantId) { throw 'Connected tenant does not match the requested tenant ID.' }
if ($context.AuthType -ne 'Delegated') { throw 'Only delegated interactive administrator auth is supported.' }

# Fail closed on existing registrations; do not modify or duplicate unknown apps.
$escapedName = $DisplayName.Replace("'", "''")
$existing = @(Get-MgApplication -Filter "displayName eq '$escapedName'" -ErrorAction Stop)
if ($existing.Count -gt 0) {
  Write-Warning 'An application with this display name already exists. Nothing was created.'
  $existing | Select-Object DisplayName, AppId, Id | Format-Table
  throw 'Review the existing registration in Entra before proceeding.'
}

$permissionId = [guid]::NewGuid().ToString()
$api = @{
  RequestedAccessTokenVersion = 2
  Oauth2PermissionScopes = @(
    @{
      Id = $permissionId
      Value = $Scope
      IsEnabled = $true
      Type = 'Admin'
      AdminConsentDisplayName = 'Use Skunkworks 365 MCP as the signed-in user'
      AdminConsentDescription = 'Allow the approved client to invoke Skunkworks 365 MCP on behalf of the signed-in user. Customer access is separately restricted by server-side grants.'
      UserConsentDisplayName = 'Use Skunkworks 365 MCP'
      UserConsentDescription = 'Invoke Skunkworks 365 MCP as the signed-in user.'
    }
  )
}
$app = New-MgApplication -DisplayName $DisplayName -SignInAudience 'AzureADMyOrg' -Api $api -ErrorAction Stop
try {
  Update-MgApplication -ApplicationId $app.Id -IdentifierUris @("api://$($app.AppId)") -ErrorAction Stop
  $sp = New-MgServicePrincipal -AppId $app.AppId -ErrorAction Stop
  Write-Host "Created API application ID: $($app.AppId)" -ForegroundColor Green
  Write-Host "Directory tenant ID: $TenantId"
  Write-Host "Application ID URI: api://$($app.AppId)"
  Write-Host "Delegated scope: api://$($app.AppId)/$Scope"
  Write-Host "Service principal ID: $($sp.Id)"
  Write-Host 'Next: configure a compatible ChatGPT OAuth client; do not enable customer data adapters yet.'
  Write-Host 'Keep registration values and any future credentials in private deployment settings.'
} catch {
  Write-Warning "The API application was created but subsequent setup failed. Its AppId is $($app.AppId)."
  Write-Warning 'Do NOT re-run to make a duplicate. Review the partial app registration in Entra.'
  throw
}
