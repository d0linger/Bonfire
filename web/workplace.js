import {
  LayoutDashboard,
  BookOpen,
  CalendarDays,
  ContactRound,
  HeartHandshake,
  Files,
  ClipboardCheck,
  Settings2,
  Landmark,
  ArrowDownLeft,
  ArrowUpRight,
  Wallet,
  Menu,
  Laptop,
  CircleAlert,
  RefreshCw,
  ChevronRight,
  LogOut,
  CircleCheck,
  ListChecks,
  Plus,
  Flame,
  WifiOff,
  Database,
  Users,
  FileText,
  Activity,
  ChevronDown,
  Check,
} from "lucide";
import { closure } from "./context.js";
import {
  eur,
  summary,
  groups,
  types,
  poolCount,
  counted,
  pooledRevenue,
} from "./domain.js";

const shapes = {
  LayoutDashboard,
  BookOpen,
  CalendarDays,
  ContactRound,
  HeartHandshake,
  Files,
  ClipboardCheck,
  Settings2,
  Landmark,
  ArrowDownLeft,
  ArrowUpRight,
  Wallet,
  Menu,
  Laptop,
  CircleAlert,
  RefreshCw,
  ChevronRight,
  LogOut,
  CircleCheck,
  ListChecks,
  Plus,
  Flame,
  WifiOff,
  Database,
  Users,
  FileText,
  Activity,
  ChevronDown,
  Check,
};
export function icon(name) {
  return (
    '<svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    shapes[name]
      .map(
        ([tag, attrs]) =>
          "<" +
          tag +
          " " +
          Object.entries(attrs)
            .map(([k, v]) => k + '="' + v + '"')
            .join(" ") +
          "/>",
      )
      .join("") +
    "</svg>"
  );
}
export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const modules = [
  ["Übersicht", "Overview", "LayoutDashboard"],
  ["Journal", "Cashbook", "BookOpen"],
  ["Veranstaltungen", "Events", "CalendarDays"],
  ["Kontakte", "Contacts", "ContactRound"],
  ["Spenden", "Donations", "HeartHandshake"],
  ["Dokumente", "Documents", "Files"],
  ["Perioden", "Closing", "ClipboardCheck"],
  ["Verwaltung", "Administration", "Settings2"],
];
export const eventTabs = [
  ["Veranstaltungen", "Overview"],
  ["Geldtaschen", "Wallets"],
  ["Zahlungen", "Payments and costs"],
  ["Preise", "Prices and printing"],
  ["Sponsoring", "Sponsors and invoices"],
];
export const onlineEventTabs = [
  ...eventTabs.filter(([page]) => page !== "Sponsoring"),
  ["Dokumente", "Documents"],
  ["Perioden", "Closing"],
];
export const adminTabs = [
  ["Verwaltung", "Organization"],
  ["Gerät & Sync", "Device and sync"],
  ["Datenaustausch", "Data exchange"],
];
export const consolePages = [
  ["Feuerwehrkonten", "Landmark"],
  ["Backup", "Database"],
  ["Benutzer", "Users"],
  ["Audit-Log", "FileText"],
  ["Systemstatus", "Activity"],
];
export const canOpenConsole = (p, role) =>
  consolePages.some(([key]) => key === p) &&
  (role === "Admin" || (["Write", "Read"].includes(role) && p === "Audit-Log"));
export const sectionOf = (p) =>
  p === "Geschäftsjahre" ||
  p === "Prüfprotokoll" ||
  consolePages.some(([key]) => key === p)
    ? "Verwaltung"
    : p === "Veranstaltungsliste"
      ? "Veranstaltungen"
      : eventTabs.some(([k]) => k === p)
        ? "Veranstaltungen"
        : adminTabs.some(([k]) => k === p) || p === "Einrichtung"
          ? "Verwaltung"
          : p;
export const titleOf = (p) =>
  modules.find(([k]) => k === sectionOf(p))?.[1] || p;
