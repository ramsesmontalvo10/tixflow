using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Services;

public interface IReservationService
{
    Task<ReservationResultDto> CreateReservationAsync(int asistenteId, ReserveRequestDto request);
}

public record ReserveRequestDto(int ZonaId, int Cantidad);

public record ReservationResultDto(
    bool Success,
    string Message,
    int? ReservaId,
    long? TotalCentesimos,
    DateTimeOffset? ExpiraEn
);

public class ReservationService(TicketingDb context) : IReservationService
{
    public async Task<ReservationResultDto> CreateReservationAsync(int asistenteId, ReserveRequestDto request)
    {
        if (request.Cantidad <= 0)
        {
            return new ReservationResultDto(false, "Quantity must be greater than zero.", null, null, null);
        }

        using var transaction = await context.Database.BeginTransactionAsync();
        try
        {
           
            var zone = await context.Zonas
                .FromSqlRaw("SELECT * FROM \"Zonas\" WHERE \"Id\" = {0} FOR UPDATE", request.ZonaId)
                .FirstOrDefaultAsync();

            if (zone == null)
            {
                return new ReservationResultDto(false, "Zone not found.", null, null, null);
            }

            var eventEntity = await context.Eventos.FindAsync(zone.EventoId);
            if (eventEntity == null)
            {
                return new ReservationResultDto(false, "Associated event not found.", null, null, null);
            }

            var now = DateTimeOffset.UtcNow;
            if (now < eventEntity.VentaAbre)
            {
                return new ReservationResultDto(false, "Ticket sales have not opened yet for this event.", null, null, null);
            }

            int activeReservationsCount = await context.Reservas
                .Where(r => r.ZonaId == request.ZonaId && r.Estado == "activa" && r.ExpiraEn > now)
                .SumAsync(r => r.Cantidad);

            int soldTicketsCount = await context.Entradas
                .Where(e => e.ZonaId == request.ZonaId && e.Estado != "reembolsada" && e.Estado != "anulada")
                .CountAsync();

            int currentOccupied = activeReservationsCount + soldTicketsCount;
            int availableQuota = zone.Aforo - currentOccupied;

            if (request.Cantidad > availableQuota)
            {
                return new ReservationResultDto(
                    false, 
                    $"Not enough capacity available. Requested: {request.Cantidad}, Available: {availableQuota}", 
                    null, null, null
                );
            }

            int userExistingTickets = await context.Entradas
                .Where(e => e.EventoId == eventEntity.Id && (e.CompradorId == asistenteId || e.TitularId == asistenteId) && e.Estado != "reembolsada")
                .CountAsync();

            int userActiveReservations = await context.Reservas
                .Where(r => r.ZonaId == request.ZonaId && r.AsistenteId == asistenteId && r.Estado == "activa" && r.ExpiraEn > now)
                .SumAsync(r => r.Cantidad);

            if ((userExistingTickets + userActiveReservations + request.Cantidad) > eventEntity.LimitePorCuenta)
            {
                return new ReservationResultDto(
                    false, 
                    $"Exceeds maximum ticket limit per account ({eventEntity.LimitePorCuenta}) for this event.", 
                    null, null, null
                );
            }

            var activePhase = await context.FasesPrecio
                .Where(fp => fp.ZonaId == request.ZonaId && fp.Desde <= now && fp.Hasta >= now)
                .FirstOrDefaultAsync();

            if (activePhase == null)
            {
                return new ReservationResultDto(false, "No active price phase found for this zone at the current time.", null, null, null);
            }

            long unitPrice = activePhase.PrecioCentesimos;
            long totalPrice = unitPrice * request.Cantidad;

            var reservation = new Reserva
            {
                AsistenteId = asistenteId,
                ZonaId = request.ZonaId,
                Cantidad = request.Cantidad,
                CreadaEn = now,
                ExpiraEn = now.AddMinutes(10),
                Estado = "activa",
                FasePrecioId = activePhase.Id,
                PrecioUnitarioCentesimos = unitPrice
            };

            context.Reservas.Add(reservation);
            await context.SaveChangesAsync();
            await transaction.CommitAsync();

            return new ReservationResultDto(true, "Reservation created successfully.", reservation.Id, totalPrice, reservation.ExpiraEn);
        }
        catch (Exception ex)
        {
            await transaction.RollbackAsync();
            return new ReservationResultDto(false, $"An error occurred during reservation: {ex.Message}", null, null, null);
        }
    }
}