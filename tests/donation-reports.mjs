import assert from "node:assert/strict";
import { randomInt, randomUUID, createHash } from "node:crypto";
import { admin } from "./local-api.mjs";

const base = new URL(process.env.BONFIRE_URL);
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname) && base.port !== "8137");
const login = await fetch(new URL("/api/login", base), {
  method: "POST",
  headers: { Authorization: admin },
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(";")[0];

async function call(route, body, status = 200, headers = {}) {
  const response = await fetch(new URL("/api/" + route, base), {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const value = await response.text();
  assert.equal(response.status, status, value.slice(0, 160));
  return status === 200 ? JSON.parse(value) : null;
}
const year = randomInt(4000, 9000);
const day = year + "-03-17";
const fiscalYear = await call("years", { Name: "Donation exercise " + year, Starts: day, Ends: day });
const createEvent = (Name) => call("events", { Year: fiscalYear.ID, Name, Starts: day, Ends: day });
const event = await createEvent("Donation exercise");
const privileged = { "X-Bonfire-Event": event.ID, "X-Bonfire-Donor": "true" };
const ordinary = { "X-Bonfire-Event": event.ID };
const period = "Synthetic reporting period";
const command = (Action, data = {}, status = 200, headers = privileged) =>
  call("donation-reports", { Action, Period: period, ...data }, status, headers);
const make = (Kind, Label, data, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(), Target, Base, Kind, Data: { Label, Date: day, ...data },
});
const send = (...Ops) => call("online?event=" + event.ID, { Ops }, 200, privileged);
const name = "Beispiel-" + randomUUID().slice(0, 8);
const fields = { given: "Mira", family: name, birth: "1990-01-25" };
const contact = make("contact", name, { Fields: fields }),
  other = make("contact", "Leer-" + name, { Fields: { given: "Test" } });
await send(contact, other);
const donor = (label, amount, extra = {}) =>
  make("donation", label, {
    Amount: amount,
    Contact: contact.Target,
    Fields: { reporting: period },
    ...extra,
  });
const active = donor("Nachtrag", 700),
  anonymous = donor("Anonyme Gabe", 455, { Status: "Anonym" }),
  missing = donor("Lückenhafter Datensatz", 400, { Contact: other.Target });
await send(
  active,
  anonymous,
  missing,
  donor("Andere Periode", 800, { Fields: { reporting: "Vorzeitraum" } }),
);
await command("Vorschau", {}, 403, ordinary);
const snapshot = await command("Vorschau");
assert.equal(snapshot.daten.SummeCent, 700);
assert.deepEqual(
  snapshot.daten.Spenden.map((x) => x.Vorgang),
  [active.Target],
);
assert.equal(snapshot.daten.Ausgeschlossen.length, 2);
assert.deepEqual(
  snapshot.daten.Ausgeschlossen.find((x) => x.Vorgang === anonymous.Target),
  { Vorgang: anonymous.Target, Grund: "Anonym" },
);
const report = randomUUID();
const decide = (Action, extra = {}, status = 200) =>
  command(
    Action,
    {
      Report: report,
      Request: randomUUID(),
      Reason: "Fiktiver Prüfvermerk",
      ...extra,
    },
    status,
  );
await decide("Geprüft", { Digest: "stale" }, 422);
const req = randomUUID();
await decide("Geprüft", { Digest: snapshot.sha256, Request: req });
await decide("Geprüft", { Digest: snapshot.sha256, Request: req });
await decide("Bestätigt", {}, 422);
await command("Datei", { Report: report }, 422);
await decide("Exportiert");
assert.equal((await command("Verlauf")).at(-1).status, "Exportiert");
const first = await command("Datei", { Report: report });
assert.equal(
  createHash("sha256").update(first.datei).digest("hex"),
  first.sha256,
);
assert.equal(first.sha256, snapshot.sha256);
await decide("Übermittelt", { Reason: "Externes Übungsprotokoll 17" });
await decide("Bestätigt", { Reason: "Eingang laut Übungsnachweis 18" });
await decide("Korrektur", { Reason: "Namenskorrektur dokumentiert" });
const corrected = make(
  "contact",
  name,
  { Fields: { ...fields, given: "Miriam" }, Note: "Übungskorrektur" },
  contact.Target,
  1,
);
const synced = await send(corrected);
assert.equal(synced.conflicts.length, 0);
const next = await command("Vorschau");
assert.notEqual(next.sha256, first.sha256);
assert.equal(
  await decide("Geprüft", { Digest: snapshot.sha256, Request: req }),
  "Geprüft",
);
const replacement = randomUUID();
await decide("Geprüft", { Report: replacement, Digest: next.sha256 });
assert.equal((await command("Verlauf")).at(-1).previous, report);
assert.deepEqual(await command("Datei", { Report: report }), first);
const changed = make(
  "donation",
  "Nachtrag berichtigt",
  { ...active.Data, Amount: 720, Note: "Korrigierter Betrag" },
  active.Target,
  1,
);
await send(changed);
await decide("Exportiert", { Report: replacement }, 422);
const unrelated = await createEvent("Unrelated exercise");
await command("Datei", { Report: report }, 422, {
  ...privileged, "X-Bonfire-Event": unrelated.ID,
});
console.log("PASS online donation review, restricted donor data, immutable exports and corrections");
