#requires -Version 5.1
<#
.SYNOPSIS
    bin/ocp.ps1 — alias dispatcher for OpenCode Prime (OCP)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Subcommand,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ScriptDir = $PSScriptRoot
$Dispatcher = Join-Path $ScriptDir 'opencode-prime.ps1'

# Do not splat a null remainder: PowerShell forwards it as an empty positional
# argument, which the installer parser correctly rejects as an unknown command.
if ($Rest.Count -gt 0) {
    & $Dispatcher $Subcommand @Rest
} else {
    & $Dispatcher $Subcommand
}
exit $LASTEXITCODE
