import { displayProof } from "./document-preview.js";
import {
  icon,
  esc,
  flowAmount,
  moduleList,
  titleOf,
  sectionOf,
  route,
  navigation,
  tabs,
  eventTabs,
  adminTabs,
  recordKinds,
  overview,
  bookings,
  ledger,
  dat,
} from "./workplace.js";
import { sponsorshipStatus } from "./sponsorship.js";
import { denominationNeeds } from "./domain.js";
import { zipSync } from "fflate";
import { historyPreview } from "./historical.js";
import { positions, lineCents } from "./positions.js";
import { background } from "./lfk.js";
import { mergeWord } from "./word-profile.js";
import { importTemplate } from "./templates.js";
import { preview, csv, workbook, evidence } from "./exchange.js";
import {
  createVault,
  readVault,
  unlock,
  save,
  slots,
  recoverReadOnly,
  download,
  b64,
  from64,
} from "./store.js";
import {
  groups,
  types,
  denom,
  monetary,
  cents,
  totalPieces,
  visible,
  summary,
  counted,
  availableNumbers,
  journalMatches,
  countID,
  today,
  eur,
} from "./domain.js";
import {
  profiles,
  profileID,
  snapshot,
  render as renderDocument,
} from "./export.js";
const article = document.querySelector("article"),
  nav = document.querySelector("nav"),
  notice = document.querySelector("#notice"),
  state = document.querySelector("#state");
const option = (v, t) =>
  '<option value="' + esc(v) + '">' + esc(t) + "</option>";
const label = (t, c) => "<label>" + esc(t) + c + "</label>";
const field = (n, t, type = "text", req = false, value = "") =>
  label(
    t,
    '<input name="' +
      n +
      '" type="' +
      type +
      '" value="' +
      esc(value) +
      '" ' +
      (req ? "required" : "") +
      ">",
  );
const select = (n, t, choices) =>
  label(
    t,
    '<select name="' +
      n +
      '">' +
      choices.map(([v, l]) => option(v, l)).join("") +
      "</select>",
  );
const button = (act, t, secondary = false) =>
  '<button type="button" data-act="' +
  act +
  '" class="' +
  (secondary ? "secondary" : "") +
  '">' +
  esc(t) +
  "</button>";
const form = (id, inner, submit) =>
  '<form id="' +
  id +
  '"><div class="form">' +
  inner +
  '</div><div class="actions"><button>' +
  esc(submit) +
  "</button></div></form>";
const panel = (t, c) => "<section><h2>" + esc(t) + "</h2>" + c + "</section>";
const heading = (t) => "<h1>" + esc(t) + "</h1>";
let profilesLocal = [];
let importFile = null,
  importRole = "",
  globalRows = [],
  imported = [],
  chosenPeriod = "",
  syncDetail = "";
let mfaSecret = "",
  mfaCodes = [],
  auditRows = [],
  logged = false;
let s,
  page = "Übersicht",
  kind = "income",
  edit = null,
  auth = "",
  events = [],
  saved = false,
  filter = "",
  journalFilters = {},
  busy = false;
const sw = navigator.serviceWorker
  ?.register("/sw.js")
  .then(() => navigator.serviceWorker.ready);
