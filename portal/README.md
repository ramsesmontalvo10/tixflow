# Portal de administración TixFlow

Portal web de administración para organizadores, desarrollado con React y TypeScript.

## Ejecución local

```powershell
npm ci
npm run dev
```

El servidor de desarrollo de Vite reenvía las solicitudes a `/api` hacia `http://localhost:5248`, evitando problemas de CORS durante el desarrollo local. Si es necesario, puedes cambiar la URL base con `VITE_API_URL`. Ejecuta `npm run build` para comprobar los tipos de TypeScript y generar la versión de producción.

Inicia sesión con una cuenta de organizador. El JWT se guarda en el almacenamiento local de este navegador (`localStorage`) y se envía como token `Bearer` en las solicitudes protegidas.

## Integración verificada con el backend

- Inicio de sesión: `POST /api/auth/login`, definido en `AuthController`.
- Eventos del organizador autenticado: `GET /api/admin/events`; la respuesta incluye solo los eventos que pertenecen a la cuenta de la sesión.
- Creación de eventos con sus zonas y fases de precio: `POST /api/admin/events`, definido en `AdminController`.
- Métricas de ventas: `GET /api/admin/events/{eventId}/sales-summary`.
- Búsqueda de entradas: `GET /api/admin/events/{eventId}/tickets/search`. El parámetro opcional `query` busca coincidencias parciales, sin distinguir mayúsculas, en el correo del comprador.
- Reembolso administrativo: `POST /api/admin/tickets/{ticketId}/refund`. El cuerpo requiere `motivo`; la identidad del organizador se obtiene del JWT y se registra en auditoría.
- Resumen de accesos: `GET /api/admin/events/{eventId}/access-logs`.
- Incidentes: `GET /api/admin/events/{eventId}/incidents`. Devuelve los resultados persistidos que coincidan con `duplicate`, `invalid_signature`, `signature_invalid`, `time_desync`, `timestamp_out_of_range` o `clock_skew`. El sincronizador actual no sube los errores de firma o tiempo detectados offline, así que esos incidentes no aparecerán a menos que se sincronicen.
- Historial de auditoría: `GET /api/admin/events/{eventId}/audit-logs`. Actualmente registra los reembolsos administrativos implementados.

Estas rutas están declaradas en `backend/Ticketing.Api/Controllers/AdminController.cs` y protegidas para el rol `organizador`. Las operaciones sobre un evento validan que pertenezca al organizador autenticado; el backend responde `403 Forbidden` si el recurso es de otro organizador.

El portal carga los eventos del organizador autenticado y permite seleccionar uno desde el selector compartido del panel. Ventas, entradas, accesos, incidentes y auditoría usan el evento seleccionado; el backend vuelve a validar la propiedad del evento en cada operación.

La creación de puertas y la asignación de personal no forman parte de `POST /api/admin/events`. Los campos relacionados que aparecen en el formulario son solo referencias visuales: no se envían ni se guardan.
