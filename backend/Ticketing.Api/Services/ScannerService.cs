using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;

namespace Ticketing.Api.Services;

public record RegisterDeviceRequest(int EventoId, int PuertaId);

public record StaffDoorDto(int Id, string Nombre);

public record StaffEventDto(
    int Id,
    string Nombre,
    DateTimeOffset Fecha,
    string Estado,
    List<StaffDoorDto> Puertas
);

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

public record RevocationDto(
    int EntradaId,
    DateTimeOffset RevocadaEn,
    string Motivo
);

public interface IScannerService
{
    Task<List<StaffEventDto>> GetAssignedEventsAsync(int userId);
    Task<int> RegisterDeviceAsync(int userId, RegisterDeviceRequest req);
    Task<List<ScanResult>> ProcessBatchAsync(int userId, SubmitBatchRequest req);
    Task<(DateTimeOffset SyncedAt, List<RevocationDto> Revocations)> GetRevocationsSinceAsync(
        int userId,
        int eventId,
        DateTimeOffset since);
}

public class ScannerService(
    TicketingDb db,
    ILogger<ScannerService> logger) : IScannerService
{
    public async Task<List<StaffEventDto>> GetAssignedEventsAsync(int userId)
    {
        var events = await (
            from assignment in db.AsignacionesStaff.AsNoTracking()
            join evento in db.Eventos.AsNoTracking() on assignment.EventoId equals evento.Id
            where assignment.StaffId == userId && evento.Estado != "finalizado"
            orderby evento.Fecha
            select new { evento.Id, evento.Nombre, evento.Fecha, evento.Estado }
        ).ToListAsync();

        if (events.Count == 0)
        {
            return [];
        }

        var eventIds = events.Select(e => e.Id).ToArray();
        var doors = await db.Puertas.AsNoTracking()
            .Where(door => eventIds.Contains(door.EventoId))
            .OrderBy(door => door.Id)
            .Select(door => new { door.Id, door.EventoId, door.Nombre })
            .ToListAsync();

        return events.Select(evento => new StaffEventDto(
            evento.Id,
            evento.Nombre,
            evento.Fecha,
            evento.Estado,
            doors.Where(door => door.EventoId == evento.Id)
                .Select(door => new StaffDoorDto(door.Id, door.Nombre))
                .ToList()
        )).ToList();
    }

    public async Task<int> RegisterDeviceAsync(int userId, RegisterDeviceRequest req)
    {
        var evento = await db.Eventos.AsNoTracking()
            .FirstOrDefaultAsync(e => e.Id == req.EventoId);
        if (evento is null)
        {
            throw new KeyNotFoundException("Event not found.");
        }

        var assigned = await db.AsignacionesStaff
            .AnyAsync(a => a.EventoId == req.EventoId && a.StaffId == userId);
        if (!assigned)
        {
            throw new UnauthorizedAccessException("Staff is not assigned to this event.");
        }

        if (evento.Estado == "finalizado")
        {
            throw new InvalidOperationException("Event has already finished.");
        }

        var doorBelongs = await db.Puertas
            .AnyAsync(p => p.Id == req.PuertaId && p.EventoId == req.EventoId);
        if (!doorBelongs)
        {
            throw new KeyNotFoundException("Door does not belong to this event.");
        }

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

        logger.LogInformation(
            "Scanner device {DeviceId} registered for user {UserId} at event {EventoId} door {PuertaId}",
            device.Id, userId, req.EventoId, req.PuertaId);

        return device.Id;
    }

    public async Task<List<ScanResult>> ProcessBatchAsync(int userId, SubmitBatchRequest req)
    {
        var device = await db.DispositivosEscaner
            .FirstOrDefaultAsync(d => d.Id == req.DeviceId);
        if (device is null)
        {
            throw new KeyNotFoundException("Device not found.");
        }
        if (device.UsuarioId != userId)
        {
            throw new UnauthorizedAccessException("Device does not belong to this user.");
        }

        var evento = await db.Eventos.AsNoTracking()
            .FirstOrDefaultAsync(e => e.Id == device.EventoId);
        if (evento is null)
        {
            throw new KeyNotFoundException("Device event not found.");
        }
        if (!await db.AsignacionesStaff.AnyAsync(
                a => a.EventoId == device.EventoId && a.StaffId == userId))
        {
            throw new UnauthorizedAccessException("Staff is no longer assigned to this event.");
        }
        if (evento.Estado == "finalizado")
        {
            throw new InvalidOperationException("Event has already finished.");
        }
        if (!await db.Puertas.AnyAsync(
                p => p.Id == device.PuertaId && p.EventoId == device.EventoId))
        {
            throw new KeyNotFoundException("Device door does not belong to its event.");
        }

        if (req.Scans.Count == 0)
        {
            return [];
        }

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
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "wrong_door"));
                continue;
            }

            var entrada = await db.Entradas
                .FirstOrDefaultAsync(e => e.Id == scan.EntradaId);
            if (entrada is null)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "ticket_not_found"));
                continue;
            }
            if (entrada.EventoId != device.EventoId)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "wrong_event"));
                continue;
            }

            if (!seenInBatch.Add(scan.EntradaId))
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "duplicate"));
                continue;
            }

            await db.Database.ExecuteSqlAsync(
                $"SELECT pg_advisory_xact_lock({scan.EntradaId})");

            await db.Entry(entrada).ReloadAsync();
            var isRevoked = await db.RevocacionesEntrada
                .AnyAsync(revocation => revocation.EntradaId == scan.EntradaId);
            if (isRevoked)
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "ticket_revoked"));
                continue;
            }

            var alreadyOk = await db.Ingresos
                .AnyAsync(i => i.EntradaId == scan.EntradaId && i.Resultado == "ok");
            var resultado = alreadyOk ? "duplicate" : "ok";

            if (!alreadyOk && entrada.Estado != "pagada")
            {
                results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, "ticket_not_usable"));
                continue;
            }

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
                entrada.Estado = "usada";
            }

            results.Add(new ScanResult(scan.ClientScanId, scan.EntradaId, resultado));
        }

        device.UltimaSync = now;
        await db.SaveChangesAsync();
        await tx.CommitAsync();

        logger.LogInformation(
            "Batch processed: {Count} scans, device {DeviceId}, user {UserId}",
            req.Scans.Count, device.Id, userId);

        return results;
    }

    public async Task<(DateTimeOffset SyncedAt, List<RevocationDto> Revocations)> GetRevocationsSinceAsync(
        int userId,
        int eventId,
        DateTimeOffset since)
    {
        var eventExists = await db.Eventos.AnyAsync(e => e.Id == eventId);
        if (!eventExists)
        {
            throw new KeyNotFoundException("Event not found.");
        }
        if (!await db.AsignacionesStaff.AnyAsync(
                a => a.EventoId == eventId && a.StaffId == userId))
        {
            throw new UnauthorizedAccessException("Staff is not assigned to this event.");
        }

        var syncedAt = DateTimeOffset.UtcNow;
        var revocations = await (
            from revocation in db.RevocacionesEntrada.AsNoTracking()
            join ticket in db.Entradas.AsNoTracking() on revocation.EntradaId equals ticket.Id
            where ticket.EventoId == eventId &&
                  revocation.RevocadaEn > since &&
                  revocation.RevocadaEn <= syncedAt
            orderby revocation.RevocadaEn
            select new RevocationDto(
                revocation.EntradaId,
                revocation.RevocadaEn,
                revocation.Motivo)
        ).ToListAsync();

        return (syncedAt, revocations);
    }
}
