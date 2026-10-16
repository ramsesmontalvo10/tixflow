# TixFlow — Plataforma de venta y control de acceso

Monorepo para venta de entradas, emisión de códigos QR rotativos y administración de eventos. Incluye una app móvil Expo, un portal web React, una API ASP.NET Core y pruebas de reglas de negocio y concurrencia. El escáner móvil valida firmas y conserva lecturas localmente; la sincronización móvil de lotes todavía no está integrada.

## Arquitectura del monorepo

| Componente | Tecnología | Responsabilidad |
|---|---|---|
| `backend/Ticketing.Api` | ASP.NET Core Web API, .NET 10, EF Core, Npgsql | Autenticación, reservas, pagos simulados, entradas, escaneo, administración y auditoría |
| PostgreSQL | PostgreSQL 16 | Fuente autoritativa para aforos, reservas, compras, entradas, revocaciones y auditoría |
| `mobile` | React Native, Expo, TypeScript | Cartelera y billetera del asistente; QR rotativo; escáner staff con validación offline |
| `portal` | React, TypeScript, Vite | Administración de eventos, ventas, entradas, accesos, incidentes y auditoría |
| `tests` | PowerShell y k6 | Pruebas de reglas del negocio y escenario de concurrencia |
| `docker-compose.yml` | Docker Compose | Orquestación de PostgreSQL, API y portal |

La semilla se encuentra en `backend/Ticketing.Api/Data/seed.json`. Al iniciar la API se aplican las migraciones pendientes y, si la base no tiene usuarios, se cargan los datos de prueba. Los identificadores de administración, organizadores y staff se desplazan al sembrar para evitar colisiones con los asistentes.

## Inicio con Docker

Requisitos: Docker Desktop con Docker Compose. En PowerShell, desde la raíz del repositorio:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
docker compose ps
```

`.env.example` contiene valores solo para desarrollo local, incluyendo las credenciales de PostgreSQL y una clave JWT de prueba. Si `.env` ya existe, el comando no lo sobrescribe. Sustituye la clave de ejemplo antes de desplegar fuera de un entorno local. Docker usa `Production` por defecto; el helper de pruebas cambia el backend a `Development` para habilitar el endpoint de diagnóstico que usa `04-rotating.ps1`.

URLs por defecto:

- Portal: `http://localhost`
- API: `http://localhost:5248`
- PostgreSQL: `localhost:5432`

La imagen del portal configura Nginx para servir la SPA y reenviar `/api` al servicio `backend` de Compose. La API espera a que PostgreSQL pase el healthcheck, ejecuta `Database.MigrateAsync()` y llama al seeder durante su arranque. La clave privada Ed25519 se crea dentro del contenedor si no existe y persiste en el volumen `signingkey`; no se incluye la clave local del repositorio en la imagen.

Para ver los logs:

```powershell
docker compose logs -f backend
docker compose logs -f db
```

Para detener los contenedores sin borrar los datos persistidos:

```powershell
docker compose down
```

