# tests/06-business-rules.ps1
# Pruebas de reglas de negocio: #7 (Reembolso tras uso), #8 (Organizador ajeno), #9 (Precio manipulado).

$ErrorActionPreference = "Stop"
$baseUrl = "http://localhost:5248"
$j = "application/json"
$passCount = 0
$failCount = 0

function Assert-True($condition, $message) {
    if ($condition) {
        Write-Host "  [PASS] $message" -ForegroundColor Green
        $script:passCount++
    } else {
        Write-Host "  [FAIL] $message" -ForegroundColor Red
        $script:failCount++
    }
}

function Psql($sql) {
    $raw = $sql | docker compose exec -T db psql -U ticketing -d ticketing_db -t -A
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo ejecutar la consulta de prueba en PostgreSQL."
    }
    return ($raw | Out-String).Trim()
}

Write-Host "=== INICIANDO PRUEBAS DE REGLAS DE NEGOCIO (06) ===" -ForegroundColor Cyan

# ---------- Setup: Autenticación ----------
Write-Host "`n-- Setup: Autenticación y Limpieza --" -ForegroundColor Yellow
$loginAsistente = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" -Method Post -ContentType $j -Body '{"email":"asistente1@correo.test","password":"Asistente2026!"}'
$tokenAsistente = $loginAsistente.accessToken
$hAsistente = @{ Authorization = "Bearer $tokenAsistente" }
Assert-True ($null -ne $tokenAsistente) "Login asistente1 OK"

# Limpiar compras anteriores de la cuenta de prueba respetando sus relaciones.
$asistenteId = [int](Psql 'SELECT "Id" FROM "Usuarios" WHERE "Email" = ''asistente1@correo.test'';')
Psql @"
BEGIN;
DELETE FROM "Ingresos" WHERE "EntradaId" IN (
    SELECT e."Id" FROM "Entradas" e JOIN "Compras" c ON c."Id" = e."CompraId"
    WHERE c."AsistenteId" = $asistenteId
);
DELETE FROM "RevocacionesEntrada" WHERE "EntradaId" IN (
    SELECT e."Id" FROM "Entradas" e JOIN "Compras" c ON c."Id" = e."CompraId"
    WHERE c."AsistenteId" = $asistenteId
);
DELETE FROM "Transferencias" WHERE "EntradaId" IN (
    SELECT e."Id" FROM "Entradas" e JOIN "Compras" c ON c."Id" = e."CompraId"
    WHERE c."AsistenteId" = $asistenteId
);
DELETE FROM "Entradas" WHERE "CompraId" IN (
    SELECT "Id" FROM "Compras" WHERE "AsistenteId" = $asistenteId
);
DELETE FROM "Compras" WHERE "AsistenteId" = $asistenteId;
DELETE FROM "Reservas" WHERE "AsistenteId" = $asistenteId;
COMMIT;
"@ | Out-Null


# ---------- Búsqueda automática de zona, evento, puerta y precio activos ----------
$seleccionRaw = Psql @'
SELECT z."Id" || '|' || e."Id" || '|' || p."Id"
FROM "Zonas" z
JOIN "Eventos" e ON e."Id" = z."EventoId"
JOIN "Usuarios" org ON org."Id" = e."OrganizadorId"
JOIN "AsignacionesStaff" a ON a."EventoId" = e."Id"
JOIN "Usuarios" staff ON staff."Id" = a."StaffId"
JOIN "Puertas" p ON p."EventoId" = e."Id"
JOIN "FasesPrecio" f ON f."ZonaId" = z."Id"
WHERE e."Estado" = 'en_venta'
  AND e."VentaAbre" <= now() AND e."Fecha" > now()
  AND f."Desde" <= now() AND now() < f."Hasta"
  AND org."Email" = 'org.istmo@ticketing.test'
  AND staff."Email" = 'staff1@ticketing.test'
ORDER BY z."Id", p."Id"
LIMIT 1;
'@
if ([string]::IsNullOrWhiteSpace($seleccionRaw)) {
    Write-Host "No se encontró una zona en venta del organizador1 con fase activa, puerta y staff asignado." -ForegroundColor Red
    exit 1
}
$seleccion = $seleccionRaw -split '\|'
$zonaId = [int]$seleccion[0]
$eventoId = [int]$seleccion[1]
$puertaId = [int]$seleccion[2]
$precioEsperado = [long](Psql ('SELECT "PrecioCentesimos" FROM "FasesPrecio" WHERE "ZonaId" = ' + $zonaId + ' AND "Desde" <= now() AND now() < "Hasta" ORDER BY "Desde" LIMIT 1;'))

Write-Host "Zona seleccionada: $zonaId (Evento ID:$eventoId, puerta ID:$puertaId)" -ForegroundColor Gray


# ==========================================
# TEST #9: Precio manipulado (Se cobra el real)
# ==========================================
Write-Host "`n-- Test #9: Precio manipulado --" -ForegroundColor Yellow

$keyRes9 = "res-" + [guid]::NewGuid().ToString()
$hRes9 = $hAsistente.Clone()
$hRes9["Idempotency-Key"] = $keyRes9

$reservaReq = @{
    zonaId = $zonaId
    cantidad = 1
    precioCentavos = 1 # Intento de manipular enviando un precio falso
}

