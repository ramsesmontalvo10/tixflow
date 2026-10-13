using Microsoft.EntityFrameworkCore;
using Ticketing.Api.Data;
var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();
builder.Services.AddDbContext<TicketingDb>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));
var app = builder.Build();
 using(var scope = app.Services.CreateScope())
 {
    var db =scope.ServiceProvider.GetRequiredService<TicketingDb>();
    await db.Database.MigrateAsync();
    await Seeder.RunAsync(db, Path.Combine(AppContext.BaseDirectory, "Data", "seed.json"));
    
 }

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

app.UseAuthorization();

app.MapControllers();

app.Run();
