using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Services;

public enum PaymentError { None, NotFound, AlreadyPaid, ReservationCancelled, ReservationExpired }

public record PaymentResultDto(
    PaymentError Error,
    string Message,
    int? CompraId = null,
    string? Estado = null,
    long? MontoCentesimos = null,
    List<int>? EntradaIds = null)
{
    public bool Success => Error == PaymentError.None;
}

public interface IPaymentService
{
    Task<PaymentResultDto> PayAsync(int asistenteId, int reservaId, string idempotencyKey);
}

public class PaymentService(TicketingDb context) : IPaymentService
{
    public async Task<PaymentResultDto> PayAsync(int asistenteId, int reservaId, string idempotencyKey)
    {
        // Reutiliza la transacción de la idempotencia; si no hay una abierta, abre la suya
        var ownsTransaction = context.Database.CurrentTransaction is null;
        await using var transaction = ownsTransaction ? await context.Database.BeginTransactionAsync() : null;

        // Una reserva ajena se reporta como inexistente (no se revela que existe)
        var info = await context.Reservas.AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == reservaId && r.AsistenteId == asistenteId);
        if (info is null) return Fail(PaymentError.NotFound, "Reservation not found.");

        // Bloqueo 1: la zona. Serializa el pago con quienes reservan en esa zona, así nadie calcula
        // disponibilidad mientras una reserva se convierte en entradas.
        var zone = await context.Zonas
            .FromSqlRaw("SELECT * FROM \"Zonas\" WHERE \"Id\" = {0} FOR UPDATE", info.ZonaId)
            .AsNoTracking()
            .FirstAsync();

        // Bloqueo 2: la reserva (orden fijo: zona primero, reserva después)
        var reserva = await context.Reservas
            .FromSqlRaw("SELECT * FROM \"Reservas\" WHERE \"Id\" = {0} FOR UPDATE", reservaId)
            .FirstAsync();

        var now = DateTimeOffset.UtcNow;

        if (reserva.Estado == "consumida")
            return Fail(PaymentError.AlreadyPaid, "This reservation has already been paid.");
        if (reserva.Estado == "cancelada")
            return Fail(PaymentError.ReservationCancelled, "This reservation was cancelled.");

        var expired = reserva.Estado == "expirada" || reserva.ExpiraEn <= now;
        if (expired)
        {
            reserva.Estado = "expirada";
            int? refundedId = null;
            long? refundedAmount = null;

            if (reserva.FasePrecioId is int phaseId && reserva.PrecioUnitarioCentesimos is long unit)
            {
                var refunded = new Compra
                {
                    AsistenteId = asistenteId, EventoId = zone.EventoId, ZonaId = zone.Id,
                    FasePrecioId = phaseId, Cantidad = reserva.Cantidad,
                    PrecioUnitarioCentesimos = unit, MontoCentesimos = unit * reserva.Cantidad,
                    IdempotencyKey = idempotencyKey, Estado = "reembolsada",
                    PagadaEn = now, ReembolsadaEn = now
                };
                context.Compras.Add(refunded);
                await context.SaveChangesAsync();
                refundedId = refunded.Id;
                refundedAmount = refunded.MontoCentesimos;
            }
            else
            {
                await context.SaveChangesAsync();
            }

            if (ownsTransaction) await transaction!.CommitAsync();
            return new PaymentResultDto(PaymentError.ReservationExpired,
                "The reservation expired before payment. The payment was automatically refunded.",
                refundedId, "reembolsada", refundedAmount);
        }

        var unitPrice = reserva.PrecioUnitarioCentesimos
            ?? throw new InvalidOperationException("Active reservation without a price.");
        var phase = reserva.FasePrecioId
            ?? throw new InvalidOperationException("Active reservation without a price phase.");

        var compra = new Compra
        {
            AsistenteId = asistenteId, EventoId = zone.EventoId, ZonaId = zone.Id,
            FasePrecioId = phase, Cantidad = reserva.Cantidad,
            PrecioUnitarioCentesimos = unitPrice, MontoCentesimos = unitPrice * reserva.Cantidad,
            IdempotencyKey = idempotencyKey, Estado = "pagada", PagadaEn = now
        };
        context.Compras.Add(compra);
        await context.SaveChangesAsync(); // necesitamos el Id de la compra para las entradas

        var entradas = Enumerable.Range(0, reserva.Cantidad).Select(_ => new Entrada
        {
            CompraId = compra.Id, EventoId = zone.EventoId, ZonaId = zone.Id,
            TitularId = asistenteId, CompradorId = asistenteId,
            Estado = "pagada", EmitidaEn = now, Version = 1
        }).ToList();
        context.Entradas.AddRange(entradas);

        reserva.Estado = "consumida";
        await context.SaveChangesAsync();

        if (ownsTransaction) await transaction!.CommitAsync();

        return new PaymentResultDto(PaymentError.None, "Payment completed.",
            compra.Id, compra.Estado, compra.MontoCentesimos, entradas.Select(e => e.Id).ToList());
    }

    private static PaymentResultDto Fail(PaymentError error, string message) => new(error, message);
}
