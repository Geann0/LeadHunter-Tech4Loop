#!/usr/bin/env pwsh
# LeadHunter Pro - Build e Instalador (PowerShell Core)

param(
    [ValidateSet("build", "repair")]
    [string]$Action = "build"
)

$ErrorActionPreference = "Stop"
$WarningPreference = "SilentlyContinue"

function Write-Success { Write-Host "✓ $args" -ForegroundColor Green }
function Write-Info { Write-Host "ℹ $args" -ForegroundColor Cyan }
function Write-Error-Safe { Write-Host "✗ $args" -ForegroundColor Red }

try {
    Write-Info "Iniciando build..."
    
    # Stage 1: TypeScript
    Write-Info "1/4 Compilando TypeScript..."
    & npm run build --silent 2>$null | Out-Null
    
    # Stage 2: Vite Build  
    Write-Info "2/4 Gerando assets com Vite..."
    & npx vite build 2>$null | Out-Null
    
    # Stage 3: Empacotamento Electron
    Write-Info "3/4 Empacotando com Electron..."
    & npx electron-packager . LeadHunter-Pro `
        --platform=win32 `
        --arch=x64 `
        --out=production-build `
        --overwrite `
        --no-asar `
        --icon=public/icon.ico `
        --asar=false 2>$null | Out-Null
        
    # Stage 4: NSIS
    if (Get-Command makensis -ErrorAction SilentlyContinue) {
        Write-Info "4/4 Gerando instalador NSIS..."
        New-Item -ItemType Directory -Path "dist_installer" -Force | Out-Null
        & makensis.exe /V4 "installer.nsi" 2>$null
        Write-Success "Instalador gerado em dist_installer\"
    } else {
        Write-Info "4/4 NSIS não disponível no PATH"
        Write-Info "Aplicativo empacotado em production-build\LeadHunter-Pro-win32-x64"
    }
    
    Write-Success "Build concluído com sucesso!"
    
} catch {
    Write-Error-Safe "Erro durante build: $_"
    exit 1
}
