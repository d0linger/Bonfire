import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { api, admin, basic } from "./local-api.mjs";

const base = process.env.BONFIRE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Lokale Prüfadresse erforderlich.");
const user = "kassa+" + randomUUID().slice(0, 8) + "@example.test";
const pw = randomUUID();
const event = await api("events", admin, {
  Name: "Anmeldeprüfung",
  Starts: "2030-01-01",
  Ends: "2030-01-02",
});
await api("users", admin, {
  Name: user.toUpperCase(),
  Password: pw,
  Role: "Kassa",
  Event: event.ID,
});
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
function code(secret, offset = 0) {
  const bits = [...secret]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const bytes = createHmac("sha1", key).update(step).digest();
  return String(
    (bytes.readUInt32BE(bytes.at(-1) & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
  });
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  const login = async (password = pw) => {
    await page.locator("#login [name=user]").fill(user.toUpperCase());
    await page.locator("#login [name=pass]").fill(password);
    await click("Anmelden");
  };
  await page.goto(base);
  await page.locator("#login").waitFor();
  await mkdir("test-results/ansichten", { recursive: true });
  await page.screenshot({ path: "test-results/ansichten/login-desktop.png" });
  assert.equal(await page.locator("[name=otp],#recoverProfile").count(), 0);
  await click("Offlineprofile und Sicherungen");
  await page.getByRole("button", { name: "Als Lesearchiv öffnen" }).waitFor();
  await click("Zurück");
  await login();
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  const { secret } = await api("mfa", basic(user, pw), {});
  const recovery = await api("mfa", basic(user, pw), {
    Secret: secret,
    Code: code(secret),
  });
  await click("Arbeitsplatz schließen");
  await login(pw + "x");
  await page.getByText("Anmeldung fehlgeschlagen.", { exact: true }).waitFor();
  assert.equal(await page.locator("[name=otp]").count(), 0);
  await login();
  const factor = page.locator("#loginFactor input");
  await factor.waitFor();
  assert.equal(await page.locator("[name=pass]").count(), 0);
  assert.equal((await page.request.get(base + "/api/workplace")).status(), 401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/ansichten/login-mfa-mobil.png" });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await factor.fill(code(secret, 1));
  await click("Bestätigen");
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  await click("Arbeitsplatz schließen");
  await login();
  await click("Recoverycode verwenden");
  await factor.fill("keinRecoverycode");
  await click("Bestätigen");
  await page
    .getByText("Zweiter Faktor ungültig oder bereits verwendet.", {
      exact: true,
    })
    .waitFor();
  await factor.fill(recovery[0]);
  await click("Bestätigen");
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  console.log(
    "PASS E-Mail-Anmeldung, archivierte Profile, Passwortprüfung vor MFA, TOTP, Recoverycode nach Fehleingabe, Sitzungsgrenze und mobiler Login.",
  );
} finally {
  await browser.close();
}
