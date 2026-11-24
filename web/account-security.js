import qrcode from "qrcode-generator";
import { esc } from "./workplace.js";
import { supportsPasskeys, usePasskey } from "./personal-passkeys.js";

const date = (value) =>
  new Date(value).toLocaleString("de-AT", {
    dateStyle: "short",
    timeStyle: "short",
  });
const button = (action, label, id = "") =>
  '<button type="button" class="secondary" data-personal="' +
  action +
  '" data-id="' +
  esc(id) +
  '">' +
  label +
  "</button>";
const password =
  '<label>Aktuelles Passwort<input type="password" name="password" autocomplete="current-password" required></label>';
const otp =
  '<label>Authenticator- oder Recoverycode<input name="code" autocomplete="one-time-code" required></label>';
function drawQR(canvas, uri) {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  const count = qr.getModuleCount(),
    size = 5;
  canvas.width = canvas.height = (count + 8) * size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col))
        ctx.fillRect((col + 4) * size, (row + 4) * size, size, size);
}
const titles = {
  password: "Passwort ändern",
  "mfa-begin": "Authenticator einrichten",
  "mfa-confirm": "Authenticator bestätigen",
  "mfa-disable": "Authenticator deaktivieren",
  recovery: "Recoverycodes erneuern",
  codes: "Recoverycodes sichern",
  register: "Passkey hinzufügen",
  remove: "Passkey entfernen",
  revoke: "Sitzung beenden",
  "revoke-others": "Andere Sitzungen beenden",
};
export async function mountAccountSecurity(host, { api }) {
  const mutate = (action, values) =>
    api("account/security", { action, ...values });
  let account, keys;
  async function refresh(message = "") {
    host.innerHTML =
      "<h1>Konto und Sicherheit</h1><p role='status'>Kontodaten werden geladen …</p>";
    [account, keys] = await Promise.all([
      api("account/security"),
      api("account/passkeys"),
    ]);
    if (!host.isConnected) return;
    const available =
      keys.available && keys.origin === location.origin && supportsPasskeys();
    let setupHint = "";
    if (!available) {
      let origin;
      try {
        origin = new URL(keys.origin);
      } catch {}
      setupHint =
        origin &&
        ["http:", "https:"].includes(origin.protocol) &&
        origin.origin !== location.origin
          ? '<p>Passkeys sind an die Anmeldeadresse gebunden. <a href="' +
            esc(origin.origin) +
            '">BONFIRE unter ' +
            esc(origin.origin) +
            " öffnen</a></p>"
          : "<p>Passkeys sind unter dieser Adresse oder in diesem Browser nicht verfügbar.</p>";
    }
    const row = (label, meta, action) =>
      "<li><div><strong>" +
      esc(label) +
      "</strong><small>" +
      esc(meta) +
      "</small></div>" +
      action +
      "</li>";
    host.innerHTML =
      "<header><h1>Konto und Sicherheit</h1><p>" +
      esc(account.login) +
      '</p></header><p role="status" class="security-message">' +
      esc(message) +
      "</p>" +
      '<section class="panel"><h2>Passwort</h2>' +
      button("password", titles.password) +
      "</section>" +
      '<section class="panel"><h2>Zwei-Faktor-Anmeldung</h2><p>' +
      (account.mfa
        ? "Authenticator aktiv · Verfügbare Recoverycodes: " +
          esc(account.recoveryRemaining)
        : "Kein Authenticator eingerichtet.") +
      '</p><div class="actions">' +
      (account.mfa
        ? button("recovery", titles.recovery) +
          button("mfa-disable", titles["mfa-disable"])
        : button("mfa-begin", titles["mfa-begin"])) +
      "</div></section>" +
      '<section class="panel"><h2>Passkeys</h2>' +
      ((keys.items || []).length
        ? "<ul>" +
          keys.items
            .map((k) =>
              row(
                k.name,
                "Erstellt " +
                  date(k.created) +
                  " · " +
                  (k.lastUsed
                    ? "Zuletzt verwendet " + date(k.lastUsed)
                    : "Bisher unbenutzt"),
                button("remove", "Entfernen", k.id),
              ),
            )
            .join("") +
          "</ul>"
        : "<p>Kein Passkey registriert.</p>") +
      (available ? button("register", titles.register) : setupHint) +
      "</section>" +
      '<section class="panel"><h2>Aktive Sitzungen</h2><ul>' +
      account.sessions
        .map((s) =>
          row(
            s.agent,
            "Angemeldet " +
              date(s.created) +
              " · Gültig bis " +
              date(s.expires),
            s.current
              ? "<strong>Diese Sitzung</strong>"
              : button("revoke", "Beenden", s.id),
          ),
        )
        .join("") +
      "</ul>" +
      (account.sessions.some((s) => !s.current)
        ? button("revoke-others", titles["revoke-others"])
        : "") +
      "</section>";
  }
  await refresh();
  host.onclick = (e) => {
    const trigger = e.target.closest("[data-personal]");
    if (trigger && !host.querySelector("dialog")) open(trigger);
  };
  function open(trigger) {
    host.querySelector('[role="status"]').textContent = "";
    let action = trigger.dataset.personal,
      busy = false,
      dataChanged = false;
    const id = trigger.dataset.id;
    const dialog = document.createElement("dialog");
    dialog.className = "account-editor entry-modal security-editor";
    dialog.setAttribute("aria-labelledby", "personal-title");
    host.append(dialog);
    const close = () => {
      if (!busy) dialog.close();
    };
    dialog.addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        if (dataChanged)
          refresh("Kontoeinstellungen aktualisiert.")
            .then(() => {
              (
                host.querySelector(
                  '[data-personal="' + trigger.dataset.personal + '"]',
                ) || host.querySelector("button")
              )?.focus();
            })
            .catch((err) => {
              host.querySelector('[role="status"]').textContent = err.message;
            });
        else trigger.focus();
      },
      { once: true },
    );
    function render(fields, submitLabel, dismiss = "Abbrechen") {
      dialog.innerHTML =
        '<form><h2 id="personal-title">' +
        titles[action] +
        "</h2>" +
        fields +
        '<p role="alert"></p><div class="actions"><button type="button" class="secondary" data-close>' +
        dismiss +
        "</button>" +
        (submitLabel
          ? '<button type="submit">' + submitLabel + "</button>"
          : "") +
        "</div></form>";
      dialog.querySelector("[data-close]").onclick = close;
      dialog.querySelector("form").onsubmit = submit;
      dialog.querySelector("input, [data-close]")?.focus();
    }
    const proof = password + (account.mfa ? otp : "");
    const details = {
      password:
        proof +
        '<label>Neues Passwort (14–72 Bytes)<input type="password" name="newPassword" required  autocomplete="new-password"></label><label>Neues Passwort wiederholen<input type="password" name="repeat" required autocomplete="new-password"></label>',
      "mfa-begin": password,
      "mfa-disable":
        "<p>Die Anmeldung mit Passwort ist danach ohne Authenticator möglich.</p>" +
        proof,
      recovery:
        "<p>Bisherige Recoverycodes verlieren ihre Gültigkeit.</p>" + proof,
      register:
        '<label>Passkey-Name<input name="name" required maxlength="80" placeholder="z. B. Diensthandy"></label>' +
        proof,
      remove:
        "<p>Passkey „" +
        esc(keys.items?.find((k) => k.id === id)?.name || "") +
        "“ aus deinem Konto entfernen?</p>" +
        proof,
      revoke: "<p>Die ausgewählte Sitzung wird abgemeldet.</p>",
      "revoke-others":
        "<p>Alle anderen Browser müssen sich erneut anmelden.</p>",
    };
    render(details[action], titles[action]);
    dialog.showModal();
    async function submit(e) {
      e.preventDefault();
      if (busy) return;
      const form = e.currentTarget,
        values = Object.fromEntries(new FormData(form));
      const alert = form.querySelector('[role="alert"]');
      alert.textContent = "";
      busy = true;
      for (const b of form.querySelectorAll("button")) b.disabled = true;
      try {
        let result;
        if (action === "register") {
          await usePasskey(api, {
            Name: values.name,
            Password: values.password,
            Code: values.code || "",
          });
        } else if (action === "remove") {
          await api("account/passkeys/remove", {
            ID: id,
            Password: values.password,
            Code: values.code || "",
          });
        } else {
          if (action === "password" && values.newPassword !== values.repeat)
            throw Error("Die neuen Passwörter stimmen nicht überein.");
          delete values.repeat;
          if (action === "revoke") values.sessionID = id;
          result = await mutate(action, values);
        }
        if (action === "mfa-begin") {
          action = "mfa-confirm";
          render(
            '<p>QR-Code mit der Authenticator-App scannen oder den Schlüssel eingeben.</p><canvas aria-label="QR-Code für Authenticator"></canvas><code>' +
              esc(result.secret) +
              '</code><label>Sechsstelliger Code<input name="code" required inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"></label>',
            "Aktivieren",
          );
          drawQR(dialog.querySelector("canvas"), result.uri);
          return;
        }
        dataChanged = true;
        if (result?.codes) {
          action = "codes";
          render(
            '<p>Diese Einmalcodes jetzt sicher verwahren. Jeder Code ersetzt einmal den Authenticator bei der Anmeldung.</p><ul class="recovery-codes">' +
              result.codes
                .map((c) => "<li><code>" + esc(c) + "</code></li>")
                .join("") +
              "</ul>",
            "",
            "Gesichert und schließen",
          );
        } else dialog.close();
      } catch (err) {
        alert.textContent = err.message;
      } finally {
        busy = false;
        for (const b of form.querySelectorAll("button")) b.disabled = false;
      }
    }
  }
}
