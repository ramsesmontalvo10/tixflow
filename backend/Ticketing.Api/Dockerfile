FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY Ticketing.Api.csproj ./
RUN dotnet restore Ticketing.Api.csproj

COPY . ./
RUN dotnet publish Ticketing.Api.csproj -c Release -o /app/out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS production
WORKDIR /app
COPY --from=build /app/out ./
RUN mkdir -p /app/data && chown -R "$APP_UID:$APP_UID" /app

ENV ASPNETCORE_URLS=http://+:5248
EXPOSE 5248
USER $APP_UID
ENTRYPOINT ["dotnet", "Ticketing.Api.dll"]
