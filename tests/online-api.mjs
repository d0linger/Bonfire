import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { api, admin, basic } from "./local-api.mjs";

const base = process.env.BONFIRE_URL;
if (
  !base ||
  !["127.0.0.1", "localhost"].includes(new URL(base).hostname) ||
  new URL(base).port === "8137"
)
  throw Error("BONFIRE_URL der separaten Online-Prüfinstallation setzen.");

async function session(authorization) {
  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Authorization: authorization },
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(";")[0];
}
async function call(path, cookie, body, status = 200, headers = {}) {
  const res = await fetch(base + "/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const value = await res.text();
  assert.equal(res.status, status, value.slice(0, 150));
  return status === 200 ? JSON.parse(value) : null;
}
const cash = await session(admin);
assert.deepEqual(await call("mode", cash), { offline: false });
for (const path of ["prepare", "sync", "renew"]) {
  const response = await fetch(base + "/api/" + path, {
    method: "POST",
    headers: { Cookie: cash },
    body: "{}",
  });
  assert.ok([404, 405].includes(response.status));
}
const suffix = randomUUID().slice(0, 8);
const date = "2141-05-01";
const year = await call("years", cash, {
  Name: "Onlineprüfung " + suffix,
  Starts: date,
  Ends: date,
});
const event = await call("events", cash, {
  Year: year.ID,
  Name: "Übungsfest",
  Starts: date,
  Ends: date,
});
const path = "online?event=" + event.ID;
const send = (body, status = 200) => call(path, cash, body, status);
const snapshot = await send({});
assert.equal(snapshot.role, "Admin");
assert.equal(snapshot.event.Year, year.ID);
assert.equal(snapshot.pending, 0);
assert.equal(snapshot.nextNumber, snapshot.first);
assert.equal(snapshot.token, undefined);
await call(path, "", {}, 401);
const make = (Kind, Label, Amount) => ({
  ID: randomUUID(),
  Target: randomUUID(),
  Kind,
  Data: { Date: date, Label, Amount },
});
const first = make("income", "Barzahlung", 100),
  other = make("income", "Zweite Zahlung", 200);
await Promise.all([
  send({ Ops: [first] }),
  send({ Ops: [first] }),
  send({ Ops: [other] }),
]);
let current = await send({});
assert.equal(current.last, 2);
assert.equal(current.entries.filter((x) => x.Kind === "income").length, 2);
await send({ Ops: [{ ...first, Data: { ...first.Data, Amount: 333 } }] }, 422);
await send(
  {
    Ops: [
      make("income", "Aus Vorjahr", 20),
      { ...make("income", "Streit", 10), Target: first.Target },
    ],
  },
  409,
);
assert.equal((await send({})).last, 2);

const bill = make("sponsorship", "Fiktive Rechnung", 300);
await send({ Ops: [bill] });
const original = make("original", "Originalrechnung");
original.Target = "original:" + bill.Target;
Object.assign(original.Data, {
  Date: date,
  Reference: bill.Target,
  Number: snapshot.first,
  PDF: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
  DOCX: Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("<document/>"),
    }),
  ).toString("base64"),
  Note: JSON.stringify({
    profile: "invoice_transfer_a4",
    subject: bill.Target,
    number: snapshot.first,
    date,
  }),
});
await send({ Ops: [original] });
current = await send({ Ops: [original] });
assert.equal(current.nextNumber, snapshot.first + 1);
assert.equal(
  current.entries.find((entry) => entry.ID === original.Target).Data.PDF,
  original.Data.PDF,
);
const audit = await call("manage", cash, { Action: "audit" }, 200, {
  "X-Bonfire-Event": event.ID,
});
assert.ok(
  audit.some((row) => row.subject === first.ID && row.username === "leitung"),
);
const reviewer = "online-" + suffix,
  password = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Password: password,
  Role: "Read",
  Event: event.ID,
});
const review = await session(basic(reviewer, password));
await call(path, review, { Ops: [make("income", "Gesperrt", 1)] }, 403);
const [ledger] = (await call("events?year=" + year.ID, cash)).filter(
  (e) => e.General,
);
await call("online?event=" + ledger.ID, review, {}, 403);
assert.equal((await call(path, review, {})).role, "Read");
const writer = "buchung-" + suffix;
await api("users", admin, {
  Name: writer,
  Password: password,
  Role: "Write",
  Event: event.ID,
});
const writeSession = await session(basic(writer, password));
await call("online?event=" + ledger.ID, writeSession, {}, 403);
const payment = make("income", "Vereinsabend", 15);
const posted = await call(path, writeSession, { Ops: [payment] });
assert.equal(posted.role, "Write");
assert.ok(posted.entries.some((row) => row.ID === payment.Target));
const transfer = make("transfer", "Wechselgeld intern", 75);
Object.assign(transfer.Data, { Account: "Tresor", To: "Festkassa" });
const outlay = make("outlay", "Privater Einkauf", 50);
await send({
  Ops: [
    transfer,
    outlay,
    make("expense", "Material", 40),
    make("refund", "Rückzahlung", 15),
    make("opening", "Anfang", 0),
    make("actual", "Istbestand", 510),
  ],
});
const [beforeReimbursement] = await call(
  "events?overview=1&year=" + year.ID,
  review,
);
assert.equal(beforeReimbursement.PaidCents, 40);
assert.equal(beforeReimbursement.OutstandingCents, 50);
const reimbursement = make("reimbursement", "Einkauf erstattet", 50);
reimbursement.Data.Reference = outlay.Target;
await send({ Action: "Abschluss" }, 422);
await send({ Ops: [reimbursement] });
await send({ Action: "Abschluss" }, 422);
const sponsorPayment = make("payment", "Rechnung beglichen", 300);
sponsorPayment.Data.Reference = bill.Target;
await send({ Ops: [sponsorPayment] });
const ledgerPath = "online?event=" + ledger.ID;
const finalizeYear = { Action: "Geschäftsjahr abschließen" };
await call(ledgerPath, cash, finalizeYear, 409);
for (const scoped of [review, writeSession]) {
  await call(path, scoped, { Action: "Abschluss" }, 403);
  await call("admin/users", scoped, undefined, 403);
}
assert.equal((await send({ Action: "Abschluss" })).closed, true);
const originalDetails = {
  Name: event.Name,
  Starts: event.Starts,
  Ends: event.Ends,
};
await call(
  "events/edit",
  cash,
  {
    Event: event.ID,
    Previous: originalDetails,
    Updated: { ...originalDetails, Name: "Nach Abschluss" },
  },
  409,
);
const scopedEvents = await call("events?overview=1&year=" + year.ID, review);
assert.deepEqual(
  scopedEvents.map((e) => e.ID),
  [event.ID],
);
assert.equal(scopedEvents[0].ReceiptsCents, 600);
assert.equal(scopedEvents[0].PaidCents, 90);
assert.equal(scopedEvents[0].OutstandingCents, 0);
assert.equal(scopedEvents[0].Closed, true);
await send({ Ops: [make("income", "Verspätet", 10)] }, 403);
await call(ledgerPath, cash, finalizeYear, 422);
await call(ledgerPath, cash, {
  Ops: [make("opening", "Eröffnung", 0), make("actual", "Gezählt", 0)],
});
assert.equal((await call(ledgerPath, cash, finalizeYear)).yearClosed, true);
const manage = (id, user, Action, Reason, status) =>
  call("manage", user, { Action, Reason }, status, { "X-Bonfire-Event": id });
await manage(event.ID, cash, "reopen", "Korrektur erforderlich", 409);
await call(
  "events",
  cash,
  { Year: year.ID, Name: "Spätes Fest", Starts: date, Ends: date },
  409,
);
await call(
  ledgerPath,
  cash,
  { Ops: [make("income", "Alter Browserdialog", 10)] },
  403,
);
await manage(event.ID, writeSession, "reopen", "Korrektur erforderlich", 403);
await manage(ledger.ID, cash, "year-reopen", "", 422);
await manage(ledger.ID, cash, "year-reopen", "Beleg aus Jahresprüfung", 200);
assert.equal((await send({})).closed, true);
assert.equal((await call(ledgerPath, cash, {})).closed, false);
await manage(event.ID, cash, "reopen", "Beleg aus Festabrechnung", 200);
assert.equal((await send({})).closed, false);
await call(path, writeSession, { Ops: [make("income", "Nach Freigabe", 10)] });
await call("logout", cash, {});
await send({}, 401);
console.log(
  "PASS Onlinebuchungen mit erneutem Senden, parallelen Tabs, atomarer Konfliktbehandlung, Originalnummer, Audit, Rollen und Abschluss ohne Gerätevorbereitung",
);
