import { esc } from "./workplace.js";

const money = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "EUR",
});
const clock = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Vienna",
});
const when = (value) => (value ? clock.format(new Date(value)) : "–");
const bytes = (value) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(
    value / 1048576,
  ) + " MiB";
const num = (value) => (Number.isFinite(value) ? String(value) : "–");
const cash = (value) => (value == null ? "–" : money.format(value / 100));
const button = (key, label) =>
  '<button type="button" class="secondary" data-check="' +
  key +
  '">' +
  esc(label) +
  "</button>";
const option = (value, label, selected) =>
  '<option value="' +
  esc(value) +
  '"' +
  (value === selected ? " selected" : "") +
  ">" +
  esc(label) +
  "</option>";
const row = (label, value) =>
  '<div class="ops-row"><span>' +
  esc(label) +
  "</span><b>" +
  esc(value) +
  "</b></div>";
const panel = (heading, content, extra = "") =>
  '<section class="ops-panel"><div class="ops-heading"><h2>' +
  esc(heading) +
  "</h2>" +
  extra +
  "</div>" +
  content +
  "</section>";
const pageHead = (heading, lead, buttons) =>
  '<div class="page-head"><div><h1>' +
  esc(heading) +
  "</h1><p>" +
  esc(lead) +
  '</p></div><div class="actions">' +
  buttons +
  "</div></div>";
const badge = (label, tone = "ok") =>
  '<span class="ops-badge ' + tone + '">' + esc(label) + "</span>";

const outcomeLabel = (value) => ({
  Übernommen: "Accepted", Konflikt: "Conflict", Geklärt: "Resolved",
  Abgewiesen: "Rejected", Erfolgreich: "Successful", Fehlgeschlagen: "Failed",
}[value] || value);

function integrity(checks, at) {
  return (
    checks
      .map((c) =>
        row(
          "Audit chain " + c.Lane,
          (c.OK ? "Intact" : "Broken") + " · " + c.Entries + " entries",
        ),
      )
      .join("") + row("Verified at", when(at))
  );
}

