using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Security.Claims;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Controllers;

public sealed class CreateAdminEventRequest
{
    [Required, StringLength(50, MinimumLength = 1)]
    public string Codigo { get; set; } = "";

    [Required, StringLength(200, MinimumLength = 2)]
    public string Nombre { get; set; } = "";

    [Required, StringLength(200, MinimumLength = 2)]
    public string Recinto { get; set; } = "";

    public DateTimeOffset Fecha { get; set; }
    public DateTimeOffset VentaAbre { get; set; }
    public DateTimeOffset ReembolsableHasta { get; set; }

    [Range(1, int.MaxValue)]
    public int LimitePorCuenta { get; set; }

    [Required]
    public string Estado { get; set; } = "proximo";

    [Required, MinLength(1)]
    public List<CreateAdminZoneRequest> Zonas { get; set; } = [];
}

public sealed class CreateAdminZoneRequest
{
    [Required, StringLength(100, MinimumLength = 1)]
    public string Nombre { get; set; } = "";

    [Range(1, int.MaxValue)]
    public int Aforo { get; set; }

    [Required, MinLength(1)]
    public List<CreateAdminPricePhaseRequest> FasesPrecio { get; set; } = [];
}

public sealed class CreateAdminPricePhaseRequest
{
    [Required, StringLength(50, MinimumLength = 1)]
    public string Fase { get; set; } = "";

    [Range(0, long.MaxValue)]
    public long PrecioCentesimos { get; set; }

    public DateTimeOffset Desde { get; set; }
    public DateTimeOffset Hasta { get; set; }
}

public sealed class AdminRefundRequest
{
    [Required, StringLength(1000, MinimumLength = 5)]
    public string Motivo { get; set; } = "";
}

[ApiController]
[Route("api/admin")]
[Authorize(Roles = "organizador")]
public class AdminController(TicketingDb db) : ControllerBase
{
    [HttpGet("events")]
    public async Task<IActionResult> GetOrganizerEvents()
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var events = await db.Eventos.AsNoTracking()
            .Where(evento => evento.OrganizadorId == organizerId)
            .OrderByDescending(evento => evento.Fecha)
            .Select(evento => new
            {
                evento.Id,
                evento.Nombre,
                evento.Fecha,
                evento.Estado
            })
            .ToListAsync();

