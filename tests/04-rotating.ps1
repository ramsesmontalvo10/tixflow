# tests/04-rotating.ps1
# Invariante 3: token firmado + rotación + transferencia.
# Cubre los tests #4 (captura) y #5 (transferencia) del enunciado.
# Uso (desde la raíz del proyecto): .\tests\04-rotating.ps1
# Requiere backend en http://localhost:5248 y docker compose levantado.

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

function Invoke-ExpectError($method, $url, $headers, $body) {
    try {
        $params = @{
            Uri = $url
            Method = $method
            Headers = $headers
            ContentType = $j
        }
        if ($body) { $params.Body = $body }
        Invoke-RestMethod @params | Out-Null
        return @{ Status = 0; Body = $null }
    } catch {
        $status = [int]$_.Exception.Response.StatusCode
        $raw = Get-ErrorBody $_
        $parsed = $null
        if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { } }
        return @{ Status = $status; Body = $parsed }
    }
}

Write-Host "== 04 - Invariante 3: token rotativo + transferencia ==" -ForegroundColor Cyan

# ---------- Setup: login de Ana y Beto ----------
$anaLogin = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"asistente1@correo.test","password":"Asistente2026!"}'
$betoLogin = Invoke-RestMethod "$base/api/auth/login" -Method Post -ContentType $j `
    -Body '{"email":"asistente2@correo.test","password":"Asistente2026!"}'
Write-Host "Login OK (Ana + Beto)" -ForegroundColor Gray

$anaH = @{ Authorization = "Bearer $($anaLogin.accessToken)" }
$betoH = @{ Authorization = "Bearer $($betoLogin.accessToken)" }

# ---------- Asegurar que Ana tiene una entrada ----------
# Primero miramos si ya tiene una entrada en la billetera.
$anaTickets = Invoke-RestMethod "$base/api/tickets/my" -Headers $anaH -Method Get

if ($anaTickets.Count -eq 0) {
    Write-Host "Ana no tiene entradas; creando una para el test..." -ForegroundColor Gray

    # Reservar zona 8, cantidad 1
    $resKey = "res-" + [guid]::NewGuid().ToString()
    $resH = @{ Authorization = "Bearer $($anaLogin.accessToken)"; "Idempotency-Key" = $resKey }
    $res = Invoke-RestMethod "$base/api/reservas" -Method Post -Headers $resH -ContentType $j `
        -Body '{"zonaId":8,"cantidad":1}'

    # Pagar
    $payKey = "pay-" + [guid]::NewGuid().ToString()
    $payH = @{ Authorization = "Bearer $($anaLogin.accessToken)"; "Idempotency-Key" = $payKey }
    $pay = Invoke-RestMethod "$base/api/reservas/$($res.reservaId)/pago" -Method Post -Headers $payH -ContentType $j -Body '{}'

    # La respuesta del pago crea Compra y Entradas. Buscar la entrada creada.
    Start-Sleep -Milliseconds 500
    $anaTickets = Invoke-RestMethod "$base/api/tickets/my" -Headers $anaH -Method Get
}

$anaTicket = $anaTickets[0]
Write-Host "Ana tiene entrada ID = $($anaTicket.id)" -ForegroundColor Gray

# ============================================================
# TEST #4 - Captura de pantalla
# ============================================================
Write-Host "`n-- Test #4: captura de pantalla --" -ForegroundColor Yellow

# 1) Pedir bloque de tokens
$block = Invoke-RestMethod "$base/api/tickets/$($anaTicket.id)/rotating?count=3" -Headers $anaH -Method Get
Check "Bloque devuelve 3 tokens" ($block.tokens.Count -eq 3)
Check "currentWindow > 0" ($block.currentWindow -gt 0)

$currentToken = $block.tokens[0]
Check "Token tiene ticketId correcto" ($currentToken.ticketId -eq $anaTicket.id)
Check "Token queda vinculado al evento de la entrada" ($currentToken.eventId -eq $anaTicket.eventoId)
Check "Token tiene firma en base64" ($currentToken.signatureBase64.Length -gt 40)

# 2) El token de la ventana actual verifica OK
$verifyCurrent = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId
    window = $currentToken.window
    signatureBase64 = $currentToken.signatureBase64
} | ConvertTo-Json)
Check "Token actual verifica OK" ($verifyCurrent.ok -eq $true)

$verifyWrongEvent = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId + 1
    window = $currentToken.window
    signatureBase64 = $currentToken.signatureBase64
} | ConvertTo-Json)
Check "Token no se puede usar en otro evento -> WrongEvent" (
    $verifyWrongEvent.ok -eq $false -and $verifyWrongEvent.error -eq "WrongEvent"
)

