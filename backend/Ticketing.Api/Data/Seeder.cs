using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Models;

namespace Ticketing.Api.Data;

record UsuarioSeed(int Id, string Nombre, string Email, string Password, string Rol,
    bool? Activo, int? OrganizadorId, DateTimeOffset? CreadoEn);

record SeedData(
    List<UsuarioSeed> UsuariosAdministrativos, List<UsuarioSeed> Organizadores,
    List<UsuarioSeed> Staff, List<UsuarioSeed> Asistentes,
    List<Evento> Eventos, List<Zona> Zonas, List<FasePrecio> FasesPrecio,
    List<Puerta> Puertas, List<AsignacionStaff> AsignacionesStaff,
    List<Reserva> Reservas, List<Compra> Compras, List<Entrada> Entradas,
    List<Transferencia> Transferencias, List<Ingreso> Ingresos);

public static class Seeder
{
    // Los ids de admin, organizadores y staff chocan con los de asistentes (1..600).
    private const int Offset = 10000;

    public static async Task RunAsync(TicketingDb  db, string path)
    {
        if (await db.Usuarios.AnyAsync()) return; // idempotente

        var json = await File.ReadAllTextAsync(path);
        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
        var d = JsonSerializer.Deserialize<SeedData>(json, opts)!;

        // Hash una sola vez por contraseña distinta (son datos de prueba)
        var hashes = new Dictionary<string, string>();
        string Hash(string pw) => hashes.TryGetValue(pw, out var h)
            ? h : hashes[pw] = BCrypt.Net.BCrypt.HashPassword(pw);

        Usuario ToUser(UsuarioSeed u, bool offset) => new()
        {
            Id = offset ? u.Id + Offset : u.Id,
            Nombre = u.Nombre, Email = u.Email, Rol = u.Rol,
            Activo = u.Activo ?? true,
            OrganizadorId = u.OrganizadorId is int o ? o + Offset : null,
            CreadoEn = u.CreadoEn ?? DateTimeOffset.UtcNow,
            PasswordHash = Hash(u.Password)
        };

        var usuarios = d.UsuariosAdministrativos.Select(u => ToUser(u, true))
            .Concat(d.Organizadores.Select(u => ToUser(u, true)))
            .Concat(d.Staff.Select(u => ToUser(u, true)))
            .Concat(d.Asistentes.Select(u => ToUser(u, false)));
        db.Usuarios.AddRange(usuarios);
        await db.SaveChangesAsync();

        foreach (var e in d.Eventos) e.OrganizadorId += Offset;
        db.Eventos.AddRange(d.Eventos);
        await db.SaveChangesAsync();

        db.Zonas.AddRange(d.Zonas);
        db.Puertas.AddRange(d.Puertas);
        await db.SaveChangesAsync();

        db.FasesPrecio.AddRange(d.FasesPrecio);
        foreach (var a in d.AsignacionesStaff) a.StaffId += Offset;
        db.AsignacionesStaff.AddRange(d.AsignacionesStaff);
        await db.SaveChangesAsync();

        db.Reservas.AddRange(d.Reservas);
        db.Compras.AddRange(d.Compras);
        await db.SaveChangesAsync();

        db.Entradas.AddRange(d.Entradas);
        await db.SaveChangesAsync();

        db.Transferencias.AddRange(d.Transferencias);
        foreach (var i in d.Ingresos) i.StaffId += Offset;
        db.Ingresos.AddRange(d.Ingresos);
        await db.SaveChangesAsync();

        // Como se insertaron ids explícitos, hay que mover las secuencias
        foreach (var t in new[] { "Usuarios", "Eventos", "Zonas", "FasesPrecio", "Puertas",
                                  "Reservas", "Compras", "Entradas", "Transferencias", "Ingresos" })
        {
            await db.Database.ExecuteSqlRawAsync(
                $"SELECT setval(pg_get_serial_sequence('\"{t}\"','Id'), COALESCE((SELECT MAX(\"Id\") FROM \"{t}\"),1))");
        }
    }
}