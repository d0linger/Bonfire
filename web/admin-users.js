import { esc, icon } from "./workplace.js";

const roles = ["Admin", "Write", "Read"];
const titles = {
  create: "Benutzer anlegen",
  edit: "Zugang bearbeiten",
  password: "Passwort zurücksetzen",
  mfa: "Zweiten Faktor zurücksetzen",
  sessions: "Sitzungen widerrufen",
  disable: "Zugang sperren",
  enable: "Zugang aktivieren",
};
const summaries = {
  password:
    "Bestehende Sitzungen werden beendet. Das neue Startpasswort persönlich übergeben.",
  mfa: "Authenticator und Recoverycodes werden entfernt. Die Person richtet den zweiten Faktor nach der nächsten Anmeldung neu ein.",
  sessions:
    "Alle Sitzungen und ausstehenden Anmeldefreigaben dieser Person werden beendet.",
  disable:
    "Der Zugang wird gesperrt und alle Sitzungen werden beendet. Bisherige Buchungen bleiben dieser Person zugeordnet.",
  enable:
    "Die Person kann sich mit ihren vorhandenen Zugangsdaten und den zugewiesenen Rechten wieder anmelden.",
};
const button = (action, label, primary = false) =>
  '<button type="button" data-account-action="' +
  action +
  '" class="' +
  (primary ? "primary" : "secondary") +
  '">' +
  label +
  "</button>";
const person = (user) => user.Label || user.Login;
const state = (txt, good) =>
  '<span class="account-status' +
  (good ? " good" : "") +
  '">' +
  esc(txt) +
  "</span>";
const field = (text, name, type, value = "", attrs = "") =>
  "<label>" +
  text +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  attrs +
  "/></label>";
