import assert from "node:assert/strict";
import { randomInt, randomUUID, createHash } from "node:crypto";
import { api, admin, auth } from "./local-api.mjs";
const year = randomInt(4000, 9000),
  day = year + "-03-17";
const event = await api("events", admin, {
  Name: "Allgemeines Übungskassenbuch " + randomUUID().slice(0, 8),
  General: false,
  Starts: day,
  Ends: day,
});

const prepare = (Name, Donor) =>
  api("prepare", admin, { Event: event.ID, Name, Donor });
const device = await prepare("Meldeprüfung", true),
  basicDevice = await prepare("Normales Gerät", false);
const period = "Übung-Zeitraum";
const command = (Action, data = {}, status = 200, d = device) =>
  api("donation-reports", auth(d), { Action, Period: period, ...data }, status);
let seq = 0;
const make = (Kind, Label, data, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq: ++seq,
  Target,
  Base,
  Kind,
  Data: { Label, Date: day, ...data },
});
const send = (...Ops) => api("sync", auth(device), { Ops });
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
await command("Vorschau", {}, 403, basicDevice);
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
const unrelated = await api("events", admin, {
  Name: "Getrennte Testveranstaltung",
  Starts: day,
  Ends: day,
});
const stranger = await api("prepare", admin, {
  Event: unrelated.ID,
  Name: "Andere Leitung",
  Donor: true,
});
await command("Datei", { Report: report }, 422, stranger);
console.log(
  "PASS Spendenprüfung, Meldezeitraum, Ausschlüsse, externe Statusnachweise, Prüfsumme und unveränderlicher Korrekturverlauf",
);
