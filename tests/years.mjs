import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { admin, basic } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port === "8137")
  throw Error("Einen isolierten lokalen Prüfstack verwenden.");

async function login(authorization) {
  const res = await fetch(new URL("/api/login", url), {
    method: "POST",
    headers: { Authorization: authorization },
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}
async function api(path, cookie, body, expected = 200, eventID) {
  const res = await fetch(new URL("/api/" + path, url), {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      ...(eventID ? { "X-Bonfire-Event": eventID } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await res.text();
  assert.equal(res.status, expected, result.slice(0, 150));
  return expected === 200 ? JSON.parse(result) : undefined;
}
const manager = await login(admin);
const y = await api("years", manager, {
  Name: "2026",
  Starts: "2026-01-01",
  Ends: "2026-10-31",
});
const next = await api("years", manager, {
  Name: "2027",
  Starts: "2026-11-01",
  Ends: "2027-12-31",
});
await api(
  "years",
  manager,
  {
    Name: "Überschneidung",
    Starts: "2026-10-31",
    Ends: "2026-11-01",
  },
  409,
);
await api(
  "years",
  manager,
  {
    Name: "2027",
    Starts: "2028-01-01",
    Ends: "2028-06-30",
  },
  409,
);
const ledgers = await api("events?year=" + y.ID, manager);
assert.equal(ledgers.length, 1);
assert.equal(ledgers[0].General, true);
assert.equal(ledgers[0].Starts, y.Starts);
assert.equal(ledgers[0].Ends, y.Ends);
const festival = { Name: "Fiktives Herbstfest", Starts: y.Ends, Ends: y.Ends };
const event = await api("events", manager, { ...festival, Year: y.ID });
assert.equal(event.Year, y.ID);
await api(
  "events",
  manager,
  { ...festival, Ends: next.Starts, Year: y.ID },
  422,
);
const nextEvent = await api("events", manager, {
  ...festival,
  Starts: next.Starts,
  Ends: next.Starts,
  Year: next.ID,
});
assert.deepEqual(
  new Set((await api("events?year=" + y.ID, manager)).map((e) => e.ID)),
  new Set([event.ID, ledgers[0].ID]),
);
const reader = "kasse-" + randomUUID().slice(0, 8),
  password = randomUUID();
await api("users", manager, {
  Name: reader,
  Password: password,
  Role: "Write",
  Event: event.ID,
});
const cashier = await login(basic(reader, password));
assert.deepEqual(
  (await api("years", cashier)).map((v) => v.ID),
  [y.ID],
);
assert.deepEqual(await api("events?year=" + next.ID, cashier), []);
await api("years", cashier, {}, 403);
await api("years/assign", cashier, { Year: next.ID, Event: nextEvent.ID }, 403);
await api("years/assign", manager, { Year: next.ID, Event: event.ID }, 409);
for (const day of [y.Starts, y.Ends, next.Starts]) {
  const op = {
    ID: randomUUID(),
    Target: randomUUID(),
    Kind: "income",
    Data: { Label: "Übungsbuchung", Date: day, Amount: 500 },
  };
  await api(
    "online?event=" + ledgers[0].ID,
    manager,
    { Ops: [op] },
    day === next.Starts ? 422 : 200,
  );
}
const mode = await api("mode", manager);
if (!mode.offline) await api("events", manager, festival, 422);
const legacyID = mode.offline
  ? (await api("events", manager, festival)).ID
  : process.env.BONFIRE_YEAR_FIXTURE_ID;
if (legacyID) {
  await api("years/assign", manager, { Year: next.ID, Event: legacyID }, 422);
  await api("years/assign", manager, { Year: y.ID, Event: legacyID });
  await api("years/assign", manager, { Year: y.ID, Event: legacyID });
  assert.ok(
    (await api("events?year=" + y.ID, manager)).some((e) => e.ID === legacyID),
  );
}
const [nextLedger] = await api("events?year=" + next.ID, manager);
const booking = (Kind, Label, extra) => ({
  ID: randomUUID(),
  Target: randomUUID(),
  Kind,
  Data: { Date: next.Starts, Label, ...extra },
});
const period = booking("period", "Testabschluss", { To: next.Ends });
await api("online?event=" + nextLedger.ID, manager, {
  Ops: [
    booking("opening", "Anfang", { Amount: 100 }),
    booking("income", "Buchung Folgejahr", { Amount: 20 }),
    booking("actual", "Bestandszählung", { Amount: 120 }),
    period,
  ],
});
for (const Action of ["period", "journal-period"]) {
  const report = await api(
    "manage",
    manager,
    { Action, Target: y.Starts, Reason: next.Ends },
    200,
    ledgers[0].ID,
  );
  assert.equal(
    report.filter((r) => r.bezeichnung === "Übungsbuchung").length,
    2,
  );
  assert.ok(!report.some((r) => r.bezeichnung === "Buchung Folgejahr"));
}
const reviewer = "pruefung-" + randomUUID().slice(0, 8);
await api("users", manager, {
  Name: reviewer,
  Password: password,
  Role: "Read",
  Event: nextLedger.ID,
});
await api("access", manager, {
  Action: "grant",
  Name: reviewer,
  Event: nextEvent.ID,
  Reason: "Fiktive Jahresprüfung",
});
const review = await login(basic(reviewer, password));
await api(
  "manage",
  review,
  { Action: "period-close", Target: period.Target },
  403,
  nextLedger.ID,
);
await api(
  "manage",
  manager,
  { Action: "period-close", Target: period.Target },
  200,
  nextLedger.ID,
);
await api(
  "events",
  manager,
  { ...festival, Year: next.ID, Starts: next.Starts, Ends: next.Ends },
  409,
);
await api(
  "online?event=" + nextEvent.ID,
  manager,
  { Ops: [booking("income", "Nach Abschluss", { Amount: 10 })] },
  409,
);
console.log(
  "PASS Freie Geschäftsjahre 2026/2027, allgemeine Kassenbücher, Jahreswechsel, Geldbuchungen an beiden Grenzen, Veranstaltungsfilter, Zugriffsrechte, Jahresauswertung und Abschluss mit Schreibschutz.",
);
