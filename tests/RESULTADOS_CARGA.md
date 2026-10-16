# Reporte técnico de prueba de carga

## Resumen ejecutivo

El escenario `load-test.js` modela una ráfaga de 200 asistentes concurrentes que compiten por las últimas 50 plazas de una zona. El caso está definido en el seed como evento `4`, zona `8`, con `50` plazas restantes. Los umbrales del script exigen 50 reservas aceptadas (`HTTP 201`), 150 rechazos por falta de capacidad (`HTTP 409`, `CapacityExceeded`) y cero respuestas inesperadas.

| Indicador | Resultado esperado por el escenario |
|---|---:|
| Asistentes virtuales | 200 |
| Solicitudes de reserva | 200 (una por VU) |
| Reservas aceptadas | 50 |
| Rechazos por capacidad agotada | 150 |
| Respuestas inesperadas, incluidos HTTP 500 | 0 |
| Sobreventa | 0 |

**Alcance de la medición:** se confirmó una corrida exitosa sobre una base local limpia y recién sembrada: 200 solicitudes, 50 reservas aceptadas y 150 conflictos de capacidad, con los umbrales del escenario cumplidos. No se conserva en el repositorio la salida completa de esa corrida; por eso no se reportan sus tiempos, throughput, latencias p95/p99 ni consumo de recursos.

Además, el escenario actual prueba **reservas temporales**, no compras pagadas: envía `POST /api/reservas` y no ejecuta `POST /api/reservas/{id}/pago`. Por tanto, las 50 aceptaciones no deben presentarse como 50 cargos o compras completadas. Para obtener ese resultado habría que ampliar el escenario para incluir el pago y reportar sus respuestas por separado.

### Corrida observada durante la preparación del evaluador

Una corrida anterior reportó 200 solicitudes: 46 reservas aceptadas, 154 conflictos de capacidad y cero respuestas inesperadas. Incumplió el objetivo de 50/150 porque la zona ya no tenía las 50 plazas libres al comenzar. Posteriormente, el evaluador repitió la prueba con una base limpia y confirmó 50 reservas aceptadas y 150 conflictos; esa corrida sí cumplió los umbrales. La corrida de 46/154 tampoco indica sobreventa: el total de aceptaciones coincidió con la capacidad disponible.

El test marca `201` y `409` como estados HTTP esperados para que `http_req_failed` no contabilice los conflictos normales de capacidad como fallos de transporte. La métrica de aplicación sigue comprobando que cada `409` tenga el código `CapacityExceeded`; cualquier otro resultado suma `unexpected_responses`.

## Diseño del escenario

- `EVENT_ID = 4`, `ZONE_ID = 8` y `EXPECTED_AVAILABLE = 50`, comprobados contra `Data/seed.json` antes de iniciar.
- 200 VUs con una iteración por VU; cada uno inicia sesión como un asistente distinto y envía una reserva de una entrada.
- Todas las reservas apuntan a la misma zona, haciendo que las operaciones compitan por la misma fila y capacidad.
- Cada petición usa una clave de idempotencia distinta (`k6-event-4-vu-N`) para que una repetición legítima no represente una segunda operación nueva.
- El `setup()` inicia sesión antes de la ráfaga. El límite de autenticación se eleva en el contenedor del backend antes de iniciarlo, porque los 200 logins llegan desde la misma dirección IP.
- El contador `unexpected_responses` suma cualquier estado distinto de `201` o del `409 CapacityExceeded` esperado. El umbral `count==0` exige, por tanto, cero respuestas HTTP 500 y cero fallos inesperados de cualquier otra clase.

## Cómo ejecutar y reproducir

Requisitos: Docker Compose, k6 y una base de prueba recién sembrada con el caso de las últimas 50 plazas. Desde PowerShell en la raíz:

```powershell
.\tests\Start-TestEnvironment.ps1
k6 run .\load-test.js
```

El helper crea `.env` desde `.env.example` solo si no existe, inicia PostgreSQL y el backend, configura un límite de autenticación adecuado para los 200 inicios de sesión y espera a que la API esté disponible en `http://localhost:5248`. No inicia un segundo backend ni elimina datos. El script usa `Asistente2026!` por defecto para las cuentas del seed; puede cambiarse con `K6_PASSWORD`. La URL se puede cambiar con `BASE_URL`.