Se pueden personalizar `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `API_PORT` y `PORTAL_PORT` mediante variables de entorno. Compose requiere `JWT_KEY`; no se debe guardar una clave de producción en el repositorio. Los valores por defecto de PostgreSQL son únicamente para desarrollo local: cámbialos y protege los puertos antes de desplegar en un entorno compartido.

### Ejecución local del backend

Requisitos: SDK .NET 10 y PostgreSQL 16. Configura `ConnectionStrings:Default` (o `ConnectionStrings__Default`) y un `Jwt:Key` de al menos 32 caracteres. La configuración de desarrollo del proyecto ya define el perfil HTTP en el puerto `5248`.

```powershell
docker compose up -d db
Set-Location .\backend\Ticketing.Api
dotnet run --launch-profile http
```

## Reglas de aforo y concurrencia

El aforo no depende de un contador actualizado en memoria. La disponibilidad efectiva se deriva de:

```text
aforo de la zona
- entradas que no estén reembolsadas ni anuladas
- cantidades de reservas activas cuya expiración sea posterior a la hora actual
```

La reserva ejecuta estas operaciones dentro de una transacción PostgreSQL:

1. Obtiene un advisory transaction lock para `(eventoId, asistenteId)`, que serializa el control del límite por cuenta en el evento.
2. Lee la zona con `SELECT ... FOR UPDATE`. Este bloqueo exclusivo de fila serializa a los compradores que compiten por esa zona.
3. Mientras conserva el lock, vuelve a calcular entradas vigentes y reservas activas, valida la capacidad y el límite por cuenta y crea la reserva.
4. El lock se libera al confirmar o revertir la transacción.

Por ello, incluso cuando muchos compradores leen una disponibilidad similar al mismo tiempo, cada reserva que modifica el aforo vuelve a validar el total bajo el bloqueo de la zona. La consulta de disponibilidad no es una autorización para vender: la decisión definitiva se toma dentro de la transacción.

Las reservas activas tienen una duración configurable (10 minutos por defecto). Se liberan al expirar o cancelar. Al pagar, las entradas se crean y la reserva pasa a consumida en una misma transacción; la cantidad total ocupada no cambia en la conversión.

### Lecturas, caché y alta disponibilidad

La instalación actual consulta PostgreSQL primario; **no configura réplicas de lectura, una caché distribuida ni una arquitectura de alta disponibilidad para consultas**. Las métricas del portal son agregadas desde el backend y no se sirven desde una caché dinámica de dos segundos. Por tanto, no se debe asumir que esas capacidades están desplegadas.

Una caché de dos segundos podría utilizarse en el futuro para paneles de solo lectura, pero no para aceptar reservas ni calcular el aforo autoritativo. Si se implementa, debe invalidarse al confirmar una reserva, pago, cancelación, reembolso o expiración; además, cualquier dato almacenado en caché sería indicativo. La creación de reservas debe seguir usando transacción, lock de zona y lectura actual de PostgreSQL. De este modo una cifra de dashboard temporalmente antigua no permitiría sobreventa.

Para alta disponibilidad real se requeriría, además, PostgreSQL redundante con failover, réplicas para lecturas no críticas, observabilidad y pruebas de consistencia/recuperación. Nada de eso lo proporciona por sí solo el Compose local incluido en este repositorio.

## Pagos, dinero e idempotencia

El flujo de pago de esta versión es **simulado**: no integra un proveedor ni procesa cargos bancarios reales.

- Todos los montos se expresan en centésimos enteros (USD en el seed); no se emplean números de punto flotante.
- El precio autoritativo se fija en la reserva a partir de la fase vigente del servidor. El cliente no envía el monto del pago.
- `POST /api/reservas` y `POST /api/reservas/{id}/pago` exigen `Idempotency-Key`.
- La respuesta y el hash semántico de la petición quedan vinculados a `(UsuarioId, Endpoint, Clave)`. Repetir la misma clave y petición devuelve la respuesta almacenada; reutilizarla con otro contenido produce `422 IdempotencyKeyReused`.
- La clave primaria compuesta y el índice único de `(AsistenteId, IdempotencyKey)` en `Compras` añaden una defensa a nivel de base de datos.
- Una reserva expirada no emite entradas. El flujo registra el resultado como reembolsado según la política de pago tardío del backend.

## Firma de entradas y alcance offline

El backend firma tokens con Ed25519 y conserva la clave privada en `data/ed25519.key` (en Docker, dentro del volumen persistente `/app/data`). La clave pública se distribuye al escáner mediante `GET /api/scanner/public-key`; el dispositivo verifica firmas, no puede emitirlas.

El payload firmado es `entradaId:ventana`, con una ventana de 30 segundos. La billetera obtiene del backend un bloque de tokens firmados para mostrar los códigos rotativos. En el escáner, la clave pública se descarga y se conserva localmente; la app valida la firma y su ventana temporal y guarda los escaneos y la detección de duplicados en SQLite.

**Límite actual importante:** el flujo móvil de staff no registra dispositivos, no sincroniza las filas de `offline_scans` con `/api/scanner/batches` ni descarga revocaciones para aplicarlas al escaneo. Por lo tanto, un escaneo guardado localmente no se refleja en el backend, y las revocaciones recientes no se garantizan durante la validación offline. El backend sí ofrece endpoints de registro, lotes y consulta de revocaciones; su existencia no significa que la app ya esté integrada con ellos.

El backend rechaza duplicados sincronizados mediante `ClientScanId` y serializa el procesamiento concurrente por entrada. El registro de dispositivo comprueba la asignación del staff al evento y que la puerta pertenezca a ese evento. Sin embargo, los lotes no vuelven a comprobar la asignación vigente ni que cada entrada corresponda al evento del dispositivo, y la consulta de revocaciones no está filtrada por las asignaciones del staff. La pantalla móvil de inicio de turno todavía presenta el evento y las puertas fijos del evento 6; no debe usarse como fuente de autorización. Completar estas validaciones y la sincronización móvil es requisito previo para tratar el flujo como un control de acceso de producción.

La clave privada no debe copiarse a móviles ni guardarse en Git. Para producción se recomienda custodiarla en un gestor de secretos o HSM/KMS, con rotación y respaldo controlados.

## Índices y diagnóstico con `EXPLAIN ANALYZE`

Los índices explícitos del modelo EF Core atienden consultas repetidas y restricciones de unicidad:

| Índice | Motivo |
|---|---|
| `Entradas (ZonaId, Estado)` | Filtrar entradas ocupantes por zona y estado al calcular disponibilidad |
| `Reservas (ZonaId, Estado, ExpiraEn)` | Sumar reservas activas/no vencidas de una zona |
| `Compras (AsistenteId, IdempotencyKey)` único | Impedir duplicar compras para una clave del asistente |
| `Ingresos (ClientScanId)` único | Evitar insertar dos veces el mismo escaneo sincronizado |
| `Ingresos (EntradaId)` | Consultar ingresos y duplicados por entrada |
| `Usuarios (Email)` único | Login e identidad única |
| `RefreshTokens (TokenHash)` único y `RefreshTokens (UsuarioId)` | Validación del refresh token y consulta de tokens del usuario |
| `DispositivosEscaner (EventoId, PuertaId)` | Localizar dispositivos asociados a evento y puerta |
| `AuditoriaAdministrativa (EventoId, Fecha)` | Recuperar auditoría de un evento ordenada por fecha |
| `AuditoriaAdministrativa (TicketId)` | Buscar auditoría asociada a una entrada |

Las claves foráneas también generan índices convencionales en EF Core cuando corresponde. Para revisar el acceso a la fila que protege la contienda por zona, ejecuta este bloque en una sesión de diagnóstico: `EXPLAIN ANALYZE` ejecuta la consulta y `FOR UPDATE` toma el lock, por lo que el bloque termina con `ROLLBACK`.

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM "Zonas"
WHERE "Id" = 8
FOR UPDATE;
ROLLBACK;
```

