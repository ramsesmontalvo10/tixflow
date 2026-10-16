const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');
const ACCESS_TOKEN_KEY = 'tixflow.admin.accessToken';

export interface AuthResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  usuarioId: number;
  rol: string;
}

export interface Incident {
  id: number;
  entradaId: number;
  puertaId: number;
  staffId: number;
  escaneadoEn: string;
  resultado: string;
}

export interface AccessLogs {
  eventoId: number;
  aforoActual: number;
  totalIngresosValidos: number;
  ingresosPorPuertaYHora: {
    puertaId: number;
    puerta: string;
    hora: string;
    ingresos: number;
  }[];
  dispositivos: {
    deviceId: number;
    puertaId: number;
    puerta: string;
    usuarioId: number;
    staff: string;
    registradoEn: string;
    ultimaSync: string | null;
  }[];
}

export interface SalesSummary {
  eventoId: number;
  entradasVendidas: number;
  reservasVigentes: number;
  ingresosCentesimos: number;
  disponibilidadPorZona: {
    zonaId: number;
    zona: string;
    aforo: number;
    entradasOcupadas: number;
    reservasVigentes: number;
    disponibles: number;
  }[];
}

export interface AdminEvent {
  id: number;
  nombre: string;
  fecha: string;
  estado: string;
}

export interface AdminTicket {
  id: number;
  eventoId: number;
  zonaId: number;
  zona: string;
  comprador: string;
  correoComprador: string;
  precioCentesimos: number;
  estado: string;
  emitidaEn: string;
}

export interface AuditLog {
  id: number;
  ticketId: string;
  accion: string;
  motivo: string;
  autor: string;
  fecha: string;
}

export interface CreateEventRequest {
  codigo: string;
  nombre: string;
  recinto: string;
  fecha: string;
  ventaAbre: string;
  reembolsableHasta: string;
  limitePorCuenta: number;
  estado: string;
  zonas: {
    nombre: string;
    aforo: number;
    fasesPrecio: {
      fase: string;
      precioCentesimos: number;
      desde: string;
      hasta: string;
    }[];
  }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function readAccessToken() {
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function saveAccessToken(token: string) {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function clearAccessToken() {
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

async function readError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      if ('message' in body && typeof body.message === 'string') return body.message;
      if ('error' in body && typeof body.error === 'string') return body.error;
    }
  } catch {
    // Use the HTTP status when the response body is empty or not JSON.
  }
  return `La solicitud falló (HTTP ${response.status}).`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }
  return response.json() as Promise<T>;
}

export async function signIn(email: string, password: string) {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return readJson<AuthResponse>(response);
}

export async function fetchEventIncidents(eventId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events/${eventId}/incidents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<Incident[]>(response);
}

export async function fetchEventAccessLogs(eventId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events/${eventId}/access-logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<AccessLogs>(response);
}

export async function createAdminEvent(request: CreateEventRequest, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  return readJson<{ id: number; codigo: string; nombre: string }>(response);
}

export async function fetchAdminEvents(token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events`, {
    headers: { Authorization: ['Bearer', token].join(' ') },
  });
  return readJson<AdminEvent[]>(response);
}

export async function fetchSalesSummary(eventId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events/${eventId}/sales-summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<SalesSummary>(response);
}

export async function searchAdminTickets(eventId: number, query: string, token: string) {
  const params = new URLSearchParams();
  if (query.trim()) params.set('query', query.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetch(
    `${API_BASE_URL}/admin/events/${eventId}/tickets/search${suffix}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return readJson<AdminTicket[]>(response);
}

export async function refundAdminTicket(ticketId: number, motivo: string, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/tickets/${ticketId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ motivo }),
  });
  return readJson<{ ticketId: number; estado: string; auditId: number }>(response);
}

export async function fetchEventAuditLogs(eventId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/events/${eventId}/audit-logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<AuditLog[]>(response);
}
