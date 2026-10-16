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

function Get-HttpStatus($method, $url, $headers, $body) {
    try {
        $params = @{ Uri = $url; Method = $method; Headers = $headers; ContentType = $j }
        if ($null -ne $body) { $params.Body = $body }
        Invoke-RestMethod @params | Out-Null
        return 0
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        throw
    }
}

Write-Host "== 05 - Invariante 4: una entrada entra una sola vez ==" -ForegroundColor Cyan

# ---------- Setup: login del staff ----------
Write-Host "`n-- Setup --" -ForegroundColor Yellow

$staffLogin = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"staff1@ticketing.test","password":"Staff2026!"}'
Check "Login staff OK" ($null -ne $staffLogin.accessToken)

$staffH = @{ Authorization = "Bearer $($staffLogin.accessToken)" }

$assignedEvents = Invoke-RestMethod "$base/api/scanner/events" -Headers $staffH -Method Get
$assignedIds = @($assignedEvents | ForEach-Object { [int]$_.id })
Check "Staff 1 solo recibe eventos asignados y no finalizados" (
    ($assignedIds -contains 4) -and
    ($assignedIds -contains 7) -and
    (-not ($assignedIds -contains 6)) -and
    (-not ($assignedIds -contains 1))
)

$unassignedDeviceBody = @{ eventoId = 6; puertaId = 16 } | ConvertTo-Json
$unassignedStatus = Get-HttpStatus "Post" "$base/api/scanner/devices" $staffH $unassignedDeviceBody
Check "Staff 1 no puede registrar un dispositivo en evento 6 -> 403" ($unassignedStatus -eq 403)

$finishedDeviceBody = @{ eventoId = 1; puertaId = 1 } | ConvertTo-Json
$finishedStatus = Get-HttpStatus "Post" "$base/api/scanner/devices" $staffH $finishedDeviceBody
Check "Un evento finalizado no permite iniciar un turno -> 409" ($finishedStatus -eq 409)

$wrongDoorBody = @{ eventoId = 4; puertaId = 16 } | ConvertTo-Json
$wrongDoorStatus = Get-HttpStatus "Post" "$base/api/scanner/devices" $staffH $wrongDoorBody
Check "No se puede registrar una puerta de otro evento -> 404" ($wrongDoorStatus -eq 404)

$revocationsStatus = Get-HttpStatus "Get" "$base/api/scanner/revocations?eventId=6&since=1970-01-01T00:00:00Z" $staffH $null
Check "Staff 1 no puede consultar revocaciones del evento 6 -> 403" ($revocationsStatus -eq 403)

# ---------- Buscar una entrada 'pagada' de un evento activo asignado ----------
if ($TicketId -eq 0) {
    $raw = Psql 'SELECT "Id" FROM "Entradas" WHERE "EventoId" = 4 AND "Estado" = ''pagada'' ORDER BY "Id" LIMIT 1;'
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Host "No hay entradas pagadas en el evento 4. Resetea la BD o pasa -TicketId." -ForegroundColor Red
        exit 1
    }
    $TicketId = [int]$raw
}

Write-Host "Entrada a escanear: $TicketId" -ForegroundColor Gray

$ticketRow = Psql "SELECT ""Estado"" || '|' || ""EventoId"" FROM ""Entradas"" WHERE ""Id"" = $TicketId;"
$ticketParts = $ticketRow.Split('|')
Check "Entrada $TicketId está pagada y pertenece al evento activo 4" (
    $ticketParts.Count -eq 2 -and $ticketParts[0] -eq "pagada" -and $ticketParts[1] -eq "4"
)

# ---------- Registrar dos dispositivos ----------
Write-Host "`n-- Registro de dispositivos --" -ForegroundColor Yellow

$deviceABody = @{ eventoId = 4; puertaId = 10 } | ConvertTo-Json
$deviceA = Invoke-RestMethod "$base/api/scanner/devices" -Method Post -Headers $staffH -ContentType $j -Body $deviceABody
Check "Dispositivo A registrado (evento 4, puerta 10)" ($deviceA.deviceId -gt 0)

$deviceBBody = @{ eventoId = 4; puertaId = 11 } | ConvertTo-Json
$deviceB = Invoke-RestMethod "$base/api/scanner/devices" -Method Post -Headers $staffH -ContentType $j -Body $deviceBBody
Check "Dispositivo B registrado (evento 4, puerta 11)" ($deviceB.deviceId -gt 0)

# ---------- La asignación se vuelve a validar al sincronizar ----------
$staffId = [int](Psql 'SELECT "Id" FROM "Usuarios" WHERE "Email" = ''staff1@ticketing.test'';')
Psql "DELETE FROM ""AsignacionesStaff"" WHERE ""EventoId"" = 4 AND ""StaffId"" = $staffId;" | Out-Null
try {
    $assignmentCheckBatch = @{
        deviceId = $deviceA.deviceId
        scans = @(
            @{
                clientScanId = [guid]::NewGuid().ToString()
                entradaId = $TicketId
                eventoId = 4
                puertaId = 10
                escaneadoEn = (Get-Date).ToUniversalTime().ToString("o")
            }
        )
    } | ConvertTo-Json -Depth 5
    $assignmentCheckStatus = Get-HttpStatus "Post" "$base/api/scanner/batches" $staffH $assignmentCheckBatch
    Check "Un dispositivo pierde acceso al revocarse la asignacion -> 403" ($assignmentCheckStatus -eq 403)
} finally {
    Psql "INSERT INTO ""AsignacionesStaff"" (""EventoId"", ""StaffId"") VALUES (4, $staffId) ON CONFLICT DO NOTHING;" | Out-Null
}

# ---------- El lote queda vinculado al evento y puerta del dispositivo ----------
$wrongEventBatch = @{
    deviceId = $deviceA.deviceId
    scans = @(
        @{
            clientScanId = [guid]::NewGuid().ToString()
            entradaId = $TicketId
            eventoId = 6
            puertaId = 16
            escaneadoEn = (Get-Date).ToUniversalTime().ToString("o")
        }
    )
} | ConvertTo-Json -Depth 5
$wrongEventResponse = Invoke-RestMethod "$base/api/scanner/batches" -Method Post -Headers $staffH -ContentType $j -Body $wrongEventBatch
Check "El lote no permite reportar el escaneo bajo otro evento" (
    $wrongEventResponse.results[0].resultado -eq "wrong_event"
)

$wrongDoorBatch = @{
    deviceId = $deviceA.deviceId
    scans = @(
        @{
            clientScanId = [guid]::NewGuid().ToString()
            entradaId = $TicketId
            eventoId = 4
            puertaId = 11
            escaneadoEn = (Get-Date).ToUniversalTime().ToString("o")
        }
    )
} | ConvertTo-Json -Depth 5
$wrongDoorResponse = Invoke-RestMethod "$base/api/scanner/batches" -Method Post -Headers $staffH -ContentType $j -Body $wrongDoorBatch
Check "Un dispositivo no puede reportar escaneos desde otra puerta" (
    $wrongDoorResponse.results[0].resultado -eq "wrong_door"
)

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
            eventoId = 4
            puertaId = 10
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
            eventoId = 4
            puertaId = 11
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

$revocations = Invoke-RestMethod "$base/api/scanner/revocations?eventId=4&since=1970-01-01T00:00:00Z" -Headers $staffH -Method Get
Check "Revocaciones del evento asignado devuelve lista y cursor" (
    ($null -ne $revocations.revocations) -and ($null -ne $revocations.syncedAt)
)

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