# 3) Un token con ventana vieja (hace 100 ventanas = 50 min) falla por ventana
$verifyOld = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId
    window = $currentToken.window - 100
    signatureBase64 = $currentToken.signatureBase64
} | ConvertTo-Json)
Check "Token viejo -> WindowOutOfRange" ($verifyOld.ok -eq $false -and $verifyOld.error -eq "WindowOutOfRange")

# 4) Firma manipulada -> InvalidSignature
$badSigBytes = [Convert]::FromBase64String($currentToken.signatureBase64)
$badSigBytes[0] = $badSigBytes[0] -bxor 0xFF
$badSig = [Convert]::ToBase64String($badSigBytes)
$verifyBad = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId
    window = $currentToken.window
    signatureBase64 = $badSig
} | ConvertTo-Json)
Check "Firma manipulada -> InvalidSignature" ($verifyBad.ok -eq $false -and $verifyBad.error -eq "InvalidSignature")

# 5) Firma malformada -> MalformedSignature
$verifyMalformed = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId
    window = $currentToken.window
    signatureBase64 = "not-base64-!!!"
} | ConvertTo-Json)
Check "Firma malformada -> MalformedSignature" ($verifyMalformed.ok -eq $false -and $verifyMalformed.error -eq "MalformedSignature")

# ============================================================
# TEST #5 - Transferencia
# ============================================================
Write-Host "`n-- Test #5: transferencia --" -ForegroundColor Yellow

# 1) Ana inicia transferencia a Beto
$transfer = Invoke-RestMethod "$base/api/tickets/$($anaTicket.id)/transfer" -Method Post -Headers $anaH -ContentType $j `
    -Body '{"recipientEmail":"asistente2@correo.test"}'
Check "Transferencia creada con estado pendiente" ($transfer.estado -eq "pendiente")
$transferId = $transfer.transferId

# 2) Ana NO puede aceptar su propia transferencia (403)
$tryAccept = Invoke-ExpectError "Post" "$base/api/transfers/$transferId/accept" $anaH $null
Check "Ana no puede aceptar su propia transferencia -> 403" ($tryAccept.Status -eq 403)

# 3) Beto acepta
$accept = Invoke-RestMethod "$base/api/transfers/$transferId/accept" -Method Post -Headers $betoH -ContentType $j
Check "Aceptar transferencia devuelve oldTicketId" ($accept.oldTicketId -eq $anaTicket.id)
Check "Aceptar transferencia devuelve newTicketId" ($accept.newTicketId -gt 0)

$newTicketId = $accept.newTicketId

# 4) La entrada vieja de Ana ya no está en su billetera
$anaTicketsAfter = Invoke-RestMethod "$base/api/tickets/my" -Headers $anaH -Method Get
$anaHasOld = $anaTicketsAfter | Where-Object { $_.id -eq $anaTicket.id }
Check "Ana ya no ve su entrada vieja" ($null -eq $anaHasOld)

# 5) Beto ve la entrada nueva
$betoTickets = Invoke-RestMethod "$base/api/tickets/my" -Headers $betoH -Method Get
$betoHasNew = $betoTickets | Where-Object { $_.id -eq $newTicketId }
Check "Beto ve la entrada nueva" ($null -ne $betoHasNew)

# 6) El código viejo de Ana ya no sirve: el token firmado para la entrada vieja
#    sigue siendo criptográficamente válido, PERO la entrada está revocada.
$verifyRevoked = Invoke-RestMethod "$base/api/_debug/verify-rotating" -Method Post -ContentType $j -Body (@{
    ticketId = $currentToken.ticketId
    eventId = $currentToken.eventId
    window = $currentToken.window
    signatureBase64 = $currentToken.signatureBase64
} | ConvertTo-Json)
Check "Token de entrada revocada -> TicketRevoked" ($verifyRevoked.ok -eq $false -and $verifyRevoked.error -eq "TicketRevoked")

# 7) La entrada vieja de Ana sigue existiendo en BD, pero con estado transferida
#    (esto lo verificamos con un SELECT aparte, no aquí).

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "Resultado: $pass PASS / $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Recuerda limpiar la BD con:" -ForegroundColor Gray
Write-Host "  docker compose exec db psql -U ticketing -d ticketing_db -c 'SELECT `"Id`", `"Estado`" FROM `"Entradas`" WHERE `"Id`" IN ($($anaTicket.id), $newTicketId);'" -ForegroundColor DarkGray

if ($fail -gt 0) { exit 1 }