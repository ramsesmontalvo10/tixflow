import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import {
  AdminEvent,
  AdminTicket,
  ApiError,
  AuditLog,
  clearAccessToken,
  createAdminEvent,
  fetchEventAccessLogs,
  fetchEventAuditLogs,
  fetchEventIncidents,
  fetchAdminEvents,
  fetchSalesSummary,
  refundAdminTicket,
  SalesSummary,
  searchAdminTickets,
  AccessLogs,
  Incident,
  readAccessToken,
  saveAccessToken,
  signIn,
} from './api';

type TabId = 'eventos' | 'ventas' | 'entradas' | 'accesos' | 'incidentes' | 'auditoria';

interface EventSelection {
  events: AdminEvent[];
  eventsLoading: boolean;
  eventsError: string;
  refreshEvents: () => Promise<void>;
  eventId: string;
  setEventId: (eventId: string) => void;
  activeEventId: number | null;
  setActiveEventId: (eventId: number) => void;
}

const EventSelectionContext = createContext<EventSelection | null>(null);

function useEventSelection() {
  const selection = useContext(EventSelectionContext);
  if (!selection) {
    throw new Error('Event selection context is unavailable.');
  }
  return selection;
}

const NAV_ITEMS: { id: TabId; icon: string; label: string; description: string }[] = [
  { id: 'eventos', icon: '⚙', label: 'Eventos', description: 'Configuración' },
  { id: 'ventas', icon: '▥', label: 'Ventas', description: 'Rendimiento' },
  { id: 'entradas', icon: '▣', label: 'Entradas', description: 'Compradores' },
  { id: 'accesos', icon: '↗', label: 'Accesos', description: 'Puertas y aforo' },
  { id: 'incidentes', icon: '⚠', label: 'Incidentes', description: 'Central de alertas' },
  { id: 'auditoria', icon: '◷', label: 'Auditoría', description: 'Registro del sistema' },
];

const TAB_TITLES: Record<TabId, string> = {
  eventos: 'Gestión de eventos',
  ventas: 'Resumen de ventas',
  entradas: 'Administración de entradas',
  accesos: 'Control de accesos',
  incidentes: 'Central de incidentes',
  auditoria: 'Auditoría del sistema',
};

interface PricePhase {
  name: string;
  priceCents: string;
  startsAt: string;
  endsAt: string;
}

interface EventZone {
  name: string;
  capacity: string;
  phases: PricePhase[];
}

interface EventDraft {
  name: string;
  code: string;
  venue: string;
  startsAt: string;
  salesOpenAt: string;
  refundableUntil: string;
  accountLimit: string;
  status: string;
  zones: EventZone[];
  gates: string[];
  staffEmails: string;
}

const EMPTY_PHASE: PricePhase = {
  name: 'Preventa',
  priceCents: '',
  startsAt: '',
  endsAt: '',
};

const EMPTY_DRAFT: EventDraft = {
  name: '',
  code: '',
  venue: '',
  startsAt: '',
  salesOpenAt: '',
  refundableUntil: '',
  accountLimit: '6',
  status: 'proximo',
  zones: [{ name: '', capacity: '', phases: [{ ...EMPTY_PHASE }] }],
  gates: [''],
  staffEmails: '',
};

function formatDate(value: string) {
  return new Date(value).toLocaleString('es-PA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.rol.toLowerCase() !== 'organizador') {
        throw new Error('Este portal es exclusivo para cuentas de organizador.');
      }
      saveAccessToken(result.accessToken);
      onLogin(result.accessToken);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'No se pudo iniciar sesión.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">t</div>
        <p className="eyebrow">TIXFLOW · ORGANIZADORES</p>
        <h1>Bienvenidos</h1>
        <p className="muted">Inicia sesión para administrar tus eventos.</p>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            Correo electrónico
            <input
              autoComplete="username"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="organizador@empresa.com"
            />
          </label>
          <label>
            Contraseña
            <input
              autoComplete="current-password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Tu contraseña"
            />
          </label>
          {error ? <p className="callout callout-error">{error}</p> : null}
          <button className="button button-primary button-wide" disabled={submitting}>
            {submitting ? 'Verificando…' : 'Iniciar sesión'}
          </button>
        </form>
        <p className="login-footnote">La sesión se almacena en este navegador.</p>
      </section>
    </main>
  );
}

