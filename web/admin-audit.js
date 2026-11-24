import { esc } from "./workplace.js";

const money = new Intl.NumberFormat("de-AT", {
  style: "currency",
  currency: "EUR",
});
const clock = new Intl.DateTimeFormat("de-AT", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Vienna",
});
const when = (value) => (value ? clock.format(new Date(value)) : "–");
const bytes = (value) =>
  new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 }).format(
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

function integrity(checks, at) {
  return (
    checks
      .map((c) =>
        row(
          "Prüfkette " + c.Lane,
          (c.OK ? "Intakt" : "Unterbrochen") + " · " + c.Entries + " Einträge",
        ),
      )
      .join("") + row("Prüfzeitpunkt", when(at))
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
  let years = [],
    events = [],
    items = [],
    more = false,
    selected = null,
    proof = null,
    loaded = false,
    revision = 0;
  const isLead = identity?.role === "Leitung";
  function render() {
    root.innerHTML =
      pageHead(
        "Audit-Log",
        "Finanzbuchungen, Zugriffsänderungen und Betriebsvorgänge nachvollziehen.",
        (isLead ? button("integrity", "Prüfketten prüfen") : "") +
          button("csv", "CSV exportieren"),
      ) +
      '<form class="ops-filter"><label>Suche<input name="q" maxlength="256" value="' +
      esc(filters.q) +
      '" placeholder="Aktion, Objekt oder Ereignis"></label>' +
      '<label>Aktion<input name="action" maxlength="256" value="' +
      esc(filters.action) +
      '"></label>' +
      '<label>Benutzer<input name="user" maxlength="256" value="' +
      esc(filters.user) +
      '"></label><label><span id="audit-outcome-label">Ergebnis</span><select name="outcome" aria-labelledby="audit-outcome-label">' +
      option("", "Alle Ergebnisse", filters.outcome) +
      [
        "Übernommen",
        "Konflikt",
        "Geklärt",
        "Abgewiesen",
        "Erfolgreich",
        "Fehlgeschlagen",
      ]
        .map((value) => option(value, value, filters.outcome))
        .join("") +
      "</select></label>" +
      '<label>Geschäftsjahr<select name="auditYear">' +
      option("", "Alle Geschäftsjahre", filters.year) +
      years.map((y) => option(y.ID, y.Name, filters.year)).join("") +
      "</select></label>" +
      '<label>Arbeitsbereich<select name="event">' +
      eventOptions(filters.year, filters.event) +
      "</select></label>" +
      '<label>Von<input type="date" name="from" value="' +
      esc(filters.from) +
      '"></label>' +
      '<label>Bis einschließlich<input type="date" name="until" value="' +
      esc(filters.until) +
      '"></label>' +
      '<div class="actions"><button>Filtern</button>' +
      button("clear", "Zurücksetzen") +
      "</div></form>" +
      '<p class="ops-notice" role="status"></p>' +
      (proof
        ? panel("Integritätsprüfung", integrity(proof.chains, proof.at))
        : "") +
      panel(
        "Protokolleinträge",
        !loaded
          ? '<p class="ops-empty">Protokoll wird geladen …</p>'
          : !items.length
            ? '<p class="ops-empty">Keine Einträge für diese Auswahl.</p>'
            : '<div class="list"><table><thead><tr><th>Serverzeit</th><th>Aktion</th><th>Ausgeführt von</th><th>Arbeitsbereich</th></tr></thead><tbody>' +
              items
                .map(
                  (e) =>
                    "<tr" +
                    (e.ID === selected ? ' class="ops-selected"' : "") +
                    "><td>" +
                    esc(when(e.At)) +
                    '</td><td><button type="button" class="ops-record" data-entry="' +
                    e.ID +
                    '">' +
                    esc(e.Action) +
                    "</button></td><td>" +
                    esc(e.User) +
                    "</td><td>" +
                    esc(e.Event || "Installation") +
                    "</td></tr>",
                )
                .join("") +
              "</tbody></table></div>" +
              '<div class="ops-pages"><span>Seite ' +
              cursors.length +
              " · " +
              items.length +
              ' Einträge</span><div class="actions">' +
              (cursors.length > 1 ? button("prev", "Neuere") : "") +
              (more ? button("next", "Ältere") : "") +
              "</div></div>",
      ) +
      details();
  }
  function eventOptions(year, value) {
    return (
      option("", "Alle Arbeitsbereiche", value) +
      events
        .filter((e) => !year || e.Year === year)
        .map((e) => option(e.ID, e.Name, value))
        .join("")
    );
  }
  function details() {
    const e = items.find((i) => i.ID === selected);
    if (!e) return "";
    const cols = [
      ["Aktion", e.Action],
      ["Benutzer", e.User],
      ["Bezug", e.Subject],
      ["Arbeitsbereich", e.Event || "Installation"],
      ["Geschäftsjahr", e.Year],
      ["Herkunft", e.Source],
      ["Serverannahme", when(e.At)],
      ["Lokale Erfassung", e.LocalTime ? when(e.LocalTime) : ""],
      ["Ergebnis", e.Outcome],
      ["Ausgangsrevision", e.Base],
      ["Zielrevision", e.Revision],
      ["Betrag vorher", e.PreviousCents != null ? cash(e.PreviousCents) : ""],
      ["Betrag nachher", e.Cents != null ? cash(e.Cents) : ""],
      ["Quellkonto", e.Origin],
      ["Zielkonto", e.Destination],
      ["Begründung", e.Reason],
    ];
    return panel(
      "Ereignis " + e.ID,
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
    selected = items.find((e) => "#" + e.ID === filters.q)?.ID ?? null;
    render();
  }
  async function run(fn) {
    try {
      await fn();
    } catch (err) {
      const msg = root.querySelector(".ops-notice");
      if (msg) msg.textContent = err.message || "Protokoll nicht erreichbar.";
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
      selected = Number(b.dataset.entry);
      render();
      root.lastElementChild?.scrollIntoView({ block: "nearest" });
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
  if (!target) return "Unbekannt";
  if (!probe && !target.enabled)
    return target.lastSuccess
      ? "Zeitplan aus · letzter Erfolg " + when(target.lastSuccess)
      : "Zeitplan deaktiviert";
  if (target.outcome === "failed")
    return "Fehlgeschlagen · " + when(target.lastAttempt);
  if (target.due)
    return "Überfällig · letzter Erfolg " + when(target.lastSuccess);
  if (target.lastSuccess) return "Erfolgreich · " + when(target.lastSuccess);
  return "Noch nie erfolgreich geprüft";
}

export function mountStatus(host, { api }) {
  const root = document.createElement("div");
  root.className = "ops-admin";
  host.replaceChildren(root);
  const intro = pageHead(
    "Systemstatus",
    "Betriebszustand der Installation und Ergebnisse der letzten Prüfungen.",
    button("refresh", "Aktualisieren"),
  );
  let generation = 0;
  async function refresh() {
    const token = ++generation;
    root.innerHTML =
      intro + '<p role="status">Betriebsdaten werden geladen …</p>';
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
          ? "Unter einer Stunde"
          : Math.floor(hours / 24) + " Tage, " + (hours % 24) + " Stunden";
      const links =
        '<div class="actions"><button type="button" class="secondary" data-admin-route="Backup">Backup öffnen</button>' +
        '<button type="button" class="secondary" data-admin-route="Audit-Log">Zum Audit-Log</button></div>';
      const failed = [backup?.local, backup?.s3, backup?.probe].some(
        (x) => x?.outcome === "failed",
      );
      const warning = failed
        ? '<div class="ops-warning"><strong>Sicherung oder Restore-Probe fehlgeschlagen.</strong> <button type="button" class="secondary" data-admin-route="Audit-Log" data-admin-search="Backup">Backup-Ereignisse ansehen</button></div>'
        : "";
      root.innerHTML =
        intro +
        warning +
        '<div class="ops-pair">' +
        panel(
          "Anwendung",
          row("Betriebsart", s.offline ? "Gerätebetrieb" : "Onlinebetrieb") +
            row("Laufzeit", uptime) +
            row("Server-Build", s.build) +
            row("Go-Laufzeit", s.runtime) +
            row(
              "App-Dateisystem frei",
              s.appDisk
                ? bytes(s.appDisk.free) + " von " + bytes(s.appDisk.total)
                : "Keine Messung verfügbar",
            ) +
            row(
              "Fehlgeschlagene HTTP-Anfragen seit Start",
              num(s.failedRequests),
            ),
          badge("Erreichbar"),
        ) +
        panel(
          "PostgreSQL",
          row("Version", s.postgres) +
            row("Schema", "Migration " + s.schema) +
            row("Datenbankgröße", bytes(s.databaseBytes)) +
            row(
              "Verbindungen im App-Pool",
              s.usedConnections +
                " aktiv / " +
                s.openConnections +
                " offen / " +
                s.maxConnections +
                " maximal",
            ) +
            row("Aktive Sitzungen", num(s.sessions)),
          badge("Bereit"),
        ) +
        "</div>" +
        panel(
          "Betriebsprüfungen",
          row("Lokales Backup", backupStatus(backup?.local)) +
            row("S3-Sicherung", backupStatus(backup?.s3)) +
            row("Wiederherstellungsprobe", backupStatus(backup?.probe, true)) +
            integrity(s.chains, s.at) +
            row("Offene finanzielle Klärfälle", num(s.conflicts)) +
            links,
        ) +
        (failures?.rows.length
          ? panel(
              "Letzte fehlgeschlagene Aufträge",
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
          esc(err.message || "Status konnte nicht geladen werden.") +
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
