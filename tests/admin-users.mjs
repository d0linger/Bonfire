import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, basic } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port === "8137")
  throw Error("Isolierten lokalen Prüfstack angeben.");
async function request(
  path,
  { cookie, authorization, body, expected = 200 } = {},
) {
  const response = await fetch(new URL("/api/" + path, url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie && { Cookie: cookie }),
      ...(authorization && { Authorization: authorization }),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    expected,
    path + " · " + (response.ok ? "Antwortstatus prüfen" : text.slice(0, 180)),
  );
  return {
    data: response.ok ? JSON.parse(text) : null,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
const login = async (token, expected = 200) =>
  request("login", { authorization: token, body: {}, expected });
const { cookie: manager } = await login(admin);
const list = async () =>
  (await request("admin/users", { cookie: manager })).data.users;
const user = async (id) => (await list()).find((u) => u.ID === id);
const mutate = async (body, expected) =>
  request("admin/users", {
    cookie: manager,
    body: { Reason: "Fiktiver Abnahmelauf", ...body },
    expected,
  });
const edit = async (id, body, expected) =>
  mutate({ ID: id, Version: (await user(id)).Version, ...body }, expected);
const loginID = "kassa-" + randomUUID().slice(0, 10) + "@example.test";
const initial = randomUUID(),
  password = randomUUID();
const y = (await request("years", { cookie: manager })).data;
const year =
  y[0] ||
  (
    await request("years", {
      cookie: manager,
      body: { Name: "Fiktiv 2170", Starts: "2170-01-01", Ends: "2170-01-02" },
    })
  ).data;
const space = (await request("events?year=" + year.ID, { cookie: manager }))
  .data[0];
await request("admin/users", { expected: 401 });
await request("admin/users", { authorization: admin, expected: 401 });
await mutate({
  Action: "create",
  Login: loginID.toUpperCase(),
  Label: "Fiktive Kassa",
  Role: "Kassa",
  Password: initial,
  MustChange: true,
  Events: [space.ID],
});
// Older clients can submit German role aliases. Responses always use the current role.
assert.equal((await user(loginID)).Role, "Write");
assert.equal((await user("leitung")).Role, "Admin");
const start = await login(basic(loginID, initial));
assert.equal(start.cookie, undefined);
assert.ok(start.data.passwordChange);
await request("events", {
  authorization: basic(loginID, initial),
  expected: 401,
});
await request("password-change", {
  body: { Ticket: start.data.passwordChange, Password: password },
});
await request("password-change", {
  body: { Ticket: start.data.passwordChange, Password: randomUUID() },
  expected: 410,
});
await login(basic(loginID, initial), 401);
let cashier = (await login(basic(loginID, password))).cookie;
await request("admin/users", { cookie: cashier, expected: 403 });
await request("admin/users", {
  cookie: cashier,
  body: { Action: "sessions", ID: "leitung" },
  expected: 403,
});
assert.ok((await user(loginID)).LastLogin);
assert.ok(
  (await request("events", { cookie: cashier })).data.some(
    (e) => e.ID === space.ID,
  ),
);
const copy = await user(loginID);
const newLogin = "umbenannt-" + randomUUID().slice(0, 8) + "@example.test";
await mutate({
  Action: "edit",
  ID: loginID,
  Version: copy.Version,
  Login: newLogin,
  Label: "Fiktive Kassa",
  Role: "Prüfung",
  Events: [],
});
assert.equal((await user(loginID)).Role, "Read");
await request("events", { cookie: cashier, expected: 401 });
await login(basic(loginID, password), 401);
cashier = (await login(basic(newLogin, password))).cookie;
assert.equal(
  (await request("workplace", { cookie: cashier })).data.user,
  loginID,
);
assert.deepEqual((await request("events", { cookie: cashier })).data, []);
await mutate({ Action: "disable", ID: loginID, Version: copy.Version }, 409);
await edit(loginID, { Action: "disable" });
await login(basic(newLogin, password), 401);
await edit(loginID, { Action: "enable" });
cashier = (await login(basic(newLogin, password))).cookie;
await edit(loginID, { Action: "sessions" });
await request("workplace", { cookie: cashier, expected: 401 });
const interim = randomUUID();
await edit(loginID, {
  Action: "password",
  Password: interim,
  MustChange: true,
});
await login(basic(newLogin, password), 401);
const pending = (await login(basic(newLogin, interim))).data.passwordChange;
await edit(loginID, { Action: "mfa" });
await request("password-change", {
  body: { Ticket: pending, Password: randomUUID() },
  expected: 410,
});
if ((await list()).filter((u) => u.Active && u.Role === "Admin").length === 1) {
  await edit("leitung", { Action: "disable" }, 422);
  await edit(
    "leitung",
    { Action: "edit", Login: "leitung", Label: "", Role: "Write", Events: [] },
    422,
  );
}
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const management = await browser.newContext();
  await management.addCookies([
    {
      name: "bonfire_session",
      value: manager.split("=")[1],
      url: url.origin + "/api/",
    },
  ]);
  const page = await management.newPage();
  await page.goto(url.origin);
  await page.locator("#admin-navigation summary").click();
  await page
    .locator("#admin-navigation")
    .getByRole("button", { name: "Benutzer", exact: true })
    .click();
  await page.getByRole("heading", { name: "Benutzerkonten" }).waitFor();
  await page
    .getByRole("button", { name: "Benutzer anlegen", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("E-Mail-Adresse oder Benutzername")
    .waitFor();
  assert.equal(
    await page.getByRole("dialog").getByLabel("Rolle").inputValue(),
    "Write",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Abbrechen" })
    .click();
  await page.getByRole("button", { name: "Fiktive Kassa " + newLogin }).click();
  await page.getByRole("button", { name: "Zugang bearbeiten" }).click();
  const dialog = page.getByRole("dialog");
  assert.deepEqual(
    (
      await dialog.locator('select[name="Role"] option').allTextContents()
    ).sort(),
    ["Admin", "Read", "Write"],
  );
  assert.equal(
    await dialog.locator('select[name="Role"]').inputValue(),
    "Read",
  );
  await dialog.getByLabel("Anzeigename").fill("Fiktive Kassa Test");
  await dialog.getByLabel("Begründung").fill("Synthetischer Oberflächentest");
  await dialog.getByRole("button", { name: "Änderungen speichern" }).click();
  await page.getByText("Änderung gespeichert.", { exact: true }).waitFor();
  assert.equal((await user(loginID)).Label, "Fiktive Kassa Test");
  const changed = await browser.newPage();
  await changed.goto(url.origin);
  await changed.locator("#login [name=user]").fill(newLogin);
  await changed.locator("#login [name=pass]").fill(interim);
  await changed.getByRole("button", { name: "Anmelden", exact: true }).click();
  await changed
    .getByRole("heading", { name: "Neues Passwort festlegen" })
    .waitFor();
  const newSecret = randomUUID();
  await changed.getByLabel("Neues Passwort", { exact: true }).fill(newSecret);
  await changed.getByLabel("Neues Passwort wiederholen").fill(newSecret);
  await changed.getByRole("button", { name: "Passwort speichern" }).click();
  await changed.locator("#login").waitFor();
  await edit(loginID, {
    Action: "edit",
    Role: "Read",
    Login: newLogin,
    Label: "Fiktive Kassa Test",
    Events: [space.ID],
  });
  await changed.locator("#login [name=user]").fill(newLogin);
  await changed.locator("#login [name=pass]").fill(newSecret);
  await changed.getByRole("button", { name: "Anmelden", exact: true }).click();
  await changed
    .locator("nav")
    .getByRole("button", { name: "Kassenbuch", exact: true })
    .click();
  const journal = changed.locator("article");
  await journal
    .getByRole("heading", { name: "Kassenbuch", exact: true })
    .waitFor();
  assert.equal(
    await journal
      .locator('[data-act="focusEntry"], [data-edit], [data-lifecycle]')
      .count(),
    0,
  );
  await changed.locator("#admin-navigation summary").click();
  const links = changed.locator("#admin-navigation");
  assert.equal(
    await links.getByRole("button", { name: "Audit-Log", exact: true }).count(),
    1,
  );
  assert.equal(
    await links.getByRole("button", { name: "Benutzer", exact: true }).count(),
    0,
  );
} finally {
  await browser.close();
}
console.log(
  "PASS Benutzerverwaltung, eigene Sitzung und Rechte, Zugriffsbereiche, stabile Kontoidentität, Passwortwechsel und Ticketablauf, Widerruf, Sperre und Schutz des letzten aktiven Admins",
);
