# tests/05-scanner.ps1
# Invariante 4: una entrada entra una sola vez + doble puerta offline.
# Cubre el test #6 del enunciado.
# Uso (desde la raíz del proyecto):
#   .\tests\05-scanner.ps1
#   .\tests\05-scanner.ps1 -TicketId 5000
# Requiere backend en http://localhost:5248 y docker compose levantado.

param(
    [int]$TicketId = 0
)

$ErrorActionPreference = "Stop"
$base = "http://localhost:5248"
$j = "application/json"
$pass = 0
$fail = 0

function Check($name, $condition) {
    if ($condition) {
        Write-Host "  [PASS] $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  [FAIL] $name" -ForegroundColor Red
        $script:fail++
    }
}

function Psql($sql) {
    $raw = $sql | docker compose exec -T db psql -U ticketing -d ticketing_db -t -A
    return ($raw | Out-String).Trim()
}

Write-Host "== 05 - Invariante 4: una entrada entra una sola vez ==" -ForegroundColor Cyan

# ---------- Setup: login del staff ----------
Write-Host "`n-- Setup --" -ForegroundColor Yellow

$staffLogin = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"staff1@ticketing.test","password":"Staff2026!"}'
Check "Login staff OK" ($null -ne $staffLogin.accessToken)

$staffH = @{ Authorization = "Bearer $($staffLogin.accessToken)" }

# ---------- Buscar una entrada 'pagada' del evento 1 ----------
if ($TicketId -eq 0) {
    $raw = Psql 'SELECT "Id" FROM "Entradas" WHERE "EventoId" = 1 AND "Estado" = ''pagada'' ORDER BY "Id" LIMIT 1;'
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Host "No hay entradas pagadas en el evento 1. Resetea la BD o pasa -TicketId." -ForegroundColor Red
        exit 1
    }
    $TicketId = [int]$raw
}

Write-Host "Entrada a escanear: $TicketId" -ForegroundColor Gray

$estado = Psql "SELECT ""Estado"" FROM ""Entradas"" WHERE ""Id"" = $TicketId;"
Check "Entrada $TicketId está 'pagada'" ($estado -eq "pagada")

# ---------- Registrar dos dispositivos ----------
Write-Host "`n-- Registro de dispositivos --" -ForegroundColor Yellow

$deviceABody = @{ eventoId = 1; puertaId = 1 } | ConvertTo-Json
$deviceA = Invoke-RestMethod "$base/api/scanner/devices" -Method Post -Headers $staffH -ContentType $j -Body $deviceABody
Check "Dispositivo A registrado (evento 1, puerta 1)" ($deviceA.deviceId -gt 0)

$deviceBBody = @{ eventoId = 1; puertaId = 2 } | ConvertTo-Json
$deviceB = Invoke-RestMethod "$base/api/scanner/devices" -Method Post -Headers $staffH -ContentType $j -Body $deviceBBody
Check "Dispositivo B registrado (evento 1, puerta 2)" ($deviceB.deviceId -gt 0)

# ---------- Test #6: dos puertas offline, misma entrada ----------
Write-Host "`n-- Test #6: dos puertas offline, misma entrada --" -ForegroundColor Yellow

$scanIdA = [guid]::NewGuid().ToString()
$scanIdB = [guid]::NewGuid().ToString()
$now = (Get-Date).ToUniversalTime().ToString("o")

$batchA = @{
    deviceId = $deviceA.deviceId
    scans = @(
        @{
            clientScanId = $scanIdA
            entradaId = $TicketId
            eventoId = 1
            puertaId = 1
            escaneadoEn = $now
        }
    )
} | ConvertTo-Json -Depth 5

$respA = Invoke-RestMethod "$base/api/scanner/batches" -Method Post -Headers $staffH -ContentType $j -Body $batchA
Check "Dispositivo A procesa 1 escaneo" ($respA.processed -eq 1)
Check "Dispositivo A -> resultado 'ok'" ($respA.results[0].resultado -eq "ok")

