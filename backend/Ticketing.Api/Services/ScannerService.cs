using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Services;

public record RegisterDeviceRequest(int EventoId, int PuertaId);

public record ScanItem(
    string ClientScanId,
    int EntradaId,
    int EventoId,
    int PuertaId,
    DateTimeOffset EscaneadoEn
);

public record SubmitBatchRequest(int DeviceId, List<ScanItem> Scans);

public record ScanResult(
    string ClientScanId,
    int EntradaId,
    string Resultado
);

public interface IScannerService
{
    Task<int> RegisterDeviceAsync(int userId, RegisterDeviceRequest req);
    Task<List<ScanResult>> ProcessBatchAsync(int userId, SubmitBatchRequest req);
    Task<List<object>> GetRevocationsSinceAsync(DateTimeOffset since);
}

public class ScannerService(
    TicketingDb db,
    ILogger<ScannerService> logger) : IScannerService
{
    // POST /api/scanner/devices
    public async Task<int> RegisterDeviceAsync(int userId, RegisterDeviceRequest req)
    {
        var assigned = await db.AsignacionesStaff
            .AnyAsync(a => a.EventoId == req.EventoId && a.StaffId == userId);
        if (!assigned)
            throw new InvalidOperationException("Staff is not assigned to this event.");

        var doorBelongs = await db.Puertas
            .AnyAsync(p => p.Id == req.PuertaId && p.EventoId == req.EventoId);
        if (!doorBelongs)
            throw new InvalidOperationException("Door does not belong to this event.");

        var device = new DispositivoEscaner
        {
            UsuarioId = userId,
            EventoId = req.EventoId,
            PuertaId = req.PuertaId,
            RegistradoEn = DateTimeOffset.UtcNow,
            UltimaSync = null
        };

        db.DispositivosEscaner.Add(device);
        await db.SaveChangesAsync();

        logger.LogInformation("Scanner device {DeviceId} registered for user {UserId} at event {EventoId} door {PuertaId}",
            device.Id, userId, req.EventoId, req.PuertaId);

        return device.Id;
    }

    // POST /api/scanner/batches
    public async Task<List<ScanResult>> ProcessBatchAsync(int userId, SubmitBatchRequest req)
    {
        var device = await db.DispositivosEscaner
            .FirstOrDefaultAsync(d => d.Id == req.DeviceId);
        if (device is null)
            throw new InvalidOperationException("Device not found.");
        if (device.UsuarioId != userId)
            throw new UnauthorizedAccessException("Device does not belong to this user.");

        if (req.Scans.Count == 0)
            return new List<ScanResult>();

        var results = new List<ScanResult>(req.Scans.Count);
        var seenInBatch = new HashSet<int>();
        var now = DateTimeOffset.UtcNow;

        await using var tx = await db.Database.BeginTransactionAsync();

        foreach (var scan in req.Scans)
        {
            if (scan.EventoId != device.EventoId)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "wrong_event"));
                continue;
            }
            if (scan.PuertaId != device.PuertaId)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "wrong_zone"));
                continue;
            }

            if (!seenInBatch.Add(scan.EntradaId))
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "duplicate"));
                continue;
            }

            await db.Database.ExecuteSqlAsync(
                $"SELECT pg_advisory_xact_lock({scan.EntradaId})");

            var alreadyOk = await db.Ingresos
                .AnyAsync(i => i.EntradaId == scan.EntradaId && i.Resultado == "ok");

            var resultado = alreadyOk ? "duplicate" : "ok";

            var inserted = await db.Database.ExecuteSqlAsync($@"
                INSERT INTO ""Ingresos"" (""EntradaId"", ""EventoId"", ""PuertaId"", ""StaffId"", ""ClientScanId"", ""EscaneadoEn"", ""SincronizadoEn"", ""Resultado"")
                VALUES ({scan.EntradaId}, {scan.EventoId}, {scan.PuertaId}, {userId}, {scan.ClientScanId}, {scan.EscaneadoEn}, {now}, {resultado})
                ON CONFLICT (""ClientScanId"") DO NOTHING
            ");

            if (inserted == 0)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "duplicate"));
                continue;
            }

            if (resultado == "ok")
            {
                var entrada = await db.Entradas.FirstOrDefaultAsync(e => e.Id == scan.EntradaId);
                if (entrada is not null)
                {
                    entrada.Estado = "usada";
                }
            }

            results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, resultado));
        }

        device.UltimaSync = now;
        await db.SaveChangesAsync();
        await tx.CommitAsync();

        logger.LogInformation("Batch processed: {Count} scans, device {DeviceId}, user {UserId}",
            req.Scans.Count, device.Id, userId);

        return results;
    }

    public async Task<List<object>> GetRevocationsSinceAsync(DateTimeOffset since)
    {
        var revocations = await db.RevocacionesEntrada
            .Where(r => r.RevocadaEn > since)
            .OrderBy(r => r.RevocadaEn)
            .Select(r => new
            {
                r.EntradaId,
                r.RevocadaEn,
                r.Motivo
            })
            .ToListAsync();

        return revocations.Cast<object>().ToList();
    }
}