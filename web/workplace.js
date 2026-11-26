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
  financialLabel,
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
  ({Feuerwehrkonten: "Treasury accounts", Benutzer: "Users", Systemstatus: "System status",
    "Audit-Log": "Audit log", Geschäftsjahre: "Fiscal years", "Konto und Sicherheit": "Account and security"}[p] ||
    modules.find(([k]) => k === sectionOf(p))?.[1] || p);
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
const dateFmt = new Intl.DateTimeFormat("en-GB", {
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
    return '<p class="empty">No transactions recorded yet.</p>';
  return (
    '<div class="list ledger-list"><table><thead><tr><th>Date</th><th>Description</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>' +
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
      ["Person or company", "Address"],
      (r) => [r.Data.Label, r.Data.Address || "Pending"],
    ],
    Preise: [
      ["Item", "Category", "Unit", "Price", "Approval"],
      (r) => [
        r.Data.Label,
        financialLabel(r.Data.Category) || "—",
        r.Data.Unit || "—",
        eur(r.Data.Amount),
        financialLabel(r.Data.Status || "Entwurf"),
      ],
    ],
    Perioden: [
      ["Description", "From", "To"],
      (r) => [r.Data.Label, dat(r.Data.Date), dat(r.Data.To)],
    ],
    Sponsoring: [
      ["Receivable", "Pledged or invoiced", "Paid", "Outstanding"],
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
    return '<p class="empty">No entries in this workspace yet.</p>';
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
        phase === "Ende" && r.Data.Status ? " · " + esc(financialLabel(r.Data.Status)) : "";
      const pooled = phase === "Anfang" ? allStart : allEnd;
      if (pooled)
        return overall
          ? eur(pooled.Data.Amount) + status(pooled)
          : "Combined count only";
      const counts = group.map((w) =>
        rows.find(
          (r) =>
            r.Kind === "count" &&
            r.Data.Wallet === w.ID &&
            r.Data.Phase === phase,
        ),
      );
      if (!counts.length || !counts.every(Boolean)) return "Pending";
      return (
        eur(counts.reduce((sum, r) => sum + r.Data.Amount, 0)) +
        (counts.length === 1 ? status(counts[0]) : "")
      );
    }
    let revenue = "Pending";
    if (allEnd || allStart) {
      if (!overall) revenue = "Combined count only";
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
    head("Wallets") +
    (wallets.length || allStart || allEnd
      ? '<div class="list"><table><thead><tr><th>Area</th><th class="num">Opening balance</th><th class="num">Closing balance</th><th class="num">Cash takings</th></tr></thead><tbody>' +
        subtotal("All wallets", wallets, true) +
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
      : '<p class="empty">No wallets recorded yet.</p>') +
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
        title + " · all wallets combined",
        eur(pool.Data.Amount),
      );
    const selected = wallets.map((w) =>
      counts.find((r) => r.Data.Wallet === w.ID && r.Data.Phase === name),
    );
    const found = selected.filter((r) => r?.Data.Amount != null);
    return line(
      "Wallet",
      title + " · " + found.length + " from " + wallets.length + " Wallets",
      found.length
        ? eur(found.reduce((sum, r) => sum + r.Data.Amount, 0))
        : "Pending",
    );
  };
  return (
    '<section class="event-counts">' +
    head("Wallet count status") +
    phase("Anfang", "Opening count") +
    phase("Ende", "Closing count") +
    (online
      ? ""
      : line("RefreshCw", "Devices still recording", pending)) +
    (conflicts ? line("CircleAlert", "Unresolved cases", conflicts) : "") +
    '<div class="actions"><button type="button" class="secondary" data-act="' +
    (device ? "sync" : "refreshWorkplace") +
    '">' +
    icon("RefreshCw") +
    (device && !online
      ? "Synchronize now"
      : "Refresh entries") +
    "</button>" +
    route("Perioden", "Review settlement", "secondary", "ClipboardCheck") +
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
    ? '<label class="period-picker">Reporting period<select name="overview-period"><option value="">Entire workspace</option>' +
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
  const openingIDs = new Set(opening.map((r) => r.Data.Account));
  const covered = !e.Accounts || rows.filter((r) => ["account", "wallet"].includes(r.Kind)).every((r) => openingIDs.has(r.ID));
  const uniqueOpening =
    covered &&
    opening.length > 0 &&
    new Set(opening.map((r) => (e.Accounts ? r.Data.Account || "" : "gesamt")))
      .size === opening.length;
  const openingText = uniqueOpening
    ? "Opening balance recorded"
    : opening.length && covered
      ? "Multiple opening balances · Check the period"
      : canAddOpening
        ? '<button type="button" class="opening-action" data-act="focusEntry" aria-haspopup="dialog">Opening balance missing</button>'
        : "Opening balance missing";
  const setupAction =
    role === "Read" ? "Prepare read-only profile" : "Prepare recording";
  const balance = uniqueOpening
    ? eur(
        start +
          a.ear +
          sum(rows.filter((r) => r.Kind === "deposit")) -
          sum(rows.filter((r) => r.Kind === "deposit-return")),
      )
    : "Pending";
  const reconciliation = closure(rows, e.Accounts, false)["report.closing"];
  const accounts = (uniqueOpening ? reconciliation.account_lines || [] : [])
    .map((account) =>
      line(
        "Wallet",
        account.label,
        account.theoretical_cents == null
          ? "Account not assigned"
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
    (eventMode ? esc(e.Name) : "Financial overview") +
    "</h1><p>" +
    esc(eventMode ? "Event settlement" : e.Name) +
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
              ? "Open event transactions"
              : "Open cashbook"
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
    kpi("Book balance", balance, openingText, "featured") +
    kpi("Income", eur(a.receipts), "Expenses " + eur(a.paid), "") +
    kpi(
      eventMode ? "Event result" : "Net receipts",
      eur(eventMode ? a.result : a.ear),
      eventMode
        ? "Receipts less direct and other costs"
        : "Cash received less payments made",
      (eventMode ? a.result : a.ear) < 0 ? "negative" : "result",
    ) +
    "</div>" +
    '<div class="columns"><section>' +
    head("Account balances") +
    accounts +
    line("Landmark", "Opening balance", uniqueOpening ? eur(start) : "Pending") +
    line("Wallet", "Unreimbursed expenses", eur(a.outstanding)) +
    '<p class="panel-foot">' +
    esc(
      e.Accounts
        ? "Account assignment enabled"
        : "Combined balance without account assignment",
    ) +
    "</p></section><section>" +
    head("Next steps") +
    task(
      "Perioden",
      "ClipboardCheck",
      "Review settlement",
      e.Closed
        ? "Closed"
        : online
          ? "Review balances and settlement"
          : pending === 1
            ? "One device has not finished recording"
            : pending + " Devices still recording",
    ) +
    (online
      ? task(
          "Veranstaltungsliste",
          "CalendarDays",
          "Events",
          "Open events in this fiscal year",
        )
      : task(
          device ? "Gerät & Sync" : e.Closed ? "Perioden" : "Einrichtung",
          conflicts ? "CircleAlert" : "Laptop",
          conflicts
            ? "Review cases"
            : device
              ? "Device sync"
              : e.Closed
                ? "View closing statement"
                : role === "Read"
                  ? "Set up read-only profile"
                  : "Set up offline recording",
          conflicts
            ? conflicts + " open conflicts"
            : device
              ? "Sync locally saved transactions"
              : role === "Read"
                ? "For viewing assigned workspaces"
                : "For recording transactions and issuing receipts on this device",
        )) +
    "</section></div>" +
    (eventMode
      ? walletTable(rows)
      : '<section class="event-strip">' +
        icon(e.General ? "BookOpen" : "CalendarDays") +
        "<div><small>Current workspace</small><h2>" +
        esc(e.Name) +
        "</h2></div>" +
        route(
          e.General ? "Journal" : "Veranstaltungen",
          e.General ? "Go to cashbook" : "Open event",
          "secondary",
        ) +
        "</section>") +
    "<section>" +
    head(
      "Recent transactions",
      route(
        online && !e.General ? "Zahlungen" : "Journal",
        "All transactions",
        "text-button",
      ),
    ) +
    ledger(bookings(rows).slice(0, 6)) +
    "</section>"
  );
}
