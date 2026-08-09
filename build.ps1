# KnockChat Tauri Build Script
# Usage: .\build.ps1 [-OutputDir <Output Directory>]
# Example: .\build.ps1 -OutputDir "E:\Release"
#          .\build.ps1                       # Defaults to .\dist

param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"

# Read product name
$configPath = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$productName = $config.productName

Write-Host "==============================" -ForegroundColor Cyan
Write-Host "  KnockChat Tauri Build Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host "Product Name: $productName"
Write-Host "Output Directory: $OutputDir"
Write-Host "==============================" -ForegroundColor Cyan

# Create the output directory
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "Created output directory: $OutputDir" -ForegroundColor Green
}

# Timestamped build output folder
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$buildDir = Join-Path $OutputDir $timestamp

Write-Host "`nStarting build..." -ForegroundColor Yellow

# Set TAURI_OUTPUT_DIR so tauri writes artifacts to the given directory
$env:TAURI_OUTPUT_DIR = $OutputDir

Push-Location $PSScriptRoot
try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed, exit code: $LASTEXITCODE"
    }
    Write-Host "`nBuild complete!" -ForegroundColor Green
}
finally {
    Pop-Location
    $env:TAURI_OUTPUT_DIR = $null
}

# Copy build artifacts into the timestamped folder
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$sourceBundle = Join-Path $PSScriptRoot "src-tauri\target\release\bundle"

if (Test-Path $sourceBundle) {
    # MSI installer
    $msiDir = Join-Path $sourceBundle "msi"
    if (Test-Path $msiDir) {
        Copy-Item "$msiDir\*.msi" $buildDir -ErrorAction SilentlyContinue
    }

    # NSIS installer
    $nsisDir = Join-Path $sourceBundle "nsis"
    if (Test-Path $nsisDir) {
        Copy-Item "$nsisDir\*.exe" $buildDir -ErrorAction SilentlyContinue
    }

    # Standalone exe from the release directory
    $releaseDir = Join-Path $PSScriptRoot "src-tauri\target\release"
    if (Test-Path $releaseDir) {
        Copy-Item "$releaseDir\$productName.exe" $buildDir -ErrorAction SilentlyContinue
    }

    Write-Host "Artifacts copied to: $buildDir" -ForegroundColor Green
}
else {
    # TAURI_OUTPUT_DIR took effect and artifacts were written directly
    Write-Host "Artifacts output to: $OutputDir" -ForegroundColor Green
}

# Show the build output
Write-Host "`nBuild Output:" -ForegroundColor Cyan
$outputFiles = Get-ChildItem -Path $OutputDir -Recurse -File |
    Where-Object { $_.Extension -match '\.(exe|msi)$' }
foreach ($file in $outputFiles) {
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  $($file.FullName) ($sizeMB MB)" -ForegroundColor White
}

Write-Host "`nDone!" -ForegroundColor Cyan
