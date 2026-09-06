#requires -Version 5.1
<#
.SYNOPSIS
    Remote one-line installer for OpenCode Prime (OCP).

.DESCRIPTION
    This script downloads the latest release archive, extracts it, and runs the
    in-repo installer (install/install.ps1). It is the pipe-friendly equivalent
    of the manual download-extract-install cycle documented in the README.

.EXAMPLE
    # One-line install (pipe):
    irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex

.EXAMPLE
    # One-line install with arguments (pipe + -Args):
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1))) -InstallerArgs @("install","-Force","-Yes")

.EXAMPLE
    # Install a specific version:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1))) -Version "0.9.0"

.NOTES
    All arguments in $InstallerArgs are forwarded to the in-repo installer.
    When -Version is omitted the latest release is installed.
#>

param(
    [string[]]$InstallerArgs = @(),
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
$Repo = "kenlin8827/opencode-prime"
$ReleaseBase = "https://github.com/$Repo/releases/latest/download"
$InstallDir = Join-Path $env:LOCALAPPDATA "opencode-prime"
$TmpZip = Join-Path $env:TEMP "ocp.zip"
$TmpExtract = Join-Path $env:TEMP "ocp-extract"

function Write-Info  { param([string]$Msg) Write-Host "[OCP] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[OCP] $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[OCP] $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[OCP ERROR] $Msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Build download URL (versioned or latest)
# ---------------------------------------------------------------------------
if ($Version) {
    $ArchiveUrl = "https://github.com/$Repo/releases/download/v$Version/opencode-prime-$Version.zip"
    Write-Info "Downloading OpenCode Prime v$Version..."
} else {
    $ArchiveUrl = "$ReleaseBase/opencode-prime-latest.zip"
    Write-Info "Downloading OpenCode Prime latest release..."
}
Write-Info "  URL: $ArchiveUrl"

try {
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $TmpZip -UseBasicParsing
}
catch {
    Write-Err "Failed to download the release archive."
    Write-Err "Error: $_"
    Write-Err "If the problem persists, download manually from:"
    Write-Err "  https://github.com/$Repo/releases/latest"
    exit 1
}

Write-Ok "Download complete."

# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------
Write-Info "Extracting to $InstallDir..."

# Clean temp extract directory
if (Test-Path $TmpExtract) {
    Remove-Item $TmpExtract -Recurse -Force
}

# Extract archive
try {
    Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract -Force
}
catch {
    Write-Err "Failed to extract the archive."
    Write-Err "Error: $_"
    Remove-Item $TmpZip -Force -ErrorAction SilentlyContinue
    exit 1
}

# The archive contains a top-level folder like "opencode-prime-<version>"
$SrcDir = (Get-ChildItem -Path $TmpExtract -Directory | Where-Object { $_.Name -like "opencode-prime-*" } | Select-Object -First 1).FullName

if (-not $SrcDir -or -not (Test-Path $SrcDir)) {
    # Fallback: if no top-level folder, use the extract directory directly
    $SrcDir = $TmpExtract
    Write-Warn "No top-level versioned folder found; using extract directory directly."
}

# Clean previous installation directory
if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Move all contents from source to destination
Get-ChildItem -Path $SrcDir | Move-Item -Destination $InstallDir -Force

Write-Ok "Extraction complete."

# Clean up temp files
Remove-Item $TmpExtract -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $TmpZip -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Run the in-repo installer
# ---------------------------------------------------------------------------
$Installer = Join-Path $InstallDir "install\install.ps1"

if (-not (Test-Path $Installer)) {
    Write-Err "Installer script not found at: $Installer"
    Write-Err "The archive may be corrupted. Please try again."
    exit 1
}

Write-Ok "Starting OpenCode Prime installer..."
Write-Host "============================================================"

# Forward all arguments to the in-repo installer
& $Installer @InstallerArgs

