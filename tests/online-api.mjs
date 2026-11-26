import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
{
  const day = "2393-07-01",
    fy = await call("years", cash, {
      Name: "Kontenprüfung",
      Starts: day,
      Ends: day,
    });
  const fest = await call("events", cash, {
    Year: fy.ID,
    Name: "Übungsfest Kasse",
    Starts: day,
    Ends: day,
    Accounts: true,
  });
  const post = (Ops, status = 200) =>
    call("online?event=" + fest.ID, cash, { Ops }, status);
  const bank = await call("fire-accounts", cash, {
    Action: "create",
    Name: "Übungsbank " + suffix,
  });
  const till = await call("fire-accounts", cash, {
    Action: "create",
    Name: "Übungskassa " + suffix,
  });
  for (const ID of [bank, till])
    await call("fire-accounts", cash, { Action: "link", ID, Event: fest.ID });
  const catalog = await call("fire-accounts", cash);
  const local = (id) =>
    catalog.locals.find((r) => r.Master === id && r.Event === fest.ID).ID;
  const tx = (kind, label, amount, data) => {
    const op = make(kind, label, amount);
    Object.assign(op.Data, data, { Date: day });
    return op;
  };
  await post([
    tx("income", "Einmaliger Festumsatz", 35000, { Account: local(till) }),
    tx("transfer", "Einzahlung", 30000, {
      Account: local(till),
      To: local(bank),
    }),
  ]);
  async function checkDisabledAttribution() {
    const options = { "X-Bonfire-Event": fest.ID };
    await call("manage", cash, { Action: "accounts", Accounts: false }, 200, options);
    const frozen = await call("year-balances?year=" + fy.ID, cash);
    assert.equal(frozen.find((b) => b.ID === bank)?.Soll, 30000);
    assert.equal(frozen.find((b) => b.ID === till)?.Soll, 5000);
    await call("manage", cash, { Action: "accounts", Accounts: true }, 200, options);
  }
  await checkDisabledAttribution();
  for (const [ID, Actual] of [
    [bank, 30000],
    [till, 5000],
  ])
    await call("fire-accounts", cash, {
      Action: "count",
      ID,
      Year: fy.ID,
      Opening: 0,
      Actual,
      Revision: 0,
    });
  await checkDisabledAttribution();
  const balances = await call("year-balances?year=" + fy.ID, cash);
  for (const [id, expected] of [
    [bank, 30000],
    [till, 5000],
  ])
    assert.equal(balances.find((b) => b.ID === id).Soll, expected);
  assert.equal(
    balances.reduce((n, b) => n + b.Transfers, 0),
    0,
  );
  assert.equal(
    balances.reduce((n, b) => n + b.Incoming, 0),
    35000,
  );
  const ledger = (await call("events?year=" + fy.ID, cash)).find(
    (e) => e.General,
  );
  await call("manage", cash, { Action: "accounts", Accounts: true }, 200, {
    "X-Bonfire-Event": ledger.ID,
  });
  await call("fire-accounts", cash, {
    Action: "link",
    ID: till,
    Event: ledger.ID,
  });
  const ledgerLocal = (await call("fire-accounts", cash)).locals.find(
    (r) => r.Master === till && r.Event === ledger.ID,
  ).ID;
  await call("online?event=" + ledger.ID, cash, {
    Ops: [
      tx("expense", "Material Vereinsheim", 1000, {
        Account: ledgerLocal,
        Fields: { issuer: "Übungsmarkt" },
      }),
    ],
  });
  const joined = (await call("year-balances?year=" + fy.ID, cash)).find(
    (b) => b.ID === till,
  );
  assert.equal(joined.Soll, 4000);
  assert.equal(new Set(joined.Lines.map((l) => l.Event)).size, 2);
  const purse = tx("wallet", "Börse Blau", undefined, {}),
    terminal = tx("account", "Übungsterminal", undefined, {});
  const cb = tx("cashback", "Bargeld an Gast", 5000, {
    Wallet: purse.Target,
    Account: purse.Target,
    To: terminal.Target,
    Fields: { provider: "Übungsterminal" },
  });
  const fee = tx("fee", "Abrechnungsgebühr", 100, {
    Account: terminal.Target,
    Fields: { provider: "Übungsterminal" },
  });
  const payout = tx("payout", "Bankgutschrift", 4900, {
    Account: terminal.Target,
    To: local(bank),
    Fields: { provider: "Übungsterminal" },
  });
  await post([purse, terminal, cb, fee, payout]);
  const settled = await call("year-balances?year=" + fy.ID, cash);
  assert.equal(
    settled.reduce((n, b) => n + b.Incoming, 0),
    35000,
  );
  assert.equal(
    settled.reduce((n, b) => n + b.Transfers, 0),
    0,
  );
  assert.equal(settled.find((b) => b.ID === bank).Soll, 34900);
  await call("fire-accounts", cash, {
    Action: "edit",
    ID: bank,
    Revision: 1,
    Name: "Inaktiv " + suffix,
    Active: false,
  });
  await post(
    [tx("income", "Gesperrtes Konto", 100, { Account: local(bank) })],
    409,
  );
  const t = tx("template", "Testschrift", undefined, {
    Reference: "guest_poster_letter_or_a4",
    Fields: { font: "times" },
  });
  t.Target = "template:" + t.Data.Reference;
  await post([t]);
  const lib = await call("template-library", cash);
  const release = lib.find(
    (r) => r.source === fest.Name && r.label === "Testschrift",
  );
  assert.ok(release);
  assert.equal(
    (await call("template-library?id=" + release.id, cash)).Fields.font,
    "times",
  );
  const copy = await call(
    "manage",
    cash,
    {
      Action: "copy",
      Target: "Übungsfest B",
      Start: day,
      End: day,
      Year: fy.ID,
      CopyKinds: ["template"],
    },
    200,
    { "X-Bonfire-Event": fest.ID },
  );
  const cloned = await call("online?event=" + copy, cash, {});
  assert.deepEqual(
    cloned.entries.filter((r) => r.Kind !== "contact").map((r) => r.Kind),
    ["template"],
  );
}
{
  const master = await call("fire-accounts", cash, {
    Action: "create",
    Name: "Übertrag " + suffix,
  });
  async function annualLedger(start) {
    const year = await call("years", cash, {
      Name: "Übernahme " + start.slice(0, 4),
      Starts: start,
      Ends: start,
    });
    const [ledger] = await call("events?year=" + year.ID, cash);
    await call("manage", cash, { Action: "accounts", Accounts: true }, 200, {
      "X-Bonfire-Event": ledger.ID,
    });
    await call("fire-accounts", cash, {
      Action: "link",
      ID: master,
      Event: ledger.ID,
    });
    const account = (await call("fire-accounts", cash)).locals.find(
      (l) => l.Master === master && l.Event === ledger.ID,
    ).ID;
    return { year: year.ID, endpoint: "online?event=" + ledger.ID, account };
  }
  const prev = await annualLedger("2761-12-31"),
    next = await annualLedger("2762-01-01");
  const count = (scope, Action, Opening, Actual, Revision, status = 200) =>
    call(
      "fire-accounts",
      cash,
      { ID: master, Year: scope.year, Action, Opening, Actual, Revision },
      status,
    );
  await count(next, "carry", null, null, 0, 422);
  const op = (k, n) => {
    const o = make(k, k, n);
    Object.assign(o.Data, { Date: "2761-12-31", Account: prev.account });
    return o;
  };
  await call(prev.endpoint, cash, {
    Ops: [op("opening", 14500), op("income", 300), op("actual", 14800)],
  });
  await count(prev, "count", 14500, 14799, 0);
  await call(prev.endpoint, cash, { Action: "Geschäftsjahr abschließen" }, 422);
  await count(prev, "count", 14500, 14800, 1);
  await call(prev.endpoint, cash, { Action: "Geschäftsjahr abschließen" });
  await count(next, "carry", null, 14800, 0);
  const [b] = await call("year-balances?year=" + next.year, cash);
  assert.equal(b.Opening, 14800);
  assert.equal(b.Actual, 14800);
  assert.equal(b.PriorActual, 14800);
}
const first = make("income", "Barzahlung", 100),
  other = make("income", "Zweite Zahlung", 100);
{
  const date = "2461-06-23";
  const poolYear = await call("years", cash, {
    Name: "Zählprüfung",
    Starts: date,
    Ends: date,
  });
  const pool = await call("events", cash, {
    Year: poolYear.ID,
    Name: "Fiktive Sammelzählung",
    Starts: date,
    Ends: date,
  });
  const endpoint = "online?event=" + pool.ID;
  const post = (Ops, status = 200) =>
    call(
      endpoint,
      cash,
      { Ops: Ops.map((op) => ({ ...op, Data: { ...op.Data, Date: date } })) },
      status,
    );
  const a = make("wallet", "Tasche A"),
    b = make("wallet", "Tasche B");
  function count(wallet, phase, n) {
    const op = make("count", "Zählung " + phase, n);
    op.Target =
      "count:" +
      createHash("sha256")
        .update(wallet + "|" + phase)
        .digest("hex")
        .slice(0, 32);
    Object.assign(op.Data, {
      Wallet: wallet,
      Phase: phase,
      Fields: { countMode: "amount", countScope: wallet ? "wallet" : "all" },
    });
    return op;
  }
  await post([
    a,
    b,
    count(a.Target, "Anfang", 10000),
    count(b.Target, "Anfang", 5000),
  ]);
  await post([count("", "Anfang", 15000)], 409);
  const end = count("", "Ende", 38000);
  const topup = make("supply", "Wechselgeld aus Hauptkassa", 3000);
  Object.assign(topup.Data, {
    Wallet: a.Target,
    Account: "Hauptkassa",
    To: a.Target,
  });
  const internal = make("supply", "Wechselgeld aus Nachbartasche", 1000);
  Object.assign(internal.Data, {
    Wallet: b.Target,
    Account: a.Target,
    To: b.Target,
  });
  const donation = make("donation", "Barspende im Gesamtbestand", 2000);
  donation.Data.Method = "Bar";
  const lateTopUp = make("supply", "Change delivered after closing count", 700);
  Object.assign(lateTopUp.Data, { Wallet: a.Target, Account: "Hauptkassa", To: a.Target });
  const receipt = await post([topup, internal, donation, end, lateTopUp]);
  const order = (op) => BigInt(receipt.entries.find((entry) => entry.ID === op.Target).Data.PostingOrder);
  assert.ok(order(topup) < order(end) && order(end) < order(lateTopUp));

  await post([count(b.Target, "Ende", 10000)], 409);
  const settlement = make("income", "Gemeinsame Barabrechnung", 18000);
  settlement.Target = "settlement-total";
  Object.assign(settlement.Data, {
    Method: "Bar",
    Reference: "wallet-settlement-total",
  });
  await post(
    [
      {
        ...settlement,
        ID: randomUUID(),
        Data: { ...settlement.Data, Amount: 20000 },
      },
    ],
    409,
  );
  await Promise.all([post([settlement]), post([settlement])]);
  const booked = (await call(endpoint, cash, {})).entries.filter(
    (r) => r.Kind === "income",
  );
  assert.equal(booked.length, 1);
  assert.equal(booked[0].Data.Amount, 18000);
  await post([
    make("opening", "Anfang", 15000),
    make("actual", "Ist inklusive externer Hauptkassa", 35000),
  ]);
  assert.equal(
    (await call(endpoint, cash, { Action: "Abschluss" })).closed,
    true,
  );
}
await Promise.all([
  ...Array.from({ length: 5 }, () => send({ Ops: [first] })),
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
const sponsor = make("contact", "Jahressponsor " + suffix);
sponsor.Data.Address = "Übungsstraße 1";
await call("online?event=" + ledger.ID, cash, { Ops: [sponsor] });
const lookup = { Action: "sponsor-contacts" };
const scope = { "X-Bonfire-Event": event.ID };
const directory = await call("manage", writeSession, lookup, 200, scope);
assert.deepEqual(
  directory.find((c) => c.id === sponsor.Target),
  {
    id: sponsor.Target,
    caption: sponsor.Data.Label + " · " + sponsor.Data.Address,
  },
);
await call("manage", review, lookup, 403, scope);
await call("manage", writeSession, lookup, 403, {
  "X-Bonfire-Event": ledger.ID,
});
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
    make("actual", "Istbestand", 410),
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
assert.equal(scopedEvents[0].ReceiptsCents, 500);
assert.equal(scopedEvents[0].PaidCents, 90);
assert.equal(scopedEvents[0].OutstandingCents, 0);
assert.equal(scopedEvents[0].Closed, true);
await send({ Ops: [make("income", "Verspätet", 10)] }, 403);
await call(ledgerPath, cash, finalizeYear, 422);
await call(ledgerPath, cash, {
  Ops: [make("opening", "Eröffnung", 0), make("actual", "Gezählt", 0)],
});
assert.equal((await call(ledgerPath, cash, finalizeYear)).yearClosed, true);
await call(
  "years/edit",
  cash,
  {
    Year: year.ID,
    Previous: { Name: year.Name, Starts: date, Ends: date },
    Updated: { Name: "Geschlossenes Jahr ändern", Starts: date, Ends: date },
  },
  409,
);
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