try {
    $bodyJson9 = $reservaReq | ConvertTo-Json
    $reservaRes = Invoke-RestMethod -Uri "$baseUrl/api/reservas" -Method Post -Headers $hRes9 -ContentType $j -Body $bodyJson9
    $reservaId = $reservaRes.reservaId

    $keyPag9 = "pay-" + [guid]::NewGuid().ToString()
    $hPag9 = $hAsistente.Clone()
    $hPag9["Idempotency-Key"] = $keyPag9

    Invoke-RestMethod -Uri "$baseUrl/api/reservas/$reservaId/pago" -Method Post -Headers $hPag9 -ContentType $j | Out-Null

    $dbPrecioStr = Psql ('SELECT "MontoCentesimos" FROM "Compras" WHERE "IdempotencyKey" = ''' + $keyPag9 + ''';')
    $dbPrecio = [long]$dbPrecioStr

    Assert-True ($dbPrecio -eq $precioEsperado) "El servidor ignoró el precio manipulado y cobró el precio vigente ($dbPrecio centesimos)."
} catch {
    Write-Host "  [FAIL] Test #9 falló por excepción: $_" -ForegroundColor Red
    $script:failCount++
}


# ==========================================
# TEST #7: Reembolso de entrada usada (Rechazado)
# ==========================================
Write-Host "`n-- Test #7: Reembolso de entrada usada --" -ForegroundColor Yellow

$keyRes7 = "res-" + [guid]::NewGuid().ToString()
$hRes7 = $hAsistente.Clone()
$hRes7["Idempotency-Key"] = $keyRes7

$bodyRes7 = @{ zonaId = $zonaId; cantidad = 1 } | ConvertTo-Json
$reserva2 = Invoke-RestMethod -Uri "$baseUrl/api/reservas" -Method Post -Headers $hRes7 -ContentType $j -Body $bodyRes7
$reserva2Id = $reserva2.reservaId

$keyPag7 = "pay-" + [guid]::NewGuid().ToString()
$hPag7 = $hAsistente.Clone()
$hPag7["Idempotency-Key"] = $keyPag7

Invoke-RestMethod -Uri "$baseUrl/api/reservas/$reserva2Id/pago" -Method Post -Headers $hPag7 -ContentType $j | Out-Null

# Obtener el ID de la entrada generada
$entradaIdStr = Psql ('SELECT e."Id" FROM "Entradas" e JOIN "Compras" c ON c."Id" = e."CompraId" WHERE c."IdempotencyKey" = ''' + $keyPag7 + ''' LIMIT 1;')
$entradaId = [int]$entradaIdStr

# Login como staff usando el correo oficial del seed
$loginStaff = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" -Method Post -ContentType $j -Body '{"email":"staff1@ticketing.test","password":"Staff2026!"}'
$hStaff = @{ Authorization = "Bearer $($loginStaff.accessToken)" }

$deviceBody = @{ eventoId = $eventoId; puertaId = $puertaId } | ConvertTo-Json
$deviceRes = Invoke-RestMethod -Uri "$baseUrl/api/scanner/devices" -Method Post -Headers $hStaff -ContentType $j -Body $deviceBody

$batchBody = @{
    deviceId = $deviceRes.deviceId
    scans = @(
        @{
            clientScanId = [guid]::NewGuid().ToString()
            entradaId = $entradaId
            eventoId = $eventoId
            puertaId = $puertaId
            escaneadoEn = (Get-Date).ToUniversalTime().ToString("o")
        }
    )
}
Invoke-RestMethod -Uri "$baseUrl/api/scanner/batches" -Method Post -Headers $hStaff -ContentType $j -Body ($batchBody | ConvertTo-Json -Depth 5) | Out-Null

# Intentar reembolsar la entrada ya usada
$refundFailed =$false
try {
    Invoke-RestMethod -Uri "$baseUrl/api/tickets/$entradaId/refund" -Method Post -Headers $hAsistente -ContentType $j
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    if ($statusCode -eq 400 -or $statusCode -eq 409 -or $statusCode -eq 422) {
        $refundFailed =$true
    }
}
Assert-True $refundFailed "El servidor rechazó correctamente el reembolso de una entrada ya usada."


# ==========================================
# TEST #8: Organizador ajeno (Rechazado - 403)
# ==========================================
Write-Host "`n-- Test #8: Acceso de organizador ajeno --" -ForegroundColor Yellow

# Login como organizador1 (dueño del evento)
$loginOrg1 = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" -Method Post -ContentType $j -Body '{"email":"org.istmo@ticketing.test","password":"Organizador2026!"}'
$resOrg1 = Invoke-WebRequest -Uri "$baseUrl/api/admin/events/$eventoId/incidents" -Method Get -Headers @{ Authorization = "Bearer $($loginOrg1.accessToken)" } -UseBasicParsing
Assert-True ([int]$resOrg1.StatusCode -eq 200) "El organizador propietario puede ver los incidentes de su evento (200 OK)."

# Login como organizador2 (ajeno al evento)
$loginOrg2 = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" -Method Post -ContentType $j -Body '{"email":"org.canal@ticketing.test","password":"Organizador2026!"}'

$org2Blocked = $false
try {
    Invoke-RestMethod -Uri "$baseUrl/api/admin/events/$eventoId/incidents" -Method Get -Headers @{ Authorization = "Bearer $($loginOrg2.accessToken)" }
} catch {
    $statusOrg2 = [int]$_.Exception.Response.StatusCode
    if ($statusOrg2 -eq 403) {
        $org2Blocked = $true
    }
}
Assert-True $org2Blocked "El servidor bloqueó al organizador ajeno devolviendo un código 403 Forbidden."


# ---------- Resultado final ----------
Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host "Resultado: $passCount PASS / $failCount FAIL" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Red" })
Write-Host "===============================================" -ForegroundColor Cyan

if ($failCount -gt 0) { exit 1 }