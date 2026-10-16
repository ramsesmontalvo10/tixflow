using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;

namespace Ticketing.Api.Services;

public record RotatingTokenDto(int TicketId, int EventId, long Window, string SignatureBase64);

public interface IRotatingTokenService
{
    long CurrentWindow();
    Task<List<RotatingTokenDto>> GenerateBlockAsync(int ticketId, int count);
    Task<(bool Ok, string? Error)> VerifyAsync(
        int ticketId,
        int eventId,
        long window,
        string signatureBase64);
}

public class RotatingTokenService(
    IEd25519Signer signer,
    TicketingDb db,
    IConfiguration cfg) : IRotatingTokenService
{
    private readonly int _windowSeconds = cfg.GetValue("Rotating:WindowSeconds", 30);
    private readonly int _windowTolerance = cfg.GetValue("Rotating:ToleranceWindows", 1);

    public long CurrentWindow() =>
        DateTimeOffset.UtcNow.ToUnixTimeSeconds() / _windowSeconds;

    public async Task<List<RotatingTokenDto>> GenerateBlockAsync(int ticketId, int count)
    {
        var eventId = await db.Entradas
            .Where(e => e.Id == ticketId)
            .Select(e => (int?)e.EventoId)
            .FirstOrDefaultAsync();
        if (eventId is null)
            throw new InvalidOperationException($"Ticket {ticketId} not found.");

        var baseWindow = CurrentWindow();
        var block = new List<RotatingTokenDto>(count);

        for (var i = 0; i < count; i++)
        {
            var window = baseWindow + i;
            var payload = signer.BuildPayload(ticketId, eventId.Value, window);
            var signature = signer.Sign(payload);
            block.Add(new RotatingTokenDto(
                ticketId,
                eventId.Value,
                window,
                Convert.ToBase64String(signature)));
        }

        return block;
    }

    public async Task<(bool Ok, string? Error)> VerifyAsync(
        int ticketId,
        int eventId,
        long window,
        string signatureBase64)
    {
        var currentWindow = CurrentWindow();
        if (Math.Abs(window - currentWindow) > _windowTolerance)
            return (false, "WindowOutOfRange");

        var actualEventId = await db.Entradas
            .Where(e => e.Id == ticketId)
            .Select(e => (int?)e.EventoId)
            .FirstOrDefaultAsync();
        if (actualEventId is null)
            return (false, "TicketNotFound");
        if (actualEventId.Value != eventId)
            return (false, "WrongEvent");

        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch { return (false, "MalformedSignature"); }

        var payload = signer.BuildPayload(ticketId, eventId, window);
        if (!signer.Verify(payload, signature))
            return (false, "InvalidSignature");

        var revoked = await db.RevocacionesEntrada.AnyAsync(r => r.EntradaId == ticketId);
        if (revoked)
            return (false, "TicketRevoked");

        return (true, null);
    }
}