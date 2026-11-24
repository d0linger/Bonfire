import assert from "node:assert/strict";
import { chromium } from "playwright";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "8137",
);
const password = Buffer.from(admin.slice(6), "base64")
  .toString()
  .slice("leitung:".length);
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url.href);
  const appearance = page.getByRole("button", {
    name: "Dark mode",
    exact: true,
  });
  const background = (locator) =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  const checkScheme = async (scheme) => {
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      scheme,
    );
    assert.equal(
      await background(page.locator("body")),
      scheme === "dark" ? "rgb(23, 26, 32)" : "rgb(244, 245, 247)",
    );
    assert.equal(
      await appearance.getAttribute("aria-pressed"),
      String(scheme === "dark"),
    );
  };
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await appearance.isVisible());
  assert.ok(await page.locator("#menu-toggle").isHidden());
  assert.ok(await page.locator("#connection").isHidden());
  await page.setViewportSize({ width: 1360, height: 900 });
  await checkScheme("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await checkScheme("dark");
  await appearance.press("Space");
  await checkScheme("light");
  await page.reload();
  await checkScheme("light");
  const other = await context.newPage();
  await other.goto(url.href);
  await other.getByRole("button", { name: "Dark mode", exact: true }).click();
  await checkScheme("dark");
  await other.close();
  await page.emulateMedia({ colorScheme: "light" });
  await checkScheme("dark");
  await page.locator("#login [name=user]").fill("leitung");
  await page.locator("#login [name=pass]").fill(password);
  await page.locator("#login button").click();
  const group = page.locator("#admin-navigation");
  await group.locator("summary").click();
  const view = page.locator("article .admin-console").first();
  for (const name of ["Backup", "Benutzer", "Audit-Log", "Systemstatus"]) {
    await group.getByRole("button", { name, exact: true }).click();
    await view.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator("#workspace-picker select").count(), 0);
    if (name === "Backup") {
      await view
        .getByRole("button", { name: "Wiederherstellen", exact: true })
        .click();
      await view.locator("dialog[open]").waitFor();
      await page.keyboard.press("Escape");
    }
    if (name === "Benutzer") {
      await view
        .getByRole("button", { name: "Anmelderichtlinie", exact: true })
        .click();
      await view
        .getByRole("heading", { name: "Anmelderichtlinie", exact: true })
        .waitFor();
    }
    if (name === "Audit-Log") {
      const panel = view.locator(".ops-panel").first();
      assert.equal(await background(panel), "rgb(34, 39, 48)");
      await appearance.click();
      await checkScheme("light");
      assert.equal(await background(panel), "rgb(255, 255, 255)");
      await view
        .locator(".ops-pages, .ops-empty")
        .filter({ hasNotText: "geladen" })
        .first()
        .waitFor();
      for (const width of [1360, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const entry = view.locator("button[data-entry]").first();
        await entry.focus();
        const before = await entry.boundingBox();
        await entry.press("Enter");
        const detail = view.locator(
          "#" + (await entry.getAttribute("aria-controls")),
        );
        await detail
          .getByRole("heading", {
            name: "Ereignis " + (await entry.getAttribute("data-entry")),
            exact: true,
          })
          .waitFor();
        assert.ok(
          await entry.evaluate(
            (b) =>
              document.activeElement === b &&
              b.closest("tr").nextElementSibling.id ===
                b.getAttribute("aria-controls"),
          ),
        );
        assert.ok(Math.abs((await entry.boundingBox()).y - before.y) < 2);
        await entry.press("Space");
        assert.equal(await entry.getAttribute("aria-expanded"), "false");
        assert.equal(await detail.isVisible(), false);
      }
      await page.setViewportSize({ width: 1360, height: 900 });
      const entry = view.locator("button[data-entry]").first();
      const id = await entry.getAttribute("data-entry");
      await view.getByLabel("Suche", { exact: true }).fill("#" + id);
      await view.getByRole("button", { name: "Filtern", exact: true }).click();
      await view.locator("#audit-detail-" + id).waitFor();
      assert.equal(
        await view
          .locator('[data-entry="' + id + '"]')
          .getAttribute("aria-expanded"),
        "true",
      );
      await view.getByLabel("Suche", { exact: true }).fill("");
      await view
        .getByLabel("Ergebnis", { exact: true })
        .selectOption("Konflikt");
      await Promise.all([
        page.waitForResponse(
          (res) =>
            new URL(res.url()).searchParams.get("outcome") === "Konflikt" &&
            res.status() === 200,
        ),
        view.getByRole("button", { name: "Filtern", exact: true }).click(),
      ]);
      await view
        .getByRole("button", { name: "Prüfketten prüfen", exact: true })
        .click();
      await view.getByText("Prüfzeitpunkt", { exact: true }).waitFor();
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await appearance.isVisible());
  await appearance.click();
  await checkScheme("dark");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator("#menu-toggle").click();
  await group.getByRole("button", { name: "Backup", exact: true }).click();
  await view
    .getByRole("button", { name: "Jetzt sichern", exact: true })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Verwaltungsnavigation, Restore-Dialog, Benutzeransicht, Auditprüfung und mobile Ansicht",
  );
} finally {
  await browser.close();
}