function UnavailableNotice({ children }: { children: string }) {
  return (
    <div className="callout callout-info">
      <span className="callout-icon">i</span>
      <span>{children}</span>
    </div>
  );
}

function ForbiddenNotice() {
  return (
    <div className="forbidden-notice" role="alert">
      <div className="forbidden-notice-icon" aria-hidden="true">🔒</div>
      <div>
        <h3>Acceso Restringido o Evento No Asignado</h3>
        <p>Lo sentimos, tu cuenta de organizador no tiene los permisos necesarios para administrar este evento o el recurso pertenece a otro usuario multi-inquilino. Por favor, selecciona un evento de tu propiedad en el panel principal.</p>
      </div>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function EventsTab() {
  const { refreshEvents, setEventId, setActiveEventId } = useEventSelection();
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function updateDraft<K extends keyof EventDraft>(key: K, value: EventDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateZone(index: number, patch: Partial<EventZone>) {
    setDraft((current) => ({
      ...current,
      zones: current.zones.map((zone, zoneIndex) =>
        zoneIndex === index ? { ...zone, ...patch } : zone,
      ),
    }));
  }

  function updatePhase(zoneIndex: number, phaseIndex: number, patch: Partial<PricePhase>) {
    setDraft((current) => ({
      ...current,
      zones: current.zones.map((zone, currentZoneIndex) =>
        currentZoneIndex === zoneIndex
          ? {
              ...zone,
              phases: zone.phases.map((phase, currentPhaseIndex) =>
                currentPhaseIndex === phaseIndex ? { ...phase, ...patch } : phase,
              ),
            }
          : zone,
      ),
    }));
  }

  async function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readAccessToken();
    if (!token) return;
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const created = await createAdminEvent({
        codigo: draft.code.trim(),
        nombre: draft.name.trim(),
        recinto: draft.venue.trim(),
        fecha: new Date(draft.startsAt).toISOString(),
        ventaAbre: new Date(draft.salesOpenAt).toISOString(),
        reembolsableHasta: new Date(draft.refundableUntil).toISOString(),
        limitePorCuenta: Number(draft.accountLimit),
        estado: draft.status,
        zonas: draft.zones.map((zone) => ({
          nombre: zone.name.trim(),
          aforo: Number(zone.capacity),
          fasesPrecio: zone.phases.map((phase) => ({
            fase: phase.name.toLowerCase(),
            precioCentesimos: Number(phase.priceCents),
            desde: new Date(phase.startsAt).toISOString(),
            hasta: new Date(phase.endsAt).toISOString(),
          })),
        })),
      }, token);
      setNotice(`Evento "${created.nombre}" creado correctamente (ID ${created.id}).`);
      setDraft(EMPTY_DRAFT);
      try {
        await refreshEvents();
        setEventId(String(created.id));
        setActiveEventId(created.id);
      } catch {
        setNotice((current) => `${current} No se pudo actualizar el selector de eventos.`);
      }
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.status === 401) {
        clearAccessToken();
        window.location.reload();
      }
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear el evento.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="CATÁLOGO" title="Configura un evento" />
      <UnavailableNotice>
        El evento, sus zonas y fases de precio se guardan en el backend. Las puertas y los correos del staff son referencias visuales: este endpoint no los registra ni los asigna.
      </UnavailableNotice>
      <form className="form-card page-stack" onSubmit={submitDraft}>
        <div className="form-section">
          <div className="form-section-title">
            <span className="step-number">01</span>
            <div><h3>Información general</h3><p>Datos básicos y límites de venta</p></div>
          </div>
          <div className="field-grid">
            <label>Nombre del evento<input required value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="Ej. Festival de verano" /></label>
            <label>Código<input required value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} placeholder="EVT-2026" /></label>
            <label>Recinto<input required value={draft.venue} onChange={(event) => updateDraft('venue', event.target.value)} placeholder="Nombre del recinto" /></label>
            <label>Fecha y hora<input required type="datetime-local" value={draft.startsAt} onChange={(event) => updateDraft('startsAt', event.target.value)} /></label>
            <label>Inicio de ventas<input required type="datetime-local" value={draft.salesOpenAt} onChange={(event) => updateDraft('salesOpenAt', event.target.value)} /></label>
            <label>Fecha límite de reembolso<input required type="datetime-local" value={draft.refundableUntil} onChange={(event) => updateDraft('refundableUntil', event.target.value)} /></label>
            <label>Límite por cuenta<input required min="1" type="number" value={draft.accountLimit} onChange={(event) => updateDraft('accountLimit', event.target.value)} /></label>
            <label>Estado del evento<select value={draft.status} onChange={(event) => updateDraft('status', event.target.value)}><option value="proximo">Próximo</option><option value="en_venta">En venta</option><option value="finalizado">Finalizado</option></select></label>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">
            <span className="step-number">02</span>
            <div><h3>Zonas y fases de precio</h3><p>Define aforo y precios en centavos por periodo</p></div>
          </div>
          {draft.zones.map((zone, zoneIndex) => (
            <div className="nested-card" key={zoneIndex}>
              <div className="field-grid">
                <label>Nombre de zona<input required value={zone.name} onChange={(event) => updateZone(zoneIndex, { name: event.target.value })} placeholder="General" /></label>
                <label>Aforo máximo<input required min="1" type="number" value={zone.capacity} onChange={(event) => updateZone(zoneIndex, { capacity: event.target.value })} placeholder="500" /></label>
              </div>
              <div className="phase-grid">
                {zone.phases.map((phase, phaseIndex) => (
                  <div className="phase-card" key={phaseIndex}>
                    <label>Fase<select value={phase.name} onChange={(event) => updatePhase(zoneIndex, phaseIndex, { name: event.target.value })}>
                      <option>Preventa</option><option>General</option><option>Taquilla</option>
                    </select></label>
                    <label>Precio (centavos)<input required min="0" type="number" value={phase.priceCents} onChange={(event) => updatePhase(zoneIndex, phaseIndex, { priceCents: event.target.value })} placeholder="4500" /></label>
                    <label>Desde<input required type="datetime-local" value={phase.startsAt} onChange={(event) => updatePhase(zoneIndex, phaseIndex, { startsAt: event.target.value })} /></label>
                    <label>Hasta<input required type="datetime-local" value={phase.endsAt} onChange={(event) => updatePhase(zoneIndex, phaseIndex, { endsAt: event.target.value })} /></label>
                  </div>
                ))}
              </div>
              <button className="button button-quiet button-small" type="button" onClick={() => updateZone(zoneIndex, { phases: [...zone.phases, { ...EMPTY_PHASE, name: 'General' }] })}>+ Agregar fase</button>
            </div>
          ))}
          <button className="button button-secondary button-small" type="button" onClick={() => updateDraft('zones', [...draft.zones, { name: '', capacity: '', phases: [{ ...EMPTY_PHASE }] }])}>+ Agregar zona</button>
        </div>

        <div className="form-section">
          <div className="form-section-title">
            <span className="step-number">03</span>
            <div><h3>Puertas y equipo</h3><p>Accesos físicos y personal autorizado</p></div>
          </div>
          <div className="field-grid">
            <label className="full-field">Puertas de acceso
              {draft.gates.map((gate, index) => (
                <input className="field-spaced" key={index} required value={gate} onChange={(event) => updateDraft('gates', draft.gates.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Puerta Norte · Acceso General" />
              ))}
              <button className="button button-quiet button-small" type="button" onClick={() => updateDraft('gates', [...draft.gates, ''])}>+ Agregar puerta</button>
            </label>
            <label className="full-field">Correos del staff asignado<textarea rows={3} value={draft.staffEmails} onChange={(event) => updateDraft('staffEmails', event.target.value)} placeholder="staff@empresa.com, un correo por línea" /></label>
          </div>
        </div>
        {notice ? <p className="callout callout-info">{notice}</p> : null}
        {error ? <p className="callout callout-error">{error}</p> : null}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar evento'}</button></div>
      </form>
    </div>
  );
}

function SalesTab() {
  const token = readAccessToken();
  const { eventId, setEventId, activeEventId, setActiveEventId } = useEventSelection();
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (activeEventId === null || !token) {
      setSummary(null);
      return;
    }
    let cancelled = false;

    const refresh = async () => {
      setLoading(true);
      setSummary(null);
      setError('');
      setForbidden(false);
      try {
        const result = await fetchSalesSummary(activeEventId, token);
        if (!cancelled) {
          setSummary(result);
          setError('');
          setForbidden(false);
        }
      } catch (requestError) {
        if (cancelled) return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          clearAccessToken();
          window.location.reload();
        }
        if (requestError instanceof ApiError && requestError.status === 403) {
          setForbidden(true);
          setSummary(null);
        }
        setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar las ventas.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeEventId, token]);

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="EN VIVO" title="Rendimiento de ventas">
        <span className={`status-pill ${summary ? 'status-live' : 'status-muted'}`}><span className="status-dot" />{summary ? 'Actualización cada 15 s' : 'Selecciona un evento'}</span>
      </SectionHeading>
      <section className="panel">
        <form className="event-filter" onSubmit={(event) => {
          event.preventDefault();
          setForbidden(false);
          setError('');
          setSummary(null);
          setActiveEventId(Number(eventId));
        }}>
          <label>ID del evento<input type="number" min="1" required value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
          <button className="button button-primary" type="submit" disabled={loading || !token}>{loading ? 'Consultando…' : 'Consultar ventas'}</button>
        </form>
      </section>
      {forbidden ? <ForbiddenNotice /> : error ? <p className="callout callout-error">{error}</p> : null}
      <div className="metric-grid">
        {[
          { label: 'Entradas vendidas', value: summary?.entradasVendidas.toLocaleString('es-PA') ?? '—', icon: '▣', tone: 'mint' },
          { label: 'Reservas vigentes', value: summary?.reservasVigentes.toLocaleString('es-PA') ?? '—', icon: '◷', tone: 'blue' },
          { label: 'Ingresos acumulados', value: summary ? `${summary.ingresosCentesimos.toLocaleString('es-PA')} ¢` : '—', icon: '$', tone: 'violet' },
          { label: 'Disponibilidad remanente', value: summary?.disponibilidadPorZona.reduce((total, zone) => total + zone.disponibles, 0).toLocaleString('es-PA') ?? '—', icon: '↗', tone: 'amber' },
        ].map((metric) => (
          <article className="metric-card" key={metric.label}>
            <div className={`metric-icon ${metric.tone}`}>{metric.icon}</div>
            <p className="metric-label">{metric.label}</p>
            <strong className="metric-value">{metric.value}</strong>
            <span className="metric-footnote">{summary ? `Evento #${summary.eventoId}` : 'Esperando consulta'}</span>
          </article>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h3>Disponibilidad por zona</h3><p>Capacidad restante y ocupación actual</p></div></div>
        <div className="table-scroll">
          <table><thead><tr><th>Evento</th><th>Zona</th><th>Aforo</th><th>Vendidas</th><th>Reservadas</th><th>Disponibles</th></tr></thead>
            <tbody>
              {summary?.disponibilidadPorZona.map((zone) => (
                <tr key={zone.zonaId}><td>#{summary.eventoId}</td><td>{zone.zona}</td><td>{zone.aforo}</td><td>{zone.entradasOcupadas}</td><td>{zone.reservasVigentes}</td><td>{zone.disponibles}</td></tr>
              ))}
              {summary && summary.disponibilidadPorZona.length === 0 ? <tr><td className="empty-cell" colSpan={6}>Este evento aún no tiene zonas configuradas.</td></tr> : null}
              {!summary ? <tr><td className="empty-cell" colSpan={6}>Introduce el ID de uno de tus eventos para cargar las métricas.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RefundModal({
  ticketId,
  onClose,
  onRefunded,
}: {
  ticketId: number;
  onClose: () => void;
  onRefunded: () => Promise<void>;
}) {
  const token = readAccessToken();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError('');
    setSubmitting(true);
    try {
      await refundAdminTicket(ticketId, reason.trim(), token);
      await onRefunded();
      onClose();
    } catch (refundError) {
      if (refundError instanceof ApiError && refundError.status === 401) {
        clearAccessToken();
        window.location.reload();
      }
      setError(refundError instanceof Error ? refundError.message : 'No se pudo procesar el reembolso.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="refund-title">
        <button className="modal-close" type="button" aria-label="Cerrar" onClick={onClose}>×</button>
        <p className="eyebrow">ACCIÓN ADMINISTRATIVA</p>
        <h2 id="refund-title">Solicitar reembolso</h2>
        <p className="muted">El motivo es obligatorio. El autor queda registrado por el backend usando la identidad autenticada.</p>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>ID de entrada<input readOnly type="number" value={ticketId} /></label>
          <label>Motivo<textarea required minLength={5} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe el motivo del reembolso" /></label>
          {error ? <p className="callout callout-error">{error}</p> : null}
          <div className="modal-actions">
            <button className="button button-secondary" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button-danger" type="submit" disabled={submitting}>{submitting ? 'Procesando…' : 'Confirmar reembolso'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function TicketsTab() {
  const token = readAccessToken();
  const { eventId, setEventId, setActiveEventId } = useEventSelection();
  const [email, setEmail] = useState('');
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [searched, setSearched] = useState(false);
  const [refundTicketId, setRefundTicketId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  async function searchTickets(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveEventId(Number(eventId));
    await refreshTickets();
  }

  async function refreshTickets() {
    if (!token || !eventId) return;
    setLoading(true);
    setTickets([]);
    setSearched(false);
    setError('');
    setForbidden(false);
    try {
      setTickets(await searchAdminTickets(Number(eventId), email.trim(), token));
      setSearched(true);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        clearAccessToken();
        window.location.reload();
      }
      if (requestError instanceof ApiError && requestError.status === 403) {
        setForbidden(true);
        setTickets([]);
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudieron buscar las entradas.');
      setSearched(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="ATENCIÓN AL CLIENTE" title="Buscar entradas">
        <span className="status-pill status-live"><span className="status-dot" />Búsqueda y reembolso disponibles</span>
      </SectionHeading>
      <UnavailableNotice>La búsqueda y el reembolso están disponibles para eventos propios. La anulación de entradas no está implementada; el reembolso requiere motivo y registra automáticamente al organizador autenticado.</UnavailableNotice>
      <section className="panel">
        <form className="search-form" onSubmit={searchTickets}>
          <label>ID del evento<input type="number" min="1" required value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
          <label>Correo del comprador<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Opcional · cliente@correo.com" /></label>
          <button className="button button-primary" type="submit" disabled={loading || !token}>{loading ? 'Buscando…' : 'Buscar entradas'}</button>
        </form>
      </section>
      {forbidden ? <ForbiddenNotice /> : error ? <p className="callout callout-error">{error}</p> : null}
      <section className="panel">
        <div className="panel-heading"><div><h3>Resultados</h3><p>Entradas asociadas al correo consultado</p></div></div>
        <div className="table-scroll">
          <table><thead><tr><th>Entrada</th><th>Evento</th><th>Comprador</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>#{ticket.id}<small className="table-secondary">{ticket.zona} · {(ticket.precioCentesimos / 100).toLocaleString('es-PA', { style: 'currency', currency: 'USD' })}</small></td>
                  <td>#{ticket.eventoId}</td>
                  <td>{ticket.comprador}<small className="table-secondary">{ticket.correoComprador}</small></td>
                  <td><span className={`ticket-state state-${ticket.estado.toLowerCase()}`}>{ticket.estado}</span></td>
                  <td>{ticket.estado === 'PAGADA' ? <button className="button button-danger button-small" type="button" onClick={() => setRefundTicketId(ticket.id)}>Reembolsar</button> : <span className="muted">Sin acciones disponibles</span>}</td>
                </tr>
              ))}
              {searched && tickets.length === 0 ? <tr><td className="empty-cell" colSpan={5}>No se encontraron entradas para esos criterios.</td></tr> : null}
              {!searched ? <tr><td className="empty-cell" colSpan={5}>Selecciona un evento y, opcionalmente, un correo para buscar entradas.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
      {refundTicketId !== null ? (
        <RefundModal
          ticketId={refundTicketId}
          onClose={() => setRefundTicketId(null)}
          onRefunded={refreshTickets}
        />
      ) : null}
    </div>
  );
}

function AccessesTab() {
  const token = readAccessToken();
  const { eventId, setEventId, setActiveEventId } = useEventSelection();
  const [accessLogs, setAccessLogs] = useState<AccessLogs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  async function loadAccessLogs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveEventId(Number(eventId));
    if (!token) return;
    setLoading(true);
    setAccessLogs(null);
    setError('');
    setForbidden(false);
    try {
      setAccessLogs(await fetchEventAccessLogs(Number(eventId), token));
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        clearAccessToken();
        window.location.reload();
      }
      if (requestError instanceof ApiError && requestError.status === 403) {
        setForbidden(true);
        setAccessLogs(null);
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar los accesos.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="OPERACIÓN DEL RECINTO" title="Flujo de accesos" />
      <section className="panel">
        <form className="event-filter" onSubmit={loadAccessLogs}>
          <label>ID del evento<input type="number" min="1" required value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
          <button className="button button-primary" disabled={loading || !token}>{loading ? 'Consultando…' : 'Actualizar accesos'}</button>
        </form>
      </section>
      {forbidden ? <ForbiddenNotice /> : error ? <p className="callout callout-error">{error}</p> : null}
      <div className="metric-grid metric-grid-three">
        {[
          ['Personas ingresadas', accessLogs?.aforoActual.toLocaleString('es-PA') ?? '—', 'Entradas únicas con escaneo aceptado'],
          ['Ingresos válidos', accessLogs?.totalIngresosValidos.toLocaleString('es-PA') ?? '—', 'Escaneos aceptados sincronizados'],
          ['Dispositivos registrados', accessLogs?.dispositivos.length.toLocaleString('es-PA') ?? '—', 'Escáneres asignados al evento'],
        ].map(([label, value, note]) => (
          <article className="metric-card" key={label}><p className="metric-label">{label}</p><strong className="metric-value">{value}</strong><span className="metric-footnote">{note}</span></article>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h3>Ingresos por puerta y hora</h3><p>Escaneos aceptados sincronizados</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Puerta</th><th>Hora (UTC)</th><th>Ingresos</th></tr></thead>
          <tbody>
            {accessLogs?.ingresosPorPuertaYHora.map((entry) => (
              <tr key={`${entry.puertaId}-${entry.hora}`}><td>{entry.puerta}</td><td>{new Date(entry.hora).toLocaleString('es-PA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })}</td><td>{entry.ingresos}</td></tr>
            ))}
            {accessLogs && accessLogs.ingresosPorPuertaYHora.length === 0 ? <tr><td className="empty-cell" colSpan={3}>Todavía no hay accesos aceptados sincronizados para este evento.</td></tr> : null}
            {!accessLogs ? <tr><td className="empty-cell" colSpan={3}>Introduce un ID de evento para consultar los accesos.</td></tr> : null}
          </tbody>
        </table></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h3>Dispositivos de escaneo</h3><p>Registro y última sincronización reportada</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Dispositivo</th><th>Puerta</th><th>Personal</th><th>Registrado</th><th>Última sincronización</th></tr></thead>
          <tbody>
            {accessLogs?.dispositivos.map((device) => (
              <tr key={device.deviceId}><td>#{device.deviceId}</td><td>{device.puerta}</td><td>{device.staff}</td><td>{new Date(device.registradoEn).toLocaleString('es-PA')}</td><td>{device.ultimaSync ? new Date(device.ultimaSync).toLocaleString('es-PA') : 'Aún sin sincronizar'}</td></tr>
            ))}
            {accessLogs && accessLogs.dispositivos.length === 0 ? <tr><td className="empty-cell" colSpan={5}>No hay dispositivos registrados para este evento.</td></tr> : null}
            {!accessLogs ? <tr><td className="empty-cell" colSpan={5}>Introduce un ID de evento para consultar sus dispositivos.</td></tr> : null}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}

function IncidentsTab({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const { eventId, setEventId, setActiveEventId } = useEventSelection();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function loadIncidents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveEventId(Number(eventId));
    setLoading(true);
    setIncidents([]);
    setLoaded(false);
    setError('');
    setForbidden(false);
    try {
      const result = await fetchEventIncidents(Number(eventId), token);
      setIncidents(result);
      setLoaded(true);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      if (requestError instanceof ApiError && requestError.status === 403) {
        setForbidden(true);
        setIncidents([]);
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar los incidentes.');
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="SEGURIDAD DEL EVENTO" title="Central de incidentes">
        <span className="status-pill status-live"><span className="status-dot" />API conectada</span>
      </SectionHeading>
      <UnavailableNotice>
        Se muestran incidentes persistidos al sincronizar escáneres. Las firmas inválidas verificadas offline no aparecen aquí porque los lotes actuales no las envían al backend.
      </UnavailableNotice>
      <section className="panel">
        <form className="event-filter" onSubmit={loadIncidents}>
          <label>ID del evento<input type="number" min="1" required value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
          <button className="button button-primary" disabled={loading}>{loading ? 'Consultando…' : 'Cargar incidentes'}</button>
        </form>
      </section>
      {forbidden ? <ForbiddenNotice /> : error ? <p className="callout callout-error">{error}</p> : null}
      <section className="panel">
        <div className="panel-heading"><div><h3>Dobles ingresos detectados</h3><p>Incidentes reales sincronizados desde las puertas</p></div><span className="count-badge">{incidents.length}</span></div>
        <div className="table-scroll"><table><thead><tr><th>Severidad</th><th>Entrada</th><th>Puerta</th><th>Personal</th><th>Fecha y hora</th></tr></thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id}>
                <td><span className="severity severity-critical">Duplicado</span></td>
                <td>#{incident.entradaId}</td>
                <td>Puerta #{incident.puertaId}</td>
                <td>Staff #{incident.staffId}</td>
                <td>{formatDate(incident.escaneadoEn)}</td>
              </tr>
            ))}
            {loaded && incidents.length === 0 ? <tr><td className="empty-cell" colSpan={5}>No se encontraron dobles ingresos para este evento.</td></tr> : null}
            {!loaded && !loading ? <tr><td className="empty-cell" colSpan={5}>Introduce un ID de evento y carga sus incidentes.</td></tr> : null}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}

function AuditTab() {
  const token = readAccessToken();
  const { eventId, setEventId, setActiveEventId } = useEventSelection();
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function loadAuditLogs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveEventId(Number(eventId));
    if (!token) return;
    setLoading(true);
    setAuditLogs([]);
    setLoaded(false);
    setError('');
    setForbidden(false);
    try {
      setAuditLogs(await fetchEventAuditLogs(Number(eventId), token));
      setLoaded(true);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        clearAccessToken();
        window.location.reload();
      }
      if (requestError instanceof ApiError && requestError.status === 403) {
        setForbidden(true);
        setAuditLogs([]);
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar la auditoría.');
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <SectionHeading eyebrow="SOLO LECTURA" title="Registro de auditoría" />
      <UnavailableNotice>El historial se carga para un evento propio y es de solo lectura. Actualmente registra reembolsos administrativos; nuevas acciones aparecerán cuando el backend también las audite.</UnavailableNotice>
      <section className="panel">
        <form className="event-filter" onSubmit={loadAuditLogs}>
          <label>ID del evento<input type="number" min="1" required value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
          <button className="button button-primary" type="submit" disabled={loading || !token}>{loading ? 'Consultando…' : 'Cargar auditoría'}</button>
        </form>
      </section>
      {forbidden ? <ForbiddenNotice /> : error ? <p className="callout callout-error">{error}</p> : null}
      <section className="panel">
        <div className="panel-heading"><div><h3>Actividad administrativa</h3><p>Orden cronológico · solo lectura</p></div><span className="status-pill status-live"><span className="status-dot" />API disponible</span></div>
        <div className="table-scroll"><table><thead><tr><th>Fecha y hora</th><th>Autor</th><th>Acción</th><th>Recurso</th><th>Detalle</th></tr></thead>
          <tbody>
            {auditLogs.map((record) => (
              <tr key={record.id}><td>{formatDate(record.fecha)}</td><td>{record.autor}</td><td><span className="ticket-state state-reembolsada">{record.accion}</span></td><td>Entrada #{record.ticketId}</td><td>{record.motivo}</td></tr>
            ))}
            {loaded && auditLogs.length === 0 ? <tr><td className="empty-cell" colSpan={5}>No hay acciones administrativas registradas para este evento.</td></tr> : null}
            {!loaded ? <tr><td className="empty-cell" colSpan={5}>Introduce un ID de evento para consultar su historial.</td></tr> : null}
          </tbody></table></div>
      </section>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => readAccessToken());
  const [activeTab, setActiveTab] = useState<TabId>('eventos');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const [eventId, setEventId] = useState('');
  const [activeEventId, setActiveEventId] = useState<number | null>(null);

  const refreshEvents = useCallback(async () => {
    if (!token) return;
    setEventsLoading(true);
    setEventsError('');
    try {
      const result = await fetchAdminEvents(token);
      setEvents(result);
      setEventId((current) =>
        current && result.some((item) => item.id === Number(current))
          ? current
          : result[0] ? String(result[0].id) : '',
      );
    } catch (loadError) {
      const message = loadError instanceof ApiError && loadError.status === 405
        ? 'La API activa todavía no tiene disponible el listado de eventos (HTTP 405). Reinicia o reconstruye el backend y vuelve a cargar.'
        : loadError instanceof Error
          ? loadError.message
          : 'No se pudieron cargar tus eventos.';
      setEventsError(message);
      throw loadError;
    } finally {
      setEventsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refreshEvents().catch(() => {
      // The error is displayed beside the event selector.
    });
  }, [refreshEvents, token]);

  function handleLogout() {
    clearAccessToken();
    setToken(null);
  }

  if (!token) return <LoginScreen onLogin={setToken} />;
  const activeToken = token;

  function renderActiveTab() {
    switch (activeTab) {
      case 'eventos': return <EventsTab />;
      case 'ventas': return <SalesTab />;
      case 'entradas': return <TicketsTab />;
      case 'accesos': return <AccessesTab />;
      case 'incidentes': return <IncidentsTab token={activeToken} onUnauthorized={handleLogout} />;
      case 'auditoria': return <AuditTab />;
    }
  }

  return (
    <EventSelectionContext.Provider
      value={{
        events,
        eventsLoading,
        eventsError,
        refreshEvents,
        eventId,
        setEventId,
        activeEventId,
        setActiveEventId,
      }}>
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand"><span className="brand-mark brand-mark-small">t</span><span>tixflow<span className="brand-period">.</span></span></div>
        <div className="workspace-label">ESPACIO DE TRABAJO</div>
        <div className="workspace-card"><div className="workspace-avatar">O</div><div><strong>Organizador</strong><span>Panel de administración</span></div><span className="workspace-chevron">⌄</span></div>
        <div className="nav-label">ADMINISTRACIÓN</div>
        <nav className="main-nav" aria-label="Módulos de administración">
          {NAV_ITEMS.map((item) => (
            <button
              className={`nav-item ${activeTab === item.id ? 'nav-item-active' : ''}`}
              key={item.id}
              onClick={() => { setActiveTab(item.id); setMobileNavOpen(false); }}
              aria-current={activeTab === item.id ? 'page' : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              {item.id === 'incidentes' ? <span className="nav-indicator" aria-label="Módulo conectado" /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><span className="help-icon">?</span><div><strong>¿Necesitas ayuda?</strong><span>Consulta la guía del portal</span></div></div>
          <div className="profile-row"><div className="profile-avatar">OR</div><div className="profile-copy"><strong>Sesión activa</strong><span>Organizador</span></div><button className="logout-button" onClick={handleLogout} title="Cerrar sesión" aria-label="Cerrar sesión">↪</button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu-button" onClick={() => setMobileNavOpen((open) => !open)} aria-label="Abrir navegación">☰</button>
          <div className="breadcrumbs"><span>Administración</span><span className="breadcrumb-separator">/</span><strong>{TAB_TITLES[activeTab]}</strong></div>
          <div className="topbar-right"><span className="environment-tag"><span />Desarrollo</span><button className="notification-button" title="Notificaciones" aria-label="Notificaciones">♧<i /></button><div className="topbar-avatar">OR</div></div>
        </header>
        <div className="content-area">
          <div className="page-title-row">
            <div><p className="eyebrow">PANEL DE ORGANIZADOR</p><h1>{TAB_TITLES[activeTab]}</h1></div>
            <div className="date-label"><span>◷</span> {new Date().toLocaleDateString('es-PA', { dateStyle: 'long' })}</div>
          </div>
          <p className="organizer-event-ids" aria-live="polite">
            <span>Eventos a tu cargo:</span>{' '}
            <strong>
              {eventsLoading
                ? 'Cargando…'
                : eventsError
                  ? 'No disponibles'
                  : events.length > 0
                    ? events.map((item) => item.id).join(', ')
                    : 'Ninguno'}
            </strong>
          </p>
          {eventsError ? <p className="callout callout-error" role="alert">{eventsError}</p> : null}
          {renderActiveTab()}
          <footer className="page-footer"><span>© 2026 TixFlow</span><span>Portal de administración · API local</span></footer>
        </div>
      </main>
    </div>
    </EventSelectionContext.Provider>
  );
}