Al ser una búsqueda por clave primaria, el plan esperado es un `Index Scan` sobre la clave primaria de `Zonas`, seguido de la adquisición del lock de fila. El plan concreto depende de la versión, estadísticas y datos. `EXPLAIN ANALYZE` sobre una sola sesión no mide la espera causada por concurrencia; para eso se necesitan sesiones concurrentes y métricas de duración.

También se puede inspeccionar el trabajo de los conteos de aforo:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM "Entradas"
WHERE "ZonaId" = 8
  AND "Estado" NOT IN ('reembolsada', 'anulada');

EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(sum("Cantidad"), 0)
FROM "Reservas"
WHERE "ZonaId" = 8
  AND "Estado" = 'activa'
  AND "ExpiraEn" > now();
```

Los índices compuestos ayudan a acotar esas búsquedas; el optimizador puede preferir otro plan en tablas pequeñas. Ejecuta `ANALYZE` después de cargas importantes y compara planes y tiempos con datos representativos antes de decidir cambios.

## Portal de administración

El portal React utiliza el JWT del organizador y opera sobre recursos de su propiedad. Sus módulos están conectados a:

- Creación de evento con zonas y fases: `POST /api/admin/events`.
- Métricas de ventas: `GET /api/admin/events/{eventId}/sales-summary`.
- Búsqueda y reembolso administrativo: `GET /api/admin/events/{eventId}/tickets/search` y `POST /api/admin/tickets/{ticketId}/refund`.
- Accesos e incidentes: `GET /api/admin/events/{eventId}/access-logs` y `/incidents`.
- Auditoría de acciones administrativas: `GET /api/admin/events/{eventId}/audit-logs`.

El servidor valida el ownership. El portal trata HTTP 403 con una alerta de acceso restringido. La creación de puertas y asignación de staff no está cubierta por el endpoint de creación del evento; los campos visuales correspondientes no se persisten. Las alertas de firma inválida que solo se verifican offline tampoco aparecen en incidentes del backend a menos que el dispositivo las sincronice.

Desarrollo local del portal:

```powershell
Set-Location .\portal
npm ci
npm run dev
```

Vite reenvía `/api` a `http://localhost:5248`. Para una build de producción ejecuta `npm run build`; el artefacto se genera en `portal/dist`.

## App móvil y rendimiento

La billetera usa `FlatList` para el listado virtualizado de entradas, en lugar de renderizar una colección larga dentro de una vista estática. El token correspondiente a la ventana actual se selecciona con `useMemo`; el QR firmado rota cada 30 segundos. El modo de demostración identifica explícitamente los QR simulados como no válidos para acceso.

### Configuración de conexión

