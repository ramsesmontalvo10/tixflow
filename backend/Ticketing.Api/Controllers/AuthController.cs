using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
using Ticketing.Api.Models;
using Ticketing.Api.Services;

namespace Ticketing.Api.Controllers;

public class RegistroDto
{
    [Required, StringLength(100, MinimumLength = 2)] public string Nombre { get; set; } = "";
    [Required, EmailAddress, StringLength(200)] public string Email { get; set; } = "";
    [Required, StringLength(100, MinimumLength = 8)] public string Password { get; set; } = "";
}
public class LoginDto
{
    [Required] public string Email { get; set; } = "";
    [Required] public string Password { get; set; } = "";
}
public class RefreshDto { [Required] public string RefreshToken { get; set; } = ""; }

public record AuthRespuesta(string AccessToken, DateTimeOffset AccessExpiraEn,
    string RefreshToken, int UsuarioId, string Rol);

[ApiController]
[Route("auth")]
[EnableRateLimiting("auth")]
public class AuthController(TicketingDb db, TokenService tokens, IConfiguration cfg) : ControllerBase
{
    private static readonly string HashFalso = BCrypt.Net.BCrypt.HashPassword("contrasena-falsa");

    [HttpPost("registro")]
    public async Task<IActionResult> Registro(RegistroDto dto)
    {
        var email = dto.Email.Trim().ToLowerInvariant();
        if (await db.Usuarios.AnyAsync(u => u.Email == email))
            return Conflict(new { error = "El email ya está registrado" });

        var u = new Usuario
        {
            Nombre = dto.Nombre.Trim(), Email = email, Rol = "asistente",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password),
            CreadoEn = DateTimeOffset.UtcNow
        };
        db.Usuarios.Add(u);
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException) 
        { return Conflict(new { error = "El email ya está registrado" }); }

        return StatusCode(201, await EmitirAsync(u));
    }

    [HttpPost("login")]
    public async Task<IActionResult> Login(LoginDto dto)
    {
        var email = dto.Email.Trim().ToLowerInvariant();
        var u = await db.Usuarios.FirstOrDefaultAsync(x => x.Email == email);
        var ok = BCrypt.Net.BCrypt.Verify(dto.Password, u?.PasswordHash ?? HashFalso);
        if (u is null || !ok || !u.Activo) return Invalido();
        return Ok(await EmitirAsync(u));
    }

    [HttpPost("refresh")]
    public async Task<IActionResult> Refresh(RefreshDto dto)
    {
        var hash = TokenService.Hash(dto.RefreshToken);
        var rt = await db.RefreshTokens.FirstOrDefaultAsync(x => x.TokenHash == hash);
        if (rt is null) return Invalido();

        var ahora = DateTimeOffset.UtcNow;
        if (rt.RevocadoEn is null && rt.ExpiraEn <= ahora) return Invalido();

        var filas = rt.RevocadoEn is null
            ? await db.RefreshTokens.Where(x => x.Id == rt.Id && x.RevocadoEn == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevocadoEn, ahora))
            : 0;

        if (filas == 0)
        {
            await db.RefreshTokens.Where(x => x.UsuarioId == rt.UsuarioId && x.RevocadoEn == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevocadoEn, ahora));
            return Invalido();
        }

        var u = await db.Usuarios.FindAsync(rt.UsuarioId);
        if (u is null || !u.Activo) return Invalido();
        return Ok(await EmitirAsync(u, rt.Id));
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout(RefreshDto dto)
    {
        var hash = TokenService.Hash(dto.RefreshToken);
        await db.RefreshTokens.Where(x => x.TokenHash == hash && x.RevocadoEn == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevocadoEn, DateTimeOffset.UtcNow));
        return NoContent();
    }

    [Authorize]
    [HttpGet("me")]
    public IActionResult Me() => Ok(new
    {
        id = User.FindFirstValue(ClaimTypes.NameIdentifier),
        email = User.FindFirstValue(ClaimTypes.Email),
        rol = User.FindFirstValue(ClaimTypes.Role)
    });

    private IActionResult Invalido() => Unauthorized(new { error = "Credenciales inválidas" });

    private async Task<AuthRespuesta> EmitirAsync(Usuario u, Guid? reemplaza = null)
    {
        var (access, expira) = tokens.CrearAccessToken(u);
        var refresh = TokenService.NuevoRefreshToken();
        var ahora = DateTimeOffset.UtcNow;

        var nuevo = new RefreshToken
        {
            Id = Guid.NewGuid(), UsuarioId = u.Id, TokenHash = TokenService.Hash(refresh),
            CreadoEn = ahora, ExpiraEn = ahora.AddDays(cfg.GetValue("Jwt:RefreshDays", 7))
        };
        db.RefreshTokens.Add(nuevo);
        await db.SaveChangesAsync();

        if (reemplaza is Guid viejo)
            await db.RefreshTokens.Where(x => x.Id == viejo)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ReemplazadoPorId, nuevo.Id));

        return new AuthRespuesta(access, expira, refresh, u.Id, u.Rol);
    }
}