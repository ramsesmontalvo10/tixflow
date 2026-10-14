using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;

namespace Ticketing.Api.Services;

public class ReservationExpiryService(
    IServiceScopeFactory scopes,
    ILogger<ReservationExpiryService> logger,
    IConfiguration cfg) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var seconds = cfg.GetValue("Reservations:ExpirySweepSeconds", 30);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(seconds));

        try
        {
            await SweepAsync(stoppingToken); 
            while (await timer.WaitForNextTickAsync(stoppingToken))
                await SweepAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<TicketingDb>();
            var now = DateTimeOffset.UtcNow;

            var expired = await db.Reservas
                .Where(r => r.Estado == "activa" && r.ExpiraEn <= now)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.Estado, "expirada"), ct);

            if (expired > 0) logger.LogInformation("Expired {Count} reservations", expired);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error while expiring reservations");
        }
    }
}