La app usa `EXPO_PUBLIC_API_URL` como override opcional de la URL del backend, por ejemplo `http://192.168.1.20:5248/api`. Sin override, el emulador Android utiliza `http://10.0.2.2:5248/api`; un dispositivo físico obtiene el host de desarrollo de Expo y usa el puerto `5248`. El host debe poder alcanzar la computadora y el backend debe escuchar en todas las interfaces (`http://*:5248`). El puerto `8081` de Expo/Metro sirve el bundle de desarrollo, no es el puerto de la API.

Si el teléfono o emulador conserva una base SQLite creada por una versión anterior, el scanner inspecciona `offline_scans` al iniciar y añade la columna `resultado` cuando no existe; las filas antiguas quedan con resultado predeterminado `ok`. La base conserva la detección local de duplicados entre reinicios de la app.

### Alcance actual del escáner staff

La app verifica firmas Ed25519 y detecta duplicados en SQLite. La pantalla de inicio de turno todavía muestra el evento y las puertas fijos del evento 6, en lugar de cargar las asignaciones del usuario; no confíes en esa selección como una autorización. La app aún no registra el dispositivo con el backend, no sincroniza lecturas ni consulta revocaciones. Además, aunque el backend valida la asignación y pertenencia de la puerta durante el registro del dispositivo, el procesamiento de lotes no vuelve a validar la asignación actual ni que cada entrada pertenezca al evento, y las revocaciones se consultan globalmente. Considera este flujo incompleto para operación real hasta integrar el cliente y cerrar esas validaciones.

Para mantener una interfaz fluida:

- Conserva `FlatList` en listas que puedan crecer, con `keyExtractor` estable y componentes de fila pequeños.
- Evita recrear callbacks/objetos costosos en cada render si la medición muestra trabajo innecesario; usa `useCallback`, `useMemo` o `React.memo` en los límites que aporten valor.
- La firma del QR se calcula en backend y el móvil solo verifica; no hagas criptografía ni solicitudes de red dentro de cada render.
- No confundas memoizar la selección del token con memoizar el componente visual del QR: si se optimiza ese componente, comprueba que solo se vuelva a renderizar al cambiar su valor.
- El escáner usa `expo-camera`, `tweetnacl` y persistencia local para operar con conectividad intermitente.

## Credenciales de prueba

Solo para la base de datos local sembrada. Las contraseñas del seed son conocidas y **no deben reutilizarse en producción**.

| Rol | Cuenta(s) de ejemplo | Contraseña |
|---|---|---|
| Administrador | `admin@ticketing.test` | `Admin2026!` |
| Organizador | `org.istmo@ticketing.test`, `org.canal@ticketing.test`, `org.pacifico@ticketing.test` | `Organizador2026!` |
| Staff | `staff1@ticketing.test` … `staff12@ticketing.test` | `Staff2026!` |
| Asistente | `asistente1@correo.test`, `asistente2@correo.test` (hay 600 cuentas `asistenteN@correo.test`) | `Asistente2026!` |

## Pruebas

Los scripts PowerShell de `tests/` cubren aforo, idempotencia, pagos, códigos rotativos, escáner y reglas de negocio. Desde PowerShell en la raíz, inicia PostgreSQL y el backend con la configuración de prueba:

```powershell
.\tests\Start-TestEnvironment.ps1
.\tests\01-aforo.ps1 -Cleanup
.\tests\02-idempotencia.ps1
.\tests\03-pago.ps1
.\tests\04-rotating.ps1
.\tests\05-scanner.ps1
.\tests\06-business-rules.ps1
```

`01-aforo.ps1` acepta `-Cleanup` para cancelar las reservas creadas durante esa prueba. Los demás scripts pueden cambiar datos; ejecútalos contra una base local de pruebas y restablece el entorno antes de repetir escenarios que dependen de datos iniciales. El helper no borra volúmenes ni datos automáticamente.

En la verificación local reportada para esta versión, los seis scripts PowerShell (`01`–`06`) terminaron sin fallos. El resultado de k6 y sus precondiciones se detallan abajo y en [`tests/RESULTADOS_CARGA.md`](./tests/RESULTADOS_CARGA.md).

Para devolver el escenario k6 al estado inicial del seed en una base local desechable, puedes eliminar los volúmenes y volver a sembrar:

```powershell
docker compose down -v
.\tests\Start-TestEnvironment.ps1
k6 run .\load-test.js
```

**`docker compose down -v` elimina los datos de PostgreSQL y la clave Ed25519 persistida en los volúmenes locales. No lo ejecutes si necesitas conservarlos.** El helper de pruebas inicia el backend en `Development` y permite los logins de k6; el Compose normal mantiene `Production` por defecto. No inicies un segundo `dotnet run` en el puerto `5248` mientras el backend de Compose esté activo.

