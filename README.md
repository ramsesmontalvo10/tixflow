# Ticketing – Plataforma de venta y control de acceso

Prueba técnica para Hypernova Labs. Plataforma de venta de entradas con control de acceso en puerta, control offline y prevención de fraude.

> Estado: en desarrollo. Los 4 invariantes del enunciado están implementados y verificados a nivel de backend. App móvil, portal, k6 y despliegue en Docker están en progreso.

## Stack

- Backend: ASP.NET Core Web API (.NET 10), Entity Framework Core, Npgsql
- Base de datos: PostgreSQL 16
- Criptografía: Ed25519 (BouncyCastle.Cryptography)
- Portal web: React + Vite (pendiente)
- App móvil: React Native + Expo, TypeScript (pendiente)
- Contenedores: Docker Compose
- Pruebas de carga: k6 (pendiente)

## Estructura del repositorio
ticketing/
├── backend/Ticketing.Api/
│ ├── Controllers/ Auth, Reservations, Tickets, Scanner
│ ├── Data/ seed.json, Seeder, TicketingDb, Migrations
│ ├── Models/ Entities.cs
│ ├── Services/ Idempotency, Payment, Reservation,
│ │ ReservationExpiry, Token, Ed25519Signer,
│ │ RotatingToken, Scanner
│ ├── data/ ed25519.key (fuera de git)
│ ├── Program.cs
│ └── Properties/ launchSettings.json
├── portal/ Portal de administración (pendiente)
├── mobile/ App móvil asistente + escáner (pendiente)
├── tests/ Scripts PowerShell de verificación
├── docker-compose.yml
├── .env.example
└── README.md

## Cómo ejecutar

Requisitos: Docker Desktop, SDK de .NET 10, Git.

1. Copia `.env.example` a `.env` y ajusta los valores.
2. Levanta la base de datos:
docker compose up -d db


3. Ejecuta el backend desde `backend/Ticketing.Api`:
dotnet run --launch-profile http


Al arrancar aplica las migraciones y carga los datos de prueba (solo si la base está vacía).

> Aviso: `dotnet bin\Debug\net10.0\Ticketing.Api.dll` falla con `Jwt:Key` vacío porque no carga `appsettings.Development.json`. Usar `dotnet run --launch-profile http`.

La cadena de conexión se toma de `ConnectionStrings:Default` (en Docker, de la variable de entorno `ConnectionStrings__Default`).

Backend en `http://localhost:5248`.

## Datos de prueba y credenciales

La semilla carga el archivo `Data/seed.json` (administración, organizadores, staff, asistentes, eventos, zonas, fases de precio, compras, entradas, transferencias, ingresos y reservas).

| Rol | Email | Contraseña |
|---|---|---|
| Admin | admin@ticketing.test | Admin2026! |
| Organizador | org.istmo@ticketing.test | Organizador2026! |
| Staff | staff1@ticketing.test | Staff2026! |
| Asistente (Ana) | asistente1@correo.test | Asistente2026! |
| Asistente (Beto) | asistente2@correo.test | Asistente2026! |

## Los 4 invariantes del enunciado

| # | Invariante | Estado |
|---|---|---|
| 1 | Nunca se vende más que el aforo (bajo concurrencia) | Implementado. Falta k6. |
| 2 | Una compra se cobra una sola vez (idempotencia) | Implementado y verificado |
| 3 | Entrada no falsificable ni copiable (código firmado y rotativo) | Implementado y verificado |
| 4 | Una entrada entra una sola vez (escaneo offline y sincronización) | Implementado y verificado |

### 1. Nunca se vende más que el aforo

- Advisory lock `pg_advisory_xact_lock(eventoId, asistenteId)` serializa por (evento, asistente).
- `SELECT ... FOR UPDATE` sobre la zona bloquea la fila hasta el commit.
- Disponibilidad = aforo − entradas vigentes (`pagada`, `transferida`, `usada`) − reservas activas no vencidas. No se guarda como contador: se calcula.
- Precio server-side desde la fase vigente al momento de la reserva, no al del pago.
- Límite por cuenta por evento (definido en `Evento.LimitePorCuenta`, 6 en el seed).

### 2. Una compra se cobra una sola vez

