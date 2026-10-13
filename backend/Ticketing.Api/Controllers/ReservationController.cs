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
public class ReservationsController(IReservationService reservationService) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> CreateReservation([FromBody] ReserveRequestDto request)
    {
        var claim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!int.TryParse(claim, out var asistenteId))
            return Unauthorized(new { message = "Invalid authentication token claims." });

        var result = await reservationService.CreateReservationAsync(asistenteId, request);

        if (result.Success)
        {
            return StatusCode(201, new
            {
                reservaId = result.ReservaId,
                zonaId = result.ZonaId,
                cantidad = result.Cantidad,
                precioUnitarioCentesimos = result.PrecioUnitarioCentesimos,
                totalCentesimos = result.TotalCentesimos,
                expiraEn = result.ExpiraEn
            });
        }

        var status = result.Error switch
        {
            ReservationError.InvalidQuantity => StatusCodes.Status400BadRequest,
            ReservationError.ZoneNotFound => StatusCodes.Status404NotFound,
            _ => StatusCodes.Status409Conflict
        };
        return StatusCode(status, new { code = result.Error.ToString(), message = result.Message });
    }
}