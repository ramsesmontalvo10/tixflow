# Ticketing – Plataforma de venta y control de acceso

Prueba técnica para Hypernova Labs. Plataforma de venta de entradas con control de acceso en puerta.

> Estado: **en desarrollo**. Este README se actualiza a medida que avanza el proyecto. Las secciones marcadas como *pendiente* aún no están implementadas.

## Stack

| Componente | Tecnología |
|---|---|
| Backend | ASP.NET Core Web API (.NET), Entity Framework Core, Npgsql |
| Base de datos | PostgreSQL 16 |
| Portal web | React + Vite *(pendiente)* |
| App móvil | React Native + Expo, TypeScript *(pendiente)* |
| Contenedores | Docker Compose |

## Estructura del repositorio

```
ticketing/
├── backend/Ticketing.Api/   API, modelo de datos, migraciones y semilla
├── portal/                  Portal de administración (pendiente)
├── mobile/                  App móvil asistente + escáner (pendiente)
├── docker-compose.yml
├── .env.example
└── README.md
```

## Cómo ejecutar (estado actual)

Requisitos: Docker Desktop, SDK de .NET, Node.js y Git.

1. Copia `.env.example` a `.env` y ajusta los valores.
2. Levanta la base de datos:
   ```powershell
   docker compose up -d
   ```
3. Ejecuta el backend desde `backend/Ticketing.Api`:
   ```powershell
   dotnet run
   ```
   Al arrancar aplica las migraciones y carga los datos de prueba (solo si la base está vacía).

La cadena de conexión se toma de `ConnectionStrings:Default` (en Docker, de la variable de entorno `ConnectionStrings__Default`).

## Datos de prueba y credenciales

La semilla carga el archivo `Data/seed.json` (administración, organizadores, staff, asistentes, eventos, zonas, fases de precio, compras, entradas, transferencias, ingresos y reservas).

Credenciales de prueba:

| Rol | Email | Contraseña |
|---|---|---|
| Admin | admin@ticketing.test | Admin2026! |
| Organizador | org.istmo@ticketing.test | Organizador2026! |
| Staff | staff1@ticketing.test | Staff2026! |
| Asistente | asistente1@correo.test | Asistente2026! |

## Decisiones de diseño

### Modelo de datos y semilla
- **Dinero en enteros** (centésimos, `bigint`). Nunca se usan decimales ni flotantes.
- **Fechas** con `DateTimeOffset` en UTC.
- **IDs de usuarios desplazados.** En los datos de prueba los IDs de admin (101), organizadores (201 a 203) y staff (301 a 312) coinciden con IDs de asistentes (1 a 600). Para guardarlos en una sola tabla, a admin, organizadores y staff se les suma **10000** al sembrar (por ejemplo, el organizador 201 queda como 10201). Las referencias (`organizador_id` de eventos, `staff_id` de asignaciones e ingresos) se ajustan igual.
- **Semilla idempotente:** si ya existen usuarios, no vuelve a cargar. Como se insertan IDs explícitos, al terminar se reajustan las secuencias de la base de datos.
- **Contraseñas con hash (BCrypt).** En la semilla se calcula un hash por cada contraseña distinta y se reutiliza entre usuarios de prueba que comparten contraseña, para no tardar. En producción cada usuario tendría su propio hash con su propia sal.
- **Restricciones en la base de datos** como última defensa contra duplicados:
  - `Usuario.Email` único.
  - `Compra (AsistenteId, IdempotencyKey)` único (un pago no se cobra dos veces).
  - `Ingreso.ClientScanId` único (reenviar un lote de escaneos no duplica ingresos).
- **Disponibilidad de una zona** = aforo − entradas vigentes (`pagada`, `transferida`, `usada`) − reservas activas no vencidas. No se guarda como un contador: se calcula.

## Invariantes del sistema

Estado de implementación (se actualizará al avanzar):

| # | Invariante | Estado |
|---|---|---|
| 1 | Nunca se vende más que el aforo (bajo concurrencia) | Pendiente |
| 2 | Una compra se cobra una sola vez (idempotencia) | Pendiente |
| 3 | Entrada no falsificable ni copiable (código firmado y rotativo) | Pendiente |
| 4 | Una entrada entra una sola vez (escaneo offline y sincronización) | Pendiente |

## Seguridad

*Pendiente.* Se documentará: autenticación con JWT de acceso corto y refresh con rotación, roles verificados en el servidor, aislamiento por organizador, límite de peticiones y manejo de secretos por variables de entorno.

## Pruebas de carga

*Pendiente.* Escenario previsto: 200 compradores concurrentes sobre la zona 8 del evento 4 (50 entradas disponibles). Resultado esperado: exactamente 50 vendidas.

## Qué no está incluido (y por qué)

*Se completará al cierre.* Todo lo que no alcance por tiempo se documentará aquí como decisión, con una nota de cómo se haría.

## Uso de IA

Se usó **Claude** como apoyo para planificar, generar borradores y revisar código. Cada parte fue revisada y probada, y las decisiones de arquitectura y de concurrencia son propias.
