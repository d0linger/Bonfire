import { esc } from "./workplace.js";

const stamp = (time) =>
  time
    ? new Date(time).toLocaleString("en-GB", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "No runs yet";
const size = (bytes) =>
  bytes >= 1048576
    ? (bytes / 1048576).toLocaleString("en-GB", { maximumFractionDigits: 1 }) +
      " MB"
    : Math.ceil(bytes / 1024) + " kB";
const names = {
  local: "Local volume",
  s3: "S3 storage",
  probe: "Restore test",
  upload: "Uploaded file",
};
const actions = {
  backup: "Backup",
  probe: "Restore test",
  promote: "Restore",
  test: "S3 connection test",
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
    ? "Failed"
    : h?.outcome === "running"
      ? "Running"
      : h?.due
        ? "Due"
        : h?.lastSuccess
          ? "Successful"
          : h?.enabled
            ? "Scheduled"
            : "Manual";
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
        ["local", "Last local backup"],
        ["s3", "Last S3 backup"],
        ["probe", "Last restore test"],
      ]
        .map(
          ([k, label]) =>
            "<div><small>" +
            label +
            "</small><strong>" +
            esc(
              k === "s3" && !state.s3Configured
                ? "Not configured"
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
            ? "Not configured"
            : stateText(state[k]),
          state[k]?.outcome === "failed",
        ),
      ) +
      "<dl><dt>Schedule</dt><dd>" +
      esc(cfg.cron || "Manual") +
      "</dd><dt>Retention</dt><dd>" +
      esc(cfg.days ? cfg.days + " days" : "Unlimited") +
      "</dd></dl></section>"
    );
  }
  function files() {
    return (
      '<div class="bk-pair">' +
      targetPanel("local") +
      targetPanel("s3") +
      "</div><section>" +
      heading("Backup files") +
      (state.s3Error ? note(state.s3Error) : "") +
      (state.files.length
        ? '<div class="list"><table><thead><tr><th>File</th><th>Destination</th><th>Size</th><th>Actions</th></tr></thead><tbody>' +
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
                '" class="secondary">Test restore</button></div></td></tr>',
            )
            .join("") +
          "</tbody></table></div>"
        : note("No backup files yet.")) +
      "</section>"
    );
  }
  function schedules() {
    return (
      "<p>Time zone " +
      esc(state.timezone) +
      ". Leave the schedule empty to run backups manually.</p>" +
      ["local", "s3", "probe"]
        .map((k) => {
          const cfg = state.schedules[k] || {},
            disabled = k === "s3" && !state.s3Configured;
          return (
            "<section>" +
            heading(names[k]) +
            (disabled
              ? note(
                  "Configure the S3 endpoint, bucket and credentials in your deployment.",
                )
              : "") +
            '<form data-bk-form="schedule"><input type="hidden" name="target" value="' +
            k +
            '"><fieldset ' +
            (disabled ? "disabled" : "") +
            '><label>Schedule (Cron)<input name="cron" value="' +
            esc(cfg.cron || "") +
            '" placeholder="0 2 * * *"></label>' +
            (k === "probe"
              ? note("The test restores the newest local backup.")
              : '<label>Retention in days (0 = unlimited)<input type="number" name="days" min="0" max="3650" required value="' +
                (cfg.days ?? 30) +
                '"></label>') +
            "<button>Save schedule</button></fieldset></form>" +
            note(
              "Next run: " +
                (state[k]?.next ? stamp(state[k].next) : "None scheduled"),
            ) +
            "</section>"
          );
        })
        .join("") +
      (state.s3Configured ? button("test", "Test S3 connection") : "")
    );
  }
  function history() {
    return (
      "<section>" +
      heading("Job history") +
      (state.recent?.length
        ? '<div class="list"><table><thead><tr><th>Time</th><th>Job</th><th>Result</th><th>Run by</th></tr></thead><tbody>' +
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
        : note("No jobs have run yet.")) +
      "</section>"
    );
  }
  function render() {
    host.innerHTML =
      '<div class="page-head"><div><h1>Backup</h1><p>Back up and restore the entire installation.</p></div><div class="bk-actions">' +
      button("restore", "Restore") +
      button("new", "Back up now", true) +
      '</div></div><div class="tabs">' +
      tabButton("files", "Backups") +
      tabButton("schedule", "Schedules and destinations") +
      tabButton("jobs", "Restore tests and history") +
      '</div><p role="status" aria-live="polite">' +
      esc(notice || (state.active ? "Job in progress…" : "")) +
      "</p>" +
      stats() +
      (tab === "files"
        ? files()
        : tab === "schedule"
          ? schedules()
          : history()) +
      button("refresh", "Refresh");
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
      button("cancel", "Close") +
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
      "Test a restore",
      "<p>The test restores the entire archive into a separate database.</p>" +
        (options
          ? '<form data-bk-form="probe"><label>Backup file<select name="file">' +
            options +
            "</select></label><button>Start restore test</button></form>"
          : "") +
        '<form data-bk-form="upload"><label>Encrypted archive from this computer<input type="file" required name="archive" accept=".enc"></label><button class="secondary">Upload for verification</button></form>' +
        (receipt
          ? "<h3>Successful restore test</h3><p>" +
            esc(names[receipt.Target] + " · " + receipt.Name) +
            "</p><p>" +
            esc(stamp(receipt.At)) +
            " · " +
            receipt.Manifest.Years +
            " fiscal years · " +
            receipt.Manifest.Entries +
            " entries · " +
            receipt.Manifest.Originals +
            " originals</p>" +
            (receipt.Manifest.Installation &&
            Date.now() - Date.parse(receipt.At) < 3600000
              ? button("confirm", "Prepare restore")
              : "")
          : ""),
    );
  }
  async function post(body) {
    await api("admin/backup", body);
    dialog?.close();
    notice = "Job accepted.";
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
            "Create backup",
            '<p>The encrypted backup includes all fiscal years, receipts and settings.</p><form data-bk-form="backup"><label>Destination<select name="target"><option value="local">Local volume</option>' +
              (state.s3Configured
                ? '<option value="s3">S3 storage</option>'
                : "") +
              "</select></label><button>Back up now</button></form>",
          );
          return;
        case "confirm":
          open(
            "Replace the active database",
            "<p><b>Restore to this BONFIRE installation.</b> Restoring replaces changes made after this backup. The previous database is retained for recovery. Everyone will be signed out.</p><p>" +
              esc(state.receipt.Name) +
              " · " +
              esc(stamp(state.receipt.Manifest.Created)) +
              '</p><form data-bk-form="promote"><label>Current password<input name="password" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code (if enabled)<input name="otp" autocomplete="one-time-code"></label><label>Type RESTORE to confirm<input name="confirmation" autocomplete="off" required pattern="RESTORE"></label><button>Restore database</button></form>',
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
          notice = "Schedule saved.";
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
    "<h1>Backup</h1><p>Loading backup status…</p>";
  try {
    await refresh();
  } catch (err) {
    host.innerHTML =
      '<h1>Backup</h1><p role="status">' +
      esc(err.message) +
      "</p>" +
      button("refresh", "Retry");
  }
}
