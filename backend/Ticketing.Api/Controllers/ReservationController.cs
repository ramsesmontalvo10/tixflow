using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Ticketing.Api.Services;

namespace Ticketing.Api.Controllers;

[ApiController]
[Route("api/reservas")]
[Authorize(Roles = "asistente")]
[EnableRateLimiting("purchase")]
public class ReservationsController(
    IReservationService reservationService,
    IPaymentService paymentService,
    IIdempotencyService idempotency) : ControllerBase
{
    private const string ReserveEndpoint = "POST /api/reservas";
    private const string PayEndpoint = "POST /api/reservas/pago";

    [HttpPost]
    public async Task<IActionResult> CreateReservation(
        [FromBody] ReserveRequestDto request,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey)
    {
        if (!TryGetUserId(out var asistenteId)) return InvalidClaims();
        if (!IsValidKey(idempotencyKey)) return MissingKey();

        var bodyHash = TokenService.Hash($"reserve:{request.ZonaId}:{request.Cantidad}");
        var response = await idempotency.ExecuteAsync(asistenteId, ReserveEndpoint, idempotencyKey!, bodyHash, async () =>
        {
            var result = await reservationService.CreateReservationAsync(asistenteId, request);

            if (result.Success)
                return IdempotentResponse.From(StatusCodes.Status201Created, new
                {
                    reservaId = result.ReservaId,
                    zonaId = result.ZonaId,
                    cantidad = result.Cantidad,
                    precioUnitarioCentesimos = result.PrecioUnitarioCentesimos,
                    totalCentesimos = result.TotalCentesimos,
                    expiraEn = result.ExpiraEn
                });

            var status = result.Error switch
            {
                ReservationError.InvalidQuantity => StatusCodes.Status400BadRequest,
                ReservationError.ZoneNotFound => StatusCodes.Status404NotFound,
                _ => StatusCodes.Status409Conflict
            };
            return IdempotentResponse.From(status, new { code = result.Error.ToString(), message = result.Message });
        });

        return ToActionResult(response);
    }

    [HttpPost("{id:int}/pago")]
    public async Task<IActionResult> Pay(
        int id,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey)
    {
        if (!TryGetUserId(out var asistenteId)) return InvalidClaims();
        if (!IsValidKey(idempotencyKey)) return MissingKey();

        var bodyHash = TokenService.Hash($"pay:{id}");
        var response = await idempotency.ExecuteAsync(asistenteId, PayEndpoint, idempotencyKey!, bodyHash, async () =>
        {
            var result = await paymentService.PayAsync(asistenteId, id, idempotencyKey!);

            if (result.Success)
                return IdempotentResponse.From(StatusCodes.Status201Created, new
                {
                    compraId = result.CompraId,
                    estado = result.Estado,
                    montoCentesimos = result.MontoCentesimos,
                    entradaIds = result.EntradaIds
                });

            var status = result.Error == PaymentError.NotFound
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status409Conflict;
            return IdempotentResponse.From(status, new
            {
                code = result.Error.ToString(),
                message = result.Message,
                compraId = result.CompraId,
                estado = result.Estado,
                montoCentesimos = result.MontoCentesimos
            });
        });

        return ToActionResult(response);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Cancel(int id)
    {
        if (!TryGetUserId(out var asistenteId)) return InvalidClaims();
        var outcome = await reservationService.CancelReservationAsync(asistenteId, id);
        return outcome switch
        {
            CancelOutcome.Cancelled => NoContent(),
            CancelOutcome.NotFound => NotFound(new { code = "NotFound", message = "Reservation not found." }),
            _ => Conflict(new { code = "AlreadyPaid", message = "A paid reservation cannot be cancelled." })
        };
    }

    private bool TryGetUserId(out int id) =>
        int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out id);

    private static bool IsValidKey(string? key) => !string.IsNullOrWhiteSpace(key) && key.Length <= 100;

    private IActionResult InvalidClaims() =>
        Unauthorized(new { message = "Invalid authentication token claims." });

    private IActionResult MissingKey() =>
        BadRequest(new { code = "MissingIdempotencyKey", message = "The Idempotency-Key header is required (max 100 characters)." });

    private static ContentResult ToActionResult(IdempotentResponse r) =>
        new() { StatusCode = r.StatusCode, Content = r.Json, ContentType = "application/json" };
}