- Tabla `IdempotencyKeys` con PK `(UsuarioId, Endpoint, Clave)`.
- `INSERT ... ON CONFLICT DO NOTHING` + `bodyHash` semántico (`reserve:{zonaId}:{cantidad}` y `pay:{id}`). Misma clave con distinto body → `422 IdempotencyKeyReused`.
- Reservas expiran en 10 minutos; `ReservationExpiryService` (BackgroundService cada 30s) libera el cupo.
- Pago tardío: si la reserva expiró, se crea una `Compra` con estado `reembolsada` para auditoría y se devuelve `409 ReservationExpired`.
- Dinero en centésimos (enteros, `bigint`, sin floats).
- Restricción en BD: `Compra (AsistenteId, IdempotencyKey)` única.

### 3. Entrada no falsificable ni copiable

- Firma Ed25519. Clave privada en backend (`data/ed25519.key`, fuera de git), generada al primer arranque y persistida. Clave pública expuesta al móvil vía `GET /api/scanner/public-key`.
- Payload canónico: `"{entradaId}:{ventana}"` en UTF-8, donde `ventana = floor(unixSeconds / 30)`. Sin JSON, sin orden de campos, sin ambigüedad.
- Rotación offline. La app descarga un bloque de N tokens firmados (default 20 = 10 minutos offline) y avanza el índice localmente.
- Verificación offline: firma → ventana (±1 tolerancia) → revocación.
- Transferencia invalida el código anterior. Se crea una entrada nueva con nuevo `EntradaId` y se revoca la vieja en `RevocacionesEntrada` (motivo `transferida`). El token viejo es criptográficamente válido pero apunta a una entrada revocada.
- Reembolso también revoca (`motivo = reembolsada`).
- Clave privada fuera del repositorio (`data/` en `.gitignore`). En producción sería un secret manager (Vault, KMS).

### 4. Una entrada entra una sola vez

