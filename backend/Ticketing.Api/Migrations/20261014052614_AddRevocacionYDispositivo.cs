using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Ticketing.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddRevocacionYDispositivo : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DispositivosEscaner",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UsuarioId = table.Column<int>(type: "integer", nullable: false),
                    EventoId = table.Column<int>(type: "integer", nullable: false),
                    PuertaId = table.Column<int>(type: "integer", nullable: false),
                    RegistradoEn = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UltimaSync = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DispositivosEscaner", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DispositivosEscaner_Eventos_EventoId",
                        column: x => x.EventoId,
                        principalTable: "Eventos",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DispositivosEscaner_Puertas_PuertaId",
                        column: x => x.PuertaId,
                        principalTable: "Puertas",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DispositivosEscaner_Usuarios_UsuarioId",
                        column: x => x.UsuarioId,
                        principalTable: "Usuarios",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "RevocacionesEntrada",
                columns: table => new
                {
                    EntradaId = table.Column<int>(type: "integer", nullable: false),
                    RevocadaEn = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Motivo = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RevocacionesEntrada", x => x.EntradaId);
                    table.ForeignKey(
                        name: "FK_RevocacionesEntrada_Entradas_EntradaId",
                        column: x => x.EntradaId,
                        principalTable: "Entradas",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DispositivosEscaner_EventoId_PuertaId",
                table: "DispositivosEscaner",
                columns: new[] { "EventoId", "PuertaId" });

            migrationBuilder.CreateIndex(
                name: "IX_DispositivosEscaner_PuertaId",
                table: "DispositivosEscaner",
                column: "PuertaId");

            migrationBuilder.CreateIndex(
                name: "IX_DispositivosEscaner_UsuarioId",
                table: "DispositivosEscaner",
                column: "UsuarioId");

            migrationBuilder.CreateIndex(
                name: "IX_RevocacionesEntrada_RevocadaEn",
                table: "RevocacionesEntrada",
                column: "RevocadaEn");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DispositivosEscaner");

            migrationBuilder.DropTable(
                name: "RevocacionesEntrada");
        }
    }
}
