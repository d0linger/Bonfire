import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.ok(url.port && url.port !== "8137");
const login = await fetch(new URL("/api/login", url), {
  method: "POST",
  headers: { Authorization: admin },
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(";")[0];
async function call(path, body, status = 200, extra = {}) {
  const r = await fetch(new URL("/api/" + path, url), {
    method: body ? "POST" : "GET",
    headers: { Cookie: cookie, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  assert.equal(r.status, status, path + " " + raw.slice(0, 200));
  return r.ok ? JSON.parse(raw) : raw;
}
const stamp = randomUUID().slice(0, 8);
const day = "2452-02-02";
const lastDay = "2452-02-05";
const year =
  (await call("years")).find((x) => x.Starts === day) ||
  (await call("years", {
    Name: "Übungsjahr 2452",
    Starts: day,
    Ends: lastDay,
  }));
const create = (Name) =>
  call("events", {
    Name: Name + " " + stamp,
    Year: year.ID,
    Starts: day,
    Ends: day,
  });
const source = await create("Probelauf"),
  other = await create("Sommerfest");
const ledger = (await call("events")).find(
  (e) => e.General && e.Year === year.ID,
);
const post = (event, ops, status = 200) =>
  call("online?event=" + event.ID, { Ops: ops }, status);
const record = (Kind, Label, Amount) => ({
  ID: randomUUID(),
  Target: randomUUID(),
  Kind,
  Data: { Label: Label + " " + stamp, Date: day, Amount },
});
const entry = record("income", "Eintritt", 1000),
  donation = record("donation", "Sammlung", 800),
  extra = record("expense", "Fehleingabe", 200);
await post(source, [entry, donation, extra]);
await call("events/delete", { Event: source.ID }, 409);
await call("events/delete", { Event: ledger.ID }, 409);
const move = {
  Event: source.ID,
  Target: entry.Target,
  Revision: 1,
  Request: randomUUID(),
  Action: "move",
  Destination: other.ID,
  Reason: "Falsche Veranstaltung",
};
await call("events/entries", { ...move, Revision: 2 }, 409);
await Promise.all([call("events/entries", move), call("events/entries", move)]);
assert.equal(
  (await post(other, [])).entries.filter(
    (r) => r.Data.Label === entry.Data.Label,
  ).length,
  1,
);
await post(source, [{ ...entry, ID: randomUUID() }], 409);
const linked = record("bar", "Stand");
const wallet = record("wallet", "Tasche");
wallet.Data.Bar = linked.Target;
await post(other, [linked, wallet]);
await call(
  "events/entries",
  {
    ...move,
    Event: other.ID,
    Target: linked.Target,
    Action: "remove",
    Destination: "",
    Request: randomUUID(),
  },
  409,
);

// A destination with account assignment must receive an explicit local account.
const mapped = await call("events", {
  Name: "Kontenprüfung " + stamp,
  Year: year.ID,
  Starts: day,
  Ends: day,
  Accounts: true,
});
const charge = record("expense", "Zuordnungsprüfung", 375);
await post(other, [charge]);
const assign = {
  ...move,
  Event: other.ID,
  Target: charge.Target,
  Request: randomUUID(),
  Destination: mapped.ID,
};
await call("events/entries", assign, 422);
assert.ok((await post(other, [])).entries.some((r) => r.ID === charge.Target));
const account = record("account", "Fiktives Bankkonto");
await post(mapped, [account]);
await call("events/entries", { ...assign, Account: account.Target });
assert.ok(
  (await post(mapped, [])).entries.some(
    (r) => r.Data.Account === account.Target && r.Data.Amount === 375,
  ),
);
const restricted = "testkassa-" + stamp;
const pass = randomUUID();
await call("users", {
  Name: restricted,
  Password: pass,
  Role: "Write",
  Event: source.ID,
});
const cashLogin = await fetch(new URL("/api/login", url), {
  method: "POST",
  headers: {
    Authorization:
      "Basic " + Buffer.from(restricted + ":" + pass).toString("base64"),
  },
});
assert.equal(cashLogin.status, 200);
const cashHeaders = {
  Cookie: cashLogin.headers.getSetCookie()[0].split(";")[0],
};
const previous = { Name: source.Name, Starts: day, Ends: day };
const updated = {
  Name: "Winterfest " + stamp,
  Starts: "2452-02-03",
  Ends: lastDay,
};
const correction = { Event: source.ID, Previous: previous, Updated: updated };
await call("events/edit", correction, 403, cashHeaders);
await call("events/edit", { ...correction, Event: ledger.ID }, 409);
await call(
  "events/edit",
  { ...correction, Updated: { ...updated, Ends: "2452-02-06" } },
  422,
);
await call(
  "events/edit",
  { ...correction, Updated: { ...updated, Ends: day } },
  422,
);
await call("events/delete", { Event: source.ID }, 403, cashHeaders);
await call(
  "events/entries",
  { ...move, Request: randomUUID() },
  403,
  cashHeaders,
);
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "bonfire_session",
      value: cookie.split("=")[1],
      url: url.origin + "/api/",
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(url.origin);
  async function openMenu() {
    if (!(await page.locator("nav").isVisible()))
      await page.locator("#menu-toggle").click();
  }
  await openMenu();
  await page.locator("#fiscal-switch summary").click();
  await page.locator('[data-fiscal="' + year.ID + '"]').click();
  await page.waitForFunction(
    () => !document.querySelector('article[aria-busy="true"]'),
  );
  await openMenu();
  await page.locator('nav [data-page="Veranstaltungen"]').click();
  await page.locator('[data-event-edit="' + source.ID + '"]').click();
  const editor = page.getByRole("dialog", { name: "Veranstaltung bearbeiten" });
  assert.equal(
    await editor.getByLabel("Veranstaltungsname").inputValue(),
    source.Name,
  );
  await editor.getByLabel("Veranstaltungsname").fill(updated.Name);
  await editor.getByLabel("Beginn").fill(updated.Starts);
  await editor.getByLabel("Ende").fill(updated.Ends);
  await editor.getByRole("button", { name: "Änderungen speichern" }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: updated.Name, exact: true }).waitFor();
  const saved = (await call("events")).find((e) => e.ID === source.ID);
  await call("events/edit", correction);
  const audit = await call("manage", { Action: "audit" }, 200, {
    "X-Bonfire-Event": source.ID,
  });
  const changes = audit.filter((r) => r.action === "Veranstaltung bearbeitet");
  assert.equal(changes.length, 1);
  assert.ok(
    changes[0].subject.includes(previous.Name) &&
      changes[0].subject.includes(updated.Name),
  );
  assert.deepEqual(
    [saved.Name, saved.Starts, saved.Ends],
    Object.values(updated),
  );
  await call(
    "events/edit",
    { ...correction, Updated: { ...updated, Name: "Alter Dialog" } },
    409,
  );
  const afterEdit = await post(source, []);
  assert.ok(
    afterEdit.entries.some(
      (r) => r.ID === donation.Target && r.Data.Date === day,
    ),
  );
  const trigger = page.locator('[data-event-cleanup="' + source.ID + '"]');
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: updated.Name });
  assert.ok(await dialog.evaluate((d) => d.matches(":modal")));
  for (const [target, destination, button] of [
    [extra.Target, "remove", "Eintrag entfernen"],
    [donation.Target, ledger.ID, "Jetzt umbuchen"],
  ]) {
    await dialog.locator("select[name=Target]").selectOption(target);
    await dialog.getByLabel("Aktion oder Ziel").selectOption(destination);
    await dialog.getByLabel("Begründung").fill("Fiktive Zuordnung berichtigt");
    await dialog.getByRole("button", { name: button }).click();
    await page.waitForFunction(
      (id) =>
        !Array.from(
          document.querySelectorAll('#event-cleanup [name="Target"] option'),
        ).some((o) => o.value === id),
      target,
    );
  }
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  assert.ok(await trigger.isVisible());
  await trigger.click();
  await dialog
    .getByRole("button", { name: "Veranstaltung löschen", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.count(), 0);
} finally {
  await browser.close();
}
assert.equal(
  (await call("events")).some((e) => e.ID === source.ID),
  false,
);
await call("events/delete", { Event: source.ID });
assert.ok(
  (await post(ledger, [])).entries.some(
    (r) => r.Data.Label === donation.Data.Label && r.Data.Amount === 800,
  ),
);
assert.ok((await call("admin/audit/integrity")).chains.every((c) => c.OK));
const history = await call(
  "manage",
  { Action: "journal-period", Target: day, Reason: day },
  200,
  { "X-Bonfire-Event": ledger.ID },
);
for (const [r, expected] of [
  [entry, 1000],
  [donation, 800],
  [extra, 0],
]) {
  const rows = history.filter((x) => x.bezeichnung === r.Data.Label);
  assert.equal(
    rows.reduce((s, v) => s + Number(v.cent), 0),
    expected,
  );
  assert.ok(
    rows.some(
      (x) => x.veranstaltung === updated.Name && x.richtung === "Storno",
    ),
  );
}
console.log(
  "PASS Mobile Veranstaltungsbearbeitung mit Namens- und Datumskorrektur, Audit, Revisionsschutz, Umbuchung und Stornojournal nach Löschung.",
);
