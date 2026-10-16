$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot\.."

Push-Location $repoRoot
try {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
        Write-Host "Creado .env con valores locales de prueba; no uses estos valores en produccion." -ForegroundColor Yellow
    }

    $previousAuthLimit = [Environment]::GetEnvironmentVariable("AUTH_RATE_LIMIT_PER_MINUTE", "Process")
    $previousAspNetEnvironment = [Environment]::GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", "Process")
    $env:AUTH_RATE_LIMIT_PER_MINUTE = "1000"
    $env:ASPNETCORE_ENVIRONMENT = "Development"
    try {
        Write-Host "Iniciando PostgreSQL y API en modo de pruebas..." -ForegroundColor Cyan
        docker compose up --build -d db backend
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Compose no pudo iniciar PostgreSQL y la API."
        }
    } finally {
        if ($null -eq $previousAuthLimit) {
            Remove-Item Env:AUTH_RATE_LIMIT_PER_MINUTE -ErrorAction SilentlyContinue
        } else {
            $env:AUTH_RATE_LIMIT_PER_MINUTE = $previousAuthLimit
        }
        if ($null -eq $previousAspNetEnvironment) {
            Remove-Item Env:ASPNETCORE_ENVIRONMENT -ErrorAction SilentlyContinue
        } else {
            $env:ASPNETCORE_ENVIRONMENT = $previousAspNetEnvironment
        }
    }

    $apiPort = 5248
    if ($env:API_PORT -match '^\d+$') {
        $apiPort = [int]$env:API_PORT
    } else {
        $envFilePort = Select-String -Path ".env" -Pattern '^\s*API_PORT\s*=\s*(\d+)\s*$' |
            Select-Object -First 1
        if ($envFilePort -and $envFilePort.Matches[0].Groups[1].Value) {
            $apiPort = [int]$envFilePort.Matches[0].Groups[1].Value
        }
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-NetConnection -ComputerName "localhost" -Port $apiPort -InformationLevel Quiet -WarningAction SilentlyContinue) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if (-not $ready) {
        docker compose logs --tail 40 backend
        throw "La API no estuvo disponible en http://localhost:$apiPort después de 60 segundos."
    }

    Write-Host ""
    Write-Host "Entorno de pruebas listo: http://localhost:$apiPort (Development)" -ForegroundColor Green
    Write-Host "Ejecuta .\tests\01-aforo.ps1 -Cleanup y los demás tests desde la raíz." -ForegroundColor Gray
    Write-Host "La base no se borra ni se reinicia; las pruebas pueden modificar sus datos." -ForegroundColor Yellow
} finally {
    Pop-Location
}