Ejecuta sobre una base en estado conocido: la semilla carga sus datos solo cuando la base no tiene usuarios. Las reservas creadas permanecen activas durante la ventana de retención (10 minutos por defecto) y reducen la disponibilidad. Una corrida posterior sobre la misma base no vuelve a encontrar las 50 plazas iniciales hasta que se restablezca el estado de prueba o expiren/liberen las reservas. No elimines el volumen de Docker si contiene datos que quieras conservar.

El script valida que el seed describa las 50 plazas objetivo, que haya 200 asistentes elegibles, que los logins funcionen y que los contadores alcancen los umbrales. El estado real de la base también debe estar limpio para el escenario: si otros tests ya reservaron plazas, la corrida tendrá menos de 50 aceptaciones y el umbral fallará aunque la reserva concurrente respete el aforo. Antes de reportar una ejecución como exitosa, restablece la base local de pruebas al seed y vuelve a correr el escenario. Conserva la salida de k6 junto con la versión de k6, commit, configuración de hardware y fecha para convertir una ejecución en evidencia medible y comparable.

## Por qué no se sobrevende

La disponibilidad no se decide con un valor cacheado: se deriva del aforo de la zona menos las entradas ocupantes y las reservas activas no vencidas. Cada reserva:

1. Abre o reutiliza una transacción PostgreSQL.
2. Obtiene un advisory lock por `(eventoId, asistenteId)` para serializar el límite de una cuenta en el evento.
3. Bloquea la fila de la zona mediante `SELECT ... FOR UPDATE`.
4. Bajo ese bloqueo, vuelve a contar entradas y reservas, comprueba aforo y crea la reserva si queda espacio.
5. Confirma la transacción; las peticiones que obtienen el lock después ven la reserva anterior y reciben `CapacityExceeded` cuando ya no queda disponibilidad.

Así, 50 peticiones pueden reservar una plaza cada una y las restantes reciben un conflicto de negocio, no un error interno. La base de datos es la fuente autoritativa de capacidad.

## Lecturas, alta disponibilidad y caché

La implementación actual no configura réplicas de lectura ni una caché con invalidación cada dos segundos. Las consultas administrativas y la lectura de capacidad se ejecutan contra PostgreSQL; tampoco hay un mecanismo de alta disponibilidad desplegado por el Compose local. No se atribuyen a esta ejecución métricas de disponibilidad de infraestructura que el escenario k6 no mide.

Como evolución, réplicas de lectura pueden servir paneles y consultas que toleren replicación retrasada, y una caché con TTL de dos segundos puede reducir lecturas repetidas de datos no autoritativos. Esa caché puede presentar cifras de dashboard ligeramente retrasadas; no debe aceptar reservas ni determinar el aforo. Si se incorpora, debe invalidarse al cambiar reservas, pagos, cancelaciones, reembolsos o expiraciones. La decisión de reservar debe permanecer en PostgreSQL, con el lock de zona y un recálculo transaccional. De este modo, una lectura de presentación temporalmente desactualizada no se convierte en una venta por encima del aforo.

## Consultas e índices relevantes

El modelo define índices compuestos sobre `Entradas (ZonaId, Estado)` y `Reservas (ZonaId, Estado, ExpiraEn)`, usados para acotar los conteos por zona y estado durante el cálculo. La búsqueda que adquiere el bloqueo de zona usa la clave primaria de `Zonas`.

Para inspeccionar el acceso a la fila bloqueada, ejecuta en una base de diagnóstico:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM "Zonas"
WHERE "Id" = 8
FOR UPDATE;
ROLLBACK;
```

Se espera una búsqueda por la clave primaria y adquisición del lock de fila. `EXPLAIN ANALYZE` ejecuta la consulta y `FOR UPDATE` retiene el lock hasta el final de la transacción: por eso se incluye `ROLLBACK`. El plan exacto depende de las estadísticas y la versión de PostgreSQL. Una corrida de una sola sesión no mide esperas de bloqueo bajo contención; esas deben analizarse con clientes concurrentes y latencias de k6.
