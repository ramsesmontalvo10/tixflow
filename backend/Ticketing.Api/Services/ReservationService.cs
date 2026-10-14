using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Services;

public interface IReservationService
{
    Task<ReservationResultDto> CreateReservationAsync(int asistenteId, ReserveRequestDto request);
    Task<CancelOutcome> CancelReservationAsync(int asistenteId, int reservaId);
}

public record ReserveRequestDto(int ZonaId, int Cantidad);

public enum ReservationError
{
    None, InvalidQuantity, ZoneNotFound, SaleNotOpen, NoPricePhase, CapacityExceeded, AccountLimitExceeded
}

public enum CancelOutcome { Cancelled, NotFound, AlreadyPaid }

public record ReservationResultDto(
    ReservationError Error,
    string Message,
    int? ReservaId = null,
    int? ZonaId = null,
    int? Cantidad = null,
    long? PrecioUnitarioCentesimos = null,
    long? TotalCentesimos = null,
    DateTimeOffset? ExpiraEn = null)
{
    public bool Success => Error == ReservationError.None;
}

public class ReservationService(TicketingDb context, IConfiguration cfg) : IReservationService
{
    public async Task<ReservationResultDto> CreateReservationAsync(int asistenteId, ReserveRequestDto request)
    {
        if (request.Cantidad <= 0)
            return Fail(ReservationError.InvalidQuantity, "Quantity must be greater than zero.");

        var ownsTransaction = context.Database.CurrentTransaction is null;
        await using var transaction = ownsTransaction ? await context.Database.BeginTransactionAsync() : null;

        var zoneInfo = await context.Zonas.AsNoTracking().FirstOrDefaultAsync(z => z.Id == request.ZonaId);
        if (zoneInfo is null) return Fail(ReservationError.ZoneNotFound, "Zone not found.");

        await context.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock({zoneInfo.EventoId}, {asistenteId})");

        var zone = await context.Zonas
            .FromSqlRaw("SELECT * FROM \"Zonas\" WHERE \"Id\" = {0} FOR UPDATE", request.ZonaId)
            .FirstAsync();

        var eventEntity = await context.Eventos.AsNoTracking().FirstAsync(e => e.Id == zone.EventoId);
        var now = DateTimeOffset.UtcNow;

        if (eventEntity.Estado != "en_venta" || now < eventEntity.VentaAbre || now >= eventEntity.Fecha)
            return Fail(ReservationError.SaleNotOpen, "Ticket sales are not open for this event.");

        if (request.Cantidad > eventEntity.LimitePorCuenta)
            return Fail(ReservationError.AccountLimitExceeded,
                $"Exceeds maximum ticket limit per account ({eventEntity.LimitePorCuenta}) for this event.");

        var soldTickets = await context.Entradas
            .Where(e => e.ZonaId == zone.Id && e.Estado != "reembolsada" && e.Estado != "anulada")
            .CountAsync();
        var activeReservations = await context.Reservas
            .Where(r => r.ZonaId == zone.Id && r.Estado == "activa" && r.ExpiraEn > now)
            .SumAsync(r => r.Cantidad);

        var available = zone.Aforo - soldTickets - activeReservations;
        if (request.Cantidad > available)
            return Fail(ReservationError.CapacityExceeded,
                $"Not enough capacity available. Requested: {request.Cantidad}, Available: {Math.Max(available, 0)}");

        var userTickets = await context.Entradas
            .Where(e => e.EventoId == eventEntity.Id
                        && (e.CompradorId == asistenteId || e.TitularId == asistenteId)
                        && e.Estado != "reembolsada" && e.Estado != "anulada")
            .CountAsync();
        var userReservations = await context.Reservas
            .Where(r => r.AsistenteId == asistenteId && r.Estado == "activa" && r.ExpiraEn > now
                        && context.Zonas.Any(z => z.Id == r.ZonaId && z.EventoId == eventEntity.Id))
            .SumAsync(r => r.Cantidad);

        if ((long)userTickets + userReservations + request.Cantidad > eventEntity.LimitePorCuenta)
            return Fail(ReservationError.AccountLimitExceeded,
                $"Exceeds maximum ticket limit per account ({eventEntity.LimitePorCuenta}) for this event.");

        var phase = await context.FasesPrecio
            .Where(f => f.ZonaId == zone.Id && f.Desde <= now && now < f.Hasta)
            .OrderBy(f => f.Desde)
            .FirstOrDefaultAsync();
        if (phase is null)
            return Fail(ReservationError.NoPricePhase, "No active price phase for this zone at the current time.");

        var holdMinutes = cfg.GetValue("Reservations:HoldMinutes", 10);
        var reservation = new Reserva
        {
            AsistenteId = asistenteId,
            ZonaId = zone.Id,
            Cantidad = request.Cantidad,
            CreadaEn = now,
            ExpiraEn = now.AddMinutes(holdMinutes),
            Estado = "activa",
            FasePrecioId = phase.Id,
            PrecioUnitarioCentesimos = phase.PrecioCentesimos
        };
        context.Reservas.Add(reservation);
        await context.SaveChangesAsync();

        if (ownsTransaction) await transaction!.CommitAsync();

        return new ReservationResultDto(ReservationError.None, "Reservation created successfully.",
            reservation.Id, zone.Id, request.Cantidad, phase.PrecioCentesimos,
            phase.PrecioCentesimos * request.Cantidad, reservation.ExpiraEn);
    }

    public async Task<CancelOutcome> CancelReservationAsync(int asistenteId, int reservaId)
    {
        var rows = await context.Reservas
            .Where(r => r.Id == reservaId && r.AsistenteId == asistenteId && r.Estado == "activa")
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.Estado, "cancelada"));
        if (rows == 1) return CancelOutcome.Cancelled;

        var current = await context.Reservas.AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == reservaId && r.AsistenteId == asistenteId);
        if (current is null) return CancelOutcome.NotFound;
        if (current.Estado == "consumida") return CancelOutcome.AlreadyPaid;

        return CancelOutcome.Cancelled;
    }

    private static ReservationResultDto Fail(ReservationError error, string message) => new(error, message);
}