export function mountAudit(host, { api, identity, search = "" }) {
  const root = document.createElement("div");
  root.className = "ops-admin";
  host.replaceChildren(root);
  const filters = {
    q: search,
    user: "",
    action: "",
    outcome: "",
    from: "",
    until: "",
    event: "",
    year: "",
  };
  const cursors = [""];
  const expanded = new Set();
  let years = [],
    events = [],
    items = [],
    more = false,
    proof = null,
    loaded = false,
    revision = 0;
  const isAdmin = identity?.role === "Admin";
  function render() {
    root.innerHTML =
      pageHead(
        "Audit log",
        "Review financial postings, access changes and system events.",
        (isAdmin ? button("integrity", "Verify audit chains") : "") +
          button("csv", "Export CSV"),
      ) +
      '<form class="ops-filter"><label>Search<input name="q" maxlength="256" value="' +
      esc(filters.q) +
      '" placeholder="Action, object or event"></label>' +
      '<label>Action<input name="action" maxlength="256" value="' +
      esc(filters.action) +
      '"></label>' +
      '<label>User<input name="user" maxlength="256" value="' +
      esc(filters.user) +
      '"></label><label><span id="audit-outcome-label">Outcome</span><select name="outcome" aria-labelledby="audit-outcome-label">' +
      option("", "All outcomes", filters.outcome) +
      [
        "Übernommen",
        "Konflikt",
        "Geklärt",
        "Abgewiesen",
        "Erfolgreich",
        "Fehlgeschlagen",
      ]
        .map((value) => option(value, outcomeLabel(value), filters.outcome))
        .join("") +
      "</select></label>" +
      '<label>Fiscal year<select name="auditYear">' +
      option("", "All fiscal years", filters.year) +
      years.map((y) => option(y.ID, y.Name, filters.year)).join("") +
      "</select></label>" +
      '<label>Workspace<select name="event">' +
      eventOptions(filters.year, filters.event) +
      "</select></label>" +
      '<label>From<input type="date" name="from" value="' +
      esc(filters.from) +
      '"></label>' +
      '<label>Through<input type="date" name="until" value="' +
      esc(filters.until) +
      '"></label>' +
      '<div class="actions"><button>Filter</button>' +
      button("clear", "Reset") +
      "</div></form>" +
      '<p class="ops-notice" role="status"></p>' +
      (proof
        ? panel("Integrity check", integrity(proof.chains, proof.at))
        : "") +
      panel(
        "Audit entries",
        !loaded
          ? '<p class="ops-empty">Loading audit entries…</p>'
          : !items.length
            ? '<p class="ops-empty">No entries match these filters.</p>'
            : '<div class="list"><table><thead><tr><th>Server time</th><th>Action</th><th>Performed by</th><th>Workspace</th></tr></thead><tbody>' +
              items
                .map(
                  (e) =>
                    "<tr" +
                    (expanded.has(e.ID) ? ' class="ops-selected"' : "") +
                    "><td>" +
                    esc(when(e.At)) +
                    '</td><td><button type="button" class="ops-record" data-entry="' +
                    e.ID +
                    '" aria-expanded="' +
                    expanded.has(e.ID) +
                    '" aria-controls="audit-detail-' +
                    e.ID +
                    '">' +
                    esc(e.Action) +
                    "</button></td><td>" +
                    esc(e.User) +
                    "</td><td>" +
                    esc(e.Event || "Installation") +
                    '</td></tr><tr class="ops-detail" id="audit-detail-' +
                    e.ID +
                    '"' +
                    (expanded.has(e.ID) ? "" : " hidden") +
                    '><td colspan="4">' +
                    (expanded.has(e.ID) ? details(e) : "") +
                    "</td></tr>",
                )
                .join("") +
              "</tbody></table></div>" +
              '<div class="ops-pages"><span>Page ' +
              cursors.length +
              " · " +
              items.length +
              ' entries</span><div class="actions">' +
              (cursors.length > 1 ? button("prev", "Newer") : "") +
              (more ? button("next", "Older") : "") +
              "</div></div>",
      );
  }
  function eventOptions(year, value) {
    return (
      option("", "All workspaces", value) +
      events
        .filter((e) => !year || e.Year === year)
        .map((e) => option(e.ID, e.Name, value))
        .join("")
    );
  }
  function details(e) {
    const cols = [
      ["Action", e.Action],
      ["User", e.User],
      ["Reference", e.Subject],
      ["Workspace", e.Event || "Installation"],
      ["Fiscal year", e.Year],
      ["Source", e.Source],
      ["Received by server", when(e.At)],
      ["Entered locally", e.LocalTime ? when(e.LocalTime) : ""],
      ["Outcome", outcomeLabel(e.Outcome)],
      ["Previous revision", e.Base],
      ["New revision", e.Revision],
      ["Previous amount", e.PreviousCents != null ? cash(e.PreviousCents) : ""],
      ["New amount", e.Cents != null ? cash(e.Cents) : ""],
      ["Source account", e.Origin],
      ["Destination account", e.Destination],
      ["Reason", e.Reason],
    ];
    return panel(
      "Event " + e.ID,
      cols
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => row(k, v))
        .join(""),
    );
  }
  const query = () =>
    new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  async function fetchPage() {
    const token = ++revision,
      params = query();
    if (cursors.at(-1)) params.set("before", cursors.at(-1));
    const reply = await api("admin/audit?" + params);
    if (token !== revision) return;
    items = reply.rows;
    more = reply.more;
    loaded = true;
    expanded.clear();
    const match = items.find((e) => "#" + e.ID === filters.q);
    if (match) expanded.add(match.ID);
    render();
  }
  async function run(fn) {
    try {
      await fn();
    } catch (err) {
      const msg = root.querySelector(".ops-notice");
      if (msg) msg.textContent = err.message || "Audit log unavailable.";
    }
  }
  root.addEventListener("change", (e) => {
    if (e.target.name === "auditYear")
      root.querySelector('[name="event"]').innerHTML = eventOptions(
        e.target.value,
        "",
      );
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const { auditYear, ...fields } = Object.fromEntries(new FormData(e.target));
    Object.assign(filters, fields, { year: auditYear });
    cursors.splice(1);
    run(fetchPage);
  });
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.type === "submit") return;
    e.stopPropagation();
    if (b.dataset.entry) {
      const id = Number(b.dataset.entry);
      const entryRow = b.closest("tr");
      const detailRow = entryRow.nextElementSibling;
      const opening = detailRow.hidden;
      if (opening) {
        expanded.add(id);
        if (!detailRow.cells[0].hasChildNodes())
          detailRow.cells[0].innerHTML = details(
            items.find((item) => item.ID === id),
          );
      } else expanded.delete(id);
      detailRow.hidden = !opening;
      entryRow.classList.toggle("ops-selected", opening);
      b.setAttribute("aria-expanded", String(opening));
      return;
    }
    run(async () => {
      switch (b.dataset.check) {
        case "clear":
          for (const k of Object.keys(filters)) filters[k] = "";
          cursors.splice(1);
          break;
        case "prev":
          cursors.pop();
          break;
        case "next":
          cursors.push(String(items.at(-1).ID));
          break;
        case "integrity":
          proof = await api("admin/audit/integrity");
          render();
          return;
        case "csv": {
          const { csv } = await api("admin/audit/export?" + query(), {});
          const target = URL.createObjectURL(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
          );
          const a = document.createElement("a");
          a.href = target;
          a.download = "bonfire-audit.csv";
          a.click();
          setTimeout(() => URL.revokeObjectURL(target), 1000);
          return;
        }
        default:
          return;
      }
      await fetchPage();
    });
  });
  render();
  run(async () => {
    [years, events] = await Promise.all([api("years"), api("events")]);
    await fetchPage();
  });
}