const late = (time) =>
  time
    ? new Date(time).toLocaleString("de-AT", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Bisher keine Anmeldung erfasst";
const editorActions = (user) =>
  [
    button("edit", "Zugang bearbeiten"),
    button("password", "Passwort zurücksetzen"),
    ...(user.MFA ? [button("mfa", "Zweiten Faktor zurücksetzen")] : []),
    button("sessions", "Sitzungen widerrufen"),
    button(
      user.Active ? "disable" : "enable",
      user.Active ? "Zugang sperren" : "Zugang aktivieren",
    ),
  ].join("");

function accessFields(events, allowed) {
  const years = new Map();
  for (const event of events) {
    if (!years.has(event.Year)) years.set(event.Year, []);
    years.get(event.Year).push(event);
  }
  return (
    '<fieldset class="account-grants"><legend>Arbeitsbereiche</legend><small>Admin verwaltet die gesamte Installation und gibt Abschlüsse frei. Write kann in den ausgewählten Arbeitsbereichen buchen. Read hat dort Lesezugriff.</small>' +
    [...years]
      .map(
        ([year, spaces]) =>
          "<details" +
          (spaces.some((e) => allowed.includes(e.ID)) ? " open" : "") +
          "><summary>" +
          esc(year) +
          "</summary>" +
          spaces
            .map(
              (e) =>
                '<label><input type="checkbox" name="Events" value="' +
                esc(e.ID) +
                '"' +
                (allowed.includes(e.ID) ? " checked" : "") +
                "> " +
                esc(e.Name) +
                "</label>",
            )
            .join("") +
          "</details>",
      )
      .join("") +
    (!events.length ? "<p>Noch keine Arbeitsbereiche vorhanden.</p>" : "") +
    "</fieldset>"
  );
}

function editFields(action, user, events) {
  let html = "";
  if (action === "edit" || action === "create") {
    html +=
      field("Anzeigename", "Label", "text", user?.Label, "maxlength=160") +
      field(
        "E-Mail-Adresse oder Benutzername",
        "Login",
        "text",
        user?.Login,
        'required maxlength=254 autocomplete="off"',
      ) +
      '<label>Rolle<select name="Role">' +
      roles
        .map(
          (role) =>
            "<option" +
            (role === (user?.Role || "Write") ? " selected" : "") +
            ">" +
            role +
            "</option>",
        )
        .join("") +
      "</select></label>" +
      accessFields(events, user?.Events || []);
  }
  if (action === "create" || action === "password") {
    html +=
      field(
        "Startpasswort (mindestens 14 Zeichen)",
        "Password",
        "password",
        "",
        'required minlength=14 maxlength=72 autocomplete="new-password"',
      ) +
      '<label class="account-check"><input name="MustChange" type="checkbox" checked> Passwortwechsel bei der nächsten Anmeldung verlangen</label>';
  }
  return (
    html +
    field(
      "Begründung",
      "Reason",
      "text",
      "",
      "required minlength=3 maxlength=320",
    )
  );
}

export async function mountUsers(host, { api }) {
  const root = document.createElement("div");
  root.className = "admin-console account-console";
  host.replaceChildren(root);
  root.innerHTML =
    '<h1>Benutzer</h1><p role="status">Benutzerkonten werden geladen …</p>';
  let data,
    view = "accounts",
    saving = false;
  function render(message = "") {
    root.innerHTML =
      '<div class="page-head"><div><h1>Benutzer</h1><p>Persönliche Konten, Rollen und Arbeitsbereiche verwalten.</p></div>' +
      button("create", icon("Plus") + " Benutzer anlegen", true) +
      "</div>" +
      '<div class="tabs" aria-label="Benutzerverwaltung"><button type="button" data-account-tab="accounts" ' +
      (view === "accounts" ? 'aria-current="page"' : "") +
      '>Benutzerkonten</button><button type="button" data-account-tab="policy" ' +
      (view === "policy" ? 'aria-current="page"' : "") +
      ">Anmelderichtlinie</button></div>" +
      '<p class="account-notice" role="status">' +
      esc(message) +
      "</p>";
    if (view === "policy") {
      root.insertAdjacentHTML(
        "beforeend",
        '<section><h2>Anmelderichtlinie</h2><dl class="account-facts"><dt>Passwort</dt><dd>14 bis 72 Bytes</dd>' +
          "<dt>Sitzungsdauer</dt><dd>30 Minuten</dd><dt>Zweiter Faktor</dt><dd>Authenticator-Code oder einmaliger Recoverycode, wenn eingerichtet</dd>" +
          "<dt>Startpasswort</dt><dd>Ein erzwungener Wechsel erfolgt nach erfolgreicher Anmeldung vor dem Zugriff auf die Arbeitsbereiche.</dd></dl></section>",
      );
      return;
    }
    root.insertAdjacentHTML(
      "beforeend",
      '<section><div class="account-section"><h2>Benutzerkonten</h2>' +
        button("refresh", "Aktualisieren") +
        '</div><div class="list"><table><thead><tr>' +
        "<th>Person</th><th>Rolle</th><th>Anmeldeschutz</th><th>Zugang</th></tr></thead><tbody>" +
        data.users
          .map(
            (u) =>
              '<tr><td><button type="button" class="account-person" aria-haspopup="dialog" data-account-id="' +
              esc(u.ID) +
              '"><strong>' +
              esc(person(u)) +
              "</strong>" +
              (u.Label ? "<small>" + esc(u.Login) + "</small>" : "") +
              "</button></td><td>" +
              state(u.Role, false) +
              "</td><td>" +
              (u.MFA ? "TOTP aktiv" : "Passwort") +
              "</td><td>" +
              state(u.Active ? "Aktiv" : "Gesperrt", u.Active) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></div></section>",
    );
  }
  function accountDetails(user) {
    const spaces = data.events
      .filter((e) => user.Events.includes(e.ID))
      .map((e) => e.Year + " · " + e.Name);
    return (
      '<div class="account-summary">' +
      state(user.Role, false) +
      state(user.Active ? "Aktiv" : "Gesperrt", user.Active) +
      "</div>" +
      '<dl class="account-facts"><dt>Anmeldung</dt><dd>' +
      esc(user.Login) +
      "</dd><dt>Arbeitsbereiche</dt><dd>" +
      esc(
        user.Role === "Admin"
          ? "Alle Geschäftsjahre und Arbeitsbereiche"
          : spaces.join(", ") || "Keine Freigabe",
      ) +
      "</dd><dt>Letzte Anmeldung</dt><dd>" +
      esc(late(user.LastLogin)) +
      "</dd><dt>Aktive Sitzungen</dt><dd>" +
      user.Sessions +
      "</dd>" +
      (user.MustChange
        ? "<dt>Passwortwechsel</dt><dd>Bei nächster Anmeldung erforderlich</dd>"
        : "") +
      '</dl><div class="actions">' +
      editorActions(user) +
      "</div>"
    );
  }
  async function refresh(message) {
    data = await api("admin/users");
    render(message);
  }
  function editor(initialAction, user) {
    let action = initialAction;
    const dialog = document.createElement("dialog");
    dialog.className = "account-editor entry-modal";
    dialog.setAttribute("aria-labelledby", "account-editor-title");
    root.append(dialog);
    function display(next) {
      action = next;
      const overview = action === "details";
      const title = overview ? person(user) : titles[action];
      const header =
        '<div class="panel-head"><h2 id="account-editor-title">' +
        esc(title) +
        '</h2><button type="button" class="entry-close" data-account-close aria-label="Schließen">×</button></div>';
      dialog.innerHTML = overview
        ? header + accountDetails(user)
        : "<form>" +
          header +
          (user ? "<p>" + esc(person(user)) + "</p>" : "") +
          (summaries[action] ? "<p>" + summaries[action] + "</p>" : "") +
          editFields(action, user, data.events) +
          '<p role="alert"></p><div class="actions"><button type="button" class="secondary" data-account-cancel>Abbrechen</button><button>' +
          (action === "edit" ? "Änderungen speichern" : titles[action]) +
          "</button></div></form>";
      dialog.scrollTop = 0;
      if (dialog.open)
        (
          dialog.querySelector("input, select, textarea") ||
          dialog.querySelector("button")
        ).focus();
    }
    display(initialAction);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.addEventListener("cancel", (e) => {
      if (saving) e.preventDefault();
    });
    dialog.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || saving) return;
      if (b.hasAttribute("data-account-close")) dialog.close();
      else if (b.hasAttribute("data-account-cancel")) {
        if (user) {
          const previous = action;
          display("details");
          dialog
            .querySelector('[data-account-action="' + previous + '"]')
            ?.focus();
        } else dialog.close();
      } else if (b.dataset.accountAction) display(b.dataset.accountAction);
    });
    dialog.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (saving) return;
      const f = new FormData(e.target);
      const input = { Action: action, Reason: f.get("Reason") };
      if (action !== "create")
        Object.assign(input, { ID: user.ID, Version: user.Version });
      if (["edit", "create"].includes(action))
        Object.assign(input, {
          Login: f.get("Login"),
          Label: f.get("Label"),
          Role: f.get("Role"),
          Events: f.getAll("Events"),
        });
      if (["password", "create"].includes(action))
        Object.assign(input, {
          Password: f.get("Password"),
          MustChange: f.has("MustChange"),
        });
      saving = true;
      const submitter = e.submitter;
      if (submitter) submitter.disabled = true;
      try {
        const result = await api("admin/users", input);
        if (result.signedOut) {
          location.reload();
          return;
        }
        const login = input.Login?.trim();
        const id =
          user?.ID || (login.includes("@") ? login.toLowerCase() : login);
        view = "accounts";
        let message = "Änderung gespeichert.";
        try {
          data = await api("admin/users");
        } catch (error) {
          message += " Liste bitte aktualisieren. " + error.message;
        }
        dialog.close();
        render(message);
        (
          root.querySelector('[data-account-id="' + CSS.escape(id) + '"]') ||
          root.querySelector('[data-account-action="refresh"]')
        ).focus({ preventScroll: true });
      } catch (error) {
        dialog.querySelector("[role=alert]").textContent = error.message;
      } finally {
        saving = false;
        if (submitter) submitter.disabled = false;
      }
    });
    dialog.showModal();
    dialog.querySelector("input:not([type=hidden]), select, textarea")?.focus();
  }
  root.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (saving || root.querySelector("dialog[open]")) return;
    const b =
      e.target.closest("button") ||
      e.target.closest("tbody tr")?.querySelector("[data-account-id]");
    if (!b) return;
    if (b.dataset.accountId) {
      b.focus({ preventScroll: true });
      editor(
        "details",
        data.users.find((u) => u.ID === b.dataset.accountId),
      );
      return;
    }
    if (b.dataset.accountTab) {
      view = b.dataset.accountTab;
      render();
      root.querySelector("[aria-current=page]")?.focus();
      return;
    }
    const action = b.dataset.accountAction;
    if (action === "refresh") {
      saving = true;
      try {
        await refresh();
      } catch (error) {
        root.querySelector(".account-notice").textContent = error.message;
      } finally {
        saving = false;
      }
    } else if (action === "create") editor(action);
  });
  try {
    await refresh();
  } catch (error) {
    root.querySelector("[role=status]").textContent = error.message;
  }
}

