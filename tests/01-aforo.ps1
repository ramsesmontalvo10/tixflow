# tests/01-aforo.ps1
# Invariante 1: nunca se vende (ni se reserva) mas que el aforo, tampoco bajo concurrencia.
# Cubre: validaciones, precio fijado por el servidor, limite por cuenta (tambien concurrente)
#        y la carrera de compradores sobre una zona con cupo limitado.
#
# Uso (desde la raiz del proyecto):
#   .\tests\01-aforo.ps1
#   .\tests\01-aforo.ps1 -ZonaId 8 -EventoId 4 -Extra 40
#   .\tests\01-aforo.ps1 -Cleanup          # al final cancela las reservas creadas por el test
#
# Requisitos:
#   - Ejecuta primero .\tests\Start-TestEnvironment.ps1 para iniciar Docker con el limite de login de prueba.
#   - BD recien sembrada (si la zona ya esta saturada por una corrida anterior, el test de
#     concurrencia se omite: usa -Cleanup o espera a que venzan las reservas).
#
# Supuestos del contrato (ajusta si tu API difiere): POST $ReservePath con { zonaId, cantidad }
# y encabezado Idempotency-Key; responde 201 con { reservaId, precioUnitarioCentesimos }.

param(
    [int]$EventoId = 4,
    [int]$ZonaId = 8,
    [int]$Extra = 30,              # compradores por encima del cupo disponible
    [int]$HoldMinutes = 10,        # vigencia esperada de una reserva
    [string]$BaseUrl = "http://localhost:5248",
    [string]$LoginPath = "/api/auth/login",
    [string]$ReservePath = "/api/reservas",
    [string]$Password = "Asistente2026!",
    [switch]$Cleanup
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl
$j = "application/json"
$pass = 0
$fail = 0
$start = (Get-Date).ToUniversalTime().ToString("o")

Add-Type -AssemblyName System.Net.Http
# Windows PowerShell 5.1 limita a 2 conexiones simultaneas por host: sin esto no habria concurrencia real
[System.Net.ServicePointManager]::DefaultConnectionLimit = 500

function Check($name, $condition) {
    if ($condition) {
        Write-Host "  [PASS] $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  [FAIL] $name" -ForegroundColor Red
        $script:fail++
    }
}

# ---------- Base de datos (via docker compose) ----------
function PsqlRows($sql) {
    $raw = $sql | docker compose exec -T db psql -U ticketing -d ticketing_db -t -A
    return @($raw | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
function Psql($sql) {
    return ((PsqlRows $sql) -join "`n").Trim()
}

# Disponibles = aforo - entradas vigentes - reservas activas no vencidas
function Disponibles($zonaId) {
    $sql = @"
SELECT z."Aforo"
  - (SELECT COUNT(*) FROM "Entradas" e WHERE e."ZonaId" = z."Id" AND e."Estado" NOT IN ('reembolsada','anulada'))
  - COALESCE((SELECT SUM(r."Cantidad") FROM "Reservas" r
              WHERE r."ZonaId" = z."Id" AND r."Estado" = 'activa' AND r."ExpiraEn" > now()), 0)
FROM "Zonas" z WHERE z."Id" = $zonaId;
"@
    return [int](Psql $sql)
}

# Asistentes sin entradas ni reservas activas en el evento (para que el limite por cuenta no estorbe)
function FreshUsers($eventoId, $count) {
    $sql = @"
SELECT u."Email" FROM "Usuarios" u
WHERE u."Rol" = 'asistente' AND u."Activo"
  AND NOT EXISTS (SELECT 1 FROM "Entradas" e
                  WHERE e."EventoId" = $eventoId
                    AND (e."CompradorId" = u."Id" OR e."TitularId" = u."Id")
                    AND e."Estado" <> 'reembolsada')
  AND NOT EXISTS (SELECT 1 FROM "Reservas" r JOIN "Zonas" z ON z."Id" = r."ZonaId"
                  WHERE z."EventoId" = $eventoId AND r."AsistenteId" = u."Id"
                    AND r."Estado" = 'activa' AND r."ExpiraEn" > now())
ORDER BY u."Id" LIMIT $count;
"@
    return @(PsqlRows $sql)
}

# ---------- HTTP ----------
function NewKey() { return [guid]::NewGuid().ToString() }

function Call($method, $path, $token, $body, $key) {
    $headers = @{}
    if ($token) { $headers["Authorization"] = "Bearer $token" }
    if ($key) { $headers["Idempotency-Key"] = $key }
    $params = @{ Uri = "$base$path"; Method = $method; UseBasicParsing = $true; Headers = $headers }
    if ($null -ne $body) {
        $params["Body"] = ($body | ConvertTo-Json -Depth 5)
        $params["ContentType"] = $j
    }
    $status = 0
    $raw = ""
    try {
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode
        $raw = $r.Content
    } catch {
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = $_.ErrorDetails.Message }
    }
    $json = $null
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        try { $json = $raw | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ Status = $status; Json = $json; Raw = $raw }
}

function Login($email, $pw) {
    $r = Call "POST" $LoginPath $null @{ email = $email; password = $pw } $null
    if ($r.Status -eq 429) {
        throw "El backend limito los inicios de sesion. Ejecuta .\tests\Start-TestEnvironment.ps1 y vuelve a correr este test."
    }
    return $r
}

# Envia N reservas a la vez con HttpClient (concurrencia real) y devuelve los codigos de estado
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(120)

function SendParallel($requests) {
    $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
    $sent = @()
    foreach ($r in $requests) {
        $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$base$ReservePath")
        $msg.Headers.Add("Authorization", "Bearer $($r.Token)")
        $msg.Headers.Add("Idempotency-Key", (NewKey))
        $msg.Content = New-Object System.Net.Http.StringContent($r.Body, [System.Text.Encoding]::UTF8, "application/json")
        $t = $client.SendAsync($msg)
        $tasks.Add($t)
        $sent += $t
    }
    try { [System.Threading.Tasks.Task]::WaitAll($tasks.ToArray()) } catch { }
    $results = foreach ($t in $sent) {
        if ($t.IsFaulted -or $t.IsCanceled) { [pscustomobject]@{ Status = 0 } }
        else { [pscustomobject]@{ Status = [int]$t.Result.StatusCode } }
    }
    return @($results)
}

function Count($results, [scriptblock]$filter) {
    return @($results | Where-Object $filter).Count
}

Write-Host "== 01 - Invariante 1: nunca se vende mas que el aforo ==" -ForegroundColor Cyan

# ---------- Setup ----------
Write-Host "`n-- Setup --" -ForegroundColor Yellow

$probe = Psql 'SELECT COUNT(*) FROM "Zonas";'
Check "Base de datos accesible (docker compose)" ($probe -match '^\d+$' -and [int]$probe -gt 0)
if ($probe -notmatch '^\d+$') { Write-Host "No se pudo consultar la BD.  Esta levantado docker compose?" -ForegroundColor Red; exit 1 }

$aforo = [int](Psql "SELECT ""Aforo"" FROM ""Zonas"" WHERE ""Id"" = $ZonaId;")
$limite = [int](Psql "SELECT ""LimitePorCuenta"" FROM ""Eventos"" WHERE ""Id"" = $EventoId;")
$precioRaw = Psql "SELECT ""PrecioCentesimos"" FROM ""FasesPrecio"" WHERE ""ZonaId"" = $ZonaId AND ""Desde"" <= now() AND now() < ""Hasta"" ORDER BY ""Desde"" LIMIT 1;"
if ([string]::IsNullOrWhiteSpace($precioRaw)) {
    Write-Host "La zona $ZonaId no tiene una fase de precio vigente. Recarga la BD (docker compose down -v)." -ForegroundColor Red
    exit 1
}
$precio = [long]$precioRaw
$dispInicial = Disponibles $ZonaId
Write-Host "Zona $ZonaId (evento $EventoId): aforo $aforo, disponibles $dispInicial, limite por cuenta $limite, precio vigente $precio" -ForegroundColor Gray

$emails = @(FreshUsers $EventoId 1)
Check "Hay asistentes sin entradas en el evento $EventoId" ($emails.Count -ge 1)
$u1 = Login $emails[0] $Password
Check "Login asistente OK" ($u1.Status -eq 200 -and $null -ne $u1.Json.accessToken)
$t1 = $u1.Json.accessToken

$staff = Login "staff1@ticketing.test" "Staff2026!"
Check "Login staff OK" ($staff.Status -eq 200 -and $null -ne $staff.Json.accessToken)

# ---------- A. Validaciones ----------
Write-Host "`n-- A. Validaciones --" -ForegroundColor Yellow

$r = Call "POST" $ReservePath $t1 @{ zonaId = $ZonaId; cantidad = 0 } (NewKey)
Check "Cantidad 0 -> 400" ($r.Status -eq 400)

$r = Call "POST" $ReservePath $t1 @{ zonaId = $ZonaId; cantidad = -3 } (NewKey)
Check "Cantidad negativa -> 400" ($r.Status -eq 400)

$r = Call "POST" $ReservePath $t1 @{ zonaId = 999999; cantidad = 1 } (NewKey)
Check "Zona inexistente -> 404" ($r.Status -eq 404)

$r = Call "POST" $ReservePath $null @{ zonaId = $ZonaId; cantidad = 1 } (NewKey)
Check "Sin token -> 401" ($r.Status -eq 401)

$r = Call "POST" $ReservePath $staff.Json.accessToken @{ zonaId = $ZonaId; cantidad = 1 } (NewKey)
Check "Un usuario staff no puede reservar -> 403" ($r.Status -eq 403)

$r = Call "POST" $ReservePath $t1 @{ zonaId = $ZonaId; cantidad = ($dispInicial + 1000) } (NewKey)
Check "Pedir mucho mas que lo disponible -> 409" ($r.Status -eq 409)

# ---------- B. Reserva simple y precio ----------
Write-Host "`n-- B. Reserva simple y precio del servidor --" -ForegroundColor Yellow

$r = Call "POST" $ReservePath $t1 @{ zonaId = $ZonaId; cantidad = 1 } (NewKey)
Check "Reserva de 1 entrada -> 201" ($r.Status -eq 201)
if ($r.Status -eq 201) {
    Check "El precio unitario es el vigente en el servidor ($precio)" ($r.Json.precioUnitarioCentesimos -eq $precio)
    $resId = [int]$r.Json.reservaId
    $row = Psql "SELECT ""Estado"" || '|' || ""Cantidad"" || '|' || ROUND(EXTRACT(EPOCH FROM (""ExpiraEn"" - ""CreadaEn""))) FROM ""Reservas"" WHERE ""Id"" = $resId;"
    $parts = $row.Split('|')
    Check "Reserva guardada como 'activa' con cantidad 1" ($parts[0] -eq 'activa' -and $parts[1] -eq '1')
    Check "La reserva vence a los $HoldMinutes minutos" ([int]$parts[2] -eq ($HoldMinutes * 60))
    Check "El cupo disponible bajo en 1" ((Disponibles $ZonaId) -eq ($dispInicial - 1))
}

# ---------- C. Limite por cuenta (datos del dataset) ----------
Write-Host "`n-- C. Limite por cuenta con entradas ya compradas --" -ForegroundColor Yellow

$email77 = Psql 'SELECT "Email" FROM "Usuarios" WHERE "Id" = 77;'
$zona5 = Psql 'SELECT "Id" FROM "Zonas" WHERE "EventoId" = 5 ORDER BY "Id" LIMIT 1;'
if ($email77 -and $zona5) {
    $u77 = Login $email77 $Password
    $r = Call "POST" $ReservePath $u77.Json.accessToken @{ zonaId = [int]$zona5; cantidad = 1 } (NewKey)
    Check "Asistente 77 (4 de 4 en el evento 5) no puede reservar mas -> 409" ($r.Status -eq 409)
    Check "El rechazo es por limite de cuenta (no por otra causa)" (($r.Raw -match 'AccountLimit') -or ($r.Raw -match '(?i)limit'))
} else {
    Write-Host "  (omitido: no se encontro al asistente 77 o al evento 5)" -ForegroundColor DarkYellow
}

# ---------- D. Limite por cuenta con peticiones simultaneas ----------
Write-Host "`n-- D. Limite por cuenta con peticiones simultaneas --" -ForegroundColor Yellow

$qty = [int][math]::Floor($limite / 2)
$expectOk = [int][math]::Floor($limite / $qty)
$parallel = $expectOk + 2

# Zonas del evento con cupo suficiente, para probar tambien el cruce entre zonas
$zonasOk = @()
foreach ($zid in @(PsqlRows "SELECT ""Id"" FROM ""Zonas"" WHERE ""EventoId"" = $EventoId ORDER BY ""Id"";")) {
    if ((Disponibles ([int]$zid)) -ge ($qty * $expectOk)) { $zonasOk += [int]$zid }
}
$emailD = @(FreshUsers $EventoId 1)
if ($zonasOk.Count -ge 1 -and $emailD.Count -ge 1) {
    $uD = Login $emailD[0] $Password
    $reqs = @()
    for ($i = 0; $i -lt $parallel; $i++) {
        $z = $zonasOk[$i % [math]::Min($zonasOk.Count, 2)]
        $reqs += @{ Token = $uD.Json.accessToken; Body = (@{ zonaId = $z; cantidad = $qty } | ConvertTo-Json) }
    }
    $res = SendParallel $reqs
    $ok = Count $res { $_.Status -eq 201 }
    $conf = Count $res { $_.Status -eq 409 }
    Write-Host "  $parallel peticiones simultaneas de $qty entradas (limite $limite) en $([math]::Min($zonasOk.Count, 2)) zona(s): $ok x 201, $conf x 409" -ForegroundColor Gray

    $uidD = Psql "SELECT ""Id"" FROM ""Usuarios"" WHERE ""Email"" = '$($emailD[0])';"
    $sumD = [int](Psql "SELECT COALESCE(SUM(r.""Cantidad""), 0) FROM ""Reservas"" r JOIN ""Zonas"" z ON z.""Id"" = r.""ZonaId"" WHERE z.""EventoId"" = $EventoId AND r.""AsistenteId"" = $uidD AND r.""Estado"" = 'activa';")
    Check "Solo $expectOk reservas aceptadas (limite $limite / $qty por reserva)" ($ok -eq $expectOk)
    Check "Las demas fueron rechazadas con 409" ($conf -eq ($parallel - $expectOk))
    Check "La cuenta nunca supera su limite en la BD ($sumD <= $limite)" ($sumD -le $limite)
} else {
    Write-Host "  (omitido: no hay zonas con cupo suficiente o asistentes libres)" -ForegroundColor DarkYellow
}

# ---------- E. Carrera de compradores sobre una zona con cupo limitado ----------
Write-Host "`n-- E. Carrera de compradores sobre la zona $ZonaId --" -ForegroundColor Yellow

$disp = Disponibles $ZonaId
if ($disp -le 0) {
    Write-Host "  (omitido: la zona ya esta saturada. Usa -Cleanup en la corrida anterior o recarga la BD)" -ForegroundColor DarkYellow
} else {
    $n = $disp + $Extra
    $mails = @(FreshUsers $EventoId $n)
    if ($mails.Count -lt $n) {
        Write-Host "  Solo hay $($mails.Count) asistentes libres (se pedian $n)" -ForegroundColor DarkYellow
        $n = $mails.Count
    }
    Write-Host "  Cupo disponible: $disp. Compradores simultaneos: $n (1 entrada cada uno). Iniciando sesion..." -ForegroundColor Gray

    $tokens = @()
    foreach ($m in $mails) {
        $l = Login $m $Password
        if ($l.Status -eq 200) { $tokens += $l.Json.accessToken }
    }
    Check "Todos los compradores iniciaron sesion ($($tokens.Count) de $n)" ($tokens.Count -eq $n)

    $expected = [math]::Min($disp, $tokens.Count)
    $stageStart = (Get-Date).ToUniversalTime().ToString("o")
    $reqs = @()
    foreach ($tk in $tokens) {
        $reqs += @{ Token = $tk; Body = (@{ zonaId = $ZonaId; cantidad = 1 } | ConvertTo-Json) }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $res = SendParallel $reqs
    $sw.Stop()

    $ok = Count $res { $_.Status -eq 201 }
    $conf = Count $res { $_.Status -eq 409 }
    $rate = Count $res { $_.Status -eq 429 }
    $err = Count $res { $_.Status -eq 0 -or $_.Status -ge 500 }
    Write-Host "  Resultado: $ok x 201, $conf x 409, $rate x 429, $err errores (en $([math]::Round($sw.Elapsed.TotalSeconds, 1)) s)" -ForegroundColor Gray

    Check "Sin 429: el limite de peticiones no distorsiono la prueba" ($rate -eq 0)
    Check "Sin errores 5xx ni conexiones caidas" ($err -eq 0)
    Check "Exactamente $expected reservas aceptadas (ni una mas, ni una menos)" ($ok -eq $expected)
    Check "Todas las demas rechazadas con 409" ($conf -eq ($tokens.Count - $expected))

    $creadas = [int](Psql "SELECT COUNT(*) FROM ""Reservas"" WHERE ""ZonaId"" = $ZonaId AND ""Estado"" = 'activa' AND ""CreadaEn"" >= '$stageStart';")
    Check "La BD tiene exactamente $expected reservas nuevas ($creadas)" ($creadas -eq $expected)

    $dispAfter = Disponibles $ZonaId
    Check "Los disponibles nunca quedan negativos ($dispAfter)" ($dispAfter -ge 0)
    if ($tokens.Count -ge $disp) {
        Check "La zona quedo llena: ocupacion = aforo (disponibles = 0)" ($dispAfter -eq 0)
    }

    # ---------- F. Zona agotada ----------
    Write-Host "`n-- F. Zona agotada --" -ForegroundColor Yellow
    $extraMail = @(FreshUsers $EventoId 1)
    if ($extraMail.Count -ge 1 -and $dispAfter -eq 0) {
        $lx = Login $extraMail[0] $Password
        $r = Call "POST" $ReservePath $lx.Json.accessToken @{ zonaId = $ZonaId; cantidad = 1 } (NewKey)
        Check "Con la zona agotada, una reserva mas -> 409" ($r.Status -eq 409)
    }
}

# ---------- Resultado final ----------
Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host "Resultado: $pass PASS / $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

$cleanSql = "UPDATE ""Reservas"" SET ""Estado"" = 'cancelada' WHERE ""Estado"" = 'activa' AND ""CreadaEn"" >= '$start';"
if ($Cleanup) {
    Psql $cleanSql | Out-Null
    Write-Host "Limpieza hecha: reservas del test canceladas." -ForegroundColor Gray
} else {
    Write-Host "Limpieza (opcional, o vuelve a correr con -Cleanup):" -ForegroundColor Gray
    Write-Host "  docker compose exec db psql -U ticketing -d ticketing_db -c '$cleanSql'" -ForegroundColor DarkGray
}

if ($fail -gt 0) { exit 1 }