- Cada escaneo lleva un `ClientScanId` (UUID generado en el móvil).
- `INSERT ... ON CONFLICT DO NOTHING` sobre `ClientScanId`: subir el mismo lote dos veces no duplica ingresos.
- Advisory lock por `EntradaId` (`pg_advisory_xact_lock(entradaId)`) serializa dos requests concurrentes (dos puertas sincronizando a la vez). El primero inserta `'ok'`, el segundo ve el `'ok'` y marca `'duplicate'`.
- `HashSet<int>` intra-lote detecta duplicados dentro del mismo request sin tocar BD.
- Si el ingreso es `'ok'`, `Entrada.Estado = "usada"`. Esto hace que `Refund` rechace el reembolso tras uso (test #7).
- Resultados posibles: `'ok'`, `'duplicate'`, `'wrong_event'`, `'wrong_zone'`.
- Los casos `expired`, `invalid_signature`, `revoked`, `wrong_event`, `wrong_zone` los detecta el escáner offline y no se suben como ingresos válidos. El backend solo reclasifica a `'ok'` o `'duplicate'`.
- Revocaciones incrementales: `GET /api/scanner/revocations?since=<ts>` para que el escáner actualice su lista local.

## Endpoints

Todas las rutas empiezan por `/api/`.

### Autenticación
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me` (requiere JWT)

### Reservas y pagos (Invariante 2)
- `POST /api/reservas` (requiere `Idempotency-Key`)
- `POST /api/reservas/{id}/pago` (requiere `Idempotency-Key`)
- `DELETE /api/reservas/{id}`

### Entradas (Invariante 3)
- `GET /api/tickets/my`
- `GET /api/tickets/{id}/rotating?count=N` (default 20, máx 100)
- `POST /api/tickets/{id}/transfer`
- `POST /api/transfers/{id}/accept`
- `POST /api/tickets/{id}/refund`

### Escáner (Invariante 4)
- `POST /api/scanner/devices`
- `POST /api/scanner/batches`
- `GET /api/scanner/revocations?since=<ts>`
- `GET /api/scanner/public-key` (sin auth, pública Ed25519)

## Códigos de error

| Código | HTTP | Significado |
|---|---|---|
| `MissingIdempotencyKey` | 400 | Falta header `Idempotency-Key` |
| `IdempotencyKeyReused` | 422 | Misma key, distinto body |
| `AlreadyPaid` | 409 | Reserva ya consumida |
| `ReservationExpired` | 409 | Pago tardío |
| `TicketNotFound` | 404 | Entrada no existe |
| `TicketNotActive` | 409 | Entrada no está `pagada` |
| `TransferNotFound` | 404 | Transferencia no existe |
| `TransferNotPending` | 409 | Transferencia ya resuelta |
| `RefundWindowClosed` | 409 | Fuera de `ReembolsableHasta` |
| `WindowOutOfRange` | — | Token fuera de tolerancia temporal |
| `InvalidSignature` | — | Firma manipulada |
| `MalformedSignature` | — | Firma no es base64 |
| `TicketRevoked` | — | Entrada revocada |
| `DeviceRegistrationFailed` | 400 | Staff no asignado o puerta incorrecta |
| `EmptyBatch` | 400 | Lote vacío |
| `BatchProcessingFailed` | 400 | Dispositivo no encontrado |
| `InvalidSince` | 400 | `since` no es ISO 8601 |

## Decisiones de diseño

### Código en inglés, datos en español

Los nombres de las entidades (`Entrada`, `Reserva`, `Compra`, `RevocacionEntrada`, `DispositivoEscaner`) se mantienen en español para no romper el seed provisto. Todo el código nuevo (servicios, controladores, DTOs, endpoints, códigos de error, logs) está en inglés.

### Por qué Ed25519 y no HMAC

HMAC usa un secreto compartido: quien verifica también puede firmar. Si roban un escáner, pueden falsificar entradas. Ed25519 separa la clave privada (backend) de la pública (escáner). El escáner solo verifica.

### Por qué la transferencia crea una entrada nueva

Si solo cambiara el `TitularId`, el payload `{entradaId, ventana}` sería idéntico para el dueño viejo y el nuevo. No habría forma de invalidar el viejo sin invalidar el nuevo. Con `entradaId` nuevo, los tokens viejos apuntan a una entrada revocada.

### Por qué la ventana rotativa y no TOTP

TOTP requiere secreto compartido entre emisor y verificador. Aquí el backend firma con privada y el escáner verifica con pública. Es un esquema de firma, no de MAC.

### Por qué el advisory lock por `EntradaId` y no por `EventoId`

Un lock por `EventoId` serializaría todos los escaneos del evento, matando el throughput. Un lock por `EntradaId` solo serializa cuando hay conflicto real entre dos escaneos de la misma entrada.

### Por qué el lote que sube el escáner solo lleva escaneos válidos

El escáner verifica firma, ventana, revocación y duplicados localmente. Solo sube los `'ok'`. Los casos `expired`, `invalid_signature`, `revoked`, `wrong_event`, `wrong_zone` se quedan en el móvil como log local. Reduce el tamaño del lote y evita reclasificar estados que el móvil ya filtró.

### Por qué `Entrada.Estado = "usada"` al ingresar

El test #7 pide que un reembolso tras uso sea rechazado. Al marcar la entrada como `"usada"`, el `Refund` actual rechaza automáticamente con `if (ticket.Estado != "pagada")`. Sin esto, tendríamos que consultar `Ingresos` en el `Refund`.

### Clave privada Ed25519

Generada al primer arranque si no existe, persistida en `data/ed25519.key`. Fuera del repo (`data/` en `.gitignore`). En producción sería un secret manager.

### Modelo de datos y semilla

- Dinero en enteros (centésimos, `bigint`). Nunca decimales ni flotantes.
- Fechas con `DateTimeOffset` en UTC.
- IDs de usuarios desplazados. Admin (101), organizadores (201-203) y staff (301-312) chocan con IDs de asistentes (1-600). Se les suma 10000 al sembrar (staff 301 → 10301). Las referencias se ajustan igual.
- Semilla idempotente: si ya existen usuarios, no recarga. Al terminar, reajusta las secuencias de la BD.
- Contraseñas con BCrypt. Un hash por cada contraseña distinta, reutilizado entre usuarios de prueba. En producción cada usuario tendría su propio hash con su propia sal.
- Restricciones en BD como última defensa: `Usuario.Email` único, `Compra (AsistenteId, IdempotencyKey)` única, `Ingreso.ClientScanId` único.

## Tests
.\tests\02-idempotencia.ps1 # 8/8 PASS
.\tests\03-pago.ps1 # 10/10 PASS
.\tests\04-rotating.ps1 # 15/15 PASS
.\tests\05-scanner.ps1 # 17/17 PASS


Cada script imprime `[PASS]` / `[FAIL]` y termina con `Resultado: N PASS / M FAIL`.

### Mapeo con los 9 casos de prueba del enunciado

| # | Caso | Cubierto por | Estado |
|---|---|---|---|
| 1 | Carrera por el último cupo (200 vs 50 → 50) | k6 | pendiente |
| 2 | Doble toque (misma compra dos veces → un cobro) | `02-idempotencia.ps1` | Cubierto |
| 3 | Reserva vencida (cupo vuelve a estar disponible) | `03-pago.ps1` | Cubierto |
| 4 | Captura de pantalla (código de hace 1 min → rechazado) | `04-rotating.ps1` | Cubierto |
| 5 | Transferencia (código del dueño anterior deja de servir) | `04-rotating.ps1` | Cubierto |
| 6 | Dos puertas offline (misma entrada → incidente al sincronizar) | `05-scanner.ps1` | Cubierto |
| 7 | Reembolso tras uso (rechazado) | `06-business-rules.ps1` | pendiente |
| 8 | Organizador ajeno (rechazado) | `06-business-rules.ps1` + AdminController | pendiente |
| 9 | Precio manipulado (se cobra el real) | `06-business-rules.ps1` | pendiente |

## Pruebas de carga

Pendiente. Escenario previsto con k6: 200 compradores concurrentes sobre una zona con 50 entradas disponibles. Resultado esperado: exactamente 50 vendidas, 0 sobreventa.

## Seguridad

- JWT de acceso corto (15 min) y refresh con rotación (7 días). El refresh viejo se revoca al emitir uno nuevo. Si un refresh ya revocado se reutiliza, se revocan todos los refresh activos del usuario (detección de robo).
- Roles verificados en el servidor: `asistente`, `staff`, `organizador`, `admin`. Cada controlador declara `[Authorize(Roles = "...")]`.
- Aislamiento por organizador: un organizador solo ve y modifica sus eventos. (Pendiente AdminController.)
- Rate limiting: política `auth` (20/min por IP) y `purchase` (60/min por usuario).
- Secretos por variables de entorno. `Jwt:Key` mínimo 32 caracteres, validado al arrancar. La clave Ed25519 nunca sale del backend.
- Idempotencia en endpoints que mueven dinero.

## Uso de IA

Se usó Claude y DeepSeek como apoyo para planificar, generar borradores y revisar código. Cada parte fue revisada, probada y entendida. Las decisiones de arquitectura y de concurrencia son propias y defendibles en el video.

## Qué no está incluido (y por qué)

Todo lo que no alcance por tiempo se documenta aquí como decisión consciente por el deadline de 4 días.

- App móvil (React Native + Expo)
- Portal web de administración
- k6 load test
- Docker Compose completo (backend + portal + BD en un `docker compose up`)
- Tests #7, #8, #9 (script `06-business-rules.ps1`)
- Lista de espera
- Selección de asiento numerado
- Push notifications
- Apple/Google Wallet
- WebSocket para live updates
- Despliegue en GCP/Azure
- CI/CD (GitHub Actions)
- Tests e2e automatizados (Detox / Maestro)
- Observabilidad con OpenTelemetry
- Protección contra bots

Lo que sí está: los 4 invariantes completos, 6 de 9 casos de prueba cubiertos con scripts, y esta documentación.

## Cómo se defiende (preguntas probables)

- ¿Por qué Ed25519 y no HMAC? HMAC usa secreto compartido: quien verifica también firma. Ed25519 separa privada (backend) de pública (escáner). El escáner solo verifica.
- ¿Por qué la transferencia crea entrada nueva? Si solo cambiara el titular, el payload `{entradaId, ventana}` sería idéntico para viejo y nuevo. Con `entradaId` nuevo, los tokens viejos apuntan a una entrada revocada.
- ¿Cómo se previene la sobreventa? Advisory lock por (evento, asistente) + `SELECT ... FOR UPDATE` sobre la zona. Disponibilidad = aforo − vendidas − reservas activas. Todo en una transacción.
- ¿Cómo funciona el pago tardío? Si la reserva expiró, se crea una `Compra` con estado `reembolsada` para auditoría y se devuelve `409 ReservationExpired`.
- ¿Cómo se detecta el doble ingreso? Advisory lock por `EntradaId` + `HashSet` intra-lote. El segundo escaneo se inserta con `Resultado = 'duplicate'`.
- ¿Por qué la ventana rotativa y no TOTP? TOTP requiere secreto compartido. Aquí el backend firma con privada y el escáner verifica con pública. Es un esquema de firma, no de MAC.
- ¿Dónde vive la clave privada? En `data/ed25519.key`, fuera del repo (`.gitignore`), generada al primer arranque. En producción sería un secret manager.
- ¿Qué pasa si reinicio el backend? Carga la misma privada del archivo, los tokens viejos siguen válidos.
- ¿Qué impide que un móvil robado falsifique entradas? Que solo tiene la pública, y la pública no firma. Necesitaría la privada, que nunca sale del backend.