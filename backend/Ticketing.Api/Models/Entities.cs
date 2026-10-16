namespace Ticketing.Api.Models;

public class Usuario
{
    public int Id { get; set; }
    public string Nombre { get; set; } = "";
    public string Email { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string Rol { get; set; } = "";
    public bool Activo { get; set; } = true;
    public int? OrganizadorId { get; set; }
    public DateTimeOffset CreadoEn { get; set; }
}

public class Evento
{
    public int Id { get; set; }
    public string Codigo { get; set; } = "";
    public string Nombre { get; set; } = "";
    public int OrganizadorId { get; set; }
    public DateTimeOffset Fecha { get; set; }
    public DateTimeOffset VentaAbre { get; set; }
    public int LimitePorCuenta { get; set; }
    public string Estado { get; set; } = "";
    public DateTimeOffset ReembolsableHasta { get; set; }
    public string Recinto { get; set; } = "";
}

public class Zona
{
    public int Id { get; set; }
    public int EventoId { get; set; }
    public string Nombre { get; set; } = "";
    public int Aforo { get; set; }
}

public class FasePrecio
{
    public int Id { get; set; }
    public int ZonaId { get; set; }
    public string Fase { get; set; } = "";
    public long PrecioCentesimos { get; set; }
    public DateTimeOffset Desde { get; set; }
    public DateTimeOffset Hasta { get; set; }
}

public class Puerta
{
    public int Id { get; set; }
    public int EventoId { get; set; }
    public string Nombre { get; set; } = "";
}

public class AsignacionStaff
{
    public int EventoId { get; set; }
    public int StaffId { get; set; }
}

public class Reserva
{
    public int Id { get; set; }
    public int AsistenteId { get; set; }
    public int ZonaId { get; set; }
    public int Cantidad { get; set; }
    public DateTimeOffset CreadaEn { get; set; }
    public DateTimeOffset ExpiraEn { get; set; }
    public string Estado { get; set; } = "activa";
    public int? FasePrecioId { get; set; }
    public long? PrecioUnitarioCentesimos { get; set; }
}

public class Compra
{
    public int Id { get; set; }
    public int AsistenteId { get; set; }
    public int EventoId { get; set; }
    public int ZonaId { get; set; }
    public int FasePrecioId { get; set; }
    public int Cantidad { get; set; }
    public long PrecioUnitarioCentesimos { get; set; }
    public long MontoCentesimos { get; set; }
    public string IdempotencyKey { get; set; } = "";
    public string Estado { get; set; } = "";
    public DateTimeOffset? PagadaEn { get; set; }
    public DateTimeOffset? ReembolsadaEn { get; set; }
}

public class Entrada
{
    public int Id { get; set; }
    public int CompraId { get; set; }
    public int EventoId { get; set; }
    public int ZonaId { get; set; }
    public int TitularId { get; set; }
    public int CompradorId { get; set; }
    public string Estado { get; set; } = "";
    public DateTimeOffset EmitidaEn { get; set; }
    public int Version { get; set; } = 1;
}

public class Transferencia
{
    public int Id { get; set; }
    public int EntradaId { get; set; }
    public int DeUsuarioId { get; set; }
    public int AUsuarioId { get; set; }
    public string Estado { get; set; } = "";
    public DateTimeOffset CreadaEn { get; set; }
    public DateTimeOffset? ResueltaEn { get; set; }
}

public class Ingreso
{
    public int Id { get; set; }
    public int EntradaId { get; set; }
    public int EventoId { get; set; }
    public int PuertaId { get; set; }
    public int StaffId { get; set; }
    public string ClientScanId { get; set; } = "";
    public DateTimeOffset EscaneadoEn { get; set; }
    public DateTimeOffset? SincronizadoEn { get; set; }
    public string Resultado { get; set; } = "";
}

public class RefreshToken
{
    public Guid Id { get; set; }
    public int UsuarioId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTimeOffset CreadoEn { get; set; }
    public DateTimeOffset ExpiraEn { get; set; }
    public DateTimeOffset? RevocadoEn { get; set; }
    public Guid? ReemplazadoPorId { get; set; }
}

public class IdempotencyKey
{
    public int UsuarioId { get; set; }
    public string Endpoint { get; set; } = "";
    public string Clave { get; set; } = "";
    public string HashCuerpo { get; set; } = "";
    public int? StatusCode { get; set; }
    public string? Respuesta { get; set; }
    public DateTimeOffset CreadaEn { get; set; }
}

public class RevocacionEntrada
{
    public int EntradaId { get; set; }
    public DateTimeOffset RevocadaEn { get; set; }
    public string Motivo { get; set; } = ""; 
}

public class DispositivoEscaner
{
    public int Id { get; set; }
    public int UsuarioId { get; set; }
    public int EventoId { get; set; }
    public int PuertaId { get; set; }
    public DateTimeOffset RegistradoEn { get; set; }
    public DateTimeOffset? UltimaSync { get; set; }
}

public class AuditoriaAdministrativa
{
    public int Id { get; set; }
    public int EventoId { get; set; }
    public string TicketId { get; set; } = "";
    public string Accion { get; set; } = "";
    public string Motivo { get; set; } = "";
    public string Autor { get; set; } = "";
    public DateTime Fecha { get; set; } = DateTime.UtcNow;
}