$batchB = @{
    deviceId = $deviceB.deviceId
    scans = @(
        @{
            clientScanId = $scanIdB
            entradaId = $TicketId
            eventoId = 1
            puertaId = 2
            escaneadoEn = $now
        }
    )
} | ConvertTo-Json -Depth 5

$respB = Invoke-RestMethod "$base/api/scanner/batches" -Method Post -Headers $staffH -ContentType $j -Body $batchB
Check "Dispositivo B procesa 1 escaneo" ($respB.processed -eq 1)
Check "Dispositivo B -> resultado 'duplicate'" ($respB.results[0].resultado -eq "duplicate")

$countIngresos = Psql "SELECT COUNT(*) FROM ""Ingresos"" WHERE ""EntradaId"" = $TicketId;"
Check "Hay 2 ingresos para la entrada $TicketId" ($countIngresos -eq "2")

$countOk = Psql "SELECT COUNT(*) FROM ""Ingresos"" WHERE ""EntradaId"" = $TicketId AND ""Resultado"" = 'ok';"
Check "Exactamente 1 ingreso 'ok'" ($countOk -eq "1")

$countDup = Psql "SELECT COUNT(*) FROM ""Ingresos"" WHERE ""EntradaId"" = $TicketId AND ""Resultado"" = 'duplicate';"
Check "Exactamente 1 ingreso 'duplicate'" ($countDup -eq "1")

$estadoAfter = Psql "SELECT ""Estado"" FROM ""Entradas"" WHERE ""Id"" = $TicketId;"
Check "Entrada ahora está 'usada'" ($estadoAfter -eq "usada")

# ---------- Idempotencia del lote ----------
Write-Host "`n-- Idempotencia del lote --" -ForegroundColor Yellow

$respA2 = Invoke-RestMethod "$base/api/scanner/batches" -Method Post -Headers $staffH -ContentType $j -Body $batchA
Check "Reenvío del mismo lote no falla" ($respA2.processed -eq 1)
Check "Reenvío -> resultado 'duplicate'" ($respA2.results[0].resultado -eq "duplicate")

$countIngresos2 = Psql "SELECT COUNT(*) FROM ""Ingresos"" WHERE ""EntradaId"" = $TicketId;"
Check "Sigue habiendo 2 ingresos (no duplicó)" ($countIngresos2 -eq "2")

# ---------- Endpoints auxiliares ----------
Write-Host "`n-- Endpoints auxiliares --" -ForegroundColor Yellow

$revocations = Invoke-RestMethod "$base/api/scanner/revocations?since=1970-01-01T00:00:00Z" -Headers $staffH -Method Get
Check "Revocaciones devuelve lista" ($null -ne $revocations.revocations)

$pub = Invoke-RestMethod "$base/api/scanner/public-key" -Method Get
Check "Clave pública sin auth" ($pub.algorithm -eq "Ed25519" -and $pub.publicKeyBase64.Length -gt 40)

# ---------- Resultado final ----------
Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host "Resultado: $pass PASS / $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Limpieza (opcional):" -ForegroundColor Gray
Write-Host "  docker compose exec db psql -U ticketing -d ticketing_db -c 'DELETE FROM ""Ingresos"" WHERE ""EntradaId"" = $TicketId;'" -ForegroundColor DarkGray
Write-Host "  docker compose exec db psql -U ticketing -d ticketing_db -c 'UPDATE ""Entradas"" SET ""Estado"" = ''pagada'' WHERE ""Id"" = $TicketId;'" -ForegroundColor DarkGray
Write-Host "  docker compose exec db psql -U ticketing -d ticketing_db -c 'DELETE FROM ""DispositivosEscaner"" WHERE ""Id"" >= $($deviceA.deviceId);'" -ForegroundColor DarkGray

if ($fail -gt 0) { exit 1 }