export function mountPasswordChange(host, ticket, onDone) {
  const root = document.createElement("div");
  root.className = "auth-card";
  root.innerHTML =
    '<div class="auth-body"><h1>Neues Passwort festlegen</h1><p>Das Startpasswort ist nur für die erste Anmeldung gültig.</p><form>' +
    field(
      "Neues Passwort",
      "Password",
      "password",
      "",
      'required minlength=14 maxlength=72 autocomplete="new-password"',
    ) +
    field(
      "Neues Passwort wiederholen",
      "Confirm",
      "password",
      "",
      'required minlength=14 maxlength=72 autocomplete="new-password"',
    ) +
    '<p role="alert"></p><div class="actions"><button>Passwort speichern</button><button type="button" class="secondary">Zur Anmeldung</button></div></form></div>';
  host.replaceChildren(root);
  root.querySelector("[type=button]").onclick = onDone;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.target,
      alert = f.querySelector("[role=alert]"),
      button = f.querySelector("button");
    if (button.disabled) return;
    if (f.elements.Password.value !== f.elements.Confirm.value) {
      alert.textContent = "Die Passwörter stimmen nicht überein.";
      return;
    }
    button.disabled = true;
    try {
      const res = await fetch("/api/password-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Ticket: ticket,
          Password: f.elements.Password.value,
        }),
      });
      if (!res.ok) throw Error((await res.text()).slice(0, 240));
      onDone();
    } catch (err) {
      alert.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  root.querySelector("input").focus();
}
