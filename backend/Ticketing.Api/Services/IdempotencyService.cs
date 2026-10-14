using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;

namespace Ticketing.Api.Services;

public record IdempotentResponse(int StatusCode, string Json)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static IdempotentResponse From(int statusCode, object body) =>
        new(statusCode, JsonSerializer.Serialize(body, JsonOptions));
}

public interface IIdempotencyService
{
    Task<IdempotentResponse> ExecuteAsync(
        int userId, string endpoint, string key, string bodyHash, Func<Task<IdempotentResponse>> action);
}

public class IdempotencyService(TicketingDb db) : IIdempotencyService
{
    public async Task<IdempotentResponse> ExecuteAsync(
        int userId, string endpoint, string key, string bodyHash, Func<Task<IdempotentResponse>> action)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        var now = DateTimeOffset.UtcNow;

        var inserted = await db.Database.ExecuteSqlInterpolatedAsync($@"
            INSERT INTO ""IdempotencyKeys"" (""UsuarioId"", ""Endpoint"", ""Clave"", ""HashCuerpo"", ""CreadaEn"")
            VALUES ({userId}, {endpoint}, {key}, {bodyHash}, {now})
            ON CONFLICT (""UsuarioId"", ""Endpoint"", ""Clave"") DO NOTHING");

        if (inserted == 0)
        {
            var previous = await db.IdempotencyKeys.AsNoTracking()
                .FirstAsync(k => k.UsuarioId == userId && k.Endpoint == endpoint && k.Clave == key);

            if (previous.HashCuerpo != bodyHash)
                return IdempotentResponse.From(422, new
                {
                    code = "IdempotencyKeyReused",
                    message = "This Idempotency-Key was already used with a different request."
                });

            return new IdempotentResponse(previous.StatusCode ?? 500, previous.Respuesta ?? "{}");
        }

        var response = await action();

        await db.IdempotencyKeys
            .Where(k => k.UsuarioId == userId && k.Endpoint == endpoint && k.Clave == key)
            .ExecuteUpdateAsync(s => s
                .SetProperty(k => k.StatusCode, response.StatusCode)
                .SetProperty(k => k.Respuesta, response.Json));

        await tx.CommitAsync();
        return response;
    }
}