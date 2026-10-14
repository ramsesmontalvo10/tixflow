# tests/03-pago.ps1
# Invariante 2: idempotencia y concurrencia en el pago.
# Uso (desde la raiz del proyecto): .\tests\03-pago.ps1
# Requiere backend en localhost:5248 y docker compose levantado.

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

function Get-ErrorBody($err) {
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
        return $err.ErrorDetails.Message
    }
    try {
        $stream = $err.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    } catch { return $null }
}

function Invoke-ExpectError($method, $url, $headers) {
    try {
        Invoke-RestMethod $url -Method $method -Headers $headers -ContentType $j -Body '{}' | Out-Null
        return @{ Status = 0; Body = $null; Raw = $null }
    } catch {
        $status = [int]$_.Exception.Response.StatusCode
        $raw = Get-ErrorBody $_
        $parsed = $null
        if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { } }
        return @{ Status = $status; Body = $parsed; Raw = $raw }
    }
}

Write-Host "== 03 - Invariante 2: pago con idempotencia ==" -ForegroundColor Cyan

# 1) Login
$login = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"asistente1@correo.test","password":"Asistente2026!"}'
Write-Host "Login OK" -ForegroundColor Gray

# 2) Reservar R1
$keyR1 = "res-" + [guid]::NewGuid().ToString()
$hR1 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyR1 }
$r1 = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $hR1 -ContentType $j `
    -Body '{"zonaId":8,"cantidad":1}'
Write-Host "Reserva R1 = $($r1.reservaId)" -ForegroundColor Gray

# 3) Pago happy path
$keyP1 = "pay-" + [guid]::NewGuid().ToString()
$hP1 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyP1 }
$p1 = Invoke-RestMethod "$base/api/reservas/$($r1.reservaId)/pago" -Method Post `
    -Headers $hP1 -ContentType $j -Body '{}'
Check "Pago R1 -> 201" ($p1.compraId -gt 0)
Check "Pago R1 emite 1 entrada" ($p1.entradaIds.Count -eq 1)

# 4) Doble toque: misma key P1
$p1b = Invoke-RestMethod "$base/api/reservas/$($r1.reservaId)/pago" -Method Post `
    -Headers $hP1 -ContentType $j -Body '{}'
Check "Doble toque: mismo compraId" ($p1.compraId -eq $p1b.compraId)
Check "Doble toque: mismas entradas" ($p1.entradaIds[0] -eq $p1b.entradaIds[0])

# 5) Misma reserva, key DISTINTA -> 409 AlreadyPaid
$keyP2 = "pay-" + [guid]::NewGuid().ToString()
$hP2 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyP2 }
$r = Invoke-ExpectError "Post" "$base/api/reservas/$($r1.reservaId)/pago" $hP2
Check "Pago R1 con otra key -> 409" ($r.Status -eq 409)
Check "Codigo AlreadyPaid" ($r.Body -and $r.Body.code -eq "AlreadyPaid")

# 6) Misma key P1, otra reserva R2 -> 422 IdempotencyKeyReused
$keyR2 = "res-" + [guid]::NewGuid().ToString()
$hR2 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyR2 }
$r2 = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $hR2 -ContentType $j `
    -Body '{"zonaId":9,"cantidad":1}'
Write-Host "Reserva R2 = $($r2.reservaId)" -ForegroundColor Gray
$r = Invoke-ExpectError "Post" "$base/api/reservas/$($r2.reservaId)/pago" $hP1
Check "Misma key P1 en R2 -> 422" ($r.Status -eq 422)
Check "Codigo IdempotencyKeyReused" ($r.Body -and $r.Body.code -eq "IdempotencyKeyReused")

# 7) Pago tardio: reservar R3, forzar vencimiento en BD, pagar -> 409
$keyR3 = "res-" + [guid]::NewGuid().ToString()
$hR3 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyR3 }
$r3 = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $hR3 -ContentType $j `
    -Body '{"zonaId":9,"cantidad":1}'
Write-Host "Reserva R3 = $($r3.reservaId)" -ForegroundColor Gray

Push-Location "$PSScriptRoot\.."
$sql = "UPDATE `"Reservas`" SET `"ExpiraEn`" = now() - interval '1 minute' WHERE `"Id`" = $($r3.reservaId);"
$sql | docker compose exec -T db psql -U ticketing -d ticketing_db | Out-Null
Pop-Location
Write-Host "R3 forzada a vencida" -ForegroundColor Gray

$keyP3 = "pay-" + [guid]::NewGuid().ToString()
$hP3 = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $keyP3 }
$r = Invoke-ExpectError "Post" "$base/api/reservas/$($r3.reservaId)/pago" $hP3
Check "Pago tardio -> 409" ($r.Status -eq 409)
Check "Codigo ReservationExpired" ($r.Body -and $r.Body.code -eq "ReservationExpired")

Write-Host ""
Write-Host "Resultado: $pass PASS / $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
if ($fail -gt 0) { exit 1 }