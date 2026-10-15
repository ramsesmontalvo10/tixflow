import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Trend } from "k6/metrics";

// Ejecutar desde la raíz: k6 run .\load-test.js
// Antes, iniciar la API local permitiendo los 200 logins del setup:
//   $env:RateLimit__AuthPerMinute = "1000"
//   dotnet run --project .\backend\Ticketing.Api\Ticketing.Api.csproj --launch-profile http
// Requiere la BD recién sembrada, con las 50 entradas disponibles de la zona 8.
// Las reservas aceptadas quedan activas hasta que venza su plazo (10 minutos por defecto).
const BASE_URL = (__ENV.BASE_URL || "http://localhost:5248").replace(/\/$/, "");
const EVENT_ID = 4;
const ZONE_ID = 8;
const VUS = 200;
const EXPECTED_AVAILABLE = 50;
const PASSWORD = __ENV.K6_PASSWORD || "Asistente2026!";
const SEED = JSON.parse(open("./backend/Ticketing.Api/Data/seed.json"));

const event = SEED.eventos.find((item) => item.id === EVENT_ID);
const zone = SEED.zonas.find((item) => item.id === ZONE_ID);
const seededCase = SEED.meta.casos_borde.zona_ultimas_50;

if (
  !event ||
  !zone ||
  zone.evento_id !== EVENT_ID ||
  seededCase.evento_id !== EVENT_ID ||
  seededCase.zona_id !== ZONE_ID ||
  seededCase.restantes !== EXPECTED_AVAILABLE
) {
  throw new Error("Los IDs o el aforo configurados no coinciden con el caso del seed.");
}

const ticketOwners = new Set();
for (const ticket of SEED.entradas) {
  if (ticket.evento_id === EVENT_ID) {
    ticketOwners.add(ticket.comprador_id);
    ticketOwners.add(ticket.titular_id);
  }
}

const users = SEED.asistentes.filter(
  (assistant) => !ticketOwners.has(assistant.id),
).slice(0, VUS);

if (users.length !== VUS) {
  throw new Error(`Se necesitan ${VUS} asistentes sin entradas en el evento ${EVENT_ID}.`);
}

const reservationsCreated = new Counter("reservations_created");
const capacityConflicts = new Counter("capacity_conflicts");
const unexpectedResponses = new Counter("unexpected_responses");
const reservationDuration = new Trend("reservation_duration", true);

export const options = {
  batch: VUS,
  batchPerHost: VUS,
  setupTimeout: "2m",
  scenarios: {
    last_tickets_competition: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "2m",
    },
  },
  thresholds: {
    reservations_created: [`count==${EXPECTED_AVAILABLE}`],
    capacity_conflicts: [`count==${VUS - EXPECTED_AVAILABLE}`],
    unexpected_responses: ["count==0"],
  },
};

export function setup() {
  const loginRequests = users.map((assistant) => ({
    method: "POST",
    url: `${BASE_URL}/api/auth/login`,
    body: JSON.stringify({
      email: assistant.email,
      password: PASSWORD,
    }),
    params: {
      headers: { "Content-Type": "application/json" },
      tags: { operation: "login" },
    },
  }));

  const loginResponses = http.batch(loginRequests);
  const tokens = loginResponses.map((response, index) => {
    if (response.status !== 200) {
      fail(
        `No se pudo iniciar sesión como ${users[index].email} (HTTP ${response.status}). ` +
          "Aumenta RateLimit__AuthPerMinute en el backend local y vuelve a ejecutar.",
      );
    }

    const token = response.json("accessToken");
    if (!token) {
      fail(`El login de ${users[index].email} no devolvió accessToken.`);
    }
    return token;
  });

  return { tokens };
}

export default function (data) {
  const token = data.tokens[__VU - 1];
  const response = http.post(
    `${BASE_URL}/api/reservas`,
    JSON.stringify({ zonaId: ZONE_ID, cantidad: 1 }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `k6-event-${EVENT_ID}-vu-${__VU}`,
      },
      tags: { operation: "reservation" },
    },
  );

  reservationDuration.add(response.timings.duration, { operation: "reservation" });

  let errorCode;
  if (response.status !== 201) {
    try {
      errorCode = response.json("code");
    } catch (_) {
      errorCode = undefined;
    }
  }

  if (response.status === 201) {
    reservationsCreated.add(1);
  } else if (response.status === 409 && errorCode === "CapacityExceeded") {
    capacityConflicts.add(1);
  } else {
    unexpectedResponses.add(1);
  }

  check(response, {
    "reserva creada o rechazada por falta de cupo": (res) =>
      res.status === 201 ||
      (res.status === 409 && errorCode === "CapacityExceeded"),
  });
}
