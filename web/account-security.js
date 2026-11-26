import qrcode from "qrcode-generator";
import { esc } from "./workplace.js";
import { supportsPasskeys, usePasskey } from "./personal-passkeys.js";

const date = (value) =>
  new Date(value).toLocaleString("en-GB", {
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
  '<label>Current password<input type="password" name="password" autocomplete="current-password" required></label>';
const otp =
  '<label>Authenticator or recovery code<input name="code" autocomplete="one-time-code" required></label>';
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
  password: "Change password",
  "mfa-begin": "Set up authenticator",
  "mfa-confirm": "Confirm authenticator",
  "mfa-disable": "Disable authenticator",
  recovery: "Replace recovery codes",
  codes: "Save recovery codes",
  register: "Add passkey",
  remove: "Remove passkey",
  revoke: "Sign out session",
  "revoke-others": "Sign out other sessions",
};
export async function mountAccountSecurity(host, { api }) {
  const mutate = (action, values) =>
    api("account/security", { action, ...values });
  let account, keys;
  async function refresh(message = "") {
    host.innerHTML =
      "<h1>Account and security</h1><p role='status'>Loading account details…</p>";
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
          ? '<p>Passkeys are linked to your sign-in address. <a href="' +
            esc(origin.origin) +
            '">Open BONFIRE at ' +
            esc(origin.origin) +
            "</a></p>"
          : "<p>Passkeys are unavailable at this address or in this browser.</p>";
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
      "<header><h1>Account and security</h1><p>" +
      esc(account.login) +
      '</p></header><p role="status" class="security-message">' +
      esc(message) +
      "</p>" +
      '<section class="panel"><h2>Password</h2>' +
      button("password", titles.password) +
      "</section>" +
      '<section class="panel"><h2>Two-factor authentication</h2><p>' +
      (account.mfa
        ? "Authenticator enabled · Remaining recovery codes: " +
          esc(account.recoveryRemaining)
        : "No authenticator configured.") +
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
                "Created " +
                  date(k.created) +
                  " · " +
                  (k.lastUsed
                    ? "Last used " + date(k.lastUsed)
                    : "Never used"),
                button("remove", "Remove", k.id),
              ),
            )
            .join("") +
          "</ul>"
        : "<p>No passkeys registered.</p>") +
      (available ? button("register", titles.register) : setupHint) +
      "</section>" +
      '<section class="panel"><h2>Active sessions</h2><ul>' +
      account.sessions
        .map((s) =>
          row(
            s.agent,
            "Signed in " +
              date(s.created) +
              " · Expires " +
              date(s.expires),
            s.current
              ? "<strong>Current session</strong>"
              : button("revoke", "End session", s.id),
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
          refresh("Account settings updated.")
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
    function render(fields, submitLabel, dismiss = "Cancel") {
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
        '<label>New password (14–72 bytes)<input type="password" name="newPassword" required  autocomplete="new-password"></label><label>Repeat new password<input type="password" name="repeat" required autocomplete="new-password"></label>',
      "mfa-begin": password,
      "mfa-disable":
        "<p>You will be able to sign in with your password alone.</p>" +
        proof,
      recovery:
        "<p>Your previous recovery codes will stop working.</p>" + proof,
      register:
        '<label>Passkey name<input name="name" required maxlength="80" placeholder="e.g. Work phone"></label>' +
        proof,
      remove:
        "<p>Remove passkey “" +
        esc(keys.items?.find((k) => k.id === id)?.name || "") +
        "” from your account?</p>" +
        proof,
      revoke: "<p>The selected session will be signed out.</p>",
      "revoke-others":
        "<p>All other browsers will need to sign in again.</p>",
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
            throw Error("The new passwords do not match.");
          delete values.repeat;
          if (action === "revoke") values.sessionID = id;
          result = await mutate(action, values);
        }
        if (action === "mfa-begin") {
          action = "mfa-confirm";
          render(
            '<p>Scan the QR code with your authenticator app or enter the setup key.</p><canvas aria-label="Authenticator QR code"></canvas><code>' +
              esc(result.secret) +
              '</code><label>Six-digit code<input name="code" required inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"></label>',
            "Enable",
          );
          drawQR(dialog.querySelector("canvas"), result.uri);
          return;
        }
        dataChanged = true;
        if (result?.codes) {
          action = "codes";
          render(
            '<p>Store these recovery codes in a safe place. Each code can be used once to sign in.</p><ul class="recovery-codes">' +
              result.codes
                .map((c) => "<li><code>" + esc(c) + "</code></li>")
                .join("") +
              "</ul>",
            "",
            "Saved, close",
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
