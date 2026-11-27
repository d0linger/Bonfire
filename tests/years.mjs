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
  CurrentPassword: process.env.BONFIRE_ADMIN_PASSWORD,
  Name: reader,
  Password: password,
  Role: "Write",
  Event: event.ID,
});
const cashier = await login(basic(reader, password));
const details = ({ Name, Starts, Ends }) => ({ Name, Starts, Ends });
const editYear = (Updated, status, Previous = details(y), cookie = manager) =>
  api("years/edit", cookie, { Year: y.ID, Previous, Updated }, status);
const renamed = {
  ...details(y),
  Name: "Fiktives Rumpfjahr",
  Starts: "2025-12-31",
};
await editYear(renamed, 403, details(y), cashier);
await editYear({ ...details(y), Name: next.Name }, 409);
await editYear({ ...details(y), Ends: next.Starts }, 409);
await editYear({ ...details(y), Ends: "2026-10-30" }, 409);
await editYear({ ...details(y), Starts: "2027-01-01" }, 422);
await editYear(renamed, 200);
await editYear(renamed, 200);
await editYear({ ...renamed, Name: "Veralteter Stand" }, 409);
const editedLedger = (await api("events?year=" + y.ID, manager)).find(
  (e) => e.General,
);
assert.deepEqual(
  [editedLedger.ID, editedLedger.Starts, editedLedger.Ends],
  [ledgers[0].ID, renamed.Starts, renamed.Ends],
);
await editYear(details(y), 200, renamed);
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
await editYear({ ...details(y), Starts: "2026-01-02" }, 409);
assert.deepEqual(
  details((await api("years", manager)).find((v) => v.ID === y.ID)),
  details(y),
);
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
await api(
  "years/edit",
  manager,
  {
    Year: next.ID,
    Previous: details(next),
    Updated: { ...details(next), Ends: "2027-12-30" },
  },
  409,
);
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
  CurrentPassword: process.env.BONFIRE_ADMIN_PASSWORD,
  Name: reviewer,
  Password: password,
  Role: "Read",
  Event: nextLedger.ID,
});
await api("access", manager, {
  CurrentPassword: process.env.BONFIRE_ADMIN_PASSWORD,
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
const following = await api("years", manager, {
  Name: "2028",
  Starts: "2028-01-01",
  Ends: "2028-12-31",
});
const [dest] = await api("events?year=" + following.ID, manager);
const sources = await api(
  "manage",
  manager,
  { Action: "year-carry" },
  200,
  dest.ID,
);
assert.equal(sources.length, 1);
assert.equal(sources[0].Source, nextLedger.ID);
assert.equal(sources[0].Amount, 120);
assert.ok(sources[0].Period);
const take = {
  Action: "year-carry",
  Target: nextLedger.ID,
  Stamp: sources[0].Stamp,
};
await api("manage", manager, { ...take, Stamp: "outdated" }, 422, dest.ID);
await api(
  "manage",
  manager,
  { ...take, AccountMap: { "": "geändertes Konto" } },
  422,
  dest.ID,
);
await api("manage", manager, take, 200, dest.ID);
const firstCarry = (await api("online?event=" + dest.ID, manager, {})).entries.filter((r) => r.Kind === "opening");
assert.equal(firstCarry.length, 1);
assert.equal(firstCarry[0].Data.Amount, 120);
await api("manage", manager, take, 200, dest.ID);
const imported = (
  await api("online?event=" + dest.ID, manager, {})
).entries.filter((r) => r.Kind === "opening");
assert.equal(imported.length, 1);
assert.equal(imported[0].ID, firstCarry[0].ID);
assert.equal(imported[0].Revision, firstCarry[0].Revision);
assert.equal(imported[0].Data.Amount, 120);
assert.equal(imported[0].Data.Fields.yearSource, nextLedger.ID);
await api("manage", cashier, { Action: "year-carry" }, 403, event.ID);
const createFest = (Year, Name, date) =>
  api("events", manager, {
    Year,
    Name,
    Starts: date,
    Ends: date,
    Accounts: true,
  });
const sourceFest = await createFest(
  following.ID,
  "Musterfest Vorjahr",
  following.Starts,
);
const later = await api("years", manager, {
  Name: "2029",
  Starts: "2029-01-01",
  Ends: "2029-12-31",
});
const destFest = await createFest(
  later.ID,
  "Musterfest Folgejahr",
  later.Starts,
);
const sourceAccount = randomUUID(),
  destAccount = randomUUID();
const line = (event, Kind, Target, extra) => ({
  ID: randomUUID(),
  Kind,
  Target,
  Data: { Label: "Musterkassa", Date: event.Starts, ...extra },
});
await api("online?event=" + sourceFest.ID, manager, {
  Ops: [
    line(sourceFest, "account", sourceAccount, {}),
    line(sourceFest, "opening", randomUUID(), {
      Amount: 0,
      Account: sourceAccount,
    }),
    line(sourceFest, "actual", randomUUID(), {
      Amount: 0,
      Account: sourceAccount,
    }),
  ],
  Action: "Abschluss",
});
await api("online?event=" + destFest.ID, manager, {
  Ops: [line(destFest, "account", destAccount, {})],
});
const [festPreview] = await api(
  "manage",
  manager,
  { Action: "year-carry" },
  200,
  destFest.ID,
);
assert.equal(festPreview.Source, sourceFest.ID);
assert.equal(festPreview.Amount, 0);
const festTransfer = {
  Action: "year-carry",
  Target: sourceFest.ID,
  Stamp: festPreview.Stamp,
};
const manualFest = await api("events", manager, {
  Year: later.ID,
  Name: "Manuell eröffnetes Fest",
  Starts: later.Starts,
  Ends: later.Starts,
});
await api("online?event=" + manualFest.ID, manager, {
  Ops: [line(manualFest, "opening", randomUUID(), { Amount: 9400 })],
});
await api("manage", manager, festTransfer, 422, manualFest.ID);
const afterRefusal = await api("online?event=" + manualFest.ID, manager, {});
assert.deepEqual(
  afterRefusal.entries
    .filter((r) => r.Kind === "opening")
    .map((r) => r.Data.Amount),
  [9400],
);
await api("manage", manager, festTransfer, 422, destFest.ID);
await api(
  "manage",
  manager,
  { ...festTransfer, AccountMap: { [sourceAccount]: destAccount } },
  200,
  destFest.ID,
);
const festOpening = (
  await api("online?event=" + destFest.ID, manager, {})
).entries.filter((r) => r.Kind === "opening");
assert.equal(festOpening.length, 1);
assert.equal(festOpening[0].Data.Amount, 0);
assert.equal(festOpening[0].Data.Account, destAccount);
console.log(
  "PASS Freie Geschäftsjahre 2026/2027, allgemeine Kassenbücher, Jahreswechsel, Geldbuchungen an beiden Grenzen, Veranstaltungsfilter, Zugriffsrechte, Jahresauswertung und Abschluss mit Schreibschutz.",
);
