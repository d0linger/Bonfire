import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, basic } from "./local-api.mjs";
import { totp } from "./totp.mjs";

const url = new URL(process.env.BONFIRE_URL);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !url.port ||
  url.port === "8137"
)
  throw Error("Isolierten lokalen Prüfstack angeben.");
url.hostname = "localhost";
const user = "konto-" + randomUUID().slice(0, 8) + "@example.test",
  initial = randomUUID(),
  changed = randomUUID();
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const context = await browser.newContext();
  const other = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const login = (client, authorization) =>
    client
      .post(new URL("api/login", url).href, {
        headers: { Authorization: authorization },
        data: {},
      })
      .catch(() => {
        throw Error("Prüfinstallation für Kontoanmeldung nicht erreichbar.");
      });
  const api = (path) => new URL("api/" + path, url).href;
  const adminContext = await browser.newContext();
  assert.ok((await login(adminContext.request, admin)).ok());
  const created = await adminContext.request.post(api("admin/users"), {
    data: {
      Action: "create",
      Login: user,
      Role: "Write",
      Label: "Übungskonto",
      Password: initial,
      Events: [],
      Reason: "Kontosicherheit prüfen",
    },
  });
  assert.equal(created.status(), 200);
  await adminContext.close();
  assert.ok((await login(other.request, basic(user, initial))).ok());
  const current = () =>
    context.request.get(api("account/security")).then((r) => r.json());
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  const dlg = page.locator("dialog[open]");
  const submit = (name) =>
    dlg.getByRole("button", { name, exact: true }).click();
  const openAccount = async () => {
    await click("Konto und Sicherheit");
    await page.getByRole("heading", { name: "Aktive Sitzungen" }).waitFor();
  };
  const settled = async () => {
    await dlg.waitFor({ state: "hidden" });
    await page
      .getByText("Kontoeinstellungen aktualisiert.", { exact: true })
      .waitFor();
  };
  await page.goto(url.href);
  await page.locator("#login [name=user]").fill(user);
  await page.locator("#login [name=pass]").fill(initial);
  await click("Sign in");
  await openAccount();
  assert.equal((await current()).sessions.length, 2);
  await click("Beenden");
  await submit("Sitzung beenden");
  await settled();
  assert.equal(
    (await other.request.get(api("account/security"))).status(),
    401,
  );
  assert.ok((await login(other.request, basic(user, initial))).ok());
  await click("Passwort ändern");
  await dlg.locator("[name=password]").fill("Falsches Passwort");
  await dlg.locator("[name=newPassword]").fill(changed);
  await dlg.locator("[name=repeat]").fill(changed);
  await submit("Passwort ändern");
  await dlg.getByText("Aktuelles Passwort prüfen.").waitFor();
  await dlg.locator("[name=password]").fill(initial);
  await submit("Passwort ändern");
  await settled();
  assert.equal(
    (await other.request.get(api("account/security"))).status(),
    401,
  );
  assert.equal(
    (await login(other.request, basic(user, initial))).status(),
    401,
  );
  assert.ok((await login(other.request, basic(user, changed))).ok());
  await page.reload();
  await openAccount();
  await click("Andere Sitzungen beenden");
  await submit("Andere Sitzungen beenden");
  await settled();
  assert.equal(
    (await other.request.get(api("account/security"))).status(),
    401,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await click("Authenticator einrichten");
  await dlg.locator("[name=password]").fill(changed);
  await submit("Authenticator einrichten");
  await dlg.locator("canvas").waitFor();
  assert.ok(await dlg.evaluate((el) => el.scrollWidth <= el.clientWidth));
  const secret = await dlg.locator("code").textContent();
  await dlg.locator("[name=code]").fill(totp(secret));
  await submit("Aktivieren");
  await dlg.locator(".recovery-codes").waitFor();
  const codes = await dlg.locator("li code").allTextContents();
  assert.equal(codes.length, 8);
  await submit("Gesichert und schließen");
  await settled();
  await click("Recoverycodes erneuern");
  await dlg.locator("[name=password]").fill(changed);
  await dlg.locator("[name=code]").fill(codes[0]);
  await submit("Recoverycodes erneuern");
  await dlg.locator(".recovery-codes").waitFor();
  const fresh = await dlg.locator("li code").allTextContents();
  assert.ok(fresh.every((c) => !codes.includes(c)));
  await submit("Gesichert und schließen");
  await settled();
  await page.setViewportSize({ width: 1280, height: 800 });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await click("Passkey hinzufügen");
  await dlg.locator("[name=name]").fill("Virtueller Kassaschlüssel");
  await dlg.locator("[name=password]").fill(changed);
  await dlg.locator("[name=code]").fill(fresh[0]);
  await submit("Passkey hinzufügen");
  await settled();
  await page.getByText("Virtueller Kassaschlüssel", { exact: true }).waitFor();
  await click("Arbeitsplatz schließen");
  await click("Sign in with a passkey");
  await openAccount();
  const keys = await context.request
    .get(api("account/passkeys"))
    .then((r) => r.json());
  assert.ok(keys.items[0].lastUsed);
  await click("Entfernen");
  await dlg.locator("[name=password]").fill(changed);
  await dlg.locator("[name=code]").fill(fresh[1]);
  await submit("Passkey entfernen");
  await settled();
  await page.getByText("Kein Passkey registriert.").waitFor();
  await click("Authenticator deaktivieren");
  await dlg.locator("[name=password]").fill(changed);
  await dlg.locator("[name=code]").fill(fresh[2]);
  await submit("Authenticator deaktivieren");
  await settled();
  assert.equal((await current()).mfa, false);
  await click("Arbeitsplatz schließen");
  await click("Sign in with a passkey");
  await page
    .getByText("Anmeldung mit diesem Passkey fehlgeschlagen.", { exact: true })
    .waitFor();
  assert.equal(
    (await context.request.get(api("account/security"))).status(),
    401,
  );
  console.log(
    "PASS Eigenkonto mit Rolle Write ohne Arbeitsbereich: Passwortwechsel, Einzel- und Sammelwiderruf, QR/TOTP, Recoverycodes und WebAuthn-Anmeldung.",
  );
} finally {
  await browser.close();
}
