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

public class RegisterDto
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

public class RefreshDto 
{ 
    [Required] public string RefreshToken { get; set; } = ""; 
}

public record AuthResponse(
    string AccessToken, 
    DateTimeOffset AccessExpiresAt,
    string RefreshToken, 
    int UsuarioId, 
    string Rol
);

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("auth")]
public class AuthController(TicketingDb db, TokenService tokens, IConfiguration cfg) : ControllerBase
{
    private static readonly string FakeHash = BCrypt.Net.BCrypt.HashPassword("fake-password");

    [HttpPost("register")]
    public async Task<IActionResult> Register(RegisterDto dto)
    {
        var email = dto.Email.Trim().ToLowerInvariant();
        if (await db.Usuarios.AnyAsync(u => u.Email == email))
            return Conflict(new { error = "El email ya está registrado" });

        var user = new Usuario
        {
            Nombre = dto.Nombre.Trim(), 
            Email = email, 
            Rol = "asistente",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password),
            CreadoEn = DateTimeOffset.UtcNow
        };
        db.Usuarios.Add(user);
        try 
        { 
            await db.SaveChangesAsync(); 
        }
        catch (DbUpdateException) 
        { 
            return Conflict(new { error = "El email ya está registrado" }); 
        }

        return StatusCode(201, await IssueTokensAsync(user));
    }

    [HttpPost("login")]
    public async Task<IActionResult> Login(LoginDto dto)
    {
        var email = dto.Email.Trim().ToLowerInvariant();
        var user = await db.Usuarios.FirstOrDefaultAsync(x => x.Email == email);
        var isValid = BCrypt.Net.BCrypt.Verify(dto.Password, user?.PasswordHash ?? FakeHash);
        if (user is null || !isValid || !user.Activo) return InvalidCredentials();
        return Ok(await IssueTokensAsync(user));
    }

    [HttpPost("refresh")]
    public async Task<IActionResult> Refresh(RefreshDto dto)
    {
        var hash = TokenService.Hash(dto.RefreshToken);
        var refreshTokenRecord = await db.RefreshTokens.FirstOrDefaultAsync(x => x.TokenHash == hash);
        if (refreshTokenRecord is null) return InvalidCredentials();

        var now = DateTimeOffset.UtcNow;
        if (refreshTokenRecord.RevocadoEn is null && refreshTokenRecord.ExpiraEn <= now) return InvalidCredentials();

        var rowsAffected = refreshTokenRecord.RevocadoEn is null
            ? await db.RefreshTokens.Where(x => x.Id == refreshTokenRecord.Id && x.RevocadoEn == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevocadoEn, now))
            : 0;

        if (rowsAffected == 0)
        {
            await db.RefreshTokens.Where(x => x.UsuarioId == refreshTokenRecord.UsuarioId && x.RevocadoEn == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevocadoEn, now));
            return InvalidCredentials();
        }

        var user = await db.Usuarios.FindAsync(refreshTokenRecord.UsuarioId);
        if (user is null || !user.Activo) return InvalidCredentials();
        return Ok(await IssueTokensAsync(user, refreshTokenRecord.Id));
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

    private IActionResult InvalidCredentials() => Unauthorized(new { error = "Credenciales inválidas" });

    private async Task<AuthResponse> IssueTokensAsync(Usuario user, Guid? replaceId = null)
    {
        var (access, expiresAt) = tokens.CreateAccessToken(user);
        var refresh = TokenService.GenerateRefreshToken();
        var now = DateTimeOffset.UtcNow;

        var newToken = new RefreshToken
        {
            Id = Guid.NewGuid(), 
            UsuarioId = user.Id, 
            TokenHash = TokenService.Hash(refresh),
            CreadoEn = now, 
            ExpiraEn = now.AddDays(cfg.GetValue("Jwt:RefreshDays", 7))
        };
        db.RefreshTokens.Add(newToken);
        await db.SaveChangesAsync();

        if (replaceId is Guid oldId)
            await db.RefreshTokens.Where(x => x.Id == oldId)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ReemplazadoPorId, newToken.Id));

        return new AuthResponse(access, expiresAt, refresh, user.Id, user.Rol);
    }
}