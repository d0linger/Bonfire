function validatePassword(value) {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 14 || bytes > 72) throw Error("The password must be 14 to 72 bytes long.");
}
import { esc, icon } from "./workplace.js";

const roles = ["Admin", "Write", "Read"];
const titles = {
  create: "Create user",
  edit: "Edit account",
  password: "Reset password",
  mfa: "Reset second factor",
  sessions: "Revoke sessions",
  disable: "Disable account",
  enable: "Enable account",
};
const summaries = {
  password:
    "This ends all active sessions. Give the temporary password directly to the account holder.",
  mfa: "This removes the authenticator and recovery codes. The account holder can set up a new second factor after signing in.",
  sessions:
    "This ends active sessions and cancels pending sign-in requests.",
  disable:
    "This disables sign-in and ends all sessions. Existing bookings retain their author.",
  enable:
    "This restores sign-in with the existing credentials and assigned permissions.",
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
    ? new Date(time).toLocaleString("en-GB", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "No recorded sign-in";
const editorActions = (user) =>
  [
    button("edit", "Edit account"),
    button("password", "Reset password"),
    ...(user.MFA ? [button("mfa", "Reset second factor")] : []),
    button("sessions", "Revoke sessions"),
    button(
      user.Active ? "disable" : "enable",
      user.Active ? "Disable account" : "Enable account",
    ),
  ].join("");

function accessFields(events, allowed) {
  const years = new Map();
  for (const event of events) {
    if (!years.has(event.Year)) years.set(event.Year, []);
    years.get(event.Year).push(event);
  }
  return (
    '<fieldset class="account-grants"><legend>Workspaces</legend><small>Admins manage the installation and approve closures. Write users can record transactions in their assigned workspaces. Read users can view those workspaces.</small>' +
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
    (!events.length ? "<p>No workspaces available.</p>" : "") +
    "</fieldset>"
  );
}

function editFields(action, user, events) {
  let html = "";
  if (action === "edit" || action === "create") {
    html +=
      field("Display name", "Label", "text", user?.Label, "maxlength=160") +
      field(
        "Email or username",
        "Login",
        "text",
        user?.Login,
        'required maxlength=254 autocomplete="off"',
      ) +
      '<label>Role<select name="Role">' +
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
        "Temporary password (at least 14 characters)",
        "Password",
        "password",
        "",
        'required autocomplete="new-password"',
      ) +
      '<label class="account-check"><input name="MustChange" type="checkbox" checked> Require a password change at next sign-in</label>';
  }
  return (
    html +
    field(
      "Reason",
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
    '<h1>Users</h1><p role="status">Loading user accounts…</p>';
  let data,
    view = "accounts",
    saving = false;
  function render(message = "") {
    root.innerHTML =
      '<div class="page-head"><div><h1>Users</h1><p>Manage user accounts, roles and workspaces.</p></div>' +
      button("create", icon("Plus") + " Create user", true) +
      "</div>" +
      '<div class="tabs" aria-label="User management"><button type="button" data-account-tab="accounts" ' +
      (view === "accounts" ? 'aria-current="page"' : "") +
      '>User accounts</button><button type="button" data-account-tab="policy" ' +
      (view === "policy" ? 'aria-current="page"' : "") +
      ">Sign-in policy</button></div>" +
      '<p class="account-notice" role="status">' +
      esc(message) +
      "</p>";
    if (view === "policy") {
      root.insertAdjacentHTML(
        "beforeend",
        '<section><h2>Sign-in policy</h2><dl class="account-facts"><dt>Password</dt><dd>14 to 72 bytes</dd>' +
          "<dt>Session duration</dt><dd>30 minutes</dd><dt>Second factor</dt><dd>Authenticator code or single-use recovery code, when enabled</dd>" +
          "<dt>Temporary password</dt><dd>Users must change their temporary password before opening a workspace.</dd></dl></section>",
      );
      return;
    }
    root.insertAdjacentHTML(
      "beforeend",
      '<section><div class="account-section"><h2>User accounts</h2>' +
        button("refresh", "Refresh") +
        '</div><div class="list"><table><thead><tr>' +
        "<th>Person</th><th>Role</th><th>Authentication</th><th>Access</th></tr></thead><tbody>" +
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
              (u.MFA ? "TOTP enabled" : "Password") +
              "</td><td>" +
              state(u.Active ? "Active" : "Disabled", u.Active) +
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
      state(user.Active ? "Active" : "Disabled", user.Active) +
      "</div>" +
      '<dl class="account-facts"><dt>Sign-in</dt><dd>' +
      esc(user.Login) +
      "</dd><dt>Workspaces</dt><dd>" +
      esc(
        user.Role === "Admin"
          ? "All fiscal years and workspaces"
          : spaces.join(", ") || "No access",
      ) +
      "</dd><dt>Last sign-in</dt><dd>" +
      esc(late(user.LastLogin)) +
      "</dd><dt>Active sessions</dt><dd>" +
      user.Sessions +
      "</dd>" +
      (user.MustChange
        ? "<dt>Password change</dt><dd>Required at next sign-in</dd>"
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
        '</h2><button type="button" class="entry-close" data-account-close aria-label="Close">×</button></div>';
      dialog.innerHTML = overview
        ? header + accountDetails(user)
        : "<form>" +
          header +
          (user ? "<p>" + esc(person(user)) + "</p>" : "") +
          (summaries[action] ? "<p>" + summaries[action] + "</p>" : "") +
          editFields(action, user, data.events) +
          '<p role="alert"></p><div class="actions"><button type="button" class="secondary" data-account-cancel>Cancel</button><button>' +
          (action === "edit" ? "Save changes" : titles[action]) +
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
        if (input.Password !== undefined) validatePassword(input.Password);
        const result = await api("admin/users", input);
        if (result.signedOut) {
          location.reload();
          return;
        }
        const login = input.Login?.trim();
        const id =
          user?.ID || (login.includes("@") ? login.toLowerCase() : login);
        view = "accounts";
        let message = "Changes saved.";
        try {
          data = await api("admin/users");
        } catch (error) {
          message += " Refresh the list. " + error.message;
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
    '<div class="auth-body"><h1>Set a new password</h1><p>The temporary password is valid for the first sign-in only.</p><form>' +
    field(
      "New password",
      "Password",
      "password",
      "",
      'required autocomplete="new-password"',
    ) +
    field(
      "Confirm new password",
      "Confirm",
      "password",
      "",
      'required autocomplete="new-password"',
    ) +
    '<p role="alert"></p><div class="actions"><button>Save password</button><button type="button" class="secondary">Back to sign-in</button></div></form></div>';
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
      alert.textContent = "The passwords do not match.";
      return;
    }
    button.disabled = true;
    try {
      validatePassword(f.elements.Password.value);
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