En la corrida k6 confirmada después de iniciar una base limpia y recién sembrada, 200 usuarios compitieron por las últimas 50 plazas: **50 reservas aceptadas, 150 conflictos por capacidad y cero respuestas inesperadas; los umbrales se cumplieron**. Una corrida previa sobre una base que ya tenía reservas activas dio 46 aceptaciones y 154 conflictos y no cumplió el objetivo exacto. Esto ilustra que k6 necesita comenzar con las 50 plazas disponibles. El escenario mide reservas temporales, no pagos, y no se reportan latencias de esa corrida como una garantía general de rendimiento. Los detalles están en [`tests/RESULTADOS_CARGA.md`](./tests/RESULTADOS_CARGA.md).

## Preguntas de defensa técnica

### ¿Cómo se evita la sobreventa?

La disponibilidad se vuelve a calcular dentro de una transacción PostgreSQL. Un advisory lock por `(eventoId, asistenteId)` serializa el límite por cuenta y `SELECT ... FOR UPDATE` serializa las reservas que compiten por la misma zona. Bajo esos locks se cuentan entradas y reservas activas antes de crear la reserva. La lectura que muestra disponibilidad no sustituye esta comprobación transaccional.

### ¿Por qué Ed25519 y no HMAC?

HMAC requiere compartir el secreto de firma con cada dispositivo que verifica; un dispositivo comprometido podría entonces generar firmas. Con Ed25519, el backend conserva la clave privada y los móviles solo reciben la clave pública para verificar.

### ¿Por qué usar una ventana rotativa y no TOTP?

La app muestra tokens firmados por el backend con ventanas temporales de 30 segundos. El verificador no necesita un secreto simétrico compartido: valida la firma asimétrica y la ventana permitida. La tolerancia de reloj y la revocación se deben considerar aparte; actualmente, la app de staff no sincroniza revocaciones.

### ¿Por qué crear una entrada nueva al transferir un ticket?

Una entrada nueva tiene un identificador distinto. Así, el token previamente emitido sigue asociado a la entrada anterior y esta puede revocarse sin invalidar por ambigüedad la entrada del nuevo titular.

### ¿Qué hace la idempotencia?

La misma clave y el mismo contenido permiten devolver el resultado previamente registrado; reutilizar la clave con un contenido distinto se rechaza. Esto evita que reintentos de red creen reservas o compras duplicadas. El pago de este proyecto es simulado: no integra un procesador ni realiza cargos bancarios.

### ¿Qué persiste el test de carga?

El escenario crea reservas temporales que ocupan capacidad hasta cancelarse o expirar. No efectúa pagos. Para volver a obtener 50 plazas, usa una base de pruebas recién sembrada o espera/cancela las reservas; no borres los volúmenes si contienen datos que debas conservar.

## Alcance no implementado / trabajo futuro

Estas capacidades no deben inferirse de la arquitectura descrita: no forman parte del alcance funcional actual o requieren integración adicional.

- Sincronización móvil del escáner con `/api/scanner/batches`, registro de dispositivos desde la app y descarga/aplicación incremental de revocaciones.
- Carga dinámica de eventos y puertas asignados al staff, más validación de asignación y pertenencia de cada entrada en todas las operaciones de escaneo.
- Creación y persistencia de puertas y asignaciones de staff desde el flujo de creación de eventos del portal.
- Sincronización en vivo del portal mediante WebSockets; los paneles cargan sus datos a través de consultas HTTP.
- Integración con pasarelas de pago reales, notificaciones push, listas de espera, asientos numerados, Apple/Google Wallet y publicación móvil de producción.
- Infraestructura productiva de alta disponibilidad, réplicas de lectura, caché distribuida, observabilidad centralizada y pipeline CI/CD. El Docker Compose del repositorio es un entorno local, no una arquitectura HA.
- Pruebas móviles E2E con Detox/Maestro y defensas especializadas contra bots de compra masiva.

## Rutas principales

- Auth: `/api/auth/register`, `/login`, `/refresh`, `/logout`, `/me`.
- Reservas/pagos: `/api/reservas`, `/api/reservas/{id}/pago`, `/api/reservas/{id}`.
- Entradas: `/api/tickets/my`, `/api/tickets/{id}/rotating`, `/api/tickets/{id}/transfer`, `/api/tickets/{id}/refund`.
- Escáner: `/api/scanner/devices`, `/api/scanner/batches`, `/api/scanner/revocations`, `/api/scanner/public-key`.
- Administración: rutas `/api/admin/events` y `/api/admin/tickets` indicadas en la sección del portal.
