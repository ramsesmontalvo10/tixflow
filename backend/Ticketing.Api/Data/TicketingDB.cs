using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Models;

namespace Ticketing.Api.Data;

public class TicketingDb(DbContextOptions<TicketingDb> options) : DbContext(options)
{
    public DbSet<Usuario> Usuarios => Set<Usuario>();
    public DbSet<Evento> Eventos => Set<Evento>();
    public DbSet<Zona> Zonas => Set<Zona>();
    public DbSet<FasePrecio> FasesPrecio => Set<FasePrecio>();
    public DbSet<Puerta> Puertas => Set<Puerta>();
    public DbSet<AsignacionStaff> AsignacionesStaff => Set<AsignacionStaff>();
    public DbSet<Reserva> Reservas => Set<Reserva>();
    public DbSet<Compra> Compras => Set<Compra>();
    public DbSet<Entrada> Entradas => Set<Entrada>();
    public DbSet<Transferencia> Transferencias => Set<Transferencia>();
    public DbSet<Ingreso> Ingresos => Set<Ingreso>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<IdempotencyKey> IdempotencyKeys => Set<IdempotencyKey>();
    public DbSet<RevocacionEntrada> RevocacionesEntrada => Set<RevocacionEntrada>();
    public DbSet<DispositivoEscaner> DispositivosEscaner => Set<DispositivoEscaner>();

    private static void Fk<TDep, TPrin>(ModelBuilder b, Expression<Func<TDep, object?>> fk)
        where TDep : class where TPrin : class =>
        b.Entity<TDep>().HasOne<TPrin>().WithMany().HasForeignKey(fk).OnDelete(DeleteBehavior.Restrict);

        protected override void OnModelCreating(ModelBuilder  b)
    {
        b.Entity<AsignacionStaff>().HasKey(a => new { a.EventoId, a.StaffId });
        b.Entity<IdempotencyKey>().HasKey(k => new { k.UsuarioId, k.Endpoint, k.Clave });
        b.Entity<RevocacionEntrada>().HasKey(r => r.EntradaId);
        b.Entity<DispositivoEscaner>().HasKey(d => d.Id);



        b.Entity<Usuario>().HasIndex(x => x.Email).IsUnique();
        b.Entity<Compra>().HasIndex(x => new { x.AsistenteId, x.IdempotencyKey }).IsUnique();
        b.Entity<Ingreso>().HasIndex(x => x.ClientScanId).IsUnique();
        b.Entity<RefreshToken>().HasIndex(x => x.TokenHash).IsUnique();


        b.Entity<Entrada>().HasIndex(x => new { x.ZonaId, x.Estado });
        b.Entity<Reserva>().HasIndex(x => new { x.ZonaId, x.Estado, x.ExpiraEn });
        b.Entity<Ingreso>().HasIndex(x => x.EntradaId);
        b.Entity<RefreshToken>().HasIndex(x => x.UsuarioId);
        b.Entity<RevocacionEntrada>().HasIndex(r => r.RevocadaEn);
        b.Entity<DispositivoEscaner>().HasIndex(d => new { d.EventoId, d.PuertaId });





        Fk<Evento, Usuario>(b, x => x.OrganizadorId);
        Fk<Zona, Evento>(b, x => x.EventoId);
        Fk<FasePrecio, Zona>(b, x => x.ZonaId);
        Fk<Puerta, Evento>(b, x => x.EventoId);
        Fk<AsignacionStaff, Evento>(b, x => x.EventoId);
        Fk<AsignacionStaff, Usuario>(b, x => x.StaffId);
        Fk<Reserva, Usuario>(b, x => x.AsistenteId);
        Fk<Reserva, Zona>(b, x => x.ZonaId);
        Fk<Compra, Usuario>(b, x => x.AsistenteId);
        Fk<Compra, Zona>(b, x => x.ZonaId);
        Fk<Compra, FasePrecio>(b, x => x.FasePrecioId);
        Fk<Entrada, Compra>(b, x => x.CompraId);
        Fk<Entrada, Zona>(b, x => x.ZonaId);
        Fk<Entrada, Usuario>(b, x => x.TitularId);
        Fk<Transferencia, Entrada>(b, x => x.EntradaId);
        Fk<Ingreso, Entrada>(b, x => x.EntradaId);
        Fk<Ingreso, Puerta>(b, x => x.PuertaId);
        Fk<Ingreso, Usuario>(b, x => x.StaffId);
        Fk<RefreshToken, Usuario>(b, x => x.UsuarioId);
        Fk<RevocacionEntrada, Entrada>(b, x => x.EntradaId);
        Fk<DispositivoEscaner, Usuario>(b, x => x.UsuarioId);
        Fk<DispositivoEscaner, Evento>(b, x => x.EventoId);
        Fk<DispositivoEscaner, Puerta>(b, x => x.PuertaId);

    }
}