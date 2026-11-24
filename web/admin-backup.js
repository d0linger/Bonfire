import { esc } from "./workplace.js";

const stamp = (time) =>
  time
    ? new Date(time).toLocaleString("de-AT", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Noch kein Lauf";
const size = (bytes) =>
  bytes >= 1048576
    ? (bytes / 1048576).toLocaleString("de-AT", { maximumFractionDigits: 1 }) +
      " MB"
    : Math.ceil(bytes / 1024) + " kB";
const names = {
  local: "Lokales Volume",
  s3: "S3-Speicher",
  probe: "Restore-Probe",
  upload: "Hochgeladene Datei",
};
const actions = {
  backup: "Sicherung",
  probe: "Restore-Probe",
  promote: "Übernahme",
  test: "S3-Verbindungstest",
};
const button = (act, label, primary = false) =>
  '<button type="button" data-backup="' +
  act +
  '" class="' +
  (primary ? "primary" : "secondary") +
  '">' +
  label +
  "</button>";
const note = (t) => '<p class="muted">' + esc(t) + "</p>";
function badge(text, warn = false) {
  return (
    '<span class="bk-badge' +
    (warn ? " bk-warn" : "") +
    '">' +
    esc(text) +
    "</span>"
  );
}
function heading(text, side = "") {
  return '<div class="bk-heading"><h2>' + text + "</h2>" + side + "</div>";
}
function stateText(h) {
  return h?.outcome === "failed"
    ? "Fehlgeschlagen"
    : h?.outcome === "running"
      ? "Läuft"
      : h?.due
        ? "Fällig"
        : h?.lastSuccess
          ? "Erfolgreich"
          : h?.enabled
            ? "Eingeplant"
            : "Manuell";
}

export async function mountBackup(host, { api }) {
  let state,
    tab = "files",
    timer,
    dialog,
    selected,
    uploaded,
    notice = "";
  host.classList.add("bk");
  function message(value) {
    notice = value;
    const text = host.querySelector("[role=status]");
    if (text) text.textContent = value;
  }
  function tabButton(id, label) {
    return (
      '<button type="button" data-backup-tab="' +
      id +
      '" aria-current="' +
      (tab === id ? "page" : "false") +
      '">' +
      label +
      "</button>"
    );
  }
  function stats() {
    return (
      '<div class="bk-stats">' +
      [
        ["local", "Letztes lokales Backup"],
        ["s3", "Letzte S3-Sicherung"],
        ["probe", "Letzte Restore-Probe"],
      ]
        .map(
          ([k, label]) =>
            "<div><small>" +
            label +
            "</small><strong>" +
            esc(
              k === "s3" && !state.s3Configured
                ? "Nicht eingerichtet"
                : stamp(state[k]?.lastSuccess),
            ) +
            "</strong><span>" +
            esc(stateText(state[k])) +
            "</span></div>",
        )
        .join("") +
      "</div>"
    );
  }
  function targetPanel(k) {
    const cfg = state.schedules[k] || {};
    return (
      "<section>" +
      heading(
        names[k],
        badge(
          k === "s3" && !state.s3Configured
            ? "Nicht eingerichtet"
            : stateText(state[k]),
          state[k]?.outcome === "failed",
        ),
      ) +
      "<dl><dt>Zeitplan</dt><dd>" +
      esc(cfg.cron || "Manuell") +
      "</dd><dt>Aufbewahrung</dt><dd>" +
      esc(cfg.days ? cfg.days + " Tage" : "Unbegrenzt") +
      "</dd></dl></section>"
    );
  }
  function files() {
    return (
      '<div class="bk-pair">' +
      targetPanel("local") +
      targetPanel("s3") +
      "</div><section>" +
      heading("Sicherungsdateien") +
      (state.s3Error ? note(state.s3Error) : "") +
      (state.files.length
        ? '<div class="list"><table><thead><tr><th>Datei</th><th>Ziel</th><th>Größe</th><th>Ausführen</th></tr></thead><tbody>' +
          state.files
            .map(
              (f, i) =>
                "<tr><td><b>" +
                esc(f.name) +
                "</b><small>" +
                esc(stamp(f.at)) +
                "</small></td><td>" +
                esc(names[f.target]) +
                "</td><td>" +
                size(f.bytes) +
                '</td><td><div class="bk-actions"><a href="/api/admin/backup/file?target=' +
                encodeURIComponent(f.target) +
                "&amp;name=" +
                encodeURIComponent(f.name) +
                '" download>Download</a><button type="button" data-bk-file="' +
                i +
                '" class="secondary">Restore prüfen</button></div></td></tr>',
            )
            .join("") +
          "</tbody></table></div>"
        : note("Noch keine Sicherungsdatei vorhanden.")) +
      "</section>"
    );
  }
  function schedules() {
    return (
      "<p>Zeitzone " +
      esc(state.timezone) +
      ". Ein leeres Zeitplanfeld aktiviert den manuellen Betrieb.</p>" +
      ["local", "s3", "probe"]
        .map((k) => {
          const cfg = state.schedules[k] || {},
            disabled = k === "s3" && !state.s3Configured;
          return (
            "<section>" +
            heading(names[k]) +
            (disabled
              ? note(
                  "S3-Endpunkt, Bucket und Zugangsdaten im Deployment hinterlegen.",
                )
              : "") +
            '<form data-bk-form="schedule"><input type="hidden" name="target" value="' +
            k +
            '"><fieldset ' +
            (disabled ? "disabled" : "") +
            '><label>Zeitplan (Cron)<input name="cron" value="' +
            esc(cfg.cron || "") +
            '" placeholder="0 2 * * *"></label>' +
            (k === "probe"
              ? note("Geprüft wird die neueste lokale Sicherung.")
              : '<label>Aufbewahrung in Tagen (0 = unbegrenzt)<input type="number" name="days" min="0" max="3650" required value="' +
                (cfg.days ?? 30) +
                '"></label>') +
            "<button>Zeitplan speichern</button></fieldset></form>" +
            note(
              "Nächster Lauf: " +
                (state[k]?.next ? stamp(state[k].next) : "Keiner geplant"),
            ) +
            "</section>"
          );
        })
        .join("") +
      (state.s3Configured ? button("test", "S3-Verbindung testen") : "")
    );
  }
  function history() {
    return (
      "<section>" +
      heading("Auftragsverlauf") +
      (state.recent?.length
        ? '<div class="list"><table><thead><tr><th>Zeitpunkt</th><th>Auftrag</th><th>Ergebnis</th><th>Ausgeführt von</th></tr></thead><tbody>' +
          state.recent
            .map(
              (j) =>
                "<tr><td>" +
                esc(stamp(j.at)) +
                "</td><td>" +
                esc(actions[j.action] || j.action) +
                "<small>" +
                esc(names[j.target]) +
                "</small></td><td>" +
                badge(
                  stateText({
                    outcome: j.outcome,
                    lastSuccess: j.outcome === "ok",
                  }),
                  j.outcome !== "ok",
                ) +
                "<small>" +
                esc(j.message) +
                "</small></td><td>" +
                esc(j.actor) +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table></div>"
        : note("Noch keine Aufträge ausgeführt.")) +
      "</section>"
    );
  }
  function render() {
    host.innerHTML =
      '<div class="page-head"><div><h1>Backup</h1><p>Sicherungen und Wiederherstellung für die gesamte Installation.</p></div><div class="bk-actions">' +
      button("restore", "Wiederherstellen") +
      button("new", "Jetzt sichern", true) +
      '</div></div><div class="tabs">' +
      tabButton("files", "Sicherungen") +
      tabButton("schedule", "Zeitpläne & Ziele") +
      tabButton("jobs", "Restore-Proben & Verlauf") +
      '</div><p role="status" aria-live="polite">' +
      esc(notice || (state.active ? "Auftrag wird ausgeführt …" : "")) +
      "</p>" +
      stats() +
      (tab === "files"
        ? files()
        : tab === "schedule"
          ? schedules()
          : history()) +
      button("refresh", "Aktualisieren");
  }
  async function refresh() {
    clearTimeout(timer);
    state = await api("admin/backup?files=all");
    if (!host.isConnected) return;
    render();
    if (state.active) {
      timer = setTimeout(() => {
        if (host.isConnected) refresh().catch((e) => message(e.message));
      }, 1500);
    }
  }
  function open(title, body) {
    dialog?.close();
    dialog = document.createElement("dialog");
    dialog.className = "bk-dialog";
    dialog.innerHTML =
      '<div class="bk-heading"><h2>' +
      title +
      "</h2>" +
      button("cancel", "Schließen") +
      "</div>" +
      body +
      '<p role="alert"></p>';
    host.append(dialog);
    const current = dialog;
    current.addEventListener("close", () => current.remove(), { once: true });
    dialog.showModal();
  }
  function restoreDialog() {
    const choices = [...(uploaded ? [uploaded] : []), ...state.files];
    const receipt = state.receipt;
    const index = choices.findIndex(
      (f) => f.name === selected?.name && f.target === selected?.target,
    );
    const options = choices
      .map(
        (f, i) =>
          '<option value="' +
          i +
          '" ' +
          (i === index ? "selected" : "") +
          ">" +
          esc(names[f.target] + " · " + f.name) +
          "</option>",
      )
      .join("");
    open(
      "Wiederherstellung prüfen",
      "<p>Die Probe stellt die gesamte Sicherung in einer getrennten Datenbank wieder her.</p>" +
        (options
          ? '<form data-bk-form="probe"><label>Sicherungsdatei<select name="file">' +
            options +
            "</select></label><button>Restore-Probe starten</button></form>"
          : "") +
        '<form data-bk-form="upload"><label>Verschlüsselte Datei vom Computer<input type="file" required name="archive" accept=".enc"></label><button class="secondary">Datei zur Prüfung laden</button></form>' +
        (receipt
          ? "<h3>Bestandene Probe</h3><p>" +
            esc(names[receipt.Target] + " · " + receipt.Name) +
            "</p><p>" +
            esc(stamp(receipt.At)) +
            " · " +
            receipt.Manifest.Years +
            " Geschäftsjahre · " +
            receipt.Manifest.Entries +
            " Einträge · " +
            receipt.Manifest.Originals +
            " Originale</p>" +
            (receipt.Manifest.Installation &&
            Date.now() - Date.parse(receipt.At) < 3600000
              ? button("confirm", "Übernahme vorbereiten")
              : "")
          : ""),
    );
  }
  async function post(body) {
    await api("admin/backup", body);
    dialog?.close();
    notice = "Auftrag angenommen.";
    await refresh();
  }
  host.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.backupTab) {
        tab = b.dataset.backupTab;
        render();
        return;
      }
      if (b.dataset.bkFile !== undefined) {
        selected = state.files[Number(b.dataset.bkFile)];
        restoreDialog();
        return;
      }
      switch (b.dataset.backup) {
        case "cancel":
          dialog?.close();
          return;
        case "refresh":
          notice = "";
          await refresh();
          return;
        case "restore":
          restoreDialog();
          return;
        case "test":
          await post({ action: "test", target: "s3" });
          return;
        case "new":
          open(
            "Sicherung erstellen",
            '<p>Alle Geschäftsjahre, Belege und Einstellungen werden verschlüsselt gesichert.</p><form data-bk-form="backup"><label>Ziel<select name="target"><option value="local">Lokales Volume</option>' +
              (state.s3Configured
                ? '<option value="s3">S3-Speicher</option>'
                : "") +
              "</select></label><button>Jetzt sichern</button></form>",
          );
          return;
        case "confirm":
          open(
            "Aktiven Datenstand ersetzen",
            "<p><b>Ziel: diese BONFIRE-Installation.</b> Alle Änderungen nach dem gewählten Sicherungsstand werden im aktiven Kassenbuch ersetzt. Die bisherige Datenbank bleibt als Rückfallkopie erhalten. Alle Sitzungen enden.</p><p>" +
              esc(state.receipt.Name) +
              " · " +
              esc(stamp(state.receipt.Manifest.Created)) +
              '</p><form data-bk-form="promote"><label>Aktuelles Passwort<input name="password" type="password" autocomplete="current-password" required></label><label>TOTP oder Recoverycode (bei MFA)<input name="otp" autocomplete="one-time-code"></label><label>Zur Bestätigung WIEDERHERSTELLEN eingeben<input name="confirmation" autocomplete="off" required pattern="WIEDERHERSTELLEN"></label><button>Wiederherstellung ausführen</button></form>',
          );
          return;
      }
    } catch (err) {
      message(err.message);
    }
  };
  host.onsubmit = async (e) => {
    const f = e.target.closest("[data-bk-form]");
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    const v = Object.fromEntries(new FormData(f));
    const submitter = e.submitter;
    if (submitter) submitter.disabled = true;
    try {
      switch (f.dataset.bkForm) {
        case "schedule":
          await api("admin/backup", {
            action: "schedule",
            target: v.target,
            cron: v.cron.trim(),
            days: Number(v.days || 0),
          });
          notice = "Zeitplan gespeichert.";
          await refresh();
          break;
        case "backup":
          await post({ action: "backup", target: v.target });
          break;
        case "probe": {
          const file = [...(uploaded ? [uploaded] : []), ...state.files][
            Number(v.file)
          ];
          await post({ action: "probe", target: file.target, name: file.name });
          break;
        }
        case "upload": {
          const res = await fetch("/api/admin/backup/upload", {
            method: "POST",
            body: v.archive,
          });
          if (!res.ok) throw Error(await res.text());
          const out = await res.json();
          uploaded = { target: "upload", name: out.name };
          selected = uploaded;
          restoreDialog();
          break;
        }
        case "promote":
          await post({
            action: "promote",
            target: state.receipt.Target,
            name: state.receipt.Name,
            ...v,
          });
          break;
      }
    } catch (err) {
      if (dialog?.open)
        dialog.querySelector("[role=alert]").textContent = err.message;
      else message(err.message);
    } finally {
      if (submitter) submitter.disabled = false;
    }
  };
  host.innerHTML =
    "<h1>Backup</h1><p>Aktueller Sicherungsstand wird geladen …</p>";
  try {
    await refresh();
  } catch (err) {
    host.innerHTML =
      '<h1>Backup</h1><p role="status">' +
      esc(err.message) +
      "</p>" +
      button("refresh", "Erneut laden");
  }
}
