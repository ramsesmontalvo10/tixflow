using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Security.Claims;
using Ticketing.Api.Data;

namespace Ticketing.Api.Controllers;

[ApiController]
[Route("api/admin")]
[Authorize(Roles = "organizador")]
public class AdminController(TicketingDb db) : ControllerBase
{
    [HttpGet("events/{eventId}/incidents")]
    public async Task<IActionResult> GetEventIncidents(int eventId)
    {
        var userIdString = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!int.TryParse(userIdString, out var currentUserId))
        {
            return Unauthorized();
        }

        var evento = await db.Eventos.FindAsync(eventId);
        if (evento == null)
        {
            return NotFound(new { message = "Event not found." });
        }

        if (evento.OrganizadorId != currentUserId)
        {
            return Forbid();
        }

        var incidents = await db.Ingresos
            .Where(i => i.EventoId == eventId && i.Resultado == "duplicate")
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
}