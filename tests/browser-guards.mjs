import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "node:https";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { admin, auditFixture } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.ok(url.port && url.port !== "8137", "Use a disposable test stack");
const engines = { chromium, firefox, webkit };
const engine = process.env.BONFIRE_ENGINE || "chromium";
assert.ok(Object.hasOwn(engines, engine), "Unsupported browser engine");
await auditFixture({ chromium: "2746-05-02", firefox: "2746-05-03", webkit: "2746-05-04" }[engine]);
// All engines exercise Secure session cookies over a real TLS connection.
const proxy = createServer({
  key: await readFile(join(process.env.RUNNER_TEMP, "browser.key")),
  cert: await readFile(join(process.env.RUNNER_TEMP, "browser.crt")),
}, (incoming, outgoing) => {
  const upstream = request({
    hostname: "127.0.0.1", port: url.port, path: incoming.url,
    method: incoming.method, headers: incoming.headers,
  }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => outgoing.destroy());
  incoming.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
const origin = "https://127.0.0.1:" + proxy.address().port;
let browser;
try {
  browser = await engines[engine].launch({ executablePath: process.env.BONFIRE_BROWSER });
  for (const colorScheme of ["light","dark"]) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, colorScheme, viewport: colorScheme === "dark" ? {width:390,height:844} : {width:1440,height:900},
    });
    const page = await context.newPage();
    for (const path of ["/", "/word-renderer.html"]) {
      const response = await page.request.get(origin + path);
      assert.equal(response.status(),200);
      const policy = new Map(response.headers()["content-security-policy"].split(";").map(directive => {
        const [name,...sources] = directive.trim().split(/\s+/);
        return [name,sources];
      }));
      assert.deepEqual(policy.get("script-src"),["'self'"]);
      assert.deepEqual(policy.get("object-src"),["'none'"]);
      assert.deepEqual(policy.get("base-uri"),["'none'"]);
      assert.deepEqual(policy.get("frame-ancestors"),[path === "/" ? "'none'" : "'self'"]);
      assert.equal(response.headers()["x-content-type-options"],"nosniff");
    }
    await page.goto(origin);
    await page.locator("#login").waitFor();
    async function audit(view) {
      const report = await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
      assert.deepEqual(report.violations.map(v => ({id:v.id,targets:v.nodes.map(n=>n.target)})),[],engine+" "+colorScheme+" "+view);
    }
    await audit("login");
    await page.locator('#login [name=user]').fill("leitung");
    await page.locator('#login [name=pass]').fill(Buffer.from(admin.slice(6),"base64").toString().slice("leitung:".length));
    await page.locator('#login button').click();
    await page.locator('#fiscal-switch').waitFor({state:"attached"});
    await audit("workspace");
    async function openNavigation() {
      if (!(await page.locator("nav").isVisible())) await page.locator("#menu-toggle").click();
    }
    await openNavigation();
    await page.locator('nav [data-act="accountSecurity"]').click();
    await page.locator('[data-personal="password"]').click();
    await page.getByRole("dialog").getByLabel("Current password").waitFor();
    await audit("password change dialog");
    await page.keyboard.press("Escape");
    await openNavigation();
    const administration = page.locator("#admin-navigation");
    if ((await administration.getAttribute("open")) === null) await administration.locator("summary").click();
    await administration.locator('[data-page="Audit-Log"]').click();
    await page.locator("button[data-entry]").first().waitFor();
    await page.locator("button[data-entry]").first().click();
    await page.locator(".ops-detail:not([hidden])").waitFor();
    await audit("expanded audit event");
    await page.reload();
    await page.locator('#fiscal-switch').waitFor({state:"attached"});
    assert.equal(await page.locator("#login").count(),0);
    await context.close();
  }
  console.log("PASS accessibility, response policies and session persistence in "+engine);
} finally {
  try { await browser?.close(); } finally { proxy.close(); }
}
