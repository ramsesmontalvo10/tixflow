using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Ticketing.Api.Services;

namespace Ticketing.Api.Controllers;

[ApiController]
[Route("api/reservas")]
[Authorize]
public class ReservationsController(IReservationService reservationService) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> CreateReservation([FromBody] ReserveRequestDto request)
    {
        var userIdClaim = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value 
                          ?? User.FindFirst("sub")?.Value;

        if (!int.TryParse(userIdClaim, out var asistenteId))
        {
            return Unauthorized(new { message = "Invalid authentication token claims." });
        }

        var result = await reservationService.CreateReservationAsync(asistenteId, request);

        if (!result.Success)
        {
            if (result.Message.Contains("Not enough capacity") || result.Message.Contains("Exceeds maximum"))
            {
                return Conflict(new { message = result.Message });
            }

            return BadRequest(new { message = result.Message });
        }

        return StatusCode(201, new
        {
            reservaId = result.ReservaId,
            totalCentesimos = result.TotalCentesimos,
            expiraEn = result.ExpiraEn,
            message = result.Message
        });
    }
}