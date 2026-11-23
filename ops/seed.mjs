import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = process.env.BONFIRE_URL || "http://127.0.0.1:8137";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
  throw Error("Übungsdaten nur für lokale Testinstallationen.");
const pass =
  process.env.BONFIRE_ADMIN_PASSWORD ||
  (await readFile(".env", "utf8"))
    .match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)[1]
    .trim();
const headers = {
  Authorization: "Basic " + Buffer.from("leitung:" + pass).toString("base64"),
  "Content-Type": "application/json",
};
async function api(path, body) {
  const r = await fetch(base + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
const name = "Übung · Sommerfest am Birkenhain";
if ((await api("events")).some((e) => e.Name === name)) {
  console.log("Übungsbereich bereits vorhanden.");
  process.exit(0);
}
const e = await api("events", {
  Name: name,
  Starts: "2026-06-01",
  Ends: "2026-06-30",
});
const d = await api("prepare", { Event: e.ID, Name: "Übungsdaten" });
headers.Authorization = "Bearer " + d.device + "." + d.token;
const ops = [];
function row(Kind, Label, Data = {}, Target = randomUUID()) {
  ops.push({
    ID: randomUUID(),
    Seq: ops.length + 1,
    Base: 0,
    Kind,
    Target,
    Data: { Date: "2026-06-12", Label, ...Data },
  });
  return Target;
}
const bar = row("bar", "Gartenbar");
row("wallet", "Geldtasche Garten", { Bar: bar });
row(
  "organization",
  "Übungsfeuerwehr Birkenhain",
  {
    Address: "Fiktiver Übungsweg 1",
    Fields: {
      holder: "Übungsfeuerwehr",
      IBAN: "TESTKONTO",
      legal: "Entwicklungsmuster ohne Zahlungsaufforderung.",
    },
  },
  "organization",
);
const c = row("contact", "Übungsbetrieb Abendrot", {
  Address: "Fiktiver Übungsweg 2",
});
row("sponsorship", "Banner am Übungsplatz", {
  Contact: c,
  Amount: 10000,
  Fields: { due: "2026-06-30", service: "Sommerfest Juni" },
});
row("price", "Apfelschorle", {
  Amount: 290,
  Unit: "0,3 l",
  Status: "Freigegeben",
  Category: "Getränk",
  Bar: bar,
});
row("price", "Gemüseweckerl", {
  Amount: 340,
  Unit: "Stück",
  Status: "Freigegeben",
  Category: "Essen",
});
row("period", "Übungsperiode Juni", { To: "2026-06-30" });
row("opening", "Eröffnung Übungskassa", { Amount: 30000 });
await api("sync", { Ops: ops, Action: "Ende", Last: ops.length });
console.log(
  "Übungsbereich mit Geldtasche, Preisen, Kontakt und Forderung angelegt.",
);
