# tests/02-idempotencia.ps1
# Invariante 2: idempotencia en reservar.
# Uso: .\tests\02-idempotencia.ps1

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

# Lee el cuerpo de un error HTTP de forma robusta en PS 5.1 y 7+
function Get-ErrorBody($err) {
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
        return $err.ErrorDetails.Message
    }
    try {
        $stream = $err.Exception.Response.GetResponseStream()
        if ($stream) {
            $reader = New-Object System.IO.StreamReader($stream)
            $text = $reader.ReadToEnd()
            $reader.Dispose()
            return $text
        }
    } catch { }
    return $null
}

function Invoke-ExpectError($method, $url, $headers, $body) {
    try {
        Invoke-RestMethod $url -Method $method -Headers $headers -ContentType $j -Body $body | Out-Null
        return @{ Status = 0; Body = $null }
    } catch {
        $status = [int]$_.Exception.Response.StatusCode
        $raw = Get-ErrorBody $_
        $parsed = $null
        if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { } }
        return @{ Status = $status; Body = $parsed; Raw = $raw }
    }
}

Write-Host "== 02 - Invariante 2: idempotencia ==" -ForegroundColor Cyan

# 1) Login
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"asistente1@correo.test","password":"Asistente2026!"}'
$auth = @{ Authorization = "Bearer $($login.accessToken)" }
Write-Host "Login OK" -ForegroundColor Gray

# 2) Sin Idempotency-Key -> 400 MissingIdempotencyKey
$r = Invoke-ExpectError "Post" "$base/api/reservas" $auth '{"zonaId":8,"cantidad":1}'
Check "Sin key -> 400" ($r.Status -eq 400)
Check "Codigo MissingIdempotencyKey" ($r.Body -and $r.Body.code -eq "MissingIdempotencyKey")
if (-not $r.Body) { Write-Host "    raw: $($r.Raw)" -ForegroundColor Yellow }

# 3) Con key -> 201
$key = "res-" + [guid]::NewGuid().ToString()
$h = @{ Authorization = "Bearer $($login.accessToken)"; "Idempotency-Key" = $key }
$r1 = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $h -ContentType $j `
    -Body '{"zonaId":8,"cantidad":1}'
Check "Con key -> 201" ($r1.reservaId -gt 0)
Check "Zona es 8" ($r1.zonaId -eq 8)
Check "Precio es 3800" ($r1.precioUnitarioCentesimos -eq 3800)

# 4) Doble toque -> mismo reservaId
$r2 = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $h -ContentType $j `
    -Body '{"zonaId":8,"cantidad":1}'
Check "Doble toque: mismo reservaId" ($r1.reservaId -eq $r2.reservaId)

# 5) Misma key, otro body -> 422
$r = Invoke-ExpectError "Post" "$base/api/reservas" $h '{"zonaId":9,"cantidad":1}'
Check "Misma key, otro body -> 422" ($r.Status -eq 422)
Check "Codigo IdempotencyKeyReused" ($r.Body -and $r.Body.code -eq "IdempotencyKeyReused")
if (-not $r.Body) { Write-Host "    raw: $($r.Raw)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "Resultado: $pass PASS / $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
if ($fail -gt 0) { exit 1 }