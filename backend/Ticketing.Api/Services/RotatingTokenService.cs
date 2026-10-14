using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;

namespace Ticketing.Api.Services;

public record RotatingTokenDto(int TicketId, long Window, string SignatureBase64);

public interface IRotatingTokenService
{
    long CurrentWindow();
    Task<List<RotatingTokenDto>> GenerateBlockAsync(int ticketId, int count);
    Task<(bool Ok, string? Error)> VerifyAsync(int ticketId, long window, string signatureBase64);
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
        var ticketExists = await db.Entradas.AnyAsync(e => e.Id == ticketId);
        if (!ticketExists)
            throw new InvalidOperationException($"Ticket {ticketId} not found.");

        var baseWindow = CurrentWindow();
        var block = new List<RotatingTokenDto>(count);

        for (var i = 0; i < count; i++)
        {
            var window = baseWindow + i;
            var payload = signer.BuildPayload(ticketId, window);
            var signature = signer.Sign(payload);
            block.Add(new RotatingTokenDto(ticketId, window, Convert.ToBase64String(signature)));
        }

        return block;
    }

    public async Task<(bool Ok, string? Error)> VerifyAsync(int ticketId, long window, string signatureBase64)
    {
        var currentWindow = CurrentWindow();
        if (Math.Abs(window - currentWindow) > _windowTolerance)
            return (false, "WindowOutOfRange");

        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch { return (false, "MalformedSignature"); }

        var payload = signer.BuildPayload(ticketId, window);
        if (!signer.Verify(payload, signature))
            return (false, "InvalidSignature");

        var revoked = await db.RevocacionesEntrada.AnyAsync(r => r.EntradaId == ticketId);
        if (revoked)
            return (false, "TicketRevoked");

        return (true, null);
    }
}