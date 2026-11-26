import assert from "node:assert/strict";
import { totp as code } from "./totp.mjs";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { api, admin, basic } from "./local-api.mjs";

const base = process.env.BONFIRE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Lokale Prüfadresse erforderlich.");
const user = "kassa+" + randomUUID().slice(0, 8) + "@example.test";
const pw = randomUUID();
const setup = await fetch(base + "/api/login", { method: "POST", headers: { Authorization: admin } });
assert.equal(setup.status, 200);
const cookie = setup.headers.getSetCookie()[0].split(";")[0];
const yearResponse = await fetch(base + "/api/years", {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ Name: "Sign-in test", Starts: "2603-03-01", Ends: "2603-03-31" }),
});
assert.equal(yearResponse.status, 200);
const year = await yearResponse.json();
const workspaces = await fetch(base + "/api/events?year=" + year.ID, { headers: { Cookie: cookie } });
assert.equal(workspaces.status, 200);
const ledger = (await workspaces.json()).find((e) => e.General);
await api("users", admin, {
  Name: user.toUpperCase(), Password: pw, Role: "Write", Event: ledger.ID,
});
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
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
    await click("Sign in");
  };
  await page.goto(base);
  await page.locator("#login").waitFor();
  await mkdir("test-results/ansichten", { recursive: true });
  await page.screenshot({ path: "test-results/ansichten/login-desktop.png" });
  assert.equal(await page.locator("[name=otp],#recoverProfile").count(), 0);
  await login();
  await page.getByRole("heading", { name: "Financial overview" }).waitFor();
  const { secret } = await api("mfa", basic(user, pw), {});
  const recovery = await api("mfa", basic(user, pw), {
    Secret: secret,
    Code: code(secret),
  });
  await click("Sign out");
  await login(pw + "x");
  await page.getByText("Sign-in failed.", { exact: true }).waitFor();
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
  await click("Verify");
  await page.getByRole("heading", { name: "Financial overview" }).waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  await click("Sign out");
  await login();
  await click("Use a recovery code");
  await factor.fill("keinRecoverycode");
  await click("Verify");
  await page
    .getByText("The code is invalid or has already been used.", {
      exact: true,
    })
    .waitFor();
  await factor.fill(recovery[0]);
  await click("Verify");
  await page.getByRole("heading", { name: "Financial overview" }).waitFor();
  console.log(
    "PASS email sign-in, password verification before MFA, TOTP, recovery code retry and mobile sign-in.",
  );
} finally {
  await browser.close();
}