async function api(path, body, token = auth) {
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: token, "Content-Type": "application/json" },
    cache: "no-store",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error((await response.text()).slice(0, 240));
  return response.json();
}
import { donationReport } from "./donors.js";
const bearer = () => "Bearer " + s.device + "." + s.token;
async function reprint(row, format) {
  if (!row.Data[format])
    throw Error("Dieses Original benötigt ein Belegprofil.");
  if (!s.recovery)
    await commit({
      ...s,
      prints: [
        ...(s.prints || []),
        {
          ID: crypto.randomUUID(),
          Subject: row.ID.slice("original:".length),
          At: new Date().toISOString(),
        },
      ],
    });
  download(
    from64(
      row.Data[format],
      format === "PDF"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "Beleg-" + row.Data.Number + "." + format.toLowerCase(),
  );
}
async function commit(next) {
  await save(next);
  s = next;
}
function canWrite() {
  if (
    Date.parse(s.expires) <= Date.now() ||
    s.closed ||
    s.sealed ||
    s.incidentState === "returning" ||
    s.ending ||
    s.role === "Prüfung"
  )
    throw Error("Lokale Schreibfreigabe beendet.");
}
async function queue(k, d, target = crypto.randomUUID(), base = 0) {
  canWrite();
  const next = structuredClone(s);
  const append = (Kind, Target, Base, Data) =>
    next.ops.push({
      LocalTime: new Date().toISOString(),
      ID: crypto.randomUUID(),
      Seq: ++next.seq,
      Kind,
      Target,
      Base,
      Data,
    });
  if (k === "attachment") {
    const { File, ...metadata } = d;
    append(k, target, base, metadata);
    const revision = String(base + 1);
    append("attachment-file", await countID("file", target, revision), 0, {
      Label: metadata.Label,
      Date: metadata.Date,
      Reference: target,
      File,
      Fields: { sha256: d.Fields.sha256, size: d.Fields.size, revision },
    });
  } else append(k, target, base, d);
  await commit(next);
}
async function sync(extra = {}) {
  if (s.recovery)
    throw Error("Wiederhergestelltes Archiv ist schreibgeschützt.");
  const probe = await api("sync", { Ops: [] }, bearer());
  if (probe.last > s.seq)
    throw Error(
      "Server kennt weitere Vorgänge dieser Gerätekennung. Profil sperren und Kopien klären.",
    );
  if (probe.last < s.last) {
    const missing = (s.history || [])
      .filter((o) => o.Seq > probe.last && o.Seq <= s.last)
      .sort((a, b) => a.Seq - b.Seq);
    if (missing.length !== s.last - probe.last)
      throw Error(
        "Wiederhergestellter Serverstand älter als lokales Archiv. Daten bleiben lokal erhalten.",
      );
    for (const o of missing) await api("sync", { Ops: [o] }, bearer());
  }
  // Each acknowledged operation is durable before removing it from the local outbox.
  do {
    const batch = s.ops.slice(0, 1),
      last = s.ops.length <= 1;
    const out = await api(
      "sync",
      { Ops: batch, ...(last ? { ...extra, Prints: s.prints || [] } : {}) },
      bearer(),
    );
    const revisions = new Map(out.entries.map((r) => [r.ID, r.Revision]));
    if (
      s.entries.some(
        (r) =>
          r.Kind !== "contact" &&
          (!revisions.has(r.ID) || revisions.get(r.ID) < r.Revision),
      )
    )
      throw Error(
        "Der Server liefert einen älteren Fachstand. Lokale Daten für die Wiederherstellung aufbewahrt.",
      );
    const next = {
      ...s,
      ...out,
      prints: last
        ? (s.prints || []).filter(
            (l) => !(out.acknowledgedPrints || []).includes(l.ID),
          )
        : s.prints,
      history: [...(s.history || []), ...batch],
      ops: s.ops.slice(batch.length),
      seq: Math.max(s.seq, out.last),
      synced: new Date().toISOString(),
    };
    if (!next.pinnedTemplates)
      next.pinnedTemplates = (s.synced ? s.entries : out.entries).filter(
        (r) => r.Kind === "template",
      );
    next.event = { ...s.event, Accounts: out.accounts };
    if (out.sealed) next.ending = false;
    await commit(next);
  } while (s.ops.length);
}
function rows() {
  return visible(s);
}
function choices(kinds) {
  return [
    ["", "—"],
    ...rows()
      .filter(
        (r) =>
          kinds.includes(r.Kind) &&
          (!r.Data.Retired || edit?.Data?.Contact === r.ID),
      )
      .map((r) => [
        r.ID,
        r.Kind === "contact"
          ? [r.Data.Label, r.Data.Address, r.Data.Fields?.distinct]
              .filter(Boolean)
              .join(" · ")
          : r.Data.Label,
      ]),
  ];
}
function refs(name, title, kinds) {
  const dropdown = select(name, title, choices(kinds));
  if (name !== "Contact" || !rows().some((r) => r.Kind === "contact"))
    return dropdown;
  return (
    label(
      "Kontakt suchen",
      '<input type="search" data-contact-filter autocomplete="off">',
    ) + dropdown
  );
}
function table(list, editable = false) {
  if (!list.length) return '<p class="muted">Keine Einträge.</p>';
  return (
    '<div class="list"><table><thead><tr><th>Datum</th><th>Vorgang</th><th>Bezeichnung</th><th>Betrag</th><th></th></tr></thead><tbody>' +
    list
      .map(
        (r) =>
          "<tr><td>" +
          esc(r.Data.Date) +
          "</td><td>" +
          esc(types[r.Kind]) +
          "</td><td>" +
          esc(r.Data.Label) +
          (r.Data.Retired ? " · Archiviert" : "") +
          (r.Kind === "attachment"
            ? r.Data.uploadPending
              ? " · Datei lokal, Übertragung offen"
              : r.Data.File
                ? " · Datei verfügbar"
                : " · Metadaten vorhanden, Datei ausständig"
            : "") +
          "</td><td>" +
          esc(flowAmount(r)) +
          "</td><td>" +
          (r.Kind === "attachment" && r.Data.File
            ? '<button type="button" data-attachment="' +
              esc(r.ID) +
              '">Datei laden</button>'
            : "") +
          (editable && !r.Data.Retired
            ? '<button class="secondary" data-edit="' +
              esc(r.ID) +
              '">Bearbeiten</button>'
            : "") +
          (editable &&
          s.role === "Leitung" &&
          !s.closed &&
          !s.sealed &&
          (r.Kind === "contact" ||
            (r.Kind === "price" && r.Data.Status !== "Freigegeben"))
            ? '<button type="button" class="secondary" data-lifecycle="' +
              esc(r.ID) +
              '">' +
              (r.Data.Retired ? "Wiederherstellen" : "Archivieren") +
              "</button>"
            : "") +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
let readiness = [];
let conflictFiles;
function incidentPanel() {
  const devices = s.devices || [];
  const labels = {
    missing: "Vermisst",
    incomplete: "Abschluss unvollständig · Ausnahme protokolliert",
    returning: "Zurückgemeldet · Einzelprüfung läuft",
  };
  const cases = devices.filter((d) => d.IncidentState);
  let content = cases
    .map(
      (d) =>
        "<p><strong>" +
        esc(d.Name) +
        "</strong> · " +
        esc(labels[d.IncidentState]) +
        " · bestätigte Folge " +
        esc(d.Last) +
        (d.IncidentNote ? "<br>" + esc(d.IncidentNote) : "") +
        "</p>",
    )
    .join("");
  for (const [id, role, allowed, label, reason] of [
    [
      "incident",
      "Leitung",
      [""],
      "Gerät vermisst melden",
      "Vorfall und bekannte Lücke",
    ],
    [
      "incomplete",
      "Prüfung",
      ["missing"],
      "Unvollständigkeit bestätigen",
      "Rekonstruktion und verbleibende Lücke",
    ],
    [
      "returnDevice",
      "Leitung",
      ["missing", "incomplete"],
      "Rückkehr zur Prüfung freigeben",
      "Nachweis der Geräterückkehr",
    ],
  ]) {
    const choices = devices.filter(
      (d) =>
        d.ID !== s.device &&
        !d.Sealed &&
        allowed.includes(d.IncidentState || ""),
    );
    if (choices.length && s.role === role)
      content += form(
        id,
        select(
          "device",
          "Betroffenes Gerät",
          choices.map((d) => [d.ID, d.Name]),
        ) + field("reason", reason, "text", true),
        label,
      );
  }
  return content ? panel("Gerätevorfälle", content) : "";
}
function devicePage() {
  const conflicts = s.conflicts
    .map((c) => {
      const cur = s.entries.find((r) => r.ID === c.Target);
      const sameName = c.Kind === "contact" && !cur && c.Base === 0;
      return panel(
        "Konflikt · " + c.Data.Label,
        (sameName
          ? "<p>Kontaktneuanlage prüfen. Bei gleichem Namen für eine getrennte Person oder Firma die Abgrenzung begründen. Vorhandene Adressen bleiben erhalten.</p>"
          : "") +
          "<p>Ausgangsrevision " +
          esc(c.Base) +
          " · gespeicherte Revision " +
          esc(cur?.Revision ?? 0) +
          "</p><p>Gespeichert: " +
          esc(cur?.Data.Label || "Fehlt") +
          " · " +
          eur(cur?.Data.Amount) +
          "</p><p>Vorschlag: " +
          esc(c.Data.Label) +
          " · " +
          eur(c.Data.Amount) +
          "</p><details><summary>Beide Fassungen ansehen</summary><pre>" +
          esc(
            JSON.stringify(
              [cur?.Data, c.Data],
              (k, v) =>
                ["File", "PDF", "DOCX"].includes(k)
                  ? v
                    ? "Datei vorhanden"
                    : undefined
                  : v,
              2,
            ),
          ) +
          "</pre></details>" +
          form(
            "resolve-" + c.ID,
            select("choice", "Entscheidung", [
              ["beibehalten", "Bisherigen Stand behalten"],
              ["übernehmen", "Vorschlag übernehmen"],
            ]) +
              (s.accounts && monetary.has(c.Kind)
                ? refs("account", "Konto für Klärung (optional)", [
                    "account",
                    "wallet",
                  ])
                : "") +
              (s.accounts &&
              ["transfer", "payout", "supply", "skim", "return"].includes(
                c.Kind,
              )
                ? refs("destination", "Zielkonto für Klärung (optional)", [
                    "account",
                    "wallet",
                  ])
                : "") +
              field("reason", "Begründung", "text", true),
            "Klärung speichern",
          ),
      );
    })
    .join("");
  return (
    "<p>" +
    esc(s.user) +
    " · " +
    esc(s.role) +
    " · Gerätefreigabe bis " +
    esc(new Date(s.expires).toLocaleString("de-AT")) +
    "</p>" +
    (!s.sealed && !s.recovery
      ? panel(
          "Gerätefreigabe verlängern",
          form(
            "renew",
            field("password", "Online-Passwort", "password", true) +
              field("otp", "TOTP oder Recoverycode (falls eingerichtet)"),
            "Gerät erneut autorisieren",
          ),
        )
      : "") +
    panel(
      "Abgleich",
      button("readiness", "Offlinebereitschaft prüfen", true) +
        readiness.map((t) => "<p>" + esc(t) + "</p>").join("") +
        "<p>" +
        s.ops.length +
        " lokale Vorgänge ausstehend · " +
        s.conflicts.length +
        " Konflikte im letzten Abgleich</p><p>" +
        esc(
          s.synced
            ? "Letzter bestätigter Abgleich " +
                new Date(s.synced).toLocaleString("de-AT")
            : "Erster Abgleich ausständig",
        ) +
        '</p><div class="actions">' +
        button("sync", "Jetzt abgleichen") +
        button("recover", "Verschlüsselte Sicherung laden", true) +
        "</div>",
    ) +
    conflicts +
    (s.role !== "Kassa"
      ? panel(
          "Prüfprotokoll",
          button("audit", "Protokoll anzeigen", true) +
            button("journalHistory", "Storno und Ersatz anzeigen", true) +
            button("numbers", "Nummernregister prüfen", true) +
            button("conflictFiles", "Strittige Originalfassungen laden", true) +
            (conflictFiles?.device === s.device && conflictFiles.list.length
              ? form(
                  "conflictFile",
                  select(
                    "operation",
                    "Archivierte Konfliktfassung",
                    conflictFiles.list.map((x) => [
                      x.id,
                      "Nr. " + x.number + " · " + x.outcome + " · " + x.id,
                    ]),
                  ) +
                    select("format", "Dateityp", [
                      ["pdf", "PDF"],
                      ["docx", "DOCX"],
                    ]),
                  "Archivdatei laden",
                )
              : "") +
            auditRows
              .map(
                (r) =>
                  "<p>" +
                  esc(r.at) +
                  " · " +
                  esc(r.username) +
                  " · " +
                  esc(r.action) +
                  (r.device ? "<br>Ausführendes Gerät " + esc(r.device) : "") +
                  (r.local_time ? " · Gerätezeit " + esc(r.local_time) : "") +
                  (r.source_device
                    ? " · Quellgerät " +
                      esc(r.source_device) +
                      " · Ausgangsrevision " +
                      esc(r.base_revision)
                    : "") +
                  "</p>",
              )
              .join(""),
        )
      : "") +
    (s.role === "Leitung"
      ? panel(
          "Veranstaltung verwalten",
          form(
            "copy",
            field("name", "Name der neuen Veranstaltung", "text", true) +
              field("start", "Neuer Beginn", "date", true, s.event.Starts) +
              field("end", "Neues Ende", "date", true, s.event.Ends),
            "Struktur und Preisentwürfe kopieren",
          ) +
            esc(syncDetail) +
            (s.closed
              ? form(
                  "reopen",
                  field("reason", "Begründung", "text", true),
                  "Veranstaltung wieder öffnen",
                )
              : ""),
        )
      : "") +
    (s.role === "Leitung"
      ? panel(
          "Kontozuordnung",
          button(
            "accounts",
            s.event.Accounts
              ? "Kontozuordnung ausschalten"
              : "Kontozuordnung einschalten",
            true,
          ),
        )
      : "") +
    incidentPanel() +
    panel(
      "Erfassungsende",
      "<p>Mit der Bestätigung endet die Erfassung auf diesem Gerät für diese Veranstaltung.</p><p>Geräte ohne bestätigtes Ende beim letzten Abgleich: " +
        esc(s.pending ?? "Unbekannt") +
        '</p><div class="actions">' +
        (!s.sealed
          ? button("seal", "Mein Erfassungsende bestätigen")
          : "<strong>Erfassungsende bestätigt</strong>") +
        (s.role === "Prüfung"
          ? button("close", "Bestände prüfen und abschließen")
          : "") +
        "</div>",
    )
  );
}
function formFields(k) {
  let f =
    field("Label", "Bezeichnung", "text", true) +
    field(
      "Date",
      k === "period" ? "Periodenbeginn" : "Datum",
      "date",
      true,
      today(),
    );
  if (monetary.has(k))
    f += label(
      "Betrag in EUR",
      '<input name="amount" inputmode="decimal" required placeholder="0,00">',
    );
  if (k === "period") f += field("To", "Periodenende", "date", true);
  if (
    ![
      "bar",
      "contact",
      "period",
      "template",
      "opening",
      "actual",
      "reserve",
    ].includes(k)
  )
    f += refs("Bar", "Bar (optional)", ["bar"]);
  if (
    [
      "expense",
      "refund",
      "deposit",
      "deposit-return",
      "donation",
      "payment",
      "count",
      "plan",
      "supply",
      "skim",
      "return",
      "income",
      "presale",
    ].includes(k)
  )
    f += refs("Wallet", "Geldtasche", ["wallet"]);
  if (
    [
      "sponsorship",
      "donation",
      "payment",
      "outlay",
      "income",
      "expense",
      "contact",
    ].includes(k) &&
    k !== "contact"
  )
    f += refs("Contact", "Kontakt", ["contact"]);
  if (k === "organization")
    f +=
      label(
        "Organisationslogo (PNG, optional)",
        '<input type="file" name="logo" accept="image/png">',
      ) +
      field("Address", "Anschrift", "text", true) +
      field("field_IBAN", "Entwicklungskonto / IBAN") +
      field("field_holder", "Kontoinhaber") +
      field("field_legal", "Freigegebener Rechnungstext") +
      field("field_donationLegal", "Freigegebener Spendentext");
  if (k === "contact")
    f +=
      field("field_salutation", "Briefanrede (optional)") +
      field("field_given", "Vorname") +
      field("field_family", "Familienname") +
      (s.donorAccess
        ? field("field_birth", "Geburtsdatum für die Spendenprüfung", "date")
        : "");
  if (["card", "fee", "payout"].includes(k))
    f += field(
      "field_provider",
      "Kartenanbieter / Abrechnungskreis",
      "text",
      true,
    );
  if (k === "presale")
    f +=
      field("field_saleQuantity", "Stückzahl Vorverkauf", "number", true) +
      field("unitSale", "Preis pro Stück in EUR", "text", true) +
      field("field_paymentEvidence", "Zahlungsnachweis / Belegnummer");
  if (k === "expense")
    f += refs("field_sale", "Zugehöriger Vorverkauf (Herstellungskosten)", [
      "presale",
    ]);
  if (k === "paper")
    f +=
      field(
        "Number",
        "Papiernummer P- (nur Zahl, " +
          s.first +
          " bis " +
          (s.paperLimit ?? s.limit) +
          ")",
        "number",
        true,
      ) +
      select("Status", "Papierbelegstatus", [
        ["Ausgegeben", "Ausgegeben"],
        ["Verworfen", "Verworfen"],
      ]) +
      refs("Reference", "Bereits erfasste Barzahlung", [
        "income",
        "payment",
        "donation",
        "presale",
      ]);
  if (k === "contact")
    f += field(
      "field_distinct",
      "Abgrenzung bei gleichem Kontaktnamen (optional)",
    );
  if (k === "sponsorship")
    f +=
      label(
        "Rechnungspositionen (optional, eine pro Zeile: Menge | Leistung | Einzelpreis)",
        '<textarea name="positions"></textarea>',
      ) +
      select(
        "field_pledge",
        "Zusage",
        ["Offen", "Zugesagt", "Zurückgezogen"].map((v) => [v, v]),
      ) +
      field("field_due", "Fälligkeit", "date") +
      field("field_service", "Leistungszeitraum") +
      field("field_paymentRef", "Zahlungsreferenz für Überweisungen");
  if (k === "price")
    f +=
      field("field_guest", "Gästebezeichnung") +
      field("field_allergens", "Bestätigte Allergene") +
      field("field_unitA", "Einheit laut erster Quelle (bei Klärung)") +
      field("field_unitB", "Abweichende Quellenangabe") +
      field("field_unitReason", "Begründung für die geklärte Ausgabeeinheit");
  if (k === "contact")
    f += field("Address", "Anschrift") + field("Category", "Person / Firma");
  if (monetary.has(k) && k !== "price")
    f += s.event.Accounts
      ? refs("Account", "Konto / Quelle", ["account", "wallet"])
      : field("Account", "Konto / Quelle");
  if (["transfer", "payout", "supply", "skim", "return"].includes(k))
    f += s.event.Accounts
      ? refs("To", "Zielkonto", ["account", "wallet"])
      : field("To", "Zielkonto", "text", true);
  if (
    [
      "income",
      "expense",
      "refund",
      "deposit",
      "deposit-return",
      "payment",
      "donation",
      "presale",
    ].includes(k)
  )
    f += select("Method", "Zahlungsart", [
      ["Bar", "Bar"],
      ["Überweisung", "Überweisung"],
      ["Karte", "Karte"],
    ]);
  if (["income", "expense", "payment", "donation", "card"].includes(k))
    f += field("field_matter", "Eindeutige externe Vorgangskennung (optional)");
  if (k === "payment") f += refs("Reference", "Forderung", ["sponsorship"]);
  else if (k === "reimbursement") {
    f += refs("Reference", "Einzelne Privatauslage", ["outlay"]);
    const debts = rows().filter((r) => r.Kind === "outlay");
    if (debts.length)
      f +=
        "<details><summary>Sammelerstattung aufteilen</summary>" +
        debts
          .map((r) =>
            field(
              "alloc_" + r.ID,
              r.Data.Label + " · maximal " + eur(r.Data.Amount),
            ),
          )
          .join("") +
        "</details>";
  } else if (k === "attachment")
    f +=
      refs(
        "Reference",
        "Zugehöriger Vorgang",
        Object.keys(types).filter((n) => n !== "attachment"),
      ) +
      label(
        "PDF, JPEG oder PNG",
        '<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required>',
      );
  else if (k === "template")
    f += select(
      "Reference",
      "Ausgabeprofil",
      profiles.map((p, i) => [profileID(i), p]),
    );
  else if (k === "price")
    f +=
      select("Category", "Sortiment", [
        ["Getränk", "Getränk"],
        ["Essen", "Essen"],
      ]) +
      field("Unit", "Einheit") +
      field("Variant", "Variante") +
      select(
        "Status",
        "Preisstand",
        s.role === "Leitung"
          ? [
              ["Entwurf", "Entwurf"],
              ["Freigegeben", "Freigegeben"],
            ]
          : [["Entwurf", "Entwurf"]],
      );
  else if (k === "donation")
    f +=
      field("Reference", "Sammler/in") +
      field(
        "field_reporting",
        "Meldezeitraum (unabhängig von der Abschlussperiode)",
      ) +
      select("Status", "Spendenart", [
        ["Offen", "Namentlich"],
        ["Anonym", "Anonym"],
      ]);
  else if (
    ["expense", "income", "refund", "deposit", "deposit-return"].includes(k)
  )
    f += field("Category", "Kategorie") + field("Reference", "Belegreferenz");
  if (k === "count")
    f += select("Status", "Erfassungsstand", [
      ["Unbestätigt", "Erfasste Beobachtung"],
      ["Bestätigt", "Zählung bestätigen"],
    ]);
  if (["count", "plan", "reserve"].includes(k)) {
    if (k !== "reserve")
      f += select(
        "Phase",
        "Phase",
        ["Anfang", "Zwischenstand", "Ende"].map((p) => [p, p]),
      );
    f +=
      '</div><h3>Stückelung</h3><div class="pieces">' +
      denom
        .map((c) =>
          label(
            eur(c),
            '<input name="coin' +
              c +
              '" aria-label="Stückzahl ' +
              esc(eur(c)) +
              '" min="0" max="1000000" inputmode="numeric" type="number" value="0" step="1"><small data-piece="' +
              c +
              '">' +
              esc(eur(0)) +
              "</small>",
          ),
        )
        .join("") +
      '</div><p class="count-total">Gezählter Betrag <output id="count-total" aria-live="polite">' +
      esc(eur(0)) +
      '</output></p><div class="form">';
  }
  return (
    f +
    field(
      "Note",
      edit ? "Änderungsgrund" : "Notiz / Textbaustein",
      "text",
      !!edit,
    )
  );
}
function journalFilterFields() {
  const all = rows(),
    labels = new Map(all.map((r) => [r.ID, r.Data.Label]));
  let fields =
    field("from", "Von", "date", false, journalFilters.from || "") +
    field("until", "Bis", "date", false, journalFilters.until || "");
  for (const [key, title, values] of [
    ["kind", "Vorgangsart", groups.Journal.map((k) => [k, types[k]])],
    ...[
      ["category", "Kategorie", "Category"],
      ["method", "Zahlungsart", "Method"],
      ["account", "Konto", "Account"],
      ["bar", "Bar", "Bar"],
    ].map(([key, title, attr]) => [
      key,
      title,
      [...new Set(all.map((r) => r.Data[attr]).filter(Boolean))]
        .sort()
        .map((v) => [v, labels.get(v) || v]),
    ]),
  ]) {
    fields += label(
      title,
      '<select name="' +
        key +
        '"><option value="">Alle</option>' +
        values
          .map(
            ([v, t]) =>
              '<option value="' +
              esc(v) +
              '"' +
              (journalFilters[key] === v ? " selected" : "") +
              ">" +
              esc(t) +
              "</option>",
          )
          .join("") +
        "</select>",
    );
  }
  return fields;
}
function records() {
  const kinds = recordKinds(page);
  if (!kinds.includes(kind)) kind = kinds[0];
  const set = rows().filter(
    (r) =>
      kinds.includes(r.Kind) &&
      (page !== "Journal" || journalMatches(r, journalFilters)) &&
      (!filter ||
        (
          r.Data.Label +
          " " +
          (r.Data.Bar || "") +
          " " +
          (r.Data.Category || "")
        )
          .toLowerCase()
          .includes(filter.toLowerCase())),
  );
  let detail = "";
  if (page === "Journal") {
    const balances = new Map();
    for (const r of rows()) {
      const provider = r.Data.Fields?.provider;
      if (provider && ["card", "fee", "payout"].includes(r.Kind))
        balances.set(
          provider,
          (balances.get(provider) || 0) +
            (r.Kind === "card" ? 1 : -1) * r.Data.Amount,
        );
    }
    detail = [...balances]
      .map(
        ([name, balance]) =>
          "<p>Anbieterguthaben " + esc(name) + " · " + eur(balance) + "</p>",
      )
      .join("");
  }
  if (page === "Sponsoring") {
    const claims = sponsorshipStatus(rows());
    if (claims.length) {
      const originals = claims.flatMap((c) =>
        c.originals.map((doc) => [
          doc.id,
          c.claim.Data.Label + " · Nr. " + doc.number,
        ]),
      );
      detail = panel(
        "Sponsoring",
        '<div class="list"><table><tr><th>Forderung</th><th>Zusage</th><th>Betrag</th><th>Bezahlt</th><th>Offen</th><th>Belege und Versand</th></tr>' +
          claims
            .map(
              (c) =>
                "<tr><td>" +
                esc(c.claim.Data.Label) +
                "</td><td>" +
                esc(c.pledge) +
                "</td><td>" +
                eur(c.claim.Data.Amount) +
                "</td><td>" +
                eur(c.paid) +
                "</td><td>" +
                eur(c.outstanding) +
                "</td><td>" +
                (c.originals
                  .map((o) => "Nr. " + o.number + " · " + esc(o.dispatch))
                  .join("<br>") || "Kein Original ausgestellt") +
                "</td></tr>",
            )
            .join("") +
          "</table></div>" +
          (s.role === "Leitung" && originals.length
            ? form(
                "dispatch",
                select("original", "Ausgestellter Beleg", originals) +
                  select(
                    "delivery",
                    "Extern erfolgte Übergabe",
                    [
                      "Extern übergeben",
                      "Extern versandt",
                      "Vermerk aufgehoben",
                    ].map((v) => [v, v]),
                  ) +
                  field(
                    "evidence",
                    "Nachweis oder Korrekturgrund",
                    "text",
                    true,
                  ),
                "Übergabe dokumentieren",
              )
            : ""),
      );
    }
  }
  if (page === "Perioden" && s.role !== "Kassa") {
    detail =
      form(
        "globalPeriod",
        field("start", "Auswertung von", "date", true, s.event.Starts) +
          field("end", "bis", "date", true, s.event.Ends) +
          select("scope", "Auswertung", [
            ["period", "Aktueller Fachstand"],
            ["journal-period", "Buchungen einschließlich Storno und Ersatz"],
          ]),
        "Zugewiesene Veranstaltungen auswerten",
      ) +
      globalRows
        .map(
          (r) =>
            "<p>" +
            esc(r.datum) +
            " · " +
            esc(r.veranstaltung) +
            " · " +
            esc(r.bezeichnung) +
            (r.revision
              ? " · " +
                esc(r.richtung) +
                " · Revision " +
                esc(r.revision) +
                " · " +
                esc(r.akteur)
              : "") +
            " · " +
            eur(r.cent) +
            "</p>",
        )
        .join("");
  }
  if (page === "Perioden" && s.role !== "Kassa") {
    detail += form(
      "periodAction",
      refs("id", "Abrechnungsperiode", ["period"]) +
        select(
          "action",
          "Vorgang",
          s.role === "Prüfung"
            ? [["period-close", "Zeitraum freigeben"]]
            : [["period-open", "Zeitraum wieder öffnen"]],
        ) +
        field("reason", "Begründung für Wiederöffnung"),
      "Periodenstand bestätigen",
    );
  }
  if (page === "Perioden" && s.role === "Leitung")
    detail += form(
      "carry",
      refs("period", "Zielperiode", ["period"]) +
        field("reason", "Begründung bei Austausch eines früheren Übertrags"),
      "Bestätigten Vorperiodenstand übernehmen",
    );
  if (page === "Geldtaschen") {
    detail = rows()
      .filter((r) => r.Kind === "wallet")
      .map(
        (r) =>
          "<p>" +
          esc(r.Data.Label) +
          " · Weitere Sammelbareinnahme " +
          eur(counted(rows(), r.ID)) +
          " " +
          (counted(rows(), r.ID) !== null &&
          (counted(rows(), r.ID) !== 0 ||
            !rows().some((x) => x.ID === "settlement:" + r.ID))
            ? '<button type="button" data-settle="' +
              esc(r.ID) +
              '">' +
              (rows().some((x) => x.ID === "settlement:" + r.ID)
                ? "Sammelbetrag berichtigen"
                : "Sammelbetrag buchen") +
              "</button>"
            : "") +
          "</p>",
      )
      .join("");
  }
  if (page === "Geldtaschen") {
    const plan = denominationNeeds(rows()).filter((r) => r.need || r.stock);
    if (plan.length)
      detail += panel(
        "Wechselgeld über alle Geldtaschen",
        "<table><thead><tr><th>Nennwert</th><th>Bedarf</th><th>Verfügbar</th><th>Fehlmenge</th></tr></thead><tbody>" +
          plan
            .map(
              (r) =>
                "<tr><td>" +
                eur(r.cent) +
                "</td><td>" +
                r.need +
                "</td><td>" +
                (r.stock ?? "Offen") +
                "</td><td>" +
                (r.missing ?? "Offen") +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>",
      );
  }
  if (page === "Geldtaschen" && !s.sealed && s.role !== "Prüfung") {
    detail += form(
      "handover",
      refs("wallet", "Geldtasche", ["wallet"]) +
        select(
          "to",
          "Empfangendes Gerät",
          (s.devices || []).filter((d) => !d.Sealed).map((d) => [d.ID, d.Name]),
        ) +
        select("status", "Übergabe", [
          ["Angeboten", "Übergabe anbieten"],
          ["Bestätigt", "Empfang bestätigen"],
        ]),
      "Übergabe dokumentieren",
    );
  }
  return (
    panel(
      "Einträge",
      '<details class="filter-box"' +
        (filter || Object.values(journalFilters).some(Boolean) ? " open" : "") +
        "><summary>Einträge filtern</summary>" +
        form(
          "filter",
          field(
            "filter",
            "Bezeichnung oder Kategorie suchen",
            "search",
            false,
            filter,
          ) + (page === "Journal" ? journalFilterFields() : ""),
          "Filtern",
        ) +
        "</details>" +
        table(set, true) +
        detail,
    ) +
    ((entryOpen || edit) &&
    !s.sealed &&
    !s.closed &&
    s.role !== "Prüfung" &&
    (page !== "Verwaltung" || s.role === "Leitung")
      ? panel(
          edit ? "Eintrag berichtigen" : "Eintrag erfassen",
          select(
            "type",
            "Vorgang",
            kinds.map((k) => [k, types[k]]),
          ) +
            form(
              "record",
              formFields(kind),
              edit ? "Berichtigung speichern" : "Lokal speichern",
            ) +
            button("cancel", "Abbrechen", true),
        )
      : "")
  );
}
let donorReview;
const donorRequest = (body) => api("donation-reports", body, bearer());
function donationPanel() {
  if (!s.donorAccess || s.recovery) return "";
  const review = donorReview?.device === s.device ? donorReview : null;
  let content = form(
    "donorLoad",
    field(
      "period",
      "Meldezeitraum",
      "text",
      true,
      review?.period || String(new Date().getFullYear()),
    ),
    "Prüfstand online laden",
  );
  if (!review) return panel("Spendenmeldedaten", content);
  const data = review.preview.daten;
  content +=
    "<p>" +
    data.Spenden.length +
    " meldbare Spenden · " +
    eur(data.SummeCent) +
    " · " +
    data.Ausgeschlossen.length +
    " ausgeschlossen</p><details><summary>Prüfdaten und Ausschlussgründe ansehen</summary><pre>" +
    esc(JSON.stringify(data, null, 2)) +
    "</pre></details>";
  const latest = review.history.at(-1);
  if (latest)
    content +=
      "<ol>" +
      review.history
        .map(
          (h) =>
            "<li>" +
            esc(
              h.at + " · " + h.actor + " · " + h.status + " · " + h.evidence,
            ) +
            "</li>",
        )
        .join("") +
      "</ol>";
  const next = {
    Geprüft: ["Exportiert", "Korrektur"],
    Exportiert: ["Übermittelt", "Korrektur"],
    Übermittelt: ["Bestätigt", "Korrektur"],
    Bestätigt: ["Korrektur"],
  };
  const options =
    latest && latest.status !== "Korrektur" ? next[latest.status] : ["Geprüft"];
  content += form(
    "donorDecision",
    select(
      "step",
      "Entscheidung",
      options.map((v) => [v, v]),
    ) + field("reason", "Prüfvermerk oder externer Nachweis", "text", true),
    "Entscheidung dokumentieren",
  );
  const released = review.history.filter((h) => h.status === "Exportiert");
  if (released.length)
    content += form(
      "donorDownload",
      select(
        "report",
        "Gespeicherter Export",
        released.map((h) => [h.id, h.at + " · " + h.id]),
      ),
      "Geprüfte Datei herunterladen",
    );
  return panel("Spendenmeldedaten", content);
}
function exchange() {
  const periods = rows().filter((r) => r.Kind === "period");
  return (
    panel(
      "Auswertungszeitraum",
      select("reportPeriod", "Zeitraum", [
        ["", "Gesamter lokaler Stand"],
        ...periods.map((r) => [
          r.ID,
          r.Data.Label + " · " + r.Data.Date + " bis " + r.Data.To,
        ]),
      ]) +
        '<div class="actions">' +
        button("csv", "Journal als CSV") +
        button("xlsx", "Journal als Excel") +
        button("evidence", "Prüfpaket laden") +
        (s.donorAccess
          ? field(
              "donorPeriod",
              "Meldezeitraum Spenden",
              "text",
              true,
              String(new Date().getFullYear()),
            ) + button("donors", "Spendenliste laden")
          : "") +
        "</div>",
    ) +
    donationPanel() +
    panel(
      "Importvorschau",
      form(
        "preview",
        select("sourceRole", "Quellenrolle", [
          ["Journal", "BONFIRE-Journal"],
          ["D1", "Historischer Abschluss · D1"],
          ["D8", "Vorbereitete Folgevorlage · D8"],
        ]) +
          field(
            "year",
            "Quellenjahr",
            "number",
            true,
            String(new Date().getFullYear()),
          ) +
          label(
            "Journaldatei (CSV oder XLSX)",
            '<input type="file" name="file" accept=".xlsx,.csv" required>',
          ),
        "Datei prüfen",
      ) +
        (imported.length
          ? "<p>" +
            imported.length +
            ' Quellenzeilen</p><div class="list"><table><tr><th>Quelle</th><th>Blatt / Zeile</th><th>Datum</th><th>Herkunft Datum</th><th>Original</th><th>Bezeichnung</th><th>Art</th><th>Betrag</th><th>Prüfstand</th></tr>' +
            imported
              .map(
                (r) =>
                  "<tr>" +
                  [
                    importRole,
                    r.sheet ? r.sheet + "!" + r.cell : r.row,
                    r.date || "Offen",
                    r.yearOrigin || "Quelldatum",
                    r.cached != null
                      ? r.raw +
                        " · Cache " +
                        (r.cached || "fehlt") +
                        (r.calculatedCent != null
                          ? " · nachgerechnet " + eur(r.calculatedCent)
                          : "") +
                        (r.differenceCent
                          ? " · Abweichung " + eur(r.differenceCent)
                          : "")
                      : (r.raw ??
                        (r.amount == null ? "Offen" : String(r.amount))),
                    r.label,
                    types[r.kind] || "Zuordnung offen",
                    eur(r.amount),
                    r.status,
                  ]
                    .map((v) => "<td>" + esc(v) + "</td>")
                    .join("") +
                  "</tr>",
              )
              .join("") +
            "</table></div>" +
            form(
              "importRow",
              select(
                "ix",
                "Einzeln geprüfte Zeile",
                imported.map((r, i) => [
                  i,
                  (r.sheet ? r.sheet + "!" + r.cell : r.row) + " · " + r.label,
                ]),
              ) +
                select("kind", "Buchungsart", [
                  ["income", "Einnahme"],
                  ["expense", "Ausgabe"],
                ]) +
                field("date", "Geprüftes Buchungsdatum", "date", true) +
                field("account", "Konto") +
                field("reason", "Prüfvermerk / Entscheidung", "text", true),
              "Geprüfte Zeile übernehmen",
            )
          : ""),
    )
  );
}
function reportRows() {
  const period = rows().find((r) => r.ID === chosenPeriod);
  return rows().filter(
    (r) =>
      !period ||
      (r.Data.Date >= period.Data.Date && r.Data.Date <= period.Data.To),
  );
}
function installStudio() {
  const options = document.querySelector("#export").closest("section");
  const editor = document.querySelector("#template").closest("section");
  const studio = document.createElement("div");
  studio.className = "document-studio";
  options.before(studio);
  const controls = document.createElement("div");
  controls.className = "doc-controls";
  controls.append(options, editor);
  studio.innerHTML =
    '<div class="proof-tabs"><button type="button" data-act="docInputs">Eingabe</button><button type="button" data-act="docProof">Druckvorschau</button></div>';
  studio.append(controls);
  const proof = document.createElement("section");
  proof.className = "proof";
  proof.innerHTML =
    '<h2>Druckvorschau</h2><p id="proof-status">Profil und Fachvorgang wählen, um die Arbeitsfassung zu prüfen.</p><div id="proof-sheet"></div>' +
    button("docProof", "Vorschau aktualisieren", true);
  studio.append(proof);
  document
    .querySelector("#export .actions")
    .insertAdjacentHTML(
      "beforeend",
      button("docProof", "Druckvorschau öffnen", true),
    );
  document
    .querySelector("#template")
    .insertAdjacentHTML(
      "beforeend",
      button("draftProof", "Änderungen ansehen", true),
    );
}
async function proofDocument(editing) {
  const studio = document.querySelector(".document-studio"),
    host = studio.querySelector("#proof-sheet"),
    status = studio.querySelector("#proof-status");
  studio.classList.add("view-proof");
  host.replaceChildren();
  status.textContent = "Arbeitsfassung wird lokal aufgebaut …";
  try {
    const vals = Object.fromEntries(
      new FormData(document.querySelector("#export")),
    );
    let source = s,
      index = Number(vals.profile);
    if (editing) {
      const form = Object.fromEntries(
          new FormData(document.querySelector("#template")),
        ),
        ref = form.Reference;
      index = profiles.findIndex((_, i) => profileID(i) === ref);
      const base =
        s.drafts?.[ref] ||
        (s.pinnedTemplates || s.entries).find((r) => r.ID === "template:" + ref)
          ?.Data ||
        {};
      source = {
        ...s,
        drafts: {
          ...s.drafts,
          [ref]: {
            ...base,
            Label: form.Label,
            Note: form.Note,
            Fields: {
              ...base.Fields,
              font: form.font,
              footer: form.footer,
              margin: form.margin,
              header: form.header,
              copies: form.copies,
              firstColumn: form.firstColumn,
              paper: form.paper,
            },
          },
        },
      };
      vals.version = "draft";
    }
    const snap = snapshot(index, source, rows(), { ...vals, number: null });
    const files = await renderDocument(snap);
    await displayProof(host, files.docx);
    status.textContent =
      profiles[index] +
      " · " +
      snap.width +
      " × " +
      snap.height +
      " mm · " +
      (vals.version === "draft" ? "Entwurf" : snap.templateVersionID) +
      " · Word-Arbeitsfassung";
  } catch (err) {
    status.textContent = err.message;
    throw err;
  }
}
function docs() {
  const originals = rows().filter((r) => r.Kind === "original");
  return (
    panel(
      "Dokument erstellen",
      form(
        "export",
        select(
          "profile",
          "Vorlage",
          profiles.map((p, i) => [i, p]),
        ) +
          refs("subject", "Fachvorgang (je nach Vorlage)", [
            "sponsorship",
            "payment",
            "donation",
            "count",
            "plan",
          ]) +
          refs("bar", "Bar (für Barbericht)", ["bar"]) +
          refs("period", "Periode (für Journal und Prüfbericht)", ["period"]) +
          select("paper", "Gästepreisliste Papier", [
            ["Profil", "Wie im Vorlagenprofil"],
            ["Letter", "Letter · Quellenformat"],
            ["A4", "A4 · alternative Fassung"],
          ]) +
          field(
            "organization",
            "Organisation",
            "text",
            true,
            rows().find((r) => r.Kind === "organization")?.Data.Label || "",
          ) +
          ((s.priceHistory || []).length
            ? select("priceVersion", "Preisstand für Karten und Gästeliste", [
                ["", "Aktuelle freigegebene Preise"],
                ...[
                  ...new Map(
                    s.priceHistory.map((p) => [p.Version, p]),
                  ).values(),
                ]
                  .reverse()
                  .map((p) => [
                    String(p.Version),
                    p.At.slice(0, 19) + " · Stand " + p.Version,
                  ]),
              ])
            : "") +
          select("version", "Vorlagenstand", [
            ["active", "Freigegebene Fassung"],
            ["draft", "Lokaler Entwurf"],
          ]) +
          field("revisionReason", "Korrekturgrund (für Ersatzbeleg)") +
          select("format", "Ausgabe", [
            ["PDF", "PDF-Arbeitsfassung"],
            ["DOCX", "DOCX-Arbeitsfassung"],
            ["Original", "Nummeriertes Original archivieren"],
            ["Korrektur", "Begründete Korrekturfassung archivieren"],
          ]),
        "Dokument erzeugen",
      ),
    ) +
    panel(
      "Dankesbriefe als Serie",
      form(
        "letters",
        rows()
          .filter((r) => r.Kind === "donation" && r.Data.Contact)
          .map((r) =>
            label(
              r.Data.Label,
              '<input type="checkbox" name="recipients" value="' +
                esc(r.ID) +
                '">',
            ),
          )
          .join(""),
        "Ausgewählte Briefe als ZIP laden",
      ),
    ) +
    panel(
      "Archiv",
      "<p>Freie Nummern dieses Geräts: " +
        availableNumbers(s) +
        "</p>" +
        originals
          .map(
            (r) =>
              "<p>" +
              esc(r.Data.Label) +
              " · " +
              r.Data.Number +
              ' <button data-file="' +
              esc(r.ID) +
              '" data-format="PDF">PDF</button> <button data-file="' +
              esc(r.ID) +
              '" data-format="DOCX">DOCX</button></p>',
          )
          .join(""),
    ) +
    panel(
      "Vorlagen anpassen",
      button(
        "pinTemplates",
        "Freigegebenen Vorlagenstand für dieses Gerät übernehmen",
        true,
      ) +
        form(
          "template",
          select(
            "Reference",
            "Profil",
            profiles.map((p, i) => [profileID(i), p]),
          ) +
            field("Label", "Überschrift", "text", true) +
            label(
              "Textbaustein",
              '<textarea name="Note">' +
                esc(s.importedText || "") +
                "</textarea>",
            ) +
            select("font", "Schriftpreset", [
              ["helvetica", "Sans Serif"],
              ["times", "Serif"],
              ["courier", "Monospace"],
            ]) +
            field("header", "Kartenkopf (optional)") +
            field(
              "copies",
              "Karten je Blatt (bis 3 Getränke / 7 Essen)",
              "number",
            ) +
            field(
              "firstColumn",
              "Kartenbreite erste Spalte in mm (40–75)",
              "number",
            ) +
            select("paper", "Gästepreisliste Standardpapier", [
              ["Letter", "Letter"],
              ["A4", "A4"],
            ]) +
            field("footer", "Fußzeile") +
            field("margin", "Seitenrand in mm", "number", true, "15"),
          "Entwurf lokal speichern",
        ).replace(
          "</form>",
          '<button data-release="true">Fassung freigeben</button></form>',
        ) +
        form(
          "wordLayout",
          label(
            "Word-Layout für Dankesbriefe (A4, DOCX)",
            '<input type="file" name="file" accept=".docx" required>',
          ),
          "Word-Layout als lokalen Briefentwurf übernehmen",
        ) +
        (s.drafts?.[profileID(6)]?.File
          ? "<p>Word-Layout lokal gespeichert</p>"
          : "") +
        form(
          "importTemplate",
          label(
            "DOCX-Textvorlage",
            '<input type="file" name="file" accept=".docx" required>',
          ),
          "Text und Felder übernehmen",
        ) +
        form(
          "lfk",
          label(
            "LFK-Formular als freigegebener Druckhintergrund",
            '<input type="file" name="file" accept=".pdf" required>',
          ),
          "A6-Formular vorbereiten",
        ),
    )
  );
}
function preparePanel() {
  return panel(
    "Veranstaltung vorbereiten",
    events.some((e) => !e.Closed)
      ? form(
          "prepare",
          select(
            "event",
            "Veranstaltung",
            events.filter((e) => !e.Closed).map((e) => [e.ID, e.Name]),
          ) +
            field("name", "Gerätename", "text", true) +
            field(
              "digitalCount",
              "Benötigte digitale Belegnummern (0–1000)",
              "number",
              true,
              onlineUser?.role === "Prüfung" ? "0" : "1000",
            ) +
            select("donor", "Meldedaten auf diesem Gerät", [
              ["", "Standardprofil"],
              ...(onlineUser?.role === "Leitung"
                ? [["ja", "Belegprofil mit sensiblen Daten (Leitung)"]]
                : []),
            ]) +
            field(
              "pass",
              "Lokales Passwort (mindestens 10 Zeichen)",
              "password",
              true,
            ),
          "Offlineprofil speichern",
        )
      : "<p>Keine offene Veranstaltung zugewiesen.</p>",
  );
}
function onlineAdmin() {
  return (
    (onlineUser?.role === "Leitung"
      ? panel(
          "Veranstaltung anlegen",
          form(
            "event",
            select("General", "Arbeitsbereich", [
              ["", "Veranstaltung"],
              ["ja", "Allgemeines Kassenbuch ohne Veranstaltung"],
            ]) +
              field("Name", "Name des Arbeitsbereichs", "text", true) +
              field("Starts", "Beginn", "date", true, today()) +
              field("Ends", "Ende", "date", true, today()) +
              select("Accounts", "Kontozuordnung", [
                ["", "Aus"],
                ["ja", "Ein"],
              ]),
            "Veranstaltung speichern",
          ),
        ) +
        panel(
          "Benutzer zuweisen",
          form(
            "user",
            field("Name", "E-Mail-Adresse oder Benutzername", "text", true) +
              field("Password", "Startpasswort", "password", true) +
              select("Role", "Rolle", [
                ["Kassa", "Kassa"],
                ["Prüfung", "Prüfung"],
              ]) +
              select(
                "Event",
                "Veranstaltung",
                events.map((e) => [e.ID, e.Name]),
              ),
            "Benutzer anlegen",
          ),
        ) +
        panel(
          "Zugriff ändern",
          form(
            "access",
            field("Name", "Bestehender Benutzer", "text", true) +
              select(
                "Event",
                "Veranstaltung",
                events.map((e) => [e.ID, e.Name]),
              ) +
              select("Action", "Zugriff", [
                ["grant", "Zuweisen"],
                ["revoke", "Entziehen"],
              ]) +
              field("Reason", "Begründung", "text", true),
            "Zuweisung speichern",
          ),
        )
      : "") +
    panel(
      "Zwei-Faktor-Anmeldung",
      mfaCodes.length
        ? "<p>Recoverycodes sicher aufbewahren</p><pre>" +
            esc(mfaCodes.join("\n")) +
            "</pre>"
        : mfaSecret
          ? "<p>Schlüssel in der Authenticator-App hinterlegen: " +
            esc(mfaSecret) +
            "</p>" +
            form(
              "mfa",
              field("Code", "Bestätigungscode", "text", true),
              "Faktor aktivieren",
            )
          : button("mfa", "Authenticator einrichten"),
    )
  );
}
function profileTools() {
  return panel(
    "Offlineprofile auf diesem Gerät",
    button("newProfile", "Neues Arbeitsprofil", true) +
      profilesLocal
        .map(
          (k, i) =>
            ' <a href="/?profil=' +
            encodeURIComponent(k) +
            '">Profil ' +
            (i + 1) +
            "</a>",
        )
        .join("") +
      (!saved
        ? "<h3>Gerätesicherung einsehen</h3><p>Öffne eine verschlüsselte Sicherung mit ihrem bisherigen lokalen Passwort. Das Archiv zeigt den gespeicherten Stand. Buchen und Synchronisieren sind im Archiv gesperrt.</p>" +
          form(
            "recoverProfile",
            label(
              "Verschlüsselte Gerätesicherung",
              '<input type="file" name="file" required>',
            ) + field("pass", "Bisheriges lokales Passwort", "password", true),
            "Als Lesearchiv öffnen",
          )
        : ""),
  );
}
let loginChallenge = "",
  loginIdentity = "",
  useRecoveryCode = false,
  profileHelp = false;
function authSurface() {
  const brand = document.querySelector("#sidebar header").outerHTML;
  let title, content, secondary;
  if (profileHelp) {
    title = "Offlineprofile und Sicherungen";
    content = profileTools();
    secondary = button("backLogin", "Zurück", true);
  } else if (saved) {
    title = "Gerät entsperren";
    content = form(
      "unlock",
      label(
        "Lokales Passwort",
        '<input type="password" name="pass" autocomplete="current-password" required>',
      ),
      "Entsperren",
    );
    secondary =
      button("recover", "Gerätesicherung speichern", true) +
      button("profileHelp", "Weitere Offlineprofile", true);
  } else if (loginChallenge) {
    title = useRecoveryCode ? "Recoverycode eingeben" : "Anmeldung bestätigen";
    content =
      '<p class="auth-hint">' +
      esc(loginIdentity) +
      "</p>" +
      form(
        "loginFactor",
        label(
          useRecoveryCode
            ? "Recoverycode"
            : "Code aus deiner Authenticator-App",
          '<input name="otp" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required ' +
            (useRecoveryCode
              ? 'maxlength="16"'
              : 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"') +
            ">",
        ),
        "Bestätigen",
      );
    secondary =
      button(
        "changeFactor",
        useRecoveryCode
          ? "Authenticator-Code verwenden"
          : "Recoverycode verwenden",
        true,
      ) + button("backLogin", "Zurück zur Anmeldung", true);
  } else {
    title = "Anmelden";
    content = form(
      "login",
      label(
        "E-Mail-Adresse oder Benutzername",
        '<input name="user" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" value="' +
          esc(loginIdentity) +
          '" required>',
      ) +
        label(
          "Passwort",
          '<input name="pass" type="password" autocomplete="current-password" required>',
        ),
      "Anmelden",
    );
    secondary = button("profileHelp", "Offlineprofile und Sicherungen", true);
  }
  return (
    '<div class="auth-card">' +
    brand +
    '<div class="auth-body"><h1>' +
    title +
    "</h1>" +
    content +
    "</div><footer>" +
    secondary +
    "</footer></div>"
  );
}
let entryOpen = false;
let overviewPeriod = "";
let onlineUser = null,
  onlineData = null,
  preferredEvent = "",
  destination = "Übersicht";
const pageDescriptions = {
  Journal: "Zahlungen, Belege und Berichtigungen im gewählten Arbeitsbereich.",
  Kontakte: "Personen und Firmen für Sponsoring und Spenden.",
  Spenden: "Spendeneingänge und Meldedaten im gewählten Arbeitsbereich.",
  Dokumente: "Belege ausstellen, Originale nachdrucken und Vorlagen anpassen.",
  Perioden: "Abrechnungszeitraum, Istbestände und Freigabe.",
  Verwaltung: "Organisation, Benutzer und Geräte verwalten.",
};
function pageHead(title, description = "", action = "") {
  return (
    '<div class="page-head"><div>' +
    heading(title) +
    (description ? "<p>" + esc(description) + "</p>" : "") +
    "</div>" +
    action +
    "</div>"
  );
}
function prepareView() {
  return (
    pageHead(
      "Gerät vorbereiten",
      "Für lokale Erfassung, Belegausgabe und Arbeiten ohne Netz.",
    ) +
    preparePanel() +
    "<details><summary>Weitere Profile und Wiederherstellung</summary>" +
    profileTools() +
    "</details>"
  );
}
async function onlineStart(user) {
  onlineUser = user;
  events = await api("events");
  const day = today(),
    distance = (e) =>
      day < e.Starts
        ? Date.parse(e.Starts) - Date.parse(day)
        : day > e.Ends
          ? Date.parse(day) - Date.parse(e.Ends)
          : 0;
  const chosen =
    events.find((e) => e.ID === preferredEvent) ||
    [...events].sort(
      (a, b) =>
        Number(a.Closed) - Number(b.Closed) ||
        distance(a) - distance(b) ||
        a.Name.localeCompare(b.Name),
    )[0];
  onlineData = chosen
    ? await api("workplace?event=" + encodeURIComponent(chosen.ID))
    : null;
  preferredEvent = chosen?.ID || "";
  logged = true;
}
let serverReachable = null;
let healthRequest = 0;
function paintConnection() {
  const online = navigator.onLine && serverReachable;
  const status = !navigator.onLine
    ? "Offline"
    : serverReachable === null
      ? "Verbindung wird geprüft"
      : online
        ? "Server erreichbar"
        : "Server nicht erreichbar";
  const network = document.querySelector("#connection");
  network.innerHTML =
    icon(online ? "Laptop" : "WifiOff") +
    esc(status) +
    (s
      ? '<span class="connection-queue">' + s.ops.length + " ausstehend</span>"
      : "");
}
async function checkConnection() {
  const request = ++healthRequest;
  if (document.hidden) return;
  let available = false;
  if (navigator.onLine) {
    try {
      const response = await fetch("/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(4500),
      });
      available = response.ok && (await response.json()) === "bereit";
    } catch {
      /* An unreachable server leaves the local profile usable. */
    }
  }
  if (request === healthRequest) {
    serverReachable = available;
    paintConnection();
  }
}
function shell() {
  const active = !!s || logged,
    who = s || onlineUser;
  nav.innerHTML = navigation(page, who?.user, who?.role, active);
  const org = s
    ? rows().find((r) => r.Kind === "organization")?.Data
    : onlineData?.entries.find((r) => r.Kind === "organization")?.Data;
  document.querySelector("#crumb").textContent =
    (org?.Label || "Feuerwehrfinanzen") +
    "   /   " +
    (active
      ? page === "Einrichtung"
        ? "Gerät vorbereiten"
        : titleOf(page)
      : saved
        ? "Entsperren"
        : "Anmeldung");
  const mark = document.querySelector("#station");
  mark.innerHTML =
    org?.File || org?.Logo
      ? '<img alt="" src="data:image/png;base64,' +
        esc(org.File || org.Logo) +
        '">'
      : icon("Landmark");
  const picker = document.querySelector("#workspace-picker");
  picker.innerHTML =
    logged && !s && events.length
      ? select(
          "workspace",
          "Arbeitsbereich",
          events.map((e) => [e.ID, e.Name]),
        )
      : "";
  if (picker.firstChild) picker.querySelector("select").value = preferredEvent;
  paintConnection();
  document.querySelector("#menu-toggle").innerHTML = icon("Menu");
  document.querySelector("#content").dataset.module = sectionOf(page);
}
function onlineView() {
  if (page === "Einrichtung") return prepareView();
  if (
    page === "Verwaltung" ||
    page === "Gerät & Sync" ||
    page === "Datenaustausch"
  )
    return (
      pageHead("Verwaltung", pageDescriptions.Verwaltung) +
      route("Einrichtung", "Gerät vorbereiten", "secondary", "Laptop") +
      onlineAdmin() +
      "<details><summary>Profile und Sicherungen</summary>" +
      profileTools() +
      "</details>"
    );
  if (!onlineData)
    return (
      pageHead(
        "Dein Arbeitsplatz",
        "Es ist noch kein Arbeitsbereich zugewiesen.",
      ) +
      (onlineUser.role === "Leitung"
        ? route("Verwaltung", "Arbeitsbereich anlegen", "primary", "Plus")
        : "<p>Die Leitung kann dir eine Veranstaltung oder ein Kassenbuch zuweisen.</p>")
    );
  const { event: e, entries: list, pending, conflicts } = onlineData;
  if (page === "Übersicht" || page === "Veranstaltungen")
    return overview(
      e,
      list,
      pending,
      conflicts,
      false,
      page === "Veranstaltungen",
      onlineUser.role,
      overviewPeriod,
    );
  const isEvent = sectionOf(page) === "Veranstaltungen";
  const content =
    page === "Journal" || page === "Zahlungen"
      ? ledger(bookings(list))
      : page === "Dokumente"
        ? '<ul class="catalog">' +
          profiles
            .map((p) => "<li>" + icon("Files") + esc(p) + "</li>")
            .join("") +
          "</ul>"
        : moduleList(page, list);
  return (
    pageHead(
      isEvent ? e.Name : titleOf(page),
      pageDescriptions[page] || e.Name,
      e.Closed
        ? ""
        : route(
            "Einrichtung",
            onlineUser.role === "Prüfung"
              ? "Prüfprofil vorbereiten"
              : "Erfassung vorbereiten",
            "primary",
            "Laptop",
          ),
    ) +
    (isEvent ? tabs(eventTabs, page) : "") +
    panel(
      page === "Dokumente"
        ? "Vorlagenprofile"
        : isEvent
          ? eventTabs.find(([k]) => k === page)[1]
          : page === "Journal"
            ? "Buchungen"
            : "Einträge",
      content,
    )
  );
}
function show() {
  document.body.classList.toggle("auth-screen", !s && !logged);
  notice.textContent = "";
  state.textContent = "";
  shell();
  if (!s) {
    article.innerHTML = logged ? onlineView() : authSurface();
    const selector = article.querySelector("#prepare [name=event]");
    if (
      selector &&
      [...selector.options].some((o) => o.value === preferredEvent)
    )
      selector.value = preferredEvent;
    return;
  }
  state.textContent =
    s.event.Name +
    "   /   " +
    (s.closed
      ? "Abgeschlossen"
      : s.sealed
        ? "Erfassung beendet"
        : s.ending
          ? "Erfassungsende ausstehend"
          : "Lokaler Arbeitsstand") +
    (s.synced
      ? " · Letzter Abgleich " + new Date(s.synced).toLocaleString("de-AT")
      : " · Erster Abgleich offen") +
    (s.conflicts.length ? " · " + s.conflicts.length + " Klärfälle" : "") +
    "   ·   " +
    s.ops.length +
    " ausstehend";
  const isEvent = sectionOf(page) === "Veranstaltungen",
    isAdmin = sectionOf(page) === "Verwaltung";
  article.innerHTML =
    page === "Übersicht" || page === "Veranstaltungen"
      ? overview(
          { ...s.event, Closed: s.closed },
          rows(),
          s.pending ?? 0,
          s.conflicts.length,
          true,
          page === "Veranstaltungen",
          s.role,
          overviewPeriod,
        )
      : pageHead(
          isEvent ? s.event.Name : titleOf(page),
          pageDescriptions[page] || s.event.Name,
          recordKinds(page).length &&
            !s.closed &&
            !s.sealed &&
            s.role !== "Prüfung"
            ? button(
                "focusEntry",
                page === "Journal" ? "Buchung erfassen" : "Eintrag erfassen",
              )
            : "",
        ) +
        (isEvent
          ? tabs(eventTabs, page)
          : isAdmin
            ? tabs(adminTabs, page)
            : "") +
        (page === "Datenaustausch"
          ? exchange()
          : page === "Dokumente"
            ? docs()
            : page === "Gerät & Sync"
              ? devicePage()
              : records()) +
        (page === "Verwaltung"
          ? panel(
              "Weitere Arbeitsbereiche",
              button("newProfile", "Anderen Arbeitsbereich öffnen", true),
            )
          : "") +
        (page === "Spenden" ? donationPanel() : "") +
        (page === "Preise"
          ? route(
              "Dokumente",
              "Preisliste und Karten drucken",
              "secondary",
              "Files",
            )
          : "");
  if (page === "Dokumente") installStudio();
  const periodSelect = article.querySelector("[name=reportPeriod]");
  if (periodSelect) periodSelect.value = chosenPeriod;
  const type = article.querySelector("[name=type]");
  if (type) {
    type.value = kind;
    type.disabled = !!edit;
  }
  if (edit) {
    const f = article.querySelector("#record");
    if (f)
      for (const [k, v] of Object.entries(edit.Data)) {
        if (f.elements.namedItem(k)) f.elements.namedItem(k).value = v ?? "";
        if (k === "Amount" && f.elements.amount)
          f.elements.amount.value =
            v == null
              ? ""
              : Math.floor(v / 100) + "," + String(v % 100).padStart(2, "0");
        if (k === "Lines" && f.elements.positions)
          f.elements.positions.value = (v || [])
            .map(
              (l) =>
                l.QuantityMilli / 1000 +
                " | " +
                l.Description +
                " | " +
                (l.UnitCents / 100).toFixed(2),
            )
            .join("\n");
        if (k === "Allocations")
          for (const [src, n] of Object.entries(v || {})) {
            if (f.elements["alloc_" + src])
              f.elements["alloc_" + src].value = (n / 100).toFixed(2);
          }
        if (k === "Fields")
          for (const [name, value] of Object.entries(v || {})) {
            if (f.elements["field_" + name])
              f.elements["field_" + name].value = value;
          }
        if (k === "Pieces")
          for (const [coin, n] of Object.entries(v || {}))
            if (f.elements["coin" + coin]) f.elements["coin" + coin].value = n;
      }
    if (f?.elements.Note) f.elements.Note.value = "";
    if (f?.querySelector("#count-total")) updateCount(f);
  }
}
let backgroundSync;
async function action(fn) {
  if (backgroundSync) await backgroundSync;
  if (busy) return;
  busy = true;
  article.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (e) {
    notice.textContent = e.message || "Vorgang fehlgeschlagen.";
  } finally {
    article.setAttribute("aria-busy", "false");
    busy = false;
  }
}
async function submit(f) {
  const vals = Object.fromEntries(new FormData(f));
  const id = f.id;
  if (id === "conflictFile") {
    const out = await api(
      "manage",
      { Action: "conflict-file", Target: vals.operation },
      bearer(),
    );
    download(
      from64(
        out[vals.format],
        vals.format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      "Konfliktfassung-" +
        out.number +
        "-" +
        vals.operation +
        "." +
        vals.format,
    );
  }
  if (id === "donorLoad") {
    await sync();
    const period = vals.period.trim();
    const preview = await donorRequest({ Action: "Vorschau", Period: period });
    const history = await donorRequest({ Action: "Verlauf", Period: period });
    donorReview = {
      device: s.device,
      period,
      preview,
      history,
      report: crypto.randomUUID(),
    };
  }
  if (id === "donorDecision" || id === "donorDownload") {
    if (donorReview?.device !== s.device || !s.donorAccess)
      throw Error("Prüfstand neu laden.");
    const { period, preview, report, history } = donorReview;
    if (id === "donorDecision") {
      const key = JSON.stringify([
        period,
        report,
        history.at(-1)?.id,
        vals.step,
        vals.reason,
      ]);
      if (donorReview.pending?.key !== key)
        donorReview.pending = { key, id: crypto.randomUUID() };
      await donorRequest({
        Action: vals.step,
        Period: period,
        Report: vals.step === "Geprüft" ? report : history.at(-1)?.id,
        Digest: preview.sha256,
        Reason: vals.reason,
        Request: donorReview.pending.id,
      });
      donorReview.history = await donorRequest({
        Action: "Verlauf",
        Period: period,
      });
      donorReview.report = crypto.randomUUID();
    } else {
      const file = await donorRequest({
        Action: "Datei",
        Period: period,
        Report: vals.report,
      });
      const bytes = new TextEncoder().encode(file.datei);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== file.sha256)
        throw Error("Prüfsumme der Exportdatei stimmt nicht.");
      download(
        new Blob([bytes], { type: "application/json" }),
        "Spendenexport-" + vals.report + ".json",
      );
    }
  }
  if (id === "login" || id === "loginFactor") {
    const headers = { "X-Bonfire-Login": "staged" };
    if (id === "login") {
      loginIdentity = vals.user.trim();
      const bytes = new TextEncoder().encode(loginIdentity + ":" + vals.pass);
      headers.Authorization = "Basic " + btoa(String.fromCharCode(...bytes));
    } else {
      headers.Authorization = "Bonfire-Challenge " + loginChallenge;
      headers["X-Bonfire-OTP"] = vals.otp.trim();
    }
    const res = await fetch("/api/login", {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      if (res.status === 410) {
        loginChallenge = "";
        useRecoveryCode = false;
        show();
        article.querySelector("[name=pass]")?.focus();
      } else if (id === "loginFactor") {
        f.elements.otp.select();
      }
      throw Error(await res.text());
    }
    const result = await res.json();
    if (result.challenge) {
      loginChallenge = result.challenge;
      useRecoveryCode = false;
      show();
      article.querySelector("[name=otp]").focus();
      return;
    }
    loginChallenge = "";
    await onlineStart({
      user: loginIdentity.includes("@")
        ? loginIdentity.toLowerCase()
        : loginIdentity,
      role: result,
    });
    page = destination;
  }
  if (id === "mfa") {
    mfaCodes = await api("mfa", { Secret: mfaSecret, ...vals });
    mfaSecret = "";
  }
  if (id === "event") {
    const created = await api("events", {
      ...vals,
      Accounts: !!vals.Accounts,
      General: !!vals.General,
    });
    preferredEvent = created.ID;
    await onlineStart(onlineUser);
    page = "Einrichtung";
  }
  if (id === "user") {
    await api("users", vals);
  }
  if (id === "access") {
    await api("access", vals);
  }
  if (id === "prepare") {
    if (vals.pass.length < 10) throw Error("Lokales Passwort zu kurz.");
    if (!sw) throw Error("Service Worker und sicherer Kontext erforderlich.");
    await sw;
    await navigator.storage.persist?.();
    const p = await api("prepare", {
      Event: vals.event,
      Name: vals.name,
      Donor: !!vals.donor,
      DigitalCount: Number(vals.digitalCount),
    });
    const next = {
      ...p,
      nextNumber: p.first,
      seq: 0,
      last: 0,
      entries: [],
      conflicts: [],
      ops: [],
    };
    await createVault(vals.pass, next);
    s = next;
    page = destination === "Einrichtung" ? "Übersicht" : destination;
    logged = false;
    onlineUser = null;
    onlineData = null;
    events = [];
    saved = true;
    auth = "";
    await api("logout", {});
    await sync();
  }
  if (id === "unlock") {
    s = await unlock(vals.pass);
    page = destination;
    setTimeout(tryAutoSync, 500);
  }
  if (id === "recoverProfile") {
    const restored = await recoverReadOnly(vals.file, vals.pass);
    await createVault(vals.pass, restored);
    s = restored;
    saved = true;
  }
  if (id === "renew") {
    const credentials =
      "Basic " +
      btoa(
        String.fromCharCode(
          ...new TextEncoder().encode(s.user + ":" + vals.password),
        ),
      );
    if (!s.nextToken) await commit({ ...s, nextToken: crypto.randomUUID() });
    const res = await fetch("/api/renew", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: credentials,
        "X-Bonfire-OTP": vals.otp,
      },
      body: JSON.stringify({
        Device: s.device,
        Proof: s.token,
        Next: s.nextToken,
      }),
    });
    if (!res.ok) throw Error(await res.text());
    await commit({
      ...s,
      expires: await res.json(),
      token: s.nextToken,
      nextToken: null,
    });
    await sync();
  }
  if (id === "periodAction") {
    await api(
      "manage",
      { Action: vals.action, Target: vals.id, Reason: vals.reason },
      bearer(),
    );
    await sync();
  }
  if (["incident", "incomplete", "returnDevice"].includes(id)) {
    await api(
      "manage",
      {
        Action: id === "returnDevice" ? "return" : id,
        Target: vals.device,
        Reason: vals.reason,
      },
      bearer(),
    );
    await sync();
  }
  if (id === "carry") {
    const period = rows().find((r) => r.ID === vals.period);
    if (!period) throw Error("Zielperiode wählen.");
    const prior = await api(
      "manage",
      { Action: "prior", Target: period.Data.Date },
      bearer(),
    );
    for (const [account, amount] of Object.entries(prior.Actuals)) {
      const target = await countID("opening", period.ID, account);
      const old = rows().find((r) => r.ID === target);
      if (
        old &&
        old.Data.Fields?.previous === prior.ID &&
        old.Data.Amount === amount
      )
        continue;
      if (old && !old.Data.Fields?.previous)
        throw Error("Vorhandene manuelle Eröffnung zuerst fachlich klären.");
      if (old && vals.reason.trim().length < 5)
        throw Error("Austausch des Vorperiodenübertrags begründen.");
      await queue(
        "opening",
        {
          Label: "Übertrag aus Abschluss " + prior.End,
          Date: period.Data.Date,
          Amount: amount,
          Account: account,
          Fields: { previous: prior.ID },
          Note: old ? vals.reason : "",
        },
        target,
        old?.Revision || 0,
      );
    }
  }
  if (id === "globalPeriod") {
    globalRows = await api(
      "manage",
      { Action: vals.scope, Target: vals.start, Reason: vals.end },
      bearer(),
    );
  }
  if (id === "copy") {
    await api(
      "manage",
      { Action: "copy", Target: vals.name, Start: vals.start, End: vals.end },
      bearer(),
    );
    syncDetail = "Veranstaltungskopie angelegt.";
  }
  if (id === "reopen") {
    await api("manage", { Action: "reopen", Reason: vals.reason }, bearer());
    await sync();
  }
  if (id === "handover") {
    const wallet = rows().find((r) => r.ID === vals.wallet),
      target = "handover:" + vals.wallet,
      prev = rows().find((r) => r.ID === target);
    if (!wallet) throw Error("Geldtasche wählen.");
    if (
      vals.status === "Angeboten" &&
      ((wallet.Data.Fields?.owner || wallet.Device) !== s.device ||
        vals.to === s.device ||
        prev?.Data.Status === "Angeboten")
    )
      throw Error(
        "Nur das zuständige Gerät kann an ein anderes Gerät übergeben.",
      );
    if (
      vals.status === "Bestätigt" &&
      (vals.to !== s.device ||
        prev?.Data.To !== s.device ||
        prev.Data.Status !== "Angeboten")
    )
      throw Error("Keine passende Übergabe an dieses Gerät.");
    await queue(
      "handover",
      {
        Date: today(),
        Label: wallet.Data.Label,
        Wallet: vals.wallet,
        To: vals.to,
        Status: vals.status,
        Note: "Übergabe " + vals.status,
      },
      target,
      prev?.Revision || 0,
    );
  }
  if (id === "preview") {
    importFile = vals.file;
    importRole = vals.sourceRole;
    imported =
      importRole === "Journal"
        ? await preview(importFile, rows())
        : await historyPreview(importFile, importRole, vals.year);
  }
  if (id === "dispatch") {
    const target = "dispatch:" + vals.original,
      existing = rows().find((r) => r.ID === target);
    if (
      s.role !== "Leitung" ||
      vals.evidence.trim().length < 3 ||
      (!existing && vals.delivery === "Vermerk aufgehoben")
    )
      throw Error("Leitung, gültigen Übergabestatus und Nachweis angeben.");
    const original = rows().find(
      (r) => r.ID === vals.original && r.Kind === "original",
    );
    if (!original) throw Error("Ausgestellten Beleg wählen.");
    await queue(
      "dispatch",
      {
        Date: today(),
        Label: "Beleg " + original.Data.Number,
        Reference: original.ID,
        Status: vals.delivery,
        Note: vals.evidence,
      },
      target,
      existing?.Revision || 0,
    );
  }
  if (id === "importRow") {
    if (s.role !== "Leitung")
      throw Error("Importfreigabe durch Leitung erforderlich.");
    const r = imported[Number(vals.ix)];
    if (!r || r.blocked || r.amount == null || importRole === "D8")
      throw Error("Diese Quellenzeile ist für eine Buchung gesperrt.");
    if (s.event.Accounts && !vals.account)
      throw Error("Kontozuordnung erforderlich.");
    const source = "source:" + r.source,
      target = "import:" + r.source + ":" + (r.key || r.row);
    if (rows().some((x) => x.ID === target))
      throw Error("Diese Quellenstelle wurde bereits übernommen.");
    if (!rows().some((x) => x.ID === source))
      await queue(
        "import-source",
        {
          Label: "Geprüfte Importquelle",
          Date: today(),
          Reference: r.source,
          Filename: importFile.name,
          File: await b64(importFile),
          Status: importRole,
        },
        source,
      );
    await queue(
      vals.kind,
      {
        Label: r.label,
        Date: vals.date,
        Amount: r.amount,
        Account: vals.account,
        Reference: source,
        Note: vals.reason,
        Fields: {
          cell: r.cell || String(r.row),
          sheet: r.sheet || "Journal",
          original: r.raw ?? String(r.amount),
          sourceColumn: r.column || "",
          dateOrigin: r.yearOrigin || "Quelldatum",
        },
      },
      target,
    );
    r.status = "Übernommen";
  }
  if (id === "letters") {
    const selected = new FormData(f).getAll("recipients");
    if (!selected.length)
      throw Error("Mindestens eine zugeordnete Spende auswählen.");
    const files = {};
    for (const subject of selected) {
      const snap = snapshot(6, s, rows(), { subject });
      const { pdf, docx } = await renderDocument(snap);
      files[subject + ".pdf"] = new Uint8Array(await pdf.arrayBuffer());
      files[subject + ".docx"] = new Uint8Array(await docx.arrayBuffer());
    }
    download(
      new Blob([zipSync(files)], { type: "application/zip" }),
      "Dankesbriefe.zip",
    );
  }
  if (id === "filter") {
    if (vals.from && vals.until && vals.from > vals.until)
      throw Error("Datumsbereich prüfen.");
    filter = vals.filter;
    if (page === "Journal") journalFilters = vals;
  }
  if (id === "record") {
    const d = { ...vals };
    delete d.amount;
    delete d.file;
    if (
      kind === "contact" &&
      !edit &&
      rows().some(
        (r) =>
          r.Kind === "contact" &&
          r.Data.Label.trim().toLocaleLowerCase("de") ===
            d.Label.trim().toLocaleLowerCase("de"),
      ) &&
      !d.field_distinct?.trim()
    )
      throw Error(
        "Dieser Kontaktname ist vorhanden. Bestehenden Kontakt wählen oder getrennte Person/Firma im Feld Abgrenzung begründen.",
      );
    if (monetary.has(kind)) d.Amount = cents(vals.amount);
    if (kind === "organization") {
      if (vals.logo?.size) {
        if (vals.logo.type !== "image/png" || vals.logo.size > 300000)
          throw Error("Organisationslogo als PNG bis 300 kB wählen.");
        d.File = await b64(vals.logo);
      } else d.File = edit?.Data.File || "";
      delete d.logo;
    }
    if (kind === "attachment") {
      if (!vals.file.size || vals.file.size > 4194304)
        throw Error("Dateigröße maximal 4 MiB.");
      const bytes = new Uint8Array(await vals.file.arrayBuffer());
      const signature = [...bytes.slice(0, 8)];
      if (
        ![
          [37, 80, 68, 70, 45],
          [255, 216, 255],
          [137, 80, 78, 71, 13, 10, 26, 10],
        ].some((m) => m.every((n, i) => signature[i] === n))
      )
        throw Error("Datei als PDF, JPEG oder PNG auswählen.");
      d.Fields = {
        ...d.Fields,
        sha256: Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (x) => x.toString(16).padStart(2, "0"),
        ).join(""),
        size: String(bytes.length),
      };
      d.File = await b64(vals.file);
      d.Filename = vals.file.name;
    }
    if (d.positions) {
      d.Lines = positions(d.positions);
      if (d.Lines.reduce((sum, l) => sum + lineCents(l), 0) !== d.Amount)
        throw Error("Positionssumme muss dem Gesamtbetrag entsprechen.");
    }
    delete d.positions;
    if (kind === "presale") {
      const qty = Number(d.field_saleQuantity),
        unit = cents(d.unitSale);
      if (
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        qty > 1000000 ||
        qty * unit !== d.Amount
      )
        throw Error(
          "Vorverkaufsmenge und Einzelpreis müssen den Erlös ergeben.",
        );
      d.field_unitCents = String(unit);
      delete d.unitSale;
    }
    for (const k of Object.keys(d)) {
      if (k.startsWith("alloc_")) {
        if (d[k]) (d.Allocations ??= {})[k.slice(5)] = cents(d[k]);
        delete d[k];
      }
      if (k.startsWith("field_")) {
        (d.Fields ??= {})[k.slice(6)] = d[k];
        delete d[k];
      }
    }
    let target = kind === "organization" ? "organization" : edit?.ID;
    if (kind === "paper") {
      d.Number = Number(d.Number);
      target = "paper:" + d.Number;
      if (
        !Number.isInteger(d.Number) ||
        d.Number < s.first ||
        d.Number > (s.paperLimit ?? s.limit) ||
        rows().some((r) => r.ID === target)
      )
        throw Error(
          "Papiernummer außerhalb der Reserve oder bereits registriert.",
        );
      if (
        d.Status === "Verworfen"
          ? d.Reference || (d.Note || "").trim().length < 3
          : rows().find((r) => r.ID === d.Reference)?.Data.Method !== "Bar"
      )
        throw Error("Barzahlung zuordnen oder verworfene Nummer begründen.");
    }
    if (
      kind === "price" &&
      d.Status === "Freigegeben" &&
      (!d.Unit?.trim() || !d.Category)
    )
      throw Error("Einheit und Sortiment vor Freigabe klären.");
    if (kind === "organization" && s.role !== "Leitung")
      throw Error("Leitungsrecht erforderlich.");
    if (kind === "count" && d.Status === "Bestätigt")
      d.Fields = {
        ...d.Fields,
        confirmedBy: s.user,
        confirmedAt: new Date().toISOString(),
      };
    if (["plan", "count", "reserve"].includes(kind)) {
      if (kind !== "reserve" && !d.Wallet) throw Error("Geldtasche auswählen.");
      d.Pieces = {};
      for (const n of denom) {
        d.Pieces[n] = Number(d["coin" + n]);
        delete d["coin" + n];
      }
      d.Amount = totalPieces(d.Pieces);
      let phaseKey = d.Phase;
      if (kind === "count" && d.Phase === "Zwischenstand") {
        const observation = edit
          ? edit.Data.Fields?.observation
          : crypto.randomUUID();
        if (observation) {
          d.Fields = { ...d.Fields, observation };
          phaseKey += "|" + observation;
        }
      }
      target =
        kind === "reserve"
          ? "coinreserve"
          : await countID(kind, d.Wallet, phaseKey);
      if (!edit && rows().some((r) => r.ID === target))
        throw Error(
          "Für diese Phase besteht eine Zählung. Bestehenden Eintrag bearbeiten.",
        );
      if (edit && target !== edit.ID)
        throw Error(
          "Geldtasche und Phase einer Berichtigung müssen übereinstimmen.",
        );
    }
    if (["supply", "skim", "return"].includes(kind)) {
      const wallet = rows().find((r) => r.ID === d.Wallet);
      if (
        !wallet ||
        (wallet.Data.Fields?.owner || wallet.Device) !== s.device ||
        rows().find((r) => r.ID === "handover:" + d.Wallet)?.Data.Status ===
          "Angeboten"
      )
        throw Error("Für diese Geldtasche fehlt die wirksame Übergabe.");
    }
    if (
      s.event.Accounts &&
      [
        "income",
        "expense",
        "reimbursement",
        "fee",
        "card",
        "payout",
        "donation",
        "payment",
        "presale",
      ].includes(kind) &&
      !d.Account
    )
      throw Error("Konto auswählen.");
    if (
      ["transfer", "payout", "skim", "supply", "return"].includes(kind) &&
      (!d.Account || !d.To || d.Account === d.To)
    )
      throw Error("Verschiedene Quell- und Zielkonten angeben.");
    if (kind === "period" && (!d.To || d.Date > d.To))
      throw Error("Periodenende prüfen.");
    if (d.Allocations) {
      if (
        d.Reference ||
        Object.values(d.Allocations).reduce((a, n) => a + n, 0) !== d.Amount
      )
        throw Error(
          "Entweder Einzelbezug oder vollständige Sammelzuordnung wählen.",
        );
    }
    if (
      ["payment", "reimbursement", "attachment"].includes(kind) &&
      !d.Reference &&
      !d.Allocations
    )
      throw Error("Zugehörigen Vorgang auswählen.");
    await queue(kind, d, target, edit?.Revision || 0);
    entryOpen = false;
    edit = null;
  }
  if (id === "lfk") {
    if (s.role !== "Leitung") throw Error("Leitung erforderlich.");
    const id = "template:" + profileID(2),
      old = rows().find((r) => r.ID === id);
    await queue(
      "template",
      {
        ...old?.Data,
        Label: old?.Data.Label || profiles[2],
        Reference: profileID(2),
        Date: today(),
        Note: old?.Data.Note || "LFK-Druckhintergrund",
        File: await b64(await background(vals.file)),
      },
      id,
      old?.Revision || 0,
    );
  }
  if (id === "wordLayout") {
    const input = new Uint8Array(await vals.file.arrayBuffer());
    const verified = mergeWord(input);
    const next = structuredClone(s),
      ref = profileID(6),
      active = (s.pinnedTemplates || s.entries).find(
        (r) => r.Kind === "template" && r.Data.Reference === ref,
      );
    (next.drafts ??= {})[ref] = {
      ...(active?.Data || {}),
      ...(next.drafts?.[ref] || {}),
      Reference: ref,
      Label: next.drafts?.[ref]?.Label || active?.Data.Label || profiles[6],
      File: await b64(new Blob([verified.bytes])),
      baseRevision: next.drafts?.[ref]?.baseRevision ?? active?.Revision ?? 0,
    };
    await commit(next);
  }
  if (id === "importTemplate") {
    const text = await importTemplate(vals.file);
    const next = structuredClone(s);
    next.importedText = text;
    await commit(next);
  }
  if (id === "template" && f.dataset.mode !== "release") {
    const next = structuredClone(s);
    (next.drafts ??= {})[vals.Reference] = {
      ...vals,
      File:
        next.drafts?.[vals.Reference]?.File ||
        (s.pinnedTemplates || s.entries).find(
          (r) => r.Kind === "template" && r.Data.Reference === vals.Reference,
        )?.Data.File ||
        "",
      baseRevision:
        next.drafts?.[vals.Reference]?.baseRevision ??
        (next.pinnedTemplates || s.entries).find(
          (r) => r.Data.Reference === vals.Reference && r.Kind === "template",
        )?.Revision ??
        0,
      Fields: {
        font: vals.font,
        footer: vals.footer,
        margin: vals.margin,
        header: vals.header,
        copies: vals.copies,
        firstColumn: vals.firstColumn,
        paper: vals.paper,
      },
    };
    await commit(next);
    show();
    return;
  }
  if (id === "template") {
    await sync();
    if (s.role !== "Leitung")
      throw Error("Nur die Leitung kann Vorlagen freigeben.");
    const target = "template:" + vals.Reference;
    await queue(
      "template",
      {
        File:
          s.drafts?.[vals.Reference]?.File ||
          rows().find((r) => r.ID === target)?.Data.File ||
          "",
        Label: vals.Label,
        Reference: vals.Reference,
        Note: vals.Note,
        Fields: {
          font: vals.font,
          footer: vals.footer,
          margin: vals.margin,
          header: vals.header,
          copies: vals.copies,
          firstColumn: vals.firstColumn,
          paper: vals.paper,
        },
        Date: today(),
      },
      target,
      s.drafts?.[vals.Reference]?.baseRevision ??
        (s.pinnedTemplates || s.entries).find((r) => r.ID === target)
          ?.Revision ??
        0,
    );
    await sync();
    if (s.conflicts.some((c) => c.Target === target))
      throw Error(
        "Neue Vorlagenfassung ist strittig. Lokaler Entwurf bleibt erhalten.",
      );
    const released = s.entries.find((r) => r.ID === target);
    if (released) {
      const next = structuredClone(s);
      next.pinnedTemplates = [
        ...(next.pinnedTemplates || []).filter((r) => r.ID !== target),
        released,
      ];
      if (next.drafts) delete next.drafts[vals.Reference];
      await commit(next);
    }
  }
  if (id.startsWith("resolve-")) {
    const c = s.conflicts.find((c) => c.ID === id.slice(8));
    await sync({
      Resolve: c.ID,
      Account: vals.account || "",
      Destination: vals.destination || "",
      Choice: vals.choice,
      Reason: vals.reason,
      Last: s.entries.find((r) => r.ID === c.Target)?.Revision || 0,
    });
  }
  if (id === "export") {
    const i = Number(vals.profile),
      original = ["Original", "Korrektur"].includes(vals.format);
    let previous;
    if (original) {
      canWrite();
      if (i === 2 && !s.donorAccess)
        throw Error(
          "Für nummerierte Spendenbelege ist ein vorbereitetes Belegprofil erforderlich.",
        );
      if (vals.version === "draft")
        throw Error("Originalausgabe verlangt die freigegebene Fassung.");
      if (i > 2 || !vals.subject)
        throw Error(
          "Ein Original benötigt eine Rechnung oder einen Spendenbeleg mit Fachvorgang.",
        );
      const old = rows().find((r) => r.ID === "original:" + vals.subject);
      if (vals.format === "Korrektur") {
        if (!old || vals.revisionReason.trim().length < 3)
          throw Error(
            "Ausgestelltes Original und Korrekturgrund erforderlich.",
          );
        previous = rows()
          .filter(
            (r) => r.Kind === "original" && r.Data.Reference === vals.subject,
          )
          .sort((a, b) => b.Data.Number - a.Data.Number)[0].Data.Number;
      }
      if (old && !previous) {
        await reprint(old, "PDF");
        return;
      }
      if (
        rows().find((r) => r.ID === vals.subject)?.Device !== s.device ||
        availableNumbers(s) === 0
      )
        throw Error("Ausstellungsrecht oder Nummernreserve fehlt.");
    }
    const snap = snapshot(i, s, rows(), {
      ...vals,
      number: original ? s.nextNumber : null,
    });
    if (previous) {
      snap.previousNumber = previous;
      snap.revisionReason = vals.revisionReason;
      const correction =
        "Ersatz für Beleg " + previous + " · " + vals.revisionReason;
      if (snap.tables) snap.tables.after.push(correction);
      else snap.lines.push(correction);
    }
    const blobs = await renderDocument(snap);
    if (original) {
      const next = structuredClone(s);
      const digest = async (b) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await b.arrayBuffer()),
          ),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
      snap.archive = {
        device: s.device,
        user: s.user,
        issuedAt: new Date().toISOString(),
        renderBuild: __BONFIRE_RENDER_BUILD__,
        fontPreset: snap.font,
        pdfSHA256: await digest(blobs.pdf),
        docxSHA256: await digest(blobs.docx),
        appAssets: (await caches.keys()).filter((k) =>
          k.startsWith("bonfire-"),
        ),
        sourceRevision: rows().find((r) => r.ID === vals.subject)?.Revision,
      };
      const d = {
        Label: snap.title,
        Date: snap.date,
        Reference: vals.subject,
        Fields: previous
          ? { previous: String(previous), reason: vals.revisionReason }
          : {},
        Number: next.nextNumber++,
        PDF: await b64(blobs.pdf),
        DOCX: await b64(blobs.docx),
        Note: JSON.stringify(snap),
      };
      next.ops.push({
        LocalTime: new Date().toISOString(),
        ID: crypto.randomUUID(),
        Seq: ++next.seq,
        Target:
          "original:" + vals.subject + (previous ? ":after:" + previous : ""),
        Base: 0,
        Kind: "original",
        Data: d,
      });
      await commit(next);
    }
    const ext = vals.format === "DOCX" ? "docx" : "pdf";
    download(
      blobs[ext],
      profileID(i) +
        (snap.number ? "-" + snap.number : "-Arbeitsfassung") +
        "." +
        ext,
    );
  }
  show();
}
document.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "template")
    e.target.dataset.mode = e.submitter?.dataset.release ? "release" : "draft";
  action(() => submit(e.target));
});
function updateCount(form) {
  const pieces = {};
  let valid = true;
  for (const coin of denom) {
    const input = form.elements["coin" + coin];
    const count = Number(input.value || 0);
    valid = valid && input.validity.valid;
    pieces[coin] = count;
    form.querySelector('[data-piece="' + coin + '"]').textContent = input
      .validity.valid
      ? eur(coin * count)
      : "Stückzahl prüfen";
  }
  form.querySelector("#count-total").textContent = valid
    ? eur(totalPieces(pieces))
    : "Stückzahlen prüfen";
}
document.addEventListener("input", (e) => {
  if (e.target.matches(".pieces input")) updateCount(e.target.form);
  if (
    ["export", "template"].includes(e.target.form?.id) &&
    document.querySelector("#proof-sheet iframe")
  ) {
    document.querySelector("#proof-sheet").replaceChildren();
    document.querySelector("#proof-status").textContent =
      "Eingaben geändert. Vorschau aktualisieren.";
  }
  if (!e.target.matches("[data-contact-filter]")) return;
  const query = e.target.value.trim().toLocaleLowerCase("de"),
    select = e.target.form?.elements.Contact;
  if (!select) return;
  for (const option of select.options)
    option.hidden =
      !!option.value && !option.text.toLocaleLowerCase("de").includes(query);
});
document.addEventListener("change", (e) => {
  if (e.target.name === "overview-period") {
    overviewPeriod = e.target.value;
    show();
    return;
  }
  if (e.target.form?.id === "template" && e.target.name === "Reference") {
    const f = e.target.form,
      ref = e.target.value;
    const cfg =
      s.drafts?.[ref] ||
      (s.pinnedTemplates || s.entries).find(
        (r) => r.Kind === "template" && r.Data.Reference === ref,
      )?.Data ||
      {};
    f.elements.Label.value =
      cfg.Label || profiles.find((_, i) => profileID(i) === ref) || "";
    f.elements.Note.value = cfg.Note || "";
    for (const key of [
      "font",
      "footer",
      "margin",
      "header",
      "copies",
      "firstColumn",
      "paper",
    ])
      f.elements[key].value =
        cfg.Fields?.[key] ||
        { font: "helvetica", margin: "15", paper: "Letter" }[key] ||
        "";
  }
  if (e.target.name === "reportPeriod") {
    chosenPeriod = e.target.value;
  }
  if (e.target.name === "type") {
    kind = e.target.value;
    edit = null;
    show();
  }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (
    !b ||
    (b.type === "submit" &&
      !b.dataset.page &&
      !b.dataset.edit &&
      !b.dataset.file)
  )
    return;
  if (b.dataset.page) {
    if (!s && !logged) {
      destination = b.dataset.page;
      show();
      article.querySelector("input")?.focus();
      return;
    }
    if (b.dataset.page === "Einrichtung")
      destination = page === "Verwaltung" ? "Übersicht" : page;
    entryOpen = false;
    page = b.dataset.page;
    document.body.classList.remove("menu-open");
    document
      .querySelector("#menu-toggle")
      .setAttribute("aria-expanded", "false");
    filter = "";
    journalFilters = {};
    edit = null;
    show();
    return;
  }
  action(async () => {
    if (b.dataset.edit) {
      edit = rows().find((r) => r.ID === b.dataset.edit);
      kind = edit.Kind;
      show();
      document.querySelector("#record")?.scrollIntoView();
      return;
    }
    if (b.dataset.lifecycle) {
      const row = rows().find((r) => r.ID === b.dataset.lifecycle);
      const reason = prompt(
        row.Data.Retired
          ? "Grund für die Wiederherstellung"
          : "Grund für die Archivierung",
      )?.trim();
      if (!reason) return;
      if (reason.length < 3) throw Error("Begründung angeben.");
      await queue(
        row.Kind,
        {
          ...row.Data,
          Retired: !row.Data.Retired,
          Fields: {
            ...row.Data.Fields,
            lifecycle: row.Data.Retired ? "Wiederhergestellt" : "Archiviert",
            lifecycleReason: reason,
          },
        },
        row.ID,
        row.Revision,
      );
      show();
      return;
    }
    if (b.dataset.settle) {
      const wallet = rows().find((r) => r.ID === b.dataset.settle);
      const target = "settlement:" + wallet.ID;
      const previous = rows().find((r) => r.ID === target);
      const amount = counted(
        rows().filter((r) => r.ID !== target),
        wallet.ID,
      );
      if (amount === null || amount < 0)
        throw Error("Zählungen und zugeordnete Geldbewegungen prüfen.");
      const reason = previous
        ? prompt("Grund für die Berichtigung des Sammelbetrags")?.trim()
        : "";
      if (previous && !reason) return;
      const end = rows().find(
        (r) =>
          r.Kind === "count" &&
          r.Data.Wallet === wallet.ID &&
          r.Data.Phase === "Ende",
      );
      await queue(
        "income",
        {
          Label: "Barabrechnung " + wallet.Data.Label,
          Date: previous?.Data.Date || end.Data.Date,
          Note: reason,
          Wallet: wallet.ID,
          Bar: wallet.Data.Bar,
          Account: wallet.ID,
          Amount: amount,
          Method: "Bar",
          Reference: "wallet-settlement",
        },
        target,
        previous?.Revision || 0,
      );
      show();
      return;
    }
    if (b.dataset.attachment) {
      const v = rows().find((r) => r.ID === b.dataset.attachment)?.Data;
      if (!v?.File) throw Error("Datei noch nicht vorhanden.");
      const mime = v.File.startsWith("JVBER")
        ? "application/pdf"
        : v.File.startsWith("/9j/")
          ? "image/jpeg"
          : "image/png";
      download(from64(v.File, mime), v.Filename || "Beleg");
      return;
    }
    if (b.dataset.file) {
      const row = rows().find((r) => r.ID === b.dataset.file);
      const ext = b.dataset.format;
      await reprint(row, ext);
      return;
    }
    switch (b.dataset.act) {
      case "refreshWorkplace":
        await onlineStart(onlineUser);
        break;
      case "profileHelp":
      case "backLogin":
      case "changeFactor":
        profileHelp = b.dataset.act === "profileHelp";
        if (b.dataset.act === "changeFactor")
          useRecoveryCode = !useRecoveryCode;
        else {
          loginChallenge = "";
          useRecoveryCode = false;
        }
        show();
        (
          article.querySelector("[name=otp], [name=user], #unlock input") ||
          article
        ).focus();
        return;
      case "focusEntry":
        entryOpen = true;
        show();
        document.querySelector("#record")?.scrollIntoView({ block: "center" });
        document.querySelector("#record [name=Label]")?.focus();
        return;
      case "docInputs":
        document
          .querySelector(".document-studio")
          .classList.remove("view-proof");
        return;
      case "docProof":
      case "draftProof":
        await proofDocument(b.dataset.act === "draftProof");
        return;
      case "newProfile":
        location.href = "/?profil=" + crypto.randomUUID();
        return;
      case "pinTemplates":
        await sync();
        await commit({
          ...s,
          pinnedTemplates: s.entries.filter((r) => r.Kind === "template"),
        });
        show();
        return;
      case "mfa":
        mfaSecret = (await api("mfa", {})).secret;
        show();
        return;
      case "lock":
        if (logged && !s) await api("logout", {});
        location.reload();
        return;
      case "csv":
        download(csv(reportRows()), "Journal.csv");
        return;
      case "xlsx":
        download(workbook(reportRows()), "Journal.xlsx");
        return;
      case "evidence":
        {
          const reports = {},
            templates = {};
          const organization =
            rows().find((r) => r.Kind === "organization")?.Data.Label || "";
          for (const [i, name] of [
            [9, "Pruefbericht"],
            [10, "Belegjournal"],
          ]) {
            const snap = snapshot(i, s, rows(), {
              period: chosenPeriod,
              organization,
            });
            templates[name] = snap.templateVersionID;
            const docs = await renderDocument(snap);
            reports[name + ".pdf"] = docs.pdf;
            reports[name + ".docx"] = docs.docx;
          }
          download(
            await evidence(s, reportRows(), reports, {
              period: chosenPeriod,
              templates,
            }),
            "Pruefpaket.zip",
          );
        }
        return;
      case "donors":
        if (!s.donorAccess) throw Error("Meldedatenprofil erforderlich.");
        download(
          new Blob(
            [
              JSON.stringify(
                donationReport(
                  rows(),
                  document.querySelector("[name=donorPeriod]").value.trim(),
                ),
                null,
                2,
              ),
            ],
            { type: "application/json" },
          ),
          "Spenden-Pruefliste.json",
        );
        return;
      case "conflictFiles":
        conflictFiles = {
          device: s.device,
          list: await api("manage", { Action: "conflict-originals" }, bearer()),
        };
        if (!conflictFiles.list.length)
          notice.textContent = "Keine strittigen Originalfassungen vorhanden.";
        break;
      case "numbers": {
        const ranges = await api("manage", { Action: "numbers" }, bearer());
        auditRows = ranges.map((x) => ({
          at: "",
          username: x.name,
          action:
            (x.capacity === 0
              ? "Keine Digitalnummern"
              : x.first + "–" + x.last) +
            " · Papier P-" +
            x.first +
            "–P-" +
            x.paper_last +
            " · " +
            x.status +
            " · Digital: " +
            (x.used || []).join(", ") +
            " · Papier: " +
            (x.paper || []).join(", "),
        }));
        break;
      }
      case "journalHistory":
        auditRows = await api("manage", { Action: "journal" }, bearer());
        break;
      case "readiness": {
        const missing = [];
        for (const path of [
          "/",
          "/app.js",
          "/app.css",
          "/manifest.webmanifest",
          "/logo-original.svg",
          "/icon-192.png",
          "/icon-512.png",
        ])
          if (!(await caches.match(path))) missing.push(path);
        const usage = await navigator.storage.estimate();
        readiness = [
          missing.length
            ? "Offlinepaket unvollständig: " + missing.join(", ")
            : "App, Renderer, Marke und Icons lokal vorhanden",
          s.synced
            ? "Fachdaten zuletzt bestätigt: " + s.synced
            : "Fachdaten noch nicht abgeglichen",
          Date.parse(s.expires) > Date.now()
            ? "Gerätefreigabe gültig"
            : "Gerätefreigabe abgelaufen",
          "Freie Belegnummern: " + availableNumbers(s),
          "Geschätzter freier Speicher: " +
            Math.floor(((usage.quota || 0) - (usage.usage || 0)) / 1048576) +
            " MiB",
          (await navigator.storage.persisted())
            ? "Speichererhalt vom Browser gewährt"
            : "Speichererhalt vom Browser unbestätigt",
        ];
        break;
      }
      case "audit":
        auditRows = await api("manage", { Action: "audit" }, bearer());
        break;
      case "accounts":
        await api(
          "manage",
          { Action: "accounts", Accounts: !s.event.Accounts },
          bearer(),
        );
        await sync();
        break;
      case "cancel":
        entryOpen = false;
        edit = null;
        break;
      case "sync":
        await sync();
        break;
      case "seal":
        if (!confirm("Erfassung dieses Geräts verbindlich beenden?")) return;
        await commit({ ...s, ending: true });
        await sync();
        await sync({ Action: "Ende", Last: s.seq });
        break;
      case "close":
        await sync({ Action: "Abschluss" });
        break;
      case "recover": {
        const v = await readVault();
        download(
          new Blob(
            [
              JSON.stringify({
                version: 1,
                salt: [...v.salt],
                iv: [...v.iv],
                ciphertext: await b64(new Blob([v.bytes])),
              }),
            ],
            { type: "application/json" },
          ),
          "bonfire-geraetesicherung.json",
        );
        break;
      }
      default:
        return;
    }
    show();
  });
});
async function tryAutoSync() {
  if (
    !s ||
    s.recovery ||
    busy ||
    backgroundSync ||
    !navigator.onLine ||
    document.visibilityState !== "visible"
  )
    return;
  backgroundSync = (async () => {
    try {
      await sync();
      if (page === "Übersicht") show();
    } catch {
      state.textContent =
        s.event.Name + " · Lokaler Stand · Serverabgleich ausständig";
    }
  })();
  try {
    await backgroundSync;
  } finally {
    backgroundSync = null;
  }
}
window.addEventListener("online", tryAutoSync);
window.addEventListener("online", checkConnection);
window.addEventListener("offline", checkConnection);
document.addEventListener("visibilitychange", checkConnection);
setInterval(checkConnection, 30000);
void checkConnection();
profilesLocal = await slots();
saved = !!(await readVault());
if (!saved) {
  try {
    const identity = await api("workplace");
    await onlineStart(identity);
  } catch {
    /* Anmeldung ist ohne aktive Serversitzung erforderlich. */
  }
}
show();

document.querySelector("#menu-toggle").addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  document
    .querySelector("#menu-toggle")
    .setAttribute("aria-expanded", String(open));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("menu-open")) {
    document.body.classList.remove("menu-open");
    const btn = document.querySelector("#menu-toggle");
    btn.setAttribute("aria-expanded", "false");
    btn.focus();
  }
});
document.querySelector("#workspace-picker").addEventListener("change", (e) =>
  action(async () => {
    try {
      const fresh = await api(
        "workplace?event=" + encodeURIComponent(e.target.value),
      );
      overviewPeriod = "";
      onlineData = fresh;
      preferredEvent = fresh.event.ID;
      show();
    } catch (err) {
      e.target.value = preferredEvent;
      throw err;
    }
  }),
);
