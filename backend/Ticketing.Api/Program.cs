using System.Security.Claims;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Ticketing.Api.Data;
using Ticketing.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// ---------- Servicios ----------
builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddProblemDetails(); 

builder.Services.AddDbContext<TicketingDb>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddScoped<IReservationService, ReservationService>();

// ---------- Autenticación (JWT) ----------
var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || jwtKey.Length < 32)
    throw new InvalidOperationException("Falta Jwt:Key (mínimo 32 caracteres)");

builder.Services.AddSingleton<TokenService>();
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o => o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidateAudience = true,
        ValidAudience = builder.Configuration["Jwt:Audience"],
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
        ValidateLifetime = true,
        ClockSkew = TimeSpan.FromSeconds(30),
        RoleClaimType = ClaimTypes.Role,
        NameClaimType = ClaimTypes.Name
    });
builder.Services.AddAuthorization();

// ---------- Límite de peticiones ----------
var authLimit = builder.Configuration.GetValue("RateLimit:AuthPerMinute", 20);
var purchaseLimit = builder.Configuration.GetValue("RateLimit:PurchasePerMinute", 60);

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    o.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = authLimit, Window = TimeSpan.FromMinutes(1) }));

    o.AddPolicy("purchase", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = purchaseLimit, Window = TimeSpan.FromMinutes(1) }));
});

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<TicketingDb>();
    await db.Database.MigrateAsync();
    await Seeder.RunAsync(db, Path.Combine(AppContext.BaseDirectory, "Data", "seed.json"));
}

app.UseExceptionHandler();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseAuthentication();   
app.UseRateLimiter();      
app.UseAuthorization();    
app.MapControllers();

app.Run();