export const route = (p, t, css = "secondary", ico = "") =>
  '<button type="button" class="' +
  css +
  '" data-page="' +
  esc(p) +
  '">' +
  (ico ? icon(ico) : "") +
  esc(t) +
  "</button>";
export function navigation(
  page,
  user,
  role,
  active,
  online = false,
  expanded = false,
  personal = online,
) {
  const main = modules.map(
    ([p, t, i]) =>
      '<button type="button" data-page="' +
      p +
      '" ' +
      (active && sectionOf(page) === p ? 'aria-current="page"' : "") +
      ">" +
      icon(i) +
      t +
      "</button>",
  );
  return (
    '<div class="nav-group">Workspace</div>' +
    main.slice(0, -1).join("") +
    '<div class="nav-tail"><div class="nav-group">Organization</div>' +
    (online
      ? '<details id="admin-navigation"' +
        (expanded ? " open" : "") +
        "><summary>" +
        icon("Settings2") +
        "<span>Administration<small>Operations, backups and system</small></span>" +
        icon("ChevronDown") +
        '</summary><div class="admin-links">' +
        [
          ...consolePages.filter(([key]) => canOpenConsole(key, role)),
          ["Verwaltung", "Settings2"],
        ]
          .map(
            ([key, glyph]) =>
              '<button type="button" data-page="' +
              key +
              '"' +
              (key === page ? ' aria-current="page"' : "") +
              ">" +
              icon(glyph) +
              ({Verwaltung: "Organization", Benutzer: "Users", Feuerwehrkonten: "Fire brigade accounts", "Audit-Log": "Audit log", Systemstatus: "System status"}[key] || key) +
              "</button>",
          )
          .join("") +
        "</div></details>"
      : main.at(-1)) +
    '<div class="identity"><span class="avatar">' +
    esc((user || "BF").slice(0, 2).toUpperCase()) +
    "</span><span>" +
    esc(user || "BONFIRE") +
    "<small>" +
    esc(role || "Local workspace") +
    "</small></span></div>" +
    (personal
      ? '<button type="button" data-act="accountSecurity"' +
        (page === "Konto und Sicherheit" ? ' aria-current="page"' : "") +
        ">" +
        icon("Settings2") +
        "Account and security</button>"
      : "") +
    (active
      ? '<button type="button" data-act="lock">' +
        icon("LogOut") +
        (role && user ? "Sign out" : "Lock device") +
        "</button>"
      : "") +
    "</div>"
  );
}
export const tabs = (list, page) =>
  '<div class="tabs" aria-label="Sections">' +
  list
    .map(
      ([p, t]) =>
        '<button type="button" data-page="' +
        p +
        '" ' +
        (page === p ? 'aria-current="page"' : "") +
        ">" +
        t +
        "</button>",
    )
    .join("") +
  "</div>";
