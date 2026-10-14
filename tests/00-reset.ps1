# tests/00-reset.ps1
# Resetea la BD al estado del seed y deja el backend listo para los tests.
# Uso (desde la raiz del proyecto): .\tests\00-reset.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot\.."

Write-Host "== Reset del entorno ==" -ForegroundColor Cyan

Push-Location $repoRoot

Write-Host "[1/4] Bajando contenedores y borrando volumenes..." -ForegroundColor Gray
docker compose down -v --remove-orphans | Out-Null

Write-Host "[2/4] Levantando solo la DB..." -ForegroundColor Gray
docker compose up -d db | Out-Null

Write-Host "[3/4] Esperando a que la DB este healthy..." -ForegroundColor Gray
$max = 30
for ($i = 0; $i -lt $max; $i++) {
    $status = docker inspect --format='{{.State.Health.Status}}' (docker compose ps -q db) 2>$null
    if ($status -eq "healthy") { break }
    Start-Sleep -Seconds 1
    if ($i -eq $max - 1) {
        Pop-Location
        throw "La DB no llego a healthy en $max segundos."
    }
}
Write-Host "      DB healthy." -ForegroundColor Green

Write-Host "[4/4] Aplicando migraciones y seed..." -ForegroundColor Gray
Push-Location "$repoRoot\backend\Ticketing.Api"
$log = New-TemporaryFile
$proc = Start-Process -FilePath "dotnet" -ArgumentList "run","--launch-profile","http" `
    -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"

# Esperar a que el backend escuche
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Select-String -Path $log -Pattern "Now listening on" -Quiet -ErrorAction SilentlyContinue) {
        $ready = $true
        break
    }
    if ($proc.HasExited) {
        Pop-Location; Pop-Location
        Get-Content $log, "$log.err" | Select-Object -Last 40
        throw "El backend termino antes de escuchar. Revisa los logs arriba."
    }
}
Pop-Location
Pop-Location

if (-not $ready) {
    $proc | Stop-Process -Force
    throw "El backend no arranco en 60 segundos."
}

Write-Host ""
Write-Host "Backend listo en http://localhost:5248 (PID $($proc.Id))" -ForegroundColor Green
Write-Host "Corre los tests: .\tests\02-idempotencia.ps1 ; .\tests\03-pago.ps1" -ForegroundColor Gray
Write-Host "Para detenerlo: Stop-Process -Id $($proc.Id)" -ForegroundColor Gray