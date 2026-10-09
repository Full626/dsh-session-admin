<#
.SYNOPSIS
    Install or uninstall dsh-session-admin for one dsh profile.
.EXAMPLE
    .\install.ps1 -Profile desktop
.EXAMPLE
    .\install.ps1 -Profile desktop -Uninstall
#>
[CmdletBinding()]
param(
    [string]$DshHome = $env:DSH_HOME,
    [string]$Profile = "desktop",
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "scripts\install.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "installer not found: $scriptPath" }

$nodeArgs = @($scriptPath, "--profile", $Profile)
if ($DshHome) { $nodeArgs += @("--dsh-home", $DshHome) }
if ($Uninstall) { $nodeArgs += "--uninstall" }
if ($DryRun) { $nodeArgs += "--dry-run" }

& node @nodeArgs
exit $LASTEXITCODE
