using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;
using Ticketing.Api.Services;

namespace Ticketing.Api.Controllers;

[ApiController]
[Route("api/tickets")]
[Authorize]
public class TicketsController(
    TicketingDb db,
    IRotatingTokenService rotating) : ControllerBase
{
    private int CurrentUserId =>
        int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? User.FindFirstValue("sub")
            ?? throw new UnauthorizedAccessException());

    // GET /api/tickets/my
    [HttpGet("my")]
    public async Task<IActionResult> MyTickets()
    {
        var userId = CurrentUserId;
        var tickets = await db.Entradas
            .Where(e => e.TitularId == userId && e.Estado == "pagada")
            .OrderByDescending(e => e.EmitidaEn)
            .Select(e => new
            {
                e.Id,
                e.EventoId,
                e.ZonaId,
                e.Estado,
                e.EmitidaEn
            })
            .ToListAsync();

        return Ok(tickets);
    }

    // GET /api/tickets/{id}/rotating?count=20
    [HttpGet("{id:int}/rotating")]
    public async Task<IActionResult> GetRotating(int id, [FromQuery] int count = 20)
    {
        if (count < 1 || count > 100)
            return BadRequest(new { code = "InvalidCount", message = "count must be between 1 and 100." });

        var userId = CurrentUserId;
        var ticket = await db.Entradas.FirstOrDefaultAsync(e => e.Id == id);

        if (ticket is null)
            return NotFound(new { code = "TicketNotFound" });
        if (ticket.TitularId != userId)
            return Forbid();
        if (ticket.Estado != "pagada")
            return Conflict(new { code = "TicketNotActive", message = $"Ticket is '{ticket.Estado}'." });

        var block = await rotating.GenerateBlockAsync(id, count);

        return Ok(new
        {
            ticketId = id,
            windowSeconds = 30,
            currentWindow = rotating.CurrentWindow(),
            tokens = block
        });
    }

    // POST /api/tickets/{id}/transfer
    [HttpPost("{id:int}/transfer")]
    public async Task<IActionResult> StartTransfer(int id, [FromBody] StartTransferRequest req)
    {
        var userId = CurrentUserId;

        var ticket = await db.Entradas.FirstOrDefaultAsync(e => e.Id == id);
        if (ticket is null) return NotFound(new { code = "TicketNotFound" });
        if (ticket.TitularId != userId) return Forbid();
        if (ticket.Estado != "pagada")
            return Conflict(new { code = "TicketNotActive", message = $"Ticket is '{ticket.Estado}'." });

        var recipient = await db.Usuarios.FirstOrDefaultAsync(u => u.Email == req.RecipientEmail);
        if (recipient is null) return NotFound(new { code = "RecipientNotFound" });
        if (recipient.Id == userId)
            return BadRequest(new { code = "CannotTransferToSelf" });

        var alreadyPending = await db.Transferencias
            .AnyAsync(t => t.EntradaId == id && t.Estado == "pendiente");
        if (alreadyPending)
            return Conflict(new { code = "TransferAlreadyPending" });

        var transfer = new Transferencia
        {
            EntradaId = id,
            DeUsuarioId = userId,
            AUsuarioId = recipient.Id,
            Estado = "pendiente",
            CreadaEn = DateTimeOffset.UtcNow
        };

        db.Transferencias.Add(transfer);
        await db.SaveChangesAsync();

        return Ok(new { transferId = transfer.Id, estado = transfer.Estado });
    }

    // POST /api/transfers/{id}/accept
    [HttpPost("/api/transfers/{id:int}/accept")]
    public async Task<IActionResult> AcceptTransfer(int id)
    {
        var userId = CurrentUserId;

        var transfer = await db.Transferencias.FirstOrDefaultAsync(t => t.Id == id);
        if (transfer is null) return NotFound(new { code = "TransferNotFound" });
        if (transfer.AUsuarioId != userId) return Forbid();
        if (transfer.Estado != "pendiente")
            return Conflict(new { code = "TransferNotPending", message = $"Transfer is '{transfer.Estado}'." });

        var oldTicket = await db.Entradas.FirstOrDefaultAsync(e => e.Id == transfer.EntradaId);
        if (oldTicket is null) return NotFound(new { code = "TicketNotFound" });
        if (oldTicket.Estado != "pagada")
            return Conflict(new { code = "TicketNotActive", message = $"Ticket is '{oldTicket.Estado}'." });

        await using var tx = await db.Database.BeginTransactionAsync();

        db.RevocacionesEntrada.Add(new RevocacionEntrada
        {
            EntradaId = oldTicket.Id,
            RevocadaEn = DateTimeOffset.UtcNow,
            Motivo = "transferida"
        });

        oldTicket.Estado = "transferida";

        var newTicket = new Entrada
        {
            CompraId = oldTicket.CompraId,
            EventoId = oldTicket.EventoId,
            ZonaId = oldTicket.ZonaId,
            TitularId = userId,
            CompradorId = oldTicket.CompradorId,
            Estado = "pagada",
            EmitidaEn = DateTimeOffset.UtcNow,
            Version = 1
        };
        db.Entradas.Add(newTicket);

        transfer.Estado = "aceptada";
        transfer.ResueltaEn = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync();
        await tx.CommitAsync();

        return Ok(new
        {
            oldTicketId = oldTicket.Id,
            newTicketId = newTicket.Id,
            transferId = transfer.Id
        });
    }

    // POST /api/tickets/{id}/refund
    [HttpPost("{id:int}/refund")]
    public async Task<IActionResult> Refund(int id)
    {
        var userId = CurrentUserId;

        var ticket = await db.Entradas.FirstOrDefaultAsync(e => e.Id == id);
        if (ticket is null) return NotFound(new { code = "TicketNotFound" });
        if (ticket.TitularId != userId) return Forbid();
        if (ticket.Estado != "pagada")
            return Conflict(new { code = "TicketNotActive", message = $"Ticket is '{ticket.Estado}'." });

        var evento = await db.Eventos.FirstAsync(e => e.Id == ticket.EventoId);
        if (DateTimeOffset.UtcNow > evento.ReembolsableHasta)
            return Conflict(new { code = "RefundWindowClosed" });

        await using var tx = await db.Database.BeginTransactionAsync();

        ticket.Estado = "reembolsada";
        db.RevocacionesEntrada.Add(new RevocacionEntrada
        {
            EntradaId = ticket.Id,
            RevocadaEn = DateTimeOffset.UtcNow,
            Motivo = "reembolsada"
        });

        await db.SaveChangesAsync();
        await tx.CommitAsync();

        return Ok(new { ticketId = ticket.Id, estado = ticket.Estado });
    }
}

public record StartTransferRequest(string RecipientEmail);