        return Ok(events);
    }

    [HttpPost("events")]
    public async Task<IActionResult> CreateEvent([FromBody] CreateAdminEventRequest request)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var allowedStates = new[] { "proximo", "en_venta", "finalizado" };
        if (!allowedStates.Contains(request.Estado, StringComparer.Ordinal))
        {
            ModelState.AddModelError(nameof(request.Estado), "Estado must be proximo, en_venta, or finalizado.");
        }

        if (request.Fecha <= DateTimeOffset.MinValue ||
            request.VentaAbre <= DateTimeOffset.MinValue ||
            request.ReembolsableHasta <= DateTimeOffset.MinValue ||
            request.VentaAbre >= request.Fecha ||
            request.ReembolsableHasta > request.Fecha)
        {
            ModelState.AddModelError(nameof(request.Fecha), "Event dates are invalid; sales must open before the event and refunds cannot extend beyond it.");
        }

        for (var zoneIndex = 0; zoneIndex < request.Zonas.Count; zoneIndex++)
        {
            var zone = request.Zonas[zoneIndex];
            for (var phaseIndex = 0; phaseIndex < zone.FasesPrecio.Count; phaseIndex++)
            {
                var phase = zone.FasesPrecio[phaseIndex];
                if (phase.Desde <= DateTimeOffset.MinValue || phase.Hasta <= phase.Desde)
                {
                    ModelState.AddModelError(
                        $"Zonas[{zoneIndex}].FasesPrecio[{phaseIndex}]",
                        "Each price phase must have a valid start date before its end date.");
                }
            }
        }

        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var evento = new Evento
        {
            Codigo = request.Codigo.Trim(),
            Nombre = request.Nombre.Trim(),
            OrganizadorId = organizerId,
            Fecha = request.Fecha,
            VentaAbre = request.VentaAbre,
            LimitePorCuenta = request.LimitePorCuenta,
            Estado = request.Estado,
            ReembolsableHasta = request.ReembolsableHasta,
            Recinto = request.Recinto.Trim()
        };

        db.Eventos.Add(evento);
        await db.SaveChangesAsync();

        var zonas = request.Zonas.Select(zone => new Zona
        {
            EventoId = evento.Id,
            Nombre = zone.Nombre.Trim(),
            Aforo = zone.Aforo
        }).ToList();
        db.Zonas.AddRange(zonas);
        await db.SaveChangesAsync();

        var fasesPrecio = request.Zonas
            .SelectMany((zone, zoneIndex) => zone.FasesPrecio.Select(phase => new FasePrecio
            {
                ZonaId = zonas[zoneIndex].Id,
                Fase = phase.Fase.Trim(),
                PrecioCentesimos = phase.PrecioCentesimos,
                Desde = phase.Desde,
                Hasta = phase.Hasta
            }))
            .ToList();
        db.FasesPrecio.AddRange(fasesPrecio);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        return Created($"/api/admin/events/{evento.Id}", new
        {
            evento.Id,
            evento.Codigo,
            evento.Nombre,
            evento.OrganizadorId,
            zonas = zonas.Select((zone, index) => new
            {
                zone.Id,
                zone.Nombre,
                zone.Aforo,
                fasesPrecio = fasesPrecio
                    .Where(phase => phase.ZonaId == zone.Id)
                    .Select(phase => new
                    {
                        phase.Id,
                        phase.Fase,
                        phase.PrecioCentesimos,
                        phase.Desde,
                        phase.Hasta
                    })
            })
        });
    }

    [HttpGet("events/{eventId:int}/sales-summary")]
    public async Task<IActionResult> GetSalesSummary(int eventId)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == eventId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        var now = DateTimeOffset.UtcNow;
        var zoneIds = db.Zonas
            .Where(zone => zone.EventoId == eventId)
            .Select(zone => zone.Id);

        var ticketsSold = await db.Entradas
            .Where(ticket => ticket.EventoId == eventId && ticket.Estado == "pagada")
            .CountAsync();

        var activeReservations = await db.Reservas
            .Where(reservation =>
                zoneIds.Contains(reservation.ZonaId) &&
                reservation.Estado == "activa" &&
                reservation.ExpiraEn > now)
            .SumAsync(reservation => (int?)reservation.Cantidad) ?? 0;

        var paidRevenueCentesimos = await db.Compras
            .Where(purchase => purchase.EventoId == eventId && purchase.Estado == "pagada")
            .SumAsync(purchase => (long?)purchase.MontoCentesimos) ?? 0;
        var refundedRevenueCentesimos = await (
            from ticket in db.Entradas
            join purchase in db.Compras on ticket.CompraId equals purchase.Id
            where ticket.EventoId == eventId &&
                  ticket.Estado == "reembolsada" &&
                  purchase.Estado == "pagada"
            select (long?)purchase.PrecioUnitarioCentesimos
        ).SumAsync() ?? 0;
        var revenueCentesimos = Math.Max(
            paidRevenueCentesimos - refundedRevenueCentesimos,
            0);

        var zones = await db.Zonas
            .AsNoTracking()
            .Where(zone => zone.EventoId == eventId)
            .Select(zone => new { zone.Id, zone.Nombre, zone.Aforo })
            .ToListAsync();
        var eventZoneIds = zones.Select(zone => zone.Id).ToArray();

        var occupiedByZone = eventZoneIds.Length == 0
            ? new Dictionary<int, int>()
            : await db.Entradas
                .Where(ticket =>
                    eventZoneIds.Contains(ticket.ZonaId) &&
                    ticket.Estado != "reembolsada" &&
                    ticket.Estado != "anulada")
                .GroupBy(ticket => ticket.ZonaId)
                .Select(group => new { ZonaId = group.Key, Count = group.Count() })
                .ToDictionaryAsync(item => item.ZonaId, item => item.Count);

        var reservedByZone = eventZoneIds.Length == 0
            ? new Dictionary<int, int>()
            : await db.Reservas
                .Where(reservation =>
                    eventZoneIds.Contains(reservation.ZonaId) &&
                    reservation.Estado == "activa" &&
                    reservation.ExpiraEn > now)
                .GroupBy(reservation => reservation.ZonaId)
                .Select(group => new { ZonaId = group.Key, Quantity = group.Sum(item => item.Cantidad) })
                .ToDictionaryAsync(item => item.ZonaId, item => item.Quantity);

        return Ok(new
        {
            eventoId = eventId,
            entradasVendidas = ticketsSold,
            reservasVigentes = activeReservations,
            ingresosCentesimos = revenueCentesimos,
            disponibilidadPorZona = zones.Select(zone =>
            {
                var occupied = occupiedByZone.GetValueOrDefault(zone.Id);
                var reserved = reservedByZone.GetValueOrDefault(zone.Id);
                return new
                {
                    zonaId = zone.Id,
                    zona = zone.Nombre,
                    aforo = zone.Aforo,
                    entradasOcupadas = occupied,
                    reservasVigentes = reserved,
                    disponibles = Math.Max(zone.Aforo - occupied - reserved, 0)
                };
            })
        });
    }

    [HttpGet("events/{eventId:int}/tickets/search")]
    public async Task<IActionResult> SearchEventTickets(int eventId, [FromQuery] string? query)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == eventId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        var normalizedQuery = query?.Trim();
        if (normalizedQuery?.Length > 200)
        {
            return BadRequest(new { message = "The search query cannot exceed 200 characters." });
        }

        var ticketsQuery =
            from ticket in db.Entradas.AsNoTracking()
            join zone in db.Zonas.AsNoTracking() on ticket.ZonaId equals zone.Id
            join buyer in db.Usuarios.AsNoTracking() on ticket.CompradorId equals buyer.Id
            join purchase in db.Compras.AsNoTracking() on ticket.CompraId equals purchase.Id
            where ticket.EventoId == eventId
            select new { ticket, zone, buyer, purchase };

        if (!string.IsNullOrWhiteSpace(normalizedQuery))
        {
            ticketsQuery = ticketsQuery.Where(item =>
                item.buyer.Email.ToLower().Contains(normalizedQuery.ToLower()));
        }

        var tickets = await ticketsQuery
            .OrderByDescending(item => item.ticket.EmitidaEn)
            .Select(item => new
            {
                id = item.ticket.Id,
                eventoId = item.ticket.EventoId,
                zonaId = item.ticket.ZonaId,
                zona = item.zone.Nombre,
                comprador = item.buyer.Nombre,
                correoComprador = item.buyer.Email,
                precioCentesimos = item.purchase.PrecioUnitarioCentesimos,
                estado = item.ticket.Estado.ToUpper(),
                emitidaEn = item.ticket.EmitidaEn
            })
            .ToListAsync();

        return Ok(tickets);
    }

    [HttpPost("tickets/{ticketId:int}/refund")]
    public async Task<IActionResult> RefundTicket(int ticketId, [FromBody] AdminRefundRequest request)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var motivo = request.Motivo.Trim();
        if (motivo.Length < 5)
        {
            ModelState.AddModelError(nameof(request.Motivo), "Motivo must contain at least 5 non-whitespace characters.");
            return ValidationProblem(ModelState);
        }

        var autor = User.Identity?.Name;
        if (string.IsNullOrWhiteSpace(autor))
        {
            return Unauthorized(new { message = "The authenticated user has no name claim." });
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var entrada = await db.Entradas
            .FromSqlRaw("SELECT * FROM \"Entradas\" WHERE \"Id\" = {0} FOR UPDATE", ticketId)
            .FirstOrDefaultAsync();
        if (entrada is null)
        {
            return NotFound(new { message = "Ticket not found." });
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == entrada.EventoId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        if (entrada.Estado != "pagada")
        {
            return Conflict(new
            {
                message = $"Only a paid ticket can be refunded (current state: {entrada.Estado})."
            });
        }

        entrada.Estado = "reembolsada";
        db.RevocacionesEntrada.Add(new RevocacionEntrada
        {
            EntradaId = entrada.Id,
            RevocadaEn = DateTimeOffset.UtcNow,
            Motivo = motivo
        });
        var auditRecord = new AuditoriaAdministrativa
        {
            EventoId = entrada.EventoId,
            TicketId = entrada.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            Accion = "REEMBOLSO",
            Motivo = motivo,
            Autor = autor,
            Fecha = DateTime.UtcNow
        };
        db.AuditoriasAdministrativas.Add(auditRecord);

        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        return Ok(new
        {
            ticketId = entrada.Id,
            estado = entrada.Estado.ToUpper(),
            auditId = auditRecord.Id
        });
    }

    [HttpGet("events/{eventId:int}/audit-logs")]
    public async Task<IActionResult> GetEventAuditLogs(int eventId)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == eventId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        var auditRecords = await db.AuditoriasAdministrativas
            .AsNoTracking()
            .Where(record => record.EventoId == eventId)
            .OrderByDescending(record => record.Fecha)
            .ThenByDescending(record => record.Id)
            .Select(record => new
            {
                record.Id,
                record.TicketId,
                record.Accion,
                record.Motivo,
                record.Autor,
                record.Fecha
            })
            .ToListAsync();

        return Ok(auditRecords);
    }

    [HttpGet("events/{eventId}/incidents")]
    public async Task<IActionResult> GetEventIncidents(int eventId)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == eventId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        var incidentResults = new[]
        {
            "duplicate",
            "invalid_signature",
            "signature_invalid",
            "time_desync",
            "timestamp_out_of_range",
            "clock_skew"
        };
        var incidents = await db.Ingresos
            .AsNoTracking()
            .Where(i => i.EventoId == eventId && incidentResults.Contains(i.Resultado))
            .OrderByDescending(i => i.EscaneadoEn)
            .ThenByDescending(i => i.Id)
            .Select(i => new
            {
                i.Id,
                i.EntradaId,
                i.PuertaId,
                i.StaffId,
                i.EscaneadoEn,
                i.Resultado
            })
            .ToListAsync();

        return Ok(incidents);
    }

    [HttpGet("events/{eventId:int}/access-logs")]
    public async Task<IActionResult> GetEventAccessLogs(int eventId)
    {
        if (!TryGetOrganizerId(out var organizerId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == eventId);
        if (evento is null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != organizerId)
        {
            return Forbid();
        }

        var successfulScans = db.Ingresos
            .AsNoTracking()
            .Where(scan => scan.EventoId == eventId && scan.Resultado == "ok");

        var hourlyTraffic = await (
            from scan in successfulScans
            join gate in db.Puertas.AsNoTracking() on scan.PuertaId equals gate.Id
            group scan by new
            {
                scan.PuertaId,
                gate.Nombre,
                scan.EscaneadoEn.Year,
                scan.EscaneadoEn.Month,
                scan.EscaneadoEn.Day,
                scan.EscaneadoEn.Hour
            }
            into scansInHour
            orderby scansInHour.Key.Year descending,
                    scansInHour.Key.Month descending,
                    scansInHour.Key.Day descending,
                    scansInHour.Key.Hour descending,
                    scansInHour.Key.PuertaId
            select new
            {
                puertaId = scansInHour.Key.PuertaId,
                puerta = scansInHour.Key.Nombre,
                scansInHour.Key.Year,
                scansInHour.Key.Month,
                scansInHour.Key.Day,
                scansInHour.Key.Hour,
                ingresos = scansInHour.Count()
            })
            .ToListAsync();

        var devices = await (
            from device in db.DispositivosEscaner.AsNoTracking()
            join gate in db.Puertas.AsNoTracking() on device.PuertaId equals gate.Id
            join staff in db.Usuarios.AsNoTracking() on device.UsuarioId equals staff.Id
            where device.EventoId == eventId
            orderby device.UltimaSync descending, device.RegistradoEn descending
            select new
            {
                deviceId = device.Id,
                puertaId = device.PuertaId,
                puerta = gate.Nombre,
                usuarioId = device.UsuarioId,
                staff = staff.Nombre,
                device.RegistradoEn,
                device.UltimaSync
            })
            .ToListAsync();

        var currentAttendance = await successfulScans
            .Select(scan => scan.EntradaId)
            .Distinct()
            .CountAsync();

        return Ok(new
        {
            eventoId = eventId,
            aforoActual = currentAttendance,
            totalIngresosValidos = await successfulScans.CountAsync(),
            ingresosPorPuertaYHora = hourlyTraffic.Select(group => new
            {
                group.puertaId,
                group.puerta,
                hora = new DateTime(
                    group.Year,
                    group.Month,
                    group.Day,
                    group.Hour,
                    0,
                    0,
                    DateTimeKind.Utc),
                group.ingresos
            }),
            dispositivos = devices
        });
    }
    private bool TryGetOrganizerId(out int organizerId) =>
        int.TryParse(User.FindFirstValue(ClaimTypes.NameIdentifier), out organizerId);
}