function backupStatus(target, probe = false) {
  if (!target) return "Unknown";
  if (!probe && !target.enabled)
    return target.lastSuccess
      ? "Schedule off · last success " + when(target.lastSuccess)
      : "Schedule disabled";
  if (target.outcome === "failed")
    return "Failed · " + when(target.lastAttempt);
  if (target.due)
    return "Overdue · last success " + when(target.lastSuccess);
  if (target.lastSuccess) return "Successful · " + when(target.lastSuccess);
  return "No successful check recorded";
}

export function mountStatus(host, { api }) {
  const root = document.createElement("div");
  root.className = "ops-admin";
  host.replaceChildren(root);
  const intro = pageHead(
    "System status",
    "Service health and results of the latest checks.",
    button("refresh", "Refresh"),
  );
  let generation = 0;
  async function refresh() {
    const token = ++generation;
    root.innerHTML =
      intro + '<p role="status">Loading system status…</p>';
    try {
      const [s, backup, failures] = await Promise.all([
        api("admin/status"),
        api("admin/backup").catch(() => null),
        api("admin/audit?outcome=Fehlgeschlagen").catch(() => null),
      ]);
      if (token !== generation) return;
      const hours = Math.floor(
        (Date.parse(s.at) - Date.parse(s.started)) / 3600000,
      );
      const uptime =
        hours < 1
          ? "Less than an hour"
          : Math.floor(hours / 24) + " days, " + (hours % 24) + " hours";
      const links =
        '<div class="actions"><button type="button" class="secondary" data-admin-route="Backup">Open backups</button>' +
        '<button type="button" class="secondary" data-admin-route="Audit-Log">Open audit log</button></div>';
      const failed = [backup?.local, backup?.s3, backup?.probe].some(
        (x) => x?.outcome === "failed",
      );
      const warning = failed
        ? '<div class="ops-warning"><strong>Backup or restore test failed.</strong> <button type="button" class="secondary" data-admin-route="Audit-Log" data-admin-search="Backup">View backup events</button></div>'
        : "";
      root.innerHTML =
        intro +
        warning +
        '<div class="ops-pair">' +
        panel(
          "Application",
          row("Operating mode", s.offline ? "Device mode" : "Online") +
            row("Uptime", uptime) +
            row("Server build", s.build) +
            row("Go runtime", s.runtime) +
            row(
              "Free application disk space",
              s.appDisk
                ? bytes(s.appDisk.free) + " of " + bytes(s.appDisk.total)
                : "Measurement unavailable",
            ) +
            row(
              "Failed HTTP requests since startup",
              num(s.failedRequests),
            ),
          badge("Reachable"),
        ) +
        panel(
          "PostgreSQL",
          row("Version", s.postgres) +
            row("Schema", "Migration " + s.schema) +
            row("Database size", bytes(s.databaseBytes)) +
            row(
              "Application pool connections",
              s.usedConnections +
                " active / " +
                s.openConnections +
                " open / " +
                s.maxConnections +
                " maximum",
            ) +
            row("Active sessions", num(s.sessions)),
          badge("Ready"),
        ) +
        "</div>" +
        panel(
          "Operational checks",
          row("Local backup", backupStatus(backup?.local)) +
            row("S3 backup", backupStatus(backup?.s3)) +
            row("Restore test", backupStatus(backup?.probe, true)) +
            integrity(s.chains, s.at) +
            row("Unresolved financial conflicts", num(s.conflicts)) +
            links,
        ) +
        (failures?.rows.length
          ? panel(
              "Recent failed jobs",
              failures.rows
                .slice(0, 5)
                .map(
                  (e) =>
                    '<div class="ops-row"><span>' +
                    esc(when(e.At)) +
                    '</span><button type="button" class="ops-record" data-admin-route="Audit-Log" data-admin-search="#' +
                    e.ID +
                    '">' +
                    esc(e.Action + " · " + e.Subject) +
                    "</button></div>",
                )
                .join(""),
            )
          : "");
    } catch (err) {
      if (token === generation)
        root.innerHTML =
          intro +
          '<p role="alert">' +
          esc(err.message || "Could not load system status.") +
          "</p>";
    }
  }
  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-check="refresh"]')) {
      e.stopPropagation();
      refresh();
    }
  });
  refresh();
}