const dateFmt = new Intl.DateTimeFormat("de-AT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
export const dat = (d) =>
  d ? dateFmt.format(new Date(d.slice(0, 10) + "T12:00:00")) : "—";
export const recordKinds = (p, online = false) =>
  ({
    Kontakte: ["contact"],
    Spenden: ["donation"],
    Preise: ["price"],
    Sponsoring: ["sponsorship", "payment"],
    Zahlungen: online
      ? [...groups.Journal, "sponsorship", "payment", "donation"]
      : groups.Journal,
    Journal: online
      ? [...groups.Journal, "donation", "sponsorship", "payment"]
      : groups.Journal,
    Verwaltung: ["organization"],
  })[p] ||
  groups[p] ||
  [];
const outflow = new Set([
  "expense",
  "refund",
  "reimbursement",
  "fee",
  "deposit-return",
]);
export function flowAmount(r) {
  return r.Data.Amount == null
    ? "—"
    : (outflow.has(r.Kind) ? "−" : "") + eur(r.Data.Amount);
}
export function ledger(rows) {
  if (!rows.length)
    return '<p class="empty">Hier liegen noch keine Buchungen vor.</p>';
  return (
    '<div class="list ledger-list"><table><thead><tr><th>Datum</th><th>Bezeichnung</th><th>Vorgang</th><th class="num">Betrag</th></tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          "<tr><td>" +
          dat(r.Data.Date) +
          "</td><td><span>" +
          esc(r.Data.Label) +
          '</span><small class="mobile-kind">' +
          esc(types[r.Kind] || r.Kind) +
          "</small>" +
          "</td><td>" +
          esc(types[r.Kind] || r.Kind) +
          '</td><td class="num">' +
          flowAmount(r) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
const journalTypes = new Set(
  [...groups.Journal, "donation", "payment"].filter(
    (k) => !["attachment", "paper"].includes(k),
  ),
);
export const bookings = (rows) =>
  rows
    .filter((r) => journalTypes.has(r.Kind))
    .sort((a, b) => (b.Data.Date || "").localeCompare(a.Data.Date || ""));
const head = (t, action = "") =>
  '<div class="panel-head"><h2>' + t + "</h2>" + action + "</div>";
export { head as panelHeading };
const line = (i, t, v) =>
  '<div class="balance-row">' +
  icon(i) +
  "<span>" +
  esc(t) +
  "</span><strong>" +
  esc(v) +
  "</strong></div>";
export function moduleList(page, all) {
  if (page === "Geldtaschen") return walletTable(all);
  const items = all.filter(
    (r) => recordKinds(page).includes(r.Kind) && !r.Data.Retired,
  );
  const formats = {
    Kontakte: [
      ["Person oder Firma", "Anschrift"],
      (r) => [r.Data.Label, r.Data.Address || "Offen"],
    ],
    Preise: [
      ["Artikel", "Sortiment", "Einheit", "Preis", "Freigabe"],
      (r) => [
        r.Data.Label,
        r.Data.Category || "—",
        r.Data.Unit || "—",
        eur(r.Data.Amount),
        r.Data.Status || "Entwurf",
      ],
    ],
    Perioden: [
      ["Bezeichnung", "Von", "Bis"],
      (r) => [r.Data.Label, dat(r.Data.Date), dat(r.Data.To)],
    ],
    Sponsoring: [
      ["Forderung", "Zugesagt / gefordert", "Bezahlt", "Offen"],
      (r) => {
        const paid = all
          .filter((p) => p.Kind === "payment" && p.Data.Reference === r.ID)
          .reduce((n, p) => n + p.Data.Amount, 0);
        return [
          r.Data.Label,
          eur(r.Data.Amount),
          eur(paid),
          eur(r.Data.Amount - paid),
        ];
      },
    ],
  };
  if (!formats[page]) return ledger(items);
  const [headers, values] = formats[page],
    show = items.filter((r) =>
      page === "Perioden"
        ? r.Kind === "period"
        : page === "Sponsoring"
          ? r.Kind === "sponsorship"
          : true,
    );
  if (!show.length)
    return '<p class="empty">Noch keine Einträge in diesem Arbeitsbereich.</p>';
  return (
    '<div class="list"><table><thead><tr>' +
    headers.map((h) => "<th>" + h + "</th>").join("") +
    "</tr></thead><tbody>" +
    show
      .map(
        (r) =>
          "<tr>" +
          values(r)
            .map((v) => "<td>" + esc(v) + "</td>")
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
export function walletTable(rows, actions = "") {
  const wallets = rows.filter((r) => r.Kind === "wallet");
  const allStart = poolCount(rows, "Anfang"),
    allEnd = poolCount(rows, "Ende");
  const groupsByBar = new Map();
  for (const w of wallets) {
    const bar = w.Data.Bar || "";
    if (!groupsByBar.has(bar)) groupsByBar.set(bar, []);
    groupsByBar.get(bar).push(w);
  }
  function subtotal(label, group, overall = false) {
    function balance(phase) {
      const status = (r) =>
        phase === "Ende" && r.Data.Status ? " · " + esc(r.Data.Status) : "";
      const pooled = phase === "Anfang" ? allStart : allEnd;
      if (pooled)
        return overall
          ? eur(pooled.Data.Amount) + status(pooled)
          : "Nur gesamt erfasst";
      const counts = group.map((w) =>
        rows.find(
          (r) =>
            r.Kind === "count" &&
            r.Data.Wallet === w.ID &&
            r.Data.Phase === phase,
        ),
      );
      if (!counts.length || !counts.every(Boolean)) return "Offen";
      return (
        eur(counts.reduce((sum, r) => sum + r.Data.Amount, 0)) +
        (counts.length === 1 ? status(counts[0]) : "")
      );
    }
    let revenue = "Offen";
    if (allEnd || allStart) {
      if (!overall) revenue = "Nur gesamt erfasst";
      else revenue = eur(pooledRevenue(rows));
    } else {
      const values = group.map((w) =>
        counted(
          rows.filter((r) => r.ID !== "settlement:" + w.ID),
          w.ID,
        ),
      );
      if (values.length && values.every((n) => n != null))
        revenue = eur(values.reduce((a, b) => a + b, 0));
    }
    return (
      '<tr><th scope="row">' +
      esc(label) +
      '</th><td class="num">' +
      balance("Anfang") +
      '</td><td class="num">' +
      balance("Ende") +
      '</td><td class="num">' +
      revenue +
      "</td></tr>"
    );
  }
  return (
    "<section>" +
    head("Geldtaschen") +
    (wallets.length || allStart || allEnd
      ? '<div class="list"><table><thead><tr><th>Bereich</th><th class="num">Anfangsbestand</th><th class="num">Endbestand</th><th class="num">Sammelbareinnahme</th></tr></thead><tbody>' +
        subtotal("Alle Geldtaschen", wallets, true) +
        [...groupsByBar]
          .map(
            ([bar, group]) =>
              (bar
                ? subtotal(
                    "Bar · " +
                      (rows.find((r) => r.Kind === "bar" && r.ID === bar)?.Data
                        .Label || bar),
                    group,
                  )
                : "") + group.map((w) => subtotal(w.Data.Label, [w])).join(""),
          )
          .join("") +
        "</tbody></table></div>"
      : '<p class="empty">Noch keine Geldtaschen erfasst.</p>') +
    actions +
    "</section>"
  );
}
function eventCounts(rows, device, pending, conflicts, online) {
  const wallets = rows.filter((r) => r.Kind === "wallet");
  const counts = rows.filter((r) => r.Kind === "count");
  const phase = (name, title) => {
    const pool = poolCount(rows, name);
    if (pool)
      return line(
        "Wallet",
        title + " · alle Geldtaschen gemeinsam",
        eur(pool.Data.Amount),
      );
    const selected = wallets.map((w) =>
      counts.find((r) => r.Data.Wallet === w.ID && r.Data.Phase === name),
    );
    const found = selected.filter((r) => r?.Data.Amount != null);
    return line(
      "Wallet",
      title + " · " + found.length + " von " + wallets.length + " Taschen",
      found.length
        ? eur(found.reduce((sum, r) => sum + r.Data.Amount, 0))
        : "Offen",
    );
  };
  return (
    '<section class="event-counts">' +
    head("Zählstand der Geldtaschen") +
    phase("Anfang", "Opening count") +
    phase("Ende", "Closing count") +
    (online
      ? ""
      : line("RefreshCw", "Geräte mit offenem Erfassungsende", pending)) +
    (conflicts ? line("CircleAlert", "Offene Klärfälle", conflicts) : "") +
    '<div class="actions"><button type="button" class="secondary" data-act="' +
    (device ? "sync" : "refreshWorkplace") +
    '">' +
    icon("RefreshCw") +
    (device && !online
      ? "Jetzt synchronisieren"
      : "Refresh entries") +
    "</button>" +
    route("Perioden", "Abschluss prüfen", "secondary", "ClipboardCheck") +
    "</div></section>"
  );
}
export function overview(
  e,
  rows,
  pending,
  conflicts,
  device,
  eventMode = false,
  role = "Admin",
  periodID = "",
  online = false,
  canAddOpening = false,
) {
  const periods = rows.filter((r) => r.Kind === "period" && r.Data.To);
  const period = periods.find((r) => r.ID === periodID);
  if (period)
    rows = rows.filter(
      (r) =>
        ["account", "wallet", "bar"].includes(r.Kind) ||
        (r.Data.Date >= period.Data.Date && r.Data.Date <= period.Data.To),
    );
  const scope = periods.length
    ? '<label class="period-picker">Auswertungszeitraum<select name="overview-period"><option value="">Gesamter Arbeitsbereich</option>' +
      periods
        .map(
          (r) =>
            '<option value="' +
            esc(r.ID) +
            '" ' +
            (r.ID === periodID ? "selected" : "") +
            ">" +
            esc(r.Data.Label) +
            " · " +
            dat(r.Data.Date) +
            " – " +
            dat(r.Data.To) +
            "</option>",
        )
        .join("") +
      "</select></label>"
    : "";
  const a = summary(rows),
    opening = rows.filter((r) => r.Kind === "opening"),
    sum = (r) => r.reduce((n, x) => n + (x.Data.Amount || 0), 0),
    start = sum(opening);
  const uniqueOpening =
    opening.length > 0 &&
    new Set(opening.map((r) => (e.Accounts ? r.Data.Account || "" : "gesamt")))
      .size === opening.length;
  const openingText = uniqueOpening
    ? "Mit erfasstem Anfangsbestand"
    : opening.length
      ? "Mehrere Eröffnungen · Zeitraum prüfen"
      : canAddOpening
        ? '<button type="button" class="opening-action" data-act="focusEntry" aria-haspopup="dialog">Opening balance missing</button>'
        : "Opening balance missing";
  const setupAction =
    role === "Read" ? "Leseprofil vorbereiten" : "Erfassung vorbereiten";
  const balance = uniqueOpening
    ? eur(
        start +
          a.ear +
          sum(rows.filter((r) => r.Kind === "deposit")) -
          sum(rows.filter((r) => r.Kind === "deposit-return")),
      )
    : "Offen";
  const reconciliation = closure(rows, e.Accounts, false)["report.closing"];
  const accounts = (uniqueOpening ? reconciliation.account_lines || [] : [])
    .map((account) =>
      line(
        "Wallet",
        account.label,
        account.theoretical_cents == null
          ? "Zuordnung offen"
          : eur(account.theoretical_cents),
      ),
    )
    .join("");
  const kpi = (t, v, n, cl) =>
    '<div class="kpi ' +
    cl +
    '"><span>' +
    t +
    "</span><strong>" +
    esc(v) +
    "</strong><small>" +
    n +
    "</small></div>";
  const task = (p, ico, t, n) =>
    '<button type="button" class="task" data-page="' +
    p +
    '">' +
    icon(ico) +
    "<span><strong>" +
    t +
    "</strong><small>" +
    esc(n) +
    "</small></span>" +
    icon("ChevronRight") +
    "</button>";
  return (
    '<div class="page-head"><div><h1>' +
    (eventMode ? esc(e.Name) : "Finanzen im Überblick") +
    "</h1><p>" +
    esc(eventMode ? "Veranstaltungsabrechnung" : e.Name) +
    " · " +
    dat(e.Starts) +
    " – " +
    dat(e.Ends) +
    "</p></div>" +
    (!device && e.Closed
      ? ""
      : route(
          device
            ? online && !e.General
              ? "Zahlungen"
              : "Journal"
            : "Einrichtung",
          device
            ? online && !e.General
              ? "Veranstaltungsbuchungen öffnen"
              : "Kassenbuch öffnen"
            : setupAction,
          "primary",
          device ? "BookOpen" : "Laptop",
        )) +
    "</div>" +
    (eventMode
      ? tabs(online ? onlineEventTabs : eventTabs, "Veranstaltungen") +
        eventCounts(rows, device, pending, conflicts, online)
      : "") +
    scope +
    '<div class="kpis">' +
    kpi("Bestand laut Buchungen", balance, openingText, "featured") +
    kpi("Einnahmen", eur(a.receipts), "Ausgaben " + eur(a.paid), "") +
    kpi(
      eventMode ? "Veranstaltungsergebnis" : "Einnahmenüberschuss",
      eur(eventMode ? a.result : a.ear),
      eventMode
        ? "Erlöse abzüglich direkter und weiterer Kosten"
        : "Zahlungswirksame Einnahmen und Ausgaben",
      (eventMode ? a.result : a.ear) < 0 ? "negative" : "result",
    ) +
    "</div>" +
    '<div class="columns"><section>' +
    head("Deine Geldbestände") +
    accounts +
    line("Landmark", "Anfangsbestand", uniqueOpening ? eur(start) : "Offen") +
    line("Wallet", "Offene Privatauslagen", eur(a.outstanding)) +
    '<p class="panel-foot">' +
    esc(
      e.Accounts
        ? "Kontozuordnung aktiviert"
        : "Gesamtbestand ohne Kontozuordnung",
    ) +
    "</p></section><section>" +
    head("Noch zu erledigen") +
    task(
      "Perioden",
      "ClipboardCheck",
      "Abrechnung prüfen",
      e.Closed
        ? "Abgeschlossen"
        : online
          ? "Bestände und Abrechnung prüfen"
          : pending === 1
            ? "Ein Gerät mit offenem Erfassungsende"
            : pending + " Geräte mit offenem Erfassungsende",
    ) +
    (online
      ? task(
          "Veranstaltungsliste",
          "CalendarDays",
          "Veranstaltungen",
          "Veranstaltungen dieses Geschäftsjahrs öffnen",
        )
      : task(
          device ? "Gerät & Sync" : e.Closed ? "Perioden" : "Einrichtung",
          conflicts ? "CircleAlert" : "Laptop",
          conflicts
            ? "Klärfälle prüfen"
            : device
              ? "Geräteabgleich"
              : e.Closed
                ? "Abschluss ansehen"
                : role === "Read"
                  ? "Leseprofil einrichten"
                  : "Offline-Erfassung einrichten",
          conflicts
            ? conflicts + " offene Konflikte"
            : device
              ? "Lokal gespeicherte Vorgänge abgleichen"
              : role === "Read"
                ? "Für die Einsicht in die zugewiesenen Arbeitsbereiche"
                : "Für Buchungen und Belegausgabe auf diesem Gerät",
        )) +
    "</section></div>" +
    (eventMode
      ? walletTable(rows)
      : '<section class="event-strip">' +
        icon(e.General ? "BookOpen" : "CalendarDays") +
        "<div><small>Aktiver Arbeitsbereich</small><h2>" +
        esc(e.Name) +
        "</h2></div>" +
        route(
          e.General ? "Journal" : "Veranstaltungen",
          e.General ? "Zum Kassenbuch" : "Veranstaltung öffnen",
          "secondary",
        ) +
        "</section>") +
    "<section>" +
    head(
      "Letzte Buchungen",
      route(
        online && !e.General ? "Zahlungen" : "Journal",
        "Alle Buchungen",
        "text-button",
      ),
    ) +
    ledger(bookings(rows).slice(0, 6)) +
    "</section>"
  );
}
