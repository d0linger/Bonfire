import { bulkWalletFields, bindWalletBatch, clearWalletBatches, submitWalletBatch } from "./wallet-batch.js";
import { fiscalPicker } from "./fiscal-picker.js";
import { fireDirectory, balanceTable, balanceLines } from "./fire-accounts.js";
import { denominationFields, floatFields, openingFloatHint, suggestedFloat, updateFloatInput, walletDirectory, walletPicker } from "./wallet-catalog.js";
import { mountAccountSecurity } from "./account-security.js";
import { supportsPasskeys, usePasskey } from "./personal-passkeys.js";
import { canOpenConsole } from "./workplace.js";
import { mountBackup } from "./admin-backup.js";
import { mountUsers, mountPasswordChange } from "./admin-users.js";
import { mountAudit, mountStatus } from "./admin-audit.js";
import contracts from "./contracts.json" with { type: "json" };
import { displayProof } from "./document-preview.js";
import {
  icon,
  esc,
  flowAmount,
  moduleList,
  panelHeading,
  titleOf,
  sectionOf,
  route,
  navigation,
  tabs,
  eventTabs,
  onlineEventTabs,
  adminTabs,
  recordKinds,
  overview,
  bookings,
  walletTable,
  ledger,
  dat,
} from "./workplace.js";
import { sponsorshipStatus } from "./sponsorship.js";
import { festivalPanel } from "./festabrechnung.js";
import { denominationNeeds, financialLabel } from "./domain.js";
import { zipSync } from "fflate";
import { historyPreview } from "./historical.js";
import { positions, lineCents } from "./positions.js";
import { background } from "./lfk.js";
import { mergeWord } from "./word-profile.js";
import { importTemplate } from "./templates.js";
import { preview, csv, workbook, evidence } from "./exchange.js";
import {
  createVault,
  readVault,
  unlock,
  save,
  slots,
  recoverReadOnly,
  download,
  b64,
  from64,
} from "./store.js";
import {
  types,
  denom,
  monetary,
  cents,
  totalPieces,
  visible,
  counted,
  poolCount,
  pooledRevenue,
  availableNumbers,
  journalMatches,
  countID,
  today,
  eur,
} from "./domain.js";
import {
  profiles,
  profileID,
  snapshot,
  render as renderDocument,
} from "./export.js";
const article = document.querySelector("article"),
  nav = document.querySelector("nav"),
  notice = document.querySelector("#notice"),
  state = document.querySelector("#state");
const option = (v, t) =>
  '<option value="' + esc(v) + '">' + esc(t) + "</option>";
const label = (t, c) => "<label>" + esc(t) + c + "</label>";
const field = (n, t, type = "text", req = false, value = "") =>
  label(
    t,
    '<input name="' +
      n +
      '" type="' +
      type +
      '" value="' +
      esc(value) +
      '" ' +
      (req ? "required" : "") +
      ">",
  );
const select = (n, t, choices, selected) =>
  label(
    t,
    '<select name="' +
      esc(n) +
      '" aria-label="' + esc(t) + '">' +
      choices
        .map(([v, l]) =>
          selected !== undefined && v === selected
            ? '<option selected value="' + esc(v) + '">' + esc(l) + "</option>"
            : option(v, l),
        )
        .join("") +
      "</select>",
  );
const button = (act, t, secondary = false) =>
  '<button type="button" data-act="' +
  act +
  '" class="' +
  (secondary ? "secondary" : "") +
  '">' +
  esc(t) +
  "</button>";
const form = (id, inner, submit, secondaryAction = "") =>
  '<form id="' +
  id +
  '"><div class="form">' +
  inner +
  '</div><div class="actions"><button>' +
  esc(submit) +
  "</button>" +
  secondaryAction +
  "</div></form>";
const panel = (t, c) => "<section><h2>" + esc(t) + "</h2>" + c + "</section>";
function popupForm(id, title, fields, submitLabel) {
  return (
    '<button type="button" data-open-form="' +
    esc(id) +
    '" aria-haspopup="dialog">' +
    esc(title) +
    "</button><template>" +
    form(id, fields, submitLabel, button("cancel", "Cancel", true)) +
    "</template>"
  );
}
const entryDialog = document.querySelector("#entry-dialog");
let entryTrigger;
function openEditor(trigger, title, content, selector = "") {
  entryTrigger = trigger;
  entryDialog.innerHTML =
    '<div class="panel-head"><h2 id="entry-title">' +
    esc(title) +
    '</h2><button type="button" class="entry-close" data-act="cancel" aria-label="Close">×</button></div>' +
    selector +
    content +
    '<div class="entry-error" role="alert"></div>';
  if (!entryDialog.open) entryDialog.showModal();
  entryDialog
    .querySelector("form input:not([type=hidden]), form select, form textarea")
    ?.focus();
}
function openReasonEditor(trigger, title, subject, saveReason) {
  openEditor(
    trigger,
    title,
    "<p>" +
      esc(subject) +
      "</p>" +
      form(
        "entry-reason",
        field("reason", "Reason", "text", true),
        title,
        button("cancel", "Cancel", true),
      ),
  );
  entryDialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(async () => {
      const reason = new FormData(event.target).get("reason").trim();
      if (!reason) throw Error("Enter a reason.");
      await saveReason(reason);
      show();
      closeEditor();
    });
  });
}
function closeEditor() {
  if (!entryDialog.open) return;
  entryDialog.close();
  delete entryDialog.dataset.recordWorkspace;
  entryDialog.replaceChildren();
  edit = null;
  const key = [
    "data-wallet-action",
    "data-catalog-edit",
    "data-year-edit",
    "data-event-edit",
    "data-event-cleanup",
    "data-edit",
    "data-lifecycle",
    "data-settle",
    "data-open-form",
    "data-act",
  ].find((k) => entryTrigger?.hasAttribute(k));
  const target = entryTrigger?.isConnected
    ? entryTrigger
    : key &&
      article.querySelector(
        "[" + key + '="' + CSS.escape(entryTrigger.getAttribute(key)) + '"]',
      );
  (target || article).focus({ preventScroll: true });
  entryTrigger = null;
}
entryDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!busy) closeEditor();
});
const heading = (t) => "<h1>" + esc(t) + "</h1>";
let profilesLocal = [];
let importFile = null,
  importRole = "",
  globalRows = [],
  imported = [],
  chosenPeriod = "",
  syncDetail = "";
let auditRows = [],
  logged = false;
let s,
  page = "Übersicht",
  kind = "income",
  edit = null,
  auth = "",
  events = [],
  saved = false,
  filter = "",
  journalFilters = {},
  busy = false;
// Preserve legacy device data until a separate migration is agreed.
const offlineEnabled = false;
const sw = undefined;
if (!offlineEnabled && navigator.serviceWorker)
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration?.update())
    .catch(() => {});
async function api(path, body, token = auth) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  if (!offlineEnabled && s && ["manage", "donation-reports"].includes(path))
    headers["X-Bonfire-Event"] = s.event.ID;
  if (
    !offlineEnabled &&
    donorAccess &&
    (path.startsWith("online?") || path === "donation-reports")
  )
    headers["X-Bonfire-Donor"] = "true";
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers,
    cache: "no-store",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 240);
    if (!offlineEnabled && response.status === 401 && logged) {
      clearWalletBatches();
      closeEditor();
      s = null;
      onlineUser = null;
      logged = false;
      donorAccess = false;
      show();
    }
    throw Object.assign(new Error(message), {
      status: response.status,
      walletBatchCommitted: path === "events/wallet-batch" && response.headers.get("X-Bonfire-Wallet-Batch") === "committed",
    });
  }
  if (path === "logout") clearWalletBatches();
  return response.json();
}
import { donationReport } from "./donors.js";
const bearer = () =>
  offlineEnabled ? "Bearer " + s.device + "." + s.token : "";
let donorAccess = false;
const unconfirmedWrites = new Set();
function onlineSnapshot(out, previous = {}) {
  return {
    ...previous,
    ...out,
    entries: out.entries || [],
    conflicts: out.conflicts || [],
    ops: [],
    prints: [],
    seq: out.last,
    pinnedTemplates: out.entries.filter((r) => r.Kind === "template"),
  };
}
async function workspaceRequest(id, body) {
  if (!navigator.onLine)
    throw Error(
      "The server is unreachable. Reconnect before saving.",
    );
  const changes =
    body.Ops?.length || body.Prints?.length || body.Action || body.Resolve;
  if (changes && unconfirmedWrites.has(id))
    throw Error(
      "Refresh the server records and check the last entry before saving again.",
    );
  try {
    const result = await api("online?event=" + encodeURIComponent(id), body);
    unconfirmedWrites.delete(id);
    return result;
  } catch (err) {
    if (err instanceof TypeError) {
      if (changes) unconfirmedWrites.add(id);
      throw Error(
        "The server did not confirm this operation. Check the server records after reconnecting.",
        { cause: err },
      );
    }
    throw err;
  }
}
async function reprint(row, format) {
  if (!row.Data[format])
    throw Error("This original requires a receipt profile.");
  if (!s.recovery)
    await commit({
      ...s,
      prints: [
        ...(s.prints || []),
        {
          ID: crypto.randomUUID(),
          Subject: row.ID.slice("original:".length),
          At: new Date().toISOString(),
        },
      ],
    });
  download(
    from64(
      row.Data[format],
      format === "PDF"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "Receipt-" + row.Data.Number + "." + format.toLowerCase(),
  );
}
async function commit(next) {
  if (offlineEnabled) {
    await save(next);
    s = next;
    return;
  }
  if (next.ops.length || next.prints?.length) {
    const result = await workspaceRequest(next.event.ID, {
      Ops: next.ops,
      Prints: next.prints || [],
      ReceiptOnly: next.ops.length > 0,
    });
    let out = result;
    if (result.saved) {
      try {
        out = await workspaceRequest(next.event.ID, {});
      } catch {
        unconfirmedWrites.add(next.event.ID);
        throw Error("The server saved the entry. Refresh the workspace before recording another entry.");
      }
    }
    s = onlineSnapshot(out, next);
  } else s = next;
}
function writableWorkspace() {
  return (
    ["Admin", "Write"].includes(s.role) &&
    !s.closed &&
    !s.sealed &&
    !s.ending &&
    !s.recovery &&
    s.incidentState !== "returning" &&
    !(offlineEnabled && Date.parse(s.expires) <= Date.now())
  );
}
const adminKinds = new Set([
  "opening",
  "period",
  "organization",
  "template",
  "dispatch",
  "import-source",
]);
function onOverview() {
  return page === "Übersicht" || page === "Veranstaltungen";
}
function editableKinds() {
  if (!writableWorkspace()) return [];
  const kinds =
    !offlineEnabled && onOverview()
      ? ["opening"]
      : recordKinds(page, !offlineEnabled);
  return kinds.filter((k) => s.role === "Admin" || !adminKinds.has(k));
}
function canWrite() {
  if (!writableWorkspace())
    throw Error(
      offlineEnabled
        ? "Local write access has expired."
        : "This workspace is read-only.",
    );
}
async function queue(k, d, target = crypto.randomUUID(), base = 0) {
  canWrite();
  const next = structuredClone(s);
  const append = (Kind, Target, Base, Data) =>
    next.ops.push({
      LocalTime: new Date().toISOString(),
      ID: crypto.randomUUID(),
      Seq: ++next.seq,
      Kind,
      Target,
      Base,
      Data,
    });
  if (k === "attachment") {
    const { File, ...metadata } = d;
    append(k, target, base, metadata);
    const revision = String(base + 1);
    append("attachment-file", await countID("file", target, revision), 0, {
      Label: metadata.Label,
      Date: metadata.Date,
      Reference: target,
      File,
      Fields: { sha256: d.Fields.sha256, size: d.Fields.size, revision },
    });
  } else append(k, target, base, d);
  await commit(next);
}
async function sync(extra = {}) {
  if (!offlineEnabled) {
    s = onlineSnapshot(await workspaceRequest(s.event.ID, extra), s);
    return;
  }
  if (s.recovery)
    throw Error("The restored archive is read-only.");
  const probe = await api("sync", { Ops: [] }, bearer());
  if (probe.last > s.seq)
    throw Error(
      "The server has additional transactions for this device ID. Lock the profile and check for copies.",
    );
  if (probe.last < s.last) {
    const missing = (s.history || [])
      .filter((o) => o.Seq > probe.last && o.Seq <= s.last)
      .sort((a, b) => a.Seq - b.Seq);
    if (missing.length !== s.last - probe.last)
      throw Error(
        "The restored server records are older than the local archive. Local data was retained.",
      );
    for (const o of missing) await api("sync", { Ops: [o] }, bearer());
  }
  // Each acknowledged operation is durable before removing it from the local outbox.
  do {
    const batch = s.ops.slice(0, 1),
      last = s.ops.length <= 1;
    const out = await api(
      "sync",
      { Ops: batch, ...(last ? { ...extra, Prints: s.prints || [] } : {}) },
      bearer(),
    );
    const revisions = new Map(out.entries.map((r) => [r.ID, r.Revision]));
    if (
      s.entries.some(
        (r) =>
          r.Kind !== "contact" &&
          (!revisions.has(r.ID) || revisions.get(r.ID) < r.Revision),
      )
    )
      throw Error(
        "The server returned an older version. Local data was retained for recovery.",
      );
    const next = {
      ...s,
      ...out,
      prints: last
        ? (s.prints || []).filter(
            (l) => !(out.acknowledgedPrints || []).includes(l.ID),
          )
        : s.prints,
      history: [...(s.history || []), ...batch],
      ops: s.ops.slice(batch.length),
      seq: Math.max(s.seq, out.last),
      synced: new Date().toISOString(),
    };
    if (!next.pinnedTemplates)
      next.pinnedTemplates = (s.synced ? s.entries : out.entries).filter(
        (r) => r.Kind === "template",
      );
    next.event = { ...s.event, Accounts: out.accounts };
    if (out.sealed) next.ending = false;
    await commit(next);
  } while (s.ops.length);
}
function rows() {
  return visible(s);
}
function choices(kinds, name) {
  return [
    ["", "—"],
    ...rows()
      .filter(
        (r) =>
          kinds.includes(r.Kind) &&
          (!["Account", "To", "Wallet"].includes(name) ||
            !r.Data.Fields?.masterInactive ||
            ["opening", "actual"].includes(kind) ||
            edit?.Data?.[name] === r.ID) &&
          (!r.Data.Retired || edit?.Data?.Contact === r.ID),
      )
      .map((r) => [
        r.ID,
        r.Kind === "contact"
          ? [r.Data.Label, r.Data.Address, r.Data.Fields?.distinct]
              .filter(Boolean)
              .join(" · ")
          : r.Data.Label,
      ]),
  ];
}
function refs(name, title, kinds, alwaysSearch = false) {
  const dropdown = select(name, title, choices(kinds, name));
  if (
    name !== "Contact" ||
    (!alwaysSearch && !rows().some((r) => r.Kind === "contact"))
  )
    return dropdown;
  return (
    label(
      "Search contacts",
      '<input type="search" data-contact-filter autocomplete="off">',
    ) + dropdown
  );
}
async function loadSponsorChoices(form) {
  if (
    offlineEnabled ||
    page !== "Zahlungen" ||
    kind !== "sponsorship" ||
    s.role !== "Write"
  )
    return;
  const picker = form.elements.Contact;
  try {
    const contacts = await api(
      "manage",
      { Action: "sponsor-contacts" },
      bearer(),
    );
    if (!form.isConnected) return;
    const available = new Set([...picker.options].map((opt) => opt.value));
    for (const { id, caption } of contacts) {
      if (!available.has(id)) picker.add(new Option(caption, id));
    }
    form
      .querySelector("[data-contact-filter]")
      .dispatchEvent(new Event("input", { bubbles: true }));
  } catch (err) {
    if (form.isConnected)
      entryDialog.querySelector(".entry-error").textContent = err.message;
  }
}
function table(list, editable = []) {
  if (!list.length) return '<p class="muted">No entries.</p>';
  return (
    '<div class="list entry-list"><table><thead><tr><th>Date</th><th>Transaction</th><th>Description</th><th>Amount</th><th aria-label="Actions"></th></tr></thead><tbody>' +
    list
      .map(
        (r) =>
          "<tr><td>" +
          esc(r.Data.Date) +
          "</td><td>" +
          esc(
            r.Data.Fields?.claimType === "invoice"
              ? "Outgoing invoice"
              : types[r.Kind],
          ) +
          "</td><td>" +
          esc(r.Data.Label) +
          (r.Kind === "expense" && r.Data.Fields?.issuer
            ? " · " + esc(r.Data.Fields.issuer)
            : "") +
          (r.Data.Retired ? " · Archived" : "") +
          (r.Kind === "attachment"
            ? r.Data.uploadPending
              ? " · File on this device, upload pending"
              : r.Data.File
                ? " · File available"
                : " · Metadata saved, file pending"
            : "") +
          "</td><td>" +
          esc(flowAmount(r)) +
          '</td><td><div class="entry-actions">' +
          (["sponsorship", "donation", "payment"].includes(r.Kind) &&
          (r.Kind !== "donation" || s.role === "Admin" || s.donorAccess)
            ? '<button type="button" class="secondary" data-record-document="' +
              esc(r.ID) +
              '">' +
              {
                donation: "Donation receipt",
                sponsorship: "Invoice",
                payment: "Confirm payment",
              }[r.Kind] +
              "</button>"
            : "") +
          (r.Kind === "attachment" && r.Data.File
            ? '<button type="button" data-attachment="' +
              esc(r.ID) +
              '">Download file</button>'
            : "") +
          (editable.includes(r.Kind) && !r.Data.Retired
            ? '<button class="secondary" data-edit="' +
              esc(r.ID) +
              '">Edit</button>'
            : "") +
          (editable.includes(r.Kind) &&
          s.role === "Admin" &&
          !s.closed &&
          !s.sealed &&
          (r.Kind === "contact" ||
            (r.Kind === "price" && r.Data.Status !== "Freigegeben"))
            ? '<button type="button" class="secondary" data-lifecycle="' +
              esc(r.ID) +
              '">' +
              (r.Data.Retired ? "Restore" : "Archive") +
              "</button>"
            : "") +
          "</div></td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
let readiness = [];
let conflictFiles;
function incidentPanel() {
  const devices = s.devices || [];
  const labels = {
    missing: "Missing",
    incomplete: "Closing incomplete · Exception recorded",
    returning: "Returned · Individual review in progress",
  };
  const cases = devices.filter((d) => d.IncidentState);
  let content = cases
    .map(
      (d) =>
        "<p><strong>" +
        esc(d.Name) +
        "</strong> · " +
        esc(labels[d.IncidentState]) +
        " · Confirmed sequence " +
        esc(d.Last) +
        (d.IncidentNote ? "<br>" + esc(d.IncidentNote) : "") +
        "</p>",
    )
    .join("");
  for (const [id, allowed, label, reason] of [
    ["incident", [""], "Report missing device", "Incident and known discrepancy"],
    [
      "incomplete",
      ["missing"],
      "Confirm incomplete records",
      "Reconstruction and remaining discrepancy",
    ],
    [
      "returnDevice",
      ["missing", "incomplete"],
      "Authorize return for review",
      "Evidence of device return",
    ],
  ]) {
    const choices = devices.filter(
      (d) =>
        d.ID !== s.device &&
        !d.Sealed &&
        allowed.includes(d.IncidentState || ""),
    );
    if (choices.length && s.role === "Admin" && !s.recovery)
      content += popupForm(
        id,
        label,
        select(
          "device",
          "Affected device",
          choices.map((d) => [d.ID, d.Name]),
        ) + field("reason", reason, "text", true),
        label,
      );
  }
  return content ? panel("Device incidents", content) : "";
}
function copyForm() {
  return popupForm(
    "copy",
    "Copy event",
    "<p>Source <strong>" +
      esc(s.event.Name) +
      "</strong></p>" +
      field("name", "New event name", "text", true) +
      (years.length
        ? select(
            "year",
            "Destination fiscal year",
            years.filter((y) => !y.Closed).map((y) => [y.ID, y.Name]),
            s.event.Year,
          )
        : "") +
      "<fieldset><legend>Copy event structure</legend>" +
      [
        ["bar", "Bars"],
        ["wallet", "Wallets"],
        ["shift", "Shifts"],
        ["price", "Draft prices"],
        ["template", "Templates"],
      ]
        .map(
          ([k, l]) =>
            '<label><input type="checkbox" checked name="copy_' +
            k +
            '">' +
            l +
            "</label>",
        )
        .join("") +
      "</fieldset>" +
      field("start", "New start date", "date", true, s.event.Starts) +
      field("end", "New end date", "date", true, s.event.Ends),
    "Copy structure and draft prices",
  );
}
function devicePage() {
  const conflicts = s.conflicts
    .map((c) => {
      const cur = s.entries.find((r) => r.ID === c.Target);
      const sameName = c.Kind === "contact" && !cur && c.Base === 0;
      return panel(
        "Conflict · " + c.Data.Label,
        (sameName
          ? "<p>Review the new contact. If another person or company has the same name, explain how to distinguish them. Existing addresses are preserved.</p>"
          : "") +
          "<p>Original revision " +
          esc(c.Base) +
          " · Saved revision " +
          esc(cur?.Revision ?? 0) +
          "</p><p>Saved: " +
          esc(cur?.Data.Label || "Missing") +
          " · " +
          eur(cur?.Data.Amount) +
          "</p><p>Suggested: " +
          esc(c.Data.Label) +
          " · " +
          eur(c.Data.Amount) +
          "</p><details><summary>View both versions</summary><pre>" +
          esc(
            JSON.stringify(
              [cur?.Data, c.Data],
              (k, v) =>
                ["File", "PDF", "DOCX"].includes(k)
                  ? v
                    ? "File available"
                    : undefined
                  : v,
              2,
            ),
          ) +
          "</pre></details>" +
          (s.role === "Admin" && !s.recovery && !s.closed
            ? form(
                "resolve-" + c.ID,
                select("choice", "Decision", [
                  ["beibehalten", "Keep existing value"],
                  ["übernehmen", "Use suggestion"],
                ]) +
                  (s.accounts && monetary.has(c.Kind)
                    ? refs("account", "Account for resolution (optional)", [
                        "account",
                        "wallet",
                      ])
                    : "") +
                  (s.accounts &&
                  [
                    "transfer",
                    "payout",
                    "supply",
                    "skim",
                    "return",
                    "cashback",
                  ].includes(c.Kind)
                    ? refs("destination", "Destination account for resolution (optional)", [
                        "account",
                        "wallet",
                      ])
                    : "") +
                  field("reason", "Reason", "text", true),
                "Save resolution",
              )
            : ""),
      );
    })
    .join("");
  return (
    (offlineEnabled
      ? "<p>" +
        esc(s.user) +
        " · " +
        esc(s.role) +
        " · Device access expires " +
        esc(new Date(s.expires).toLocaleString("en-GB")) +
        "</p>" +
        (!s.sealed && !s.recovery
          ? panel(
              "Extend device authorization",
              form(
                "renew",
                field("password", "Online password", "password", true) +
                  field("otp", "TOTP or recovery code (if configured)"),
                "Reauthorize device",
              ),
            )
          : "") +
        panel(
          "Reconcile",
          button("readiness", "Check offline readiness", true) +
            readiness.map((t) => "<p>" + esc(t) + "</p>").join("") +
            "<p>" +
            s.ops.length +
            " local transactions pending · " +
            s.conflicts.length +
            " conflicts at the last sync</p><p>" +
            esc(
              s.synced
                ? "Last confirmed sync " +
                    new Date(s.synced).toLocaleString("en-GB")
                : "First sync pending",
            ) +
            '</p><div class="actions">' +
            button("sync", "Sync now") +
            button("recover", "Download encrypted backup", true) +
            "</div>",
        )
      : button("sync", "Refresh entries", true)) +
    conflicts +
    panel(
      "Audit log",
      '<div class="actions">' +
        button("audit", "Show log", true) +
        button("journalHistory", "Show reversal and replacement", true) +
        button("numbers", "Review number register", true) +
        button("conflictFiles", "Load disputed originals", true) +
        "</div>" +
        (conflictFiles?.device === s.device && conflictFiles.list.length
          ? form(
              "conflictFile",
              select(
                "operation",
                "Archived conflicting version",
                conflictFiles.list.map((x) => [
                  x.id,
                  "No. " + x.number + " · " + x.outcome + " · " + x.id,
                ]),
              ) +
                select("format", "File type", [
                  ["pdf", "PDF"],
                  ["docx", "DOCX"],
                ]),
              "Download archive",
            )
          : conflictFiles?.device === s.device ? "<p>No disputed originals found.</p>" : "") +
        auditRows
          .map(
            (r) =>
              "<p>" +
              esc(r.at) +
              " · " +
              esc(r.username) +
              " · " +
              esc(r.action) +
              (r.device ? "<br>Recording device " + esc(r.device) : "") +
              (r.local_time ? " · Device time " + esc(r.local_time) : "") +
              (r.source_device
                ? " · Source device " +
                  esc(r.source_device) +
                  " · Original revision " +
                  esc(r.base_revision)
                : "") +
              "</p>",
          )
          .join(""),
    ) +
    (s.role === "Admin" && !s.event.General
      ? panel(
          "Manage event",
          copyForm() +
            esc(syncDetail) +
            (s.closed
              ? popupForm(
                  "reopen",
                  "Reopen workspace",
                  field("reason", "Reason", "text", true),
                  "Reopen event",
                )
              : ""),
        )
      : "") +
    (s.role === "Admin"
      ? panel(
          "Account allocation",
          button(
            "accounts",
            s.event.Accounts
              ? "Disable account allocation"
              : "Enable account allocation",
            true,
          ),
        )
      : "") +
    (offlineEnabled
      ? incidentPanel() +
        panel(
          "End of recording",
          "<p>Confirm to finish recording this event on this device.</p><p>Devices still recording at the last sync: " +
            esc(s.pending ?? "Unknown") +
            '</p><div class="actions">' +
            (!s.sealed
              ? button("seal", "Confirm end of recording")
              : "<strong>Recording complete</strong>") +
            (s.role === "Admin" && !s.closed && !s.recovery
              ? button("close", "Review balances and close")
              : "") +
            "</div>",
        )
      : s.role === "Admin" && !s.closed
        ? button("close", "Review balances and close")
        : "")
  );
}
function formFields(k, countPhase = "") {
  const eventBooking = !offlineEnabled && page === "Zahlungen";
  const walletTopUp = page === "Geldtaschen" && k === "supply" && !edit;
  const simpleBooking = [
    "expense",
    "income",
    "refund",
    "deposit",
    "deposit-return",
  ].includes(k);
  let extra = "";
  let f =
    field(
      "Label",
      k === "expense"
        ? "What was it for?"
        : k === "contact"
          ? "Name or company"
          : "Description",
      "text",
      true,
      walletTopUp
        ? "Change top-up"
        : k === "count"
          ? {
              Anfang: "Opening count",
              Ende: "Closing count",
              Zwischenstand: "Interim count",
            }[countPhase]
          : "",
    ) +
    field(
      "Date",
      k === "period" ? "Period start" : "Date",
      "date",
      true,
      offlineEnabled ? today() : defaultDay(s.event),
    );
  if (monetary.has(k) && k !== "supply")
    f += label(
      "Amount in EUR",
      '<input name="amount" inputmode="decimal" required placeholder="0,00">',
    );
  if (k === "period") f += field("To", "Period end", "date", true);
  if (k === "expense") {
    const issuers = [
      ...new Set(
        rows()
          .filter((r) => r.Kind === "expense")
          .map((r) => r.Data.Fields?.issuer)
          .filter(Boolean),
      ),
    ].sort();
    f += label(
      "Invoice issuer",
      '<input name="field_issuer" list="expense-issuers" maxlength="200"><datalist id="expense-issuers">' +
        issuers.map((v) => option(v, v)).join("") +
        "</datalist>",
    );
  }
  if (
    ![
      "bar",
      "contact",
      "period",
      "template",
      "opening",
      "actual",
      "reserve",
      "count",
    ].includes(k)
  )
    extra += refs("Bar", "Bar (optional)", ["bar"]);
  if (
    [
      "expense",
      "refund",
      "deposit",
      "deposit-return",
      "donation",
      "payment",
      "count",
      "plan",
      "supply",
      "skim",
      "cashback",
      "return",
      "income",
      "presale",
    ].includes(k)
  ) {
    if (k === "count" && (countPhase || edit?.Data.Phase) !== "Zwischenstand")
      f += select("field_countScope", "Count scope", [
        ["wallet", "Single wallet"],
        ["all", "All wallets combined"],
      ]);
    const wallet = refs(
      "Wallet",
      walletTopUp ? "Receiving wallet" : "Wallet",
      ["wallet"],
    );
    if (simpleBooking) extra += wallet;
    else f += wallet;
    if (k === "count" && countPhase === "Anfang")
      f += '<p class="catalog-hint" hidden aria-live="polite"></p>';
  }
  if (
    k === "sponsorship" ||
    (!eventBooking &&
      ["donation", "payment", "outlay", "income", "expense"].includes(k))
  ) {
    const contact = refs(
      "Contact",
      eventBooking ? "Sponsor from the contact directory" : "Contact",
      ["contact"],
      eventBooking,
    );
    if (simpleBooking) extra += contact;
    else f += contact;
  } else if (eventBooking && edit?.Data.Contact) {
    const contact = rows().find(
      (r) => r.Kind === "contact" && r.ID === edit.Data.Contact,
    );
    if (contact)
      f += "<p>Linked contact: " + esc(contact.Data.Label) + "</p>";
  }
  if (k === "organization")
    f +=
      label(
        "Organization logo (PNG, optional)",
        '<input type="file" name="logo" accept="image/png">',
      ) +
      field("Address", "Address", "text", true) +
      field("field_IBAN", "Account / IBAN") +
      field("field_holder", "Account holder") +
      field("field_legal", "Approved invoice text") +
      field("field_donationLegal", "Approved donation text");
  if (k === "contact")
    f +=
      field("field_salutation", "Letter salutation (optional)") +
      field("field_given", "First name") +
      field("field_family", "Last name") +
      (s.donorAccess
        ? field("field_birth", "Date of birth for donation reporting", "date")
        : "");
  if (["card", "fee", "payout", "cashback"].includes(k))
    f += field(
      "field_provider",
      "Card provider / settlement group",
      "text",
      true,
    );
  if (k === "presale")
    f +=
      field("field_saleQuantity", "Advance tickets sold", "number", true) +
      field("unitSale", "Unit price in EUR", "text", true) +
      field("field_paymentEvidence", "Proof of payment / receipt number");
  if (k === "expense")
    extra += refs("field_sale", "Related advance sale (production costs)", [
      "presale",
    ]);
  if (k === "paper")
    f +=
      field(
        "Number",
        "Paper number P- (digits only, " +
          s.first +
          " to " +
          (s.paperLimit ?? s.limit) +
          ")",
        "number",
        true,
      ) +
      select("Status", "Paper receipt status", [
        ["Ausgegeben", "Issued"],
        ["Verworfen", "Voided"],
      ]) +
      refs("Reference", "Previously recorded cash payment", [
        "income",
        "payment",
        "donation",
        "presale",
      ]);
  if (k === "contact")
    f += field(
      "field_distinct",
      "Distinguishing detail for contacts with the same name (optional)",
    );
  if (k === "sponsorship")
    f +=
      select("field_claimType", "Receivable type", [
        ["sponsor", "Sponsoring"],
        ["invoice", "Outgoing invoice"],
      ]) +
      label(
        "Invoice line items (optional, one per line: quantity | description | unit price)",
        '<textarea name="positions"></textarea>',
      ) +
      select(
        "field_pledge",
        "Pledge",
        ["Offen", "Zugesagt", "Zurückgezogen"].map((v) => [v, financialLabel(v)]),
      ) +
      field("field_due", "Due date", "date") +
      field("field_service", "Service period") +
      field("field_paymentRef", "Bank transfer reference");
  if (k === "price")
    f +=
      field("field_guest", "Guest-facing name") +
      field("field_allergens", "Confirmed allergens") +
      field("field_unitA", "Unit in the first source (when resolving a discrepancy)") +
      field("field_unitB", "Conflicting source information") +
      field("field_unitReason", "Reason for the agreed sale unit");
  if (k === "contact") {
    const legacy =
      edit?.Data.Address &&
      !edit.Data.Fields?.street &&
      !edit.Data.Fields?.town &&
      !edit.Data.Fields?.zip;
    f +=
      (legacy
        ? label("Previous address", '<textarea name="Address"></textarea>')
        : "") +
      field("field_street", "Street and house number") +
      field("field_zip", "Postal code") +
      field("field_town", "Town or city") +
      field("Category", "Person / company");
  }
  if (monetary.has(k) && !["price", "cashback", "skim", "return"].includes(k)) {
    const sourceLabel = walletTopUp
      ? "Taken from (source)"
      : "Account / source";
    if (
      walletTopUp &&
      !s.event.Accounts &&
      rows().filter((r) => r.Kind === "wallet").length > 1
    )
      f += select("sourceWallet", "Change source", [
        ["", "Main cashbox or other source"],
        ...choices(["wallet"]).filter(([id]) => id),
      ]);
    if (s.event.Accounts)
      f += refs("Account", sourceLabel, ["account", "wallet"]);
    else if (simpleBooking) extra += field("Account", "Account / source");
    else f += field("Account", sourceLabel, "text", walletTopUp);
  }
  if (
    !walletTopUp &&
    ["transfer", "payout", "skim", "return", "cashback"].includes(k)
  )
    f += s.event.Accounts
      ? refs(
          "To",
          k === "cashback" ? "Terminal clearing account" : "Destination account",
          k === "cashback" ? ["account"] : ["account", "wallet"],
        )
      : field(
          "To",
          k === "cashback" ? "Terminal clearing account" : "Destination account",
          "text",
          true,
        );
  if (
    [
      "income",
      "expense",
      "refund",
      "deposit",
      "deposit-return",
      "payment",
      "donation",
      "presale",
    ].includes(k)
  )
    f += select("Method", "Payment method", [
      ["Bar", "Cash"],
      ["Überweisung", "Bank transfer"],
      ["Karte", "Card"],
    ]);
  if (
    [
      "income",
      "expense",
      "payment",
      "donation",
      "card",
      "supply",
      "skim",
      "cashback",
      "return",
    ].includes(k)
  )
    extra += field("field_matter", "External transaction ID");
  if (k === "payment") f += refs("Reference", "Receivable", ["sponsorship"]);
  else if (k === "reimbursement") {
    f += refs("Reference", "Individual personal advance", ["outlay"]);
    const debts = rows().filter((r) => r.Kind === "outlay");
    if (debts.length)
      f +=
        "<details><summary>Allocate grouped reimbursement</summary>" +
        debts
          .map((r) =>
            field(
              "alloc_" + r.ID,
              r.Data.Label + " · maximum " + eur(r.Data.Amount),
            ),
          )
          .join("") +
        "</details>";
  } else if (k === "attachment")
    f +=
      refs(
        "Reference",
        "Associated transaction",
        Object.keys(types).filter((n) => n !== "attachment"),
      ) +
      label(
        "PDF, JPEG or PNG",
        '<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required>',
      );
  else if (k === "template")
    f += select(
      "Reference",
      "Issuing profile",
      profiles.map((p, i) => [profileID(i), p]),
    );
  else if (k === "price")
    f +=
      select("Category", "Product range", [
        ["Getränk", "Drink"],
        ["Essen", "Food"],
      ]) +
      field("Unit", "Unit") +
      field("Variant", "Variant") +
      select(
        "Status",
        "Price version",
        s.role === "Admin"
          ? [
              ["Entwurf", "Draft"],
              ["Freigegeben", "Approved"],
            ]
          : [["Entwurf", "Draft"]],
      );
  else if (k === "donation")
    f +=
      field("Reference", "Collector") +
      field(
        "field_reporting",
        "Reporting period (independent of the accounting period)",
      ) +
      select("Status", "Donation type", [
        [
          "Offen",
          eventBooking && !edit?.Data.Contact
            ? "Donor details pending"
            : "Named",
        ],
        ["Anonym", "Anonymous"],
      ]);
  else if (simpleBooking)
    extra +=
      field("Category", "Category") + field("Reference", "Receipt reference");
  if (k === "count")
    f += select("Status", "Recording status", [
      ["Unbestätigt", "Recorded observation"],
      ["Bestätigt", "Confirm count"],
    ]);
  if (["count", "plan", "reserve", "supply"].includes(k)) {
    if (countPhase)
      f += '<input type="hidden" name="Phase" value="' + esc(countPhase) + '">';
    else if (k === "count" || k === "plan")
      f += select(
        "Phase",
        "Phase",
        ["Anfang", "Zwischenstand", "Ende"].map((p) => [p, financialLabel(p)]),
      );
    if (k === "count" || k === "supply")
      f +=
        select("field_countMode", "Enter amount", [
          ["amount", "Enter total amount"],
          ["pieces", "Count coins and notes"],
        ]) +
        label(
          k === "supply" ? "Amount in EUR" : "Counted amount in EUR",
          '<input name="amount" inputmode="decimal" placeholder="0,00">',
        );
    f +=
      '</div>' + denominationFields() + '<div class="form">';
  }
  if (edit) f += field("Note", "Reason for correction", "text", true);
  else extra += field("Note", "Note / text snippet");
  if (extra)
    f +=
      '<details class="record-extra"><summary>' +
      (simpleBooking
        ? edit
          ? "Allocation and receipt details"
          : "Allocation, receipt and note"
        : "More details") +
      '</summary><div class="form">' +
      extra +
      "</div></details>";
  return f;
}
function journalFilterFields() {
  const all = rows(),
    labels = new Map(all.map((r) => [r.ID, r.Data.Label]));
  let fields =
    field("from", "From", "date", false, journalFilters.from || "") +
    field("until", "To", "date", false, journalFilters.until || "");
  for (const [key, title, values] of [
    [
      "kind",
      "Transaction type",
      recordKinds(page, !offlineEnabled).map((k) => [k, types[k]]),
    ],
    ...[
      ["category", "Category", "Category"],
      ["method", "Payment method", "Method"],
      ["account", "Account", "Account"],
      ["bar", "Bar", "Bar"],
    ].map(([key, title, attr]) => [
      key,
      title,
      [...new Set(all.map((r) => r.Data[attr]).filter(Boolean))]
        .sort()
        .map((v) => [v, labels.get(v) || (attr === "Method" ? financialLabel(v) : v)]),
    ]),
  ]) {
    fields += label(
      title,
      '<select name="' +
        key +
        '"><option value="">All</option>' +
        values
          .map(
            ([v, t]) =>
              '<option value="' +
              esc(v) +
              '"' +
              (journalFilters[key] === v ? " selected" : "") +
              ">" +
              esc(t) +
              "</option>",
          )
          .join("") +
        "</select>",
    );
  }
  return fields;
}
function isBookingList() {
  return page === "Journal" || (!offlineEnabled && page === "Zahlungen");
}
function walletSettlementSummary(entries) {
  const pooled = poolCount(entries, "Anfang") || poolCount(entries, "Ende");
  function actionRow(wallet) {
    const target = wallet ? "settlement:" + wallet.ID : "settlement-total";
    const previous = entries.find((r) => r.ID === target);
    const amount = wallet
      ? counted(
          entries.filter((r) => r.ID !== target),
          wallet.ID,
        )
      : pooledRevenue(entries);
    if (amount == null)
      return wallet
        ? ""
        : "<p>Enter a pooled closing count and an opening balance. The opening balance can also come from individual counts for all wallets.</p>";
    const label = wallet
      ? esc(wallet.Data.Label) + " · Additional pooled cash income"
      : "All wallets · Pooled cash income";
    let action = "";
    if (amount < 0) action = "Review counts and money movements.";
    else if (previous?.Data.Amount === amount) action = "Posted";
    else if (writableWorkspace()) {
      const title = previous
        ? "Correct pooled amount"
        : wallet
          ? "Post pooled amount"
          : "Post total";
      action =
        '<button type="button" data-settle="' +
        esc(wallet?.ID || target) +
        '">' +
        title +
        "</button>";
    }
    return "<p>" + label + " " + eur(amount) + " " + action + "</p>";
  }
  const actions = pooled
    ? actionRow(null)
    : entries
        .filter((r) => r.Kind === "wallet")
        .map(actionRow)
        .join("");
  return walletTable(entries, actions);
}
function records() {
  const kinds = recordKinds(page, !offlineEnabled);
  if (!kinds.includes(kind)) kind = kinds[0];
  const set = rows().filter(
    (r) =>
      kinds.includes(r.Kind) &&
      (!isBookingList() || journalMatches(r, journalFilters)) &&
      (!filter ||
        (
          r.Data.Label +
          " " +
          (r.Data.Bar || "") +
          " " +
          (r.Data.Category || "") +
          " " +
          (r.Data.Fields?.issuer || "")
        )
          .toLowerCase()
          .includes(filter.toLowerCase())),
  );
  let detail = "";
  if (isBookingList()) {
    const balances = new Map();
    for (const r of rows()) {
      const provider = r.Data.Fields?.provider;
      if (provider && ["card", "fee", "payout", "cashback"].includes(r.Kind))
        balances.set(
          provider,
          (balances.get(provider) || 0) +
            (["card", "cashback"].includes(r.Kind) ? 1 : -1) * r.Data.Amount,
        );
    }
    detail = [...balances]
      .map(
        ([name, balance]) =>
          "<p>Provider balance " + esc(name) + " · " + eur(balance) + "</p>",
      )
      .join("");
  }
  if (page === "Sponsoring" || (!offlineEnabled && page === "Zahlungen")) {
    const claims = sponsorshipStatus(rows());
    if (claims.length) {
      const originals = claims.flatMap((c) =>
        c.originals.map((doc) => [
          doc.id,
          c.claim.Data.Label + " · No. " + doc.number,
        ]),
      );
      detail += panel(
        "Sponsoring",
        '<div class="list"><table><tr><th>Receivable</th><th>Pledge</th><th>Amount</th><th>Paid</th><th>Open</th><th>Receipts and delivery</th></tr>' +
          claims
            .map(
              (c) =>
                "<tr><td>" +
                esc(c.claim.Data.Label) +
                "</td><td>" +
                esc(c.pledge) +
                "</td><td>" +
                eur(c.claim.Data.Amount) +
                "</td><td>" +
                eur(c.paid) +
                "</td><td>" +
                eur(c.outstanding) +
                "</td><td>" +
                (c.originals
                  .map((o) => "No. " + o.number + " · " + esc(financialLabel(o.dispatch)))
                  .join("<br>") || "No original issued") +
                (page === "Zahlungen"
                  ? ' <button type="button" class="secondary" data-claim-invoice="' +
                    esc(c.claim.ID) +
                    '">Open invoice</button>'
                  : "") +
                "</td></tr>",
            )
            .join("") +
          "</table></div>" +
          (s.role === "Admin" && !s.closed && originals.length
            ? popupForm(
                "dispatch",
                "Record handover",
                select("original", "Issued receipt", originals) +
                  select(
                    "delivery",
                    "External handover",
                    [
                      "Extern übergeben",
                      "Extern versandt",
                      "Vermerk aufgehoben",
                    ].map((v) => [v, financialLabel(v)]),
                  ) +
                  field(
                    "evidence",
                    "Supporting evidence or reason for correction",
                    "text",
                    true,
                  ),
                "Record handover",
              )
            : ""),
      );
    }
  }
  if (page === "Perioden") {
    detail =
      form(
        "globalPeriod",
        field("start", "Report from", "date", true, s.event.Starts) +
          field("end", "to", "date", true, s.event.Ends) +
          select("scope", "Report", [
            ["period", "Current records"],
            ["journal-period", "Bookings including reversals and replacements"],
          ]),
        "Analyze assigned events",
      ) +
      globalRows
        .map(
          (r) =>
            "<p>" +
            esc(r.datum) +
            " · " +
            esc(r.veranstaltung) +
            " · " +
            esc(r.bezeichnung) +
            (r.revision
              ? " · " +
                esc(r.richtung) +
                " · Revision " +
                esc(r.revision) +
                " · " +
                esc(r.akteur)
              : "") +
            " · " +
            eur(r.cent) +
            "</p>",
        )
        .join("");
  }
  if (page === "Perioden" && s.role === "Admin" && !s.recovery && !s.closed) {
    detail += popupForm(
      "periodAction",
      "Change period status",
      refs("id", "Accounting period", ["period"]) +
        select("action", "Transaction", [
          ["period-close", "Approve period"],
          ["period-open", "Reopen period"],
        ]) +
        field("reason", "Reason for reopening"),
      "Confirm period status",
    );
  }
  if (page === "Perioden" && s.role === "Admin" && !s.closed)
    detail += popupForm(
      "carry",
      "Carry forward prior balance",
      refs("period", "Destination period", ["period"]) +
        field("reason", "Reason for replacing an earlier carry-forward"),
      "Carry forward the confirmed prior balance",
    );
  if (page === "Geldtaschen") {
    const plan = denominationNeeds(rows()).filter((r) => r.need || r.stock);
    const starts = rows().filter(
        (r) => r.Kind === "count" && r.Data.Phase === "Anfang",
      ),
      plans = rows().filter(
        (r) => r.Kind === "plan" && r.Data.Phase === "Anfang",
      );
    const needed =
      starts.some((r) => r.Data.Fields?.countScope === "all") && !plans.length
        ? starts
        : [
            ...plans,
            ...starts.filter(
              (r) =>
                r.Data.Fields?.countScope !== "all" &&
                !plans.some((p) => p.Data.Wallet === r.Data.Wallet),
            ),
          ];
    if (needed.length)
      detail += panel(
        "Prepare change",
        "<p>Required amount · <strong>" +
          eur(needed.reduce((sum, r) => sum + (r.Data.Amount ?? 0), 0)) +
          "</strong></p>" +
          (needed.some((r) => !r.Data.Pieces)
            ? "<p>Denomination counts are missing for part of the amount.</p>"
            : ""),
      );
    if (plan.length)
      detail += panel(
        "Change across all wallets",
        "<table><thead><tr><th>Denomination</th><th>Required</th><th>Available</th><th>Shortfall</th></tr></thead><tbody>" +
          plan
            .map(
              (r) =>
                "<tr><td>" +
                eur(r.cent) +
                "</td><td>" +
                r.need +
                "</td><td>" +
                (r.stock ?? "Unknown") +
                "</td><td>" +
                (r.missing ?? "Unknown") +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>",
      );
  }
  if (offlineEnabled && page === "Geldtaschen" && writableWorkspace()) {
    detail += popupForm(
      "handover",
      "Record physical handover",
      refs("wallet", "Wallet", ["wallet"]) +
        select(
          "to",
          "Receiving device",
          (s.devices || []).filter((d) => !d.Sealed).map((d) => [d.ID, d.Name]),
        ) +
        select("status", "Handover", [
          ["Angeboten", "Offer handover"],
          ["Bestätigt", "Confirm receipt"],
        ]),
      "Record handover",
    );
  }
  return (
    (page === "Perioden" && !s.event.General
      ? festivalPanel(rows()) + walletSettlementSummary(rows())
      : "") +
    (page === "Geldtaschen" ? walletSettlementSummary(rows()) : "") +
    "<section>" +
    panelHeading(
      "Entries",
      !offlineEnabled ? button("sync", "Refresh entries", true) : "",
    ) +
    '<details class="filter-box"' +
    (filter || Object.values(journalFilters).some(Boolean) ? " open" : "") +
    "><summary>Filter entries</summary>" +
    form(
      "filter",
      field(
        "filter",
        "Search by description or category",
        "search",
        false,
        filter,
      ) + (isBookingList() ? journalFilterFields() : ""),
      "Filter",
    ) +
    "</details>" +
    table(set, editableKinds()) +
    detail +
    "</section>"
  );
}
function recordForm(countPhase = "") {
  return form(
    "record",
    formFields(kind, countPhase),
    edit
      ? "Save correction"
      : offlineEnabled
        ? "Save locally"
        : "Save",
    button("cancel", "Cancel", true),
  );
}
function entryLabel(page) {
  return (
    {
      Übersicht: "Enter opening balance",
      Veranstaltungen: "Enter opening balance",
      Journal: "Record transaction",
      Zahlungen: offlineEnabled
        ? "Add entry"
        : "Record event transaction",
      Kontakte: "Add contact",
      Spenden: "Record donation",
      Preise: "Add price",
    }[page] || "Add entry"
  );
}
const walletStages = [
  [
    "Before the event",
    [
      ["bar", "Add bar"],
      ["shift", "Add shift"],
      ["reserve", "Record available change"],
      ["plan", "Plan change per wallet"],
    ],
  ],
  [
    "During the event",
    [
      ["skim", "Collect cash"],
      ["count:Zwischenstand", "Record interim count"],
    ],
  ],
  ["At event close", [["return", "Return remaining cash"]]],
];
function walletButton(action, title) {
  return (
    '<button type="button" class="secondary" aria-haspopup="dialog" data-wallet-action="' +
    esc(action) +
    '">' +
    esc(title) +
    "</button>"
  );
}
function walletActions() {
  return (
    '<section class="wallet-menu" aria-label="Manage wallets"><div class="actions">' +
    walletButton("wallet", "Add wallet") +
    (!offlineEnabled ? '<button type="button" class="secondary" data-act="pickWallets" aria-haspopup="dialog">Add from wallet list</button>' : "") +
    walletButton("count:Anfang", "Count opening balance") +
    walletButton("supply", "Add change") +
    walletButton("count:Ende", "Count closing balance") +
    (!offlineEnabled && !s.event.General ? '<button type="button" class="secondary" data-act="bulkWallets" aria-haspopup="dialog">Bulk wallet entry</button>' : "") +
    '</div><details class="wallet-more"' +
    (article.querySelector(".wallet-more[open]") ? " open" : "") +
    '><summary>More actions</summary><div class="wallet-actions">' +
    walletStages
      .map(
        ([stage, actions]) =>
          "<div><h2>" +
          esc(stage) +
          "</h2>" +
          actions
            .map(([action, title]) => walletButton(action, title))
            .join("") +
          "</div>",
      )
      .join("") +
    "</div></details></section>"
  );
}
function bookingTypeSelector(kinds) {
  const basic = ["income", "expense", "donation"];
  const sponsorship = ["sponsorship", "payment"];
  const sections = [
    ["Income and expenses", basic],
    ["Sponsorship and invoices", sponsorship],
    [
      "More actions",
      kinds.filter((k) => !basic.includes(k) && !sponsorship.includes(k)),
    ],
  ];
  return label(
    "Transaction",
    '<select name="type">' +
      sections
        .map(([title, items]) => {
          const options = items
            .filter((k) => kinds.includes(k))
            .map((k) =>
              option(
                k,
                k === "sponsorship"
                  ? "Sponsorship receivable / invoice"
                  : types[k],
              ),
            )
            .join("");
          return options
            ? '<optgroup label="' + esc(title) + '">' + options + "</optgroup>"
            : "";
        })
        .join("") +
      "</select>",
  );
}
function openRecord(trigger, item = null) {
  canWrite();
  const kinds = editableKinds();
  if (!kinds.length || (item && !kinds.includes(item.Kind))) return;
  edit = item;
  const [walletKind, countPhase] = (trigger?.dataset.walletAction || "").split(
    ":",
  );
  if (walletKind && (page !== "Geldtaschen" || !kinds.includes(walletKind)))
    return;
  kind = item?.Kind || walletKind || (kinds.includes(kind) ? kind : kinds[0]);
  const selector =
    kinds.length > 1 && page !== "Geldtaschen"
      ? !offlineEnabled && isBookingList()
        ? bookingTypeSelector(kinds)
        : select(
            "type",
            "Transaction",
            kinds.map((k) => [k, types[k]]),
          )
      : "";
  openEditor(
    trigger,
    item
      ? types[kind] + " correct"
      : walletKind
        ? trigger.textContent
        : entryLabel(page),
    recordForm(countPhase),
    (offlineEnabled
      ? ""
      : '<p class="booking-target">Booking destination <strong>' +
        esc(workspaceLabel()) +
        "</strong></p>") + selector,
  );
  if (!offlineEnabled) entryDialog.dataset.recordWorkspace = s.event.ID;
  const type = entryDialog.querySelector("[name=type]");
  if (type) {
    type.value = kind;
    type.disabled = !!item;
  }
  const record = entryDialog.querySelector("#record");
  if (item) fillRecord(record);
  if (record.elements.field_countMode) {
    const fields = record.elements;
    if (fields.field_countScope) {
      if (
        !item &&
        (!rows().some((r) => r.Kind === "wallet") ||
          poolCount(rows(), "Anfang") ||
          (countPhase === "Ende" && poolCount(rows(), "Ende")))
      )
        fields.field_countScope.value = "all";
      if (item)
        fields.field_countScope.value =
          item.Data.Fields?.countScope || "wallet";
      for (const opt of fields.field_countScope.options) {
        opt.disabled = item
          ? opt.value !== fields.field_countScope.value
          : overlapsCountScope(
              rows(),
              opt.value === "all",
              fields.Phase.value,
            ) ||
            (opt.value === "wallet" &&
              !rows().some((r) => r.Kind === "wallet"));
      }
      if (fields.field_countScope.selectedOptions[0]?.disabled)
        fields.field_countScope.value =
          [...fields.field_countScope.options].find((opt) => !opt.disabled)
            ?.value || "";
    }
    if (item)
      fields.field_countMode.value = item.Data.Pieces ? "pieces" : "amount";
    updateCountOptions(record);
  }
  loadSponsorChoices(record);
  if (!item && kind === "opening" && onOverview()) {
    const period = rows().find(
      (r) => r.Kind === "period" && r.ID === overviewPeriod,
    );
    const fields = entryDialog.querySelector("#record").elements;
    fields.Label.value = "Opening balance";
    fields.Date.min = period?.Data.Date || s.event.Starts;
    fields.Date.max = period?.Data.To || s.event.Ends;
    fields.Date.value = fields.Date.min;
    if (!offlineEnabled && s.event.Year && fields.Date.min === s.event.Starts)
      addYearCarryChoice(entryDialog.querySelector("#record"));
    fields.amount.focus();
  }
}
function addYearCarryChoice(manual) {
  manual.insertAdjacentHTML(
    "beforebegin",
    '<fieldset class="opening-method"><legend>Opening balance</legend>' +
      '<label><input type="radio" name="openingMethod" value="manual" checked> Enter manually</label>' +
      '<label><input type="radio" name="openingMethod" value="prior"> Carry forward from prior year</label></fieldset>',
  );
  const choice = manual.previousElementSibling;
  const preview = document.createElement("div");
  manual.after(preview);
  preview.hidden = true;
  const workspace = s.event;
  let sources;
  choice.addEventListener("change", async () => {
    const prior = choice.querySelector(":checked").value === "prior";
    manual.hidden = prior;
    preview.hidden = !prior;
    if (!prior || sources || preview.getAttribute("aria-busy") === "true")
      return;
    preview.setAttribute("aria-busy", "true");
    preview.textContent = "Loading prior closing balance…";
    try {
      sources = await api("manage", { Action: "year-carry" });
      if (!preview.isConnected) return;
      if (!sources.length) {
        preview.textContent =
          "There is no confirmed closing balance for this workspace in the previous fiscal year. Enter the opening balance manually.";
        return;
      }
      const sourceOptions = new Map(
        sources.map((l) => [l.Source, l.Name + " · " + l.Year]),
      );
      preview.innerHTML =
        select("source", "Source in prior year", [
          ["", "Select an option"],
          ...sourceOptions,
        ]) + '<div class="year-carry-preview"></div>';
      const picker = preview.querySelector("select");
      if (workspace.General && sourceOptions.size === 1)
        picker.value = sources[0].Source;
      const targetAccounts = workspace.Accounts
        ? choices(["account", "wallet"])
        : [];
      const render = () => {
        const lines = sources.filter((l) => l.Source === picker.value);
        const box = preview.querySelector(".year-carry-preview");
        if (!lines.length) {
          box.replaceChildren();
          return;
        }
        box.innerHTML =
          "<p>Confirmed closing balance as of " +
          dat(lines[0].End) +
          " · <strong>" +
          eur(lines.reduce((sum, l) => sum + l.Amount, 0)) +
          "</strong></p>" +
          form(
            "year-carry",
            '<input type="hidden" name="source" value="' +
              esc(picker.value) +
              '">' +
              '<input type="hidden" name="stamp" value="' +
              esc(lines[0].Stamp) +
              '">' +
              lines
                .map((l) =>
                  workspace.Accounts
                    ? select(
                        "account:" + l.Account,
                        l.Label + " · " + eur(l.Amount) + " → Destination account",
                        targetAccounts,
                      )
                    : lines.length > 1
                      ? "<p>" + esc(l.Label) + " · " + eur(l.Amount) + "</p>"
                      : "",
                )
                .join("") +
              "<p>Opening balance as of " +
              dat(workspace.Starts) +
              "</p>",
            "Carry forward opening balance",
            button("cancel", "Cancel", true),
          );
        for (const account of box.querySelectorAll("select"))
          account.required = true;
        if (workspace.Accounts && targetAccounts.length === 1) {
          box
            .querySelector("form")
            .replaceWith(
              document.createTextNode(
                "Create a destination account under Closing first.",
              ),
            );
        }
      };
      picker.addEventListener("change", render);
      render();
    } catch (err) {
      preview.textContent = err.message;
    } finally {
      preview.removeAttribute("aria-busy");
    }
  });
}
let donorReview;
const donorRequest = (body) => api("donation-reports", body, bearer());
function donationPanel() {
  if (!offlineEnabled && s.role === "Admin" && !s.donorAccess)
    return panel(
      "Donation reporting data",
      button("viewDonors", "Unlock reporting data for this session", true),
    );
  if (s.role !== "Admin" || !s.donorAccess || s.recovery) return "";
  const review = donorReview?.device === s.device ? donorReview : null;
  let content = form(
    "donorLoad",
    field(
      "period",
      "Reporting period",
      "text",
      true,
      review?.period || String(new Date().getFullYear()),
    ),
    "Load current review status",
  );
  if (!review) return panel("Donation reporting data", content);
  const data = review.preview.daten;
  content +=
    "<p>" +
    data.Spenden.length +
    " reportable donations · " +
    eur(data.SummeCent) +
    " · " +
    data.Ausgeschlossen.length +
    " excluded</p><details><summary>View review details and reasons for exclusion</summary><pre>" +
    esc(JSON.stringify({
      event: data.Veranstaltung,
      reportingPeriod: data.Meldezeitraum,
      totalCents: data.SummeCent,
      donations: data.Spenden.map(({Vorgang, Datum, BetragCent, Person, Revision}) => ({
        transaction: Vorgang, date: Datum, amountCents: BetragCent, revision: Revision,
        firstName: Person.Vorname, lastName: Person.Nachname, birthDate: Person.Geburtsdatum,
      })),
      excluded: data.Ausgeschlossen.map(({Vorgang, Grund}) => ({transaction: Vorgang, reason: financialLabel(Grund)})),
    }, null, 2)) +
    "</pre></details>";
  const latest = review.history.at(-1);
  if (latest)
    content +=
      "<ol>" +
      review.history
        .map(
          (h) =>
            "<li>" +
            esc(
              h.at + " · " + h.actor + " · " + financialLabel(h.status) + " · " + h.evidence,
            ) +
            "</li>",
        )
        .join("") +
      "</ol>";
  const next = {
    Geprüft: ["Exportiert", "Korrektur"],
    Exportiert: ["Übermittelt", "Korrektur"],
    Übermittelt: ["Bestätigt", "Korrektur"],
    Bestätigt: ["Korrektur"],
  };
  const options =
    latest && latest.status !== "Korrektur" ? next[latest.status] : ["Geprüft"];
  if (!s.closed)
    content += popupForm(
      "donorDecision",
      "Add review note",
      select(
        "step",
        "Decision",
        options.map((v) => [v, financialLabel(v)]),
      ) + field("reason", "Review note or external evidence", "text", true),
      "Record decision",
    );
  const released = review.history.filter((h) => h.status === "Exportiert");
  if (released.length)
    content += form(
      "donorDownload",
      select(
        "report",
        "Saved export",
        released.map((h) => [h.id, h.at + " · " + h.id]),
      ),
      "Download verified file",
    );
  return panel("Donation reporting data", content);
}
function exchange() {
  const periods = rows().filter((r) => r.Kind === "period");
  return (
    panel(
      "Reporting period",
      select("reportPeriod", "Date range", [
        [
          "",
          offlineEnabled
            ? "Complete local copy"
            : "Selected workspace",
        ],
        ...periods.map((r) => [
          r.ID,
          r.Data.Label + " · " + r.Data.Date + " to " + r.Data.To,
        ]),
      ]) +
        '<div class="actions">' +
        button("csv", "Export journal as CSV") +
        button("xlsx", "Export journal as Excel") +
        button("evidence", "Download review package") +
        (s.donorAccess
          ? field(
              "donorPeriod",
              "Donation reporting period",
              "text",
              true,
              String(new Date().getFullYear()),
            ) + button("donors", "Download donation list")
          : "") +
        "</div>",
    ) +
    donationPanel() +
    (s.role === "Admin" && writableWorkspace()
      ? panel(
          "Import preview",
          form(
            "preview",
            select("sourceRole", "Source role", [
              ["Journal", "BONFIRE-Journal"],
              ["D1", "Historical closing statement · D1"],
              ["D8", "Prepared follow-up template · D8"],
            ]) +
              field(
                "year",
                "Year shown in the historical source (XLSX)",
                "number",
                false,
              ) +
              label(
                "Journal file (CSV or XLSX)",
                '<input type="file" name="file" accept=".xlsx,.csv" required>',
              ),
            "Review file",
          ) +
            (imported.length
              ? "<p>" +
                imported.length +
                ' source rows</p><div class="list"><table><tr><th>Source</th><th>Sheet / row</th><th>Date</th><th>Date source</th><th>Original</th><th>Description</th><th>Type</th><th>Amount</th><th>Review status</th></tr>' +
                imported
                  .map(
                    (r) =>
                      "<tr>" +
                      [
                        importRole,
                        r.sheet ? r.sheet + "!" + r.cell : r.row,
                        r.date || "Pending",
                        r.yearOrigin || "Source date",
                        r.cached != null
                          ? r.raw +
                            " · Cache " +
                            (r.cached || "missing") +
                            (r.calculatedCent != null
                              ? " · Recalculated " + eur(r.calculatedCent)
                              : "") +
                            (r.differenceCent
                              ? " · Difference " + eur(r.differenceCent)
                              : "")
                          : (r.raw ??
                            (r.amount == null ? "Pending" : String(r.amount))),
                        r.label,
                        types[r.kind] || "Allocation pending",
                        eur(r.amount),
                        r.status,
                      ]
                        .map((v) => "<td>" + esc(v) + "</td>")
                        .join("") +
                      "</tr>",
                  )
                  .join("") +
                "</table></div>" +
                popupForm(
                  "importRow",
                  "Review import row",
                  select(
                    "ix",
                    "Individually reviewed row",
                    [["", "Select a source row"], ...imported.map((r, i) => [
                      i,
                      (r.sheet ? r.sheet + "!" + r.cell : r.row) +
                        " · " +
                        r.label,
                    ])],
                  ) +
                    select("kind", "Booking type", [
                      ["", "Select a booking type"],
                      ["income", "Income"],
                      ["expense", "Expense"],
                    ]) +
                    field("date", "Verified booking date", "date", true) +
                    field("account", "Account") +
                    field("reason", "Review note / decision", "text", true),
                  "Import reviewed row",
                )
              : ""),
        )
      : "")
  );
}
function reportRows() {
  const period = rows().find((r) => r.ID === chosenPeriod);
  return rows().filter(
    (r) =>
      !period ||
      (r.Data.Date >= period.Data.Date && r.Data.Date <= period.Data.To),
  );
}
function installStudio() {
  const options = document.querySelector("#export").closest("section");
  const editor = document.querySelector("#template")?.closest("section");
  const studio = document.createElement("div");
  studio.className = "document-studio";
  options.before(studio);
  const controls = document.createElement("div");
  controls.className = "doc-controls";
  controls.append(options);
  if (editor) controls.append(editor);
  studio.innerHTML =
    '<div class="proof-tabs"><button type="button" data-act="docInputs">Input</button><button type="button" data-act="docProof">Print preview</button></div>';
  studio.append(controls);
  const proof = document.createElement("section");
  proof.className = "proof";
  proof.innerHTML =
    '<h2>Print preview</h2><p id="proof-status">Select a profile and transaction to review the draft.</p><div id="proof-sheet"></div>' +
    button("docProof", "Refresh preview", true);
  studio.append(proof);
  document
    .querySelector("#export .actions")
    .insertAdjacentHTML(
      "beforeend",
      button("docProof", "Open print preview", true),
    );
}
let proofRevision = 0;
async function proofDocument(editing) {
  const revision = ++proofRevision;
  const studio = document.querySelector(".document-studio"),
    host = studio.querySelector("#proof-sheet"),
    status = studio.querySelector("#proof-status");
  studio.classList.add("view-proof");
  host.replaceChildren();
  status.textContent = "Preparing draft locally…";
  try {
    const vals = Object.fromEntries(
      new FormData(document.querySelector("#export")),
    );
    let source = s,
      index = Number(vals.profile);
    if (editing) {
      const form = Object.fromEntries(
          new FormData(document.querySelector("#template")),
        ),
        ref = form.Reference;
      index = profiles.findIndex((_, i) => profileID(i) === ref);
      const base =
        s.drafts?.[ref] ||
        (s.pinnedTemplates || s.entries).find((r) => r.ID === "template:" + ref)
          ?.Data ||
        {};
      source = {
        ...s,
        drafts: {
          ...s.drafts,
          [ref]: {
            ...base,
            Label: form.Label,
            Note: form.Note,
            Fields: {
              ...base.Fields,
              font: form.font,
              footer: form.footer,
              margin: form.margin,
              header: form.header,
              copies: form.copies,
              firstColumn: form.firstColumn,
              paper: form.paper,
            },
          },
        },
      };
      vals.version = "draft";
    }
    const snap = snapshot(index, source, rows(), { ...vals, number: null });
    const files = await renderDocument(snap);
    if (revision !== proofRevision || !host.isConnected) return;
    const previewHost = document.createElement("div");
    host.replaceChildren(previewHost);
    await displayProof(previewHost, files.docx);
    if (revision !== proofRevision || !previewHost.isConnected) return;
    status.textContent =
      profiles[index] +
      " · " +
      snap.width +
      " × " +
      snap.height +
      " mm · " +
      (vals.version === "draft" ? "Entwurf" : snap.templateVersionID) +
      " · Word draft";
  } catch (err) {
    if (revision !== proofRevision || !host.isConnected) return;
    status.textContent = err.message;
    throw err;
  }
}
async function openRecordDocument(trigger) {
  const id = trigger.dataset.recordDocument;
  let row = rows().find((r) => r.ID === id);
  if (row.Kind === "donation" && !s.donorAccess) {
    donorAccess = true;
    try {
      await sync();
    } catch (err) {
      donorAccess = false;
      throw err;
    }
    row = rows().find((r) => r.ID === id);
  }
  const i = { sponsorship: 0, payment: 11, donation: 12 }[row.Kind];
  const existing = rows()
    .filter(
      (r) =>
        r.Kind === "original" &&
        r.Data.Reference === id &&
        (r.Data.Fields?.series === "confirmation") === i >= 11,
    )
    .sort((a, b) => b.Data.Number - a.Data.Number)[0];
  if (existing) {
    const key = esc(existing.ID);
    openEditor(
      trigger,
      existing.Data.Label + " · No. " + existing.Data.Number,
      '<div class="actions">' +
        ["PDF", "DOCX"]
          .map(
            (ext) =>
              '<button type="button" data-file="' +
              key +
              '" data-format="' +
              ext +
              '">' +
              "Save " + ext + "</button>",
          )
          .join("") +
        (navigator.canShare?.({
          files: [new File([""], "Receipt.pdf", { type: "application/pdf" })],
        })
          ? '<button type="button" data-share-original="' +
            key +
            '">Share PDF</button>'
          : "") +
        "</div>",
    );
    return;
  }
  const hidden = (name, value) =>
    '<input type="hidden" name="' +
    name +
    '" value="' +
    esc(String(value)) +
    '">';
  const name = trigger.textContent;
  const content =
    "<p>" +
    esc(row.Data.Label) +
    " · " +
    esc(row.Data.Date) +
    " · <strong>" +
    eur(row.Data.Amount) +
    "</strong></p>";
  const inputs =
    hidden("subject", id) +
    hidden("profile", i) +
    hidden("version", "active") +
    hidden("format", writableWorkspace() ? "Original" : "PDF") +
    (i === 12 && !writableWorkspace() ? refs("recipient", "Recipient", ["contact"]) : "") +
    '<div class="document-preview" data-receipt-preview></div>';
  openEditor(
    trigger,
    name,
    content +
      form(
        "export",
        inputs,
        writableWorkspace() ? "Issue original" : "Save PDF preview",
      ),
  );
  const f = entryDialog.querySelector("form");
  f.dataset.event = s.event.ID;
  if (f.elements.recipient) f.elements.recipient.value = row.Data.Contact || "";
  const preview = () => {
    const vals = Object.fromEntries(new FormData(f)),
      snap = snapshot(i, s, rows(), vals);
    f.querySelector("[data-receipt-preview]").textContent = [
      ...(snap.tables?.address || []),
      snap.tables?.intro || snap.title,
    ].join(" · ");
  };
  f.addEventListener("change", preview);
  const proof = document.createElement("button");
  proof.type = "button";
  proof.textContent = "Print preview";
  const host = document.createElement("div");
  f.querySelector("[data-receipt-preview]").after(proof, host);
  proof.onclick = () =>
    action(async () => {
      const snap = snapshot(i, s, rows(), Object.fromEntries(new FormData(f)));
      host.replaceChildren();
      await displayProof(host, (await renderDocument(snap)).docx);
    });
  f.addEventListener("change", () => host.replaceChildren());
  preview();
}
async function libraryDialog(trigger) {
  const list = await api("template-library");
  const builtin = profiles.map((label, i) => ({
    id: "standard-" + i,
    label,
    profile: profileID(i),
    revision: 0,
    source: "BONFIRE",
  }));
  const releases = [...list, ...builtin],
    opts = releases.map((t) => [
      String(t.id),
      t.source +
        " · " +
        t.label +
        " · " +
        (t.revision ? "Version " + t.revision : "Standard"),
    ]);
  const content =
    select("release", "Template version", opts) +
    refs("subject", "Transaction for preview", [
      "sponsorship",
      "payment",
      "donation",
      "count",
      "plan",
    ]) +
    "<p>Destination · " +
    esc(s.event.Name) +
    '</p><div class="actions"><button type="button" data-preview-release>Print preview</button></div><div data-library-proof></div>';
  openEditor(
    trigger,
    "Template library",
    form("library", content, "Use template"),
  );
  const f = entryDialog.querySelector("form");
  const source = async () => {
    const t = releases.find((v) => String(v.id) === f.elements.release.value);
    const v = t.revision
      ? await api("template-library?id=" + encodeURIComponent(t.id))
      : { Reference: t.profile, Label: t.label, Fields: {} };
    return {
      ...v,
      Date: today(),
      Fields: {
        ...v.Fields,
        sourceRelease: String(t.id),
        sourceVersion: t.source + " · " + (t.revision || "Standard"),
      },
    };
  };
  f.librarySource = source;
  f.dataset.event = s.event.ID;
  f.querySelector("[data-preview-release]").onclick = () =>
    action(async () => {
      const v = await source(),
        i = profiles.findIndex((_, i) => profileID(i) === v.Reference);
      const snap = snapshot(i, { ...s, drafts: { [v.Reference]: v } }, rows(), {
        version: "draft",
        subject: f.elements.subject.value,
      });
      const host = f.querySelector("[data-library-proof]");
      host.replaceChildren();
      await displayProof(host, (await renderDocument(snap)).docx);
    });
}
function docs() {
  const originals = rows().filter((r) => r.Kind === "original");
  return (
    panel(
      "Create document",
      (!offlineEnabled && s.role === "Admin" && writableWorkspace()
        ? '<div class="actions">' +
          button("library", "Template library", true) +
          "</div>"
        : "") +
        form(
          "export",
          select(
            "profile",
            "Template",
            profiles.map((p, i) => [i, p]),
          ) +
            refs("subject", "Transaction (depending on template)", [
              "sponsorship",
              "payment",
              "donation",
              "count",
              "plan",
            ]) +
            refs("bar", "Bar (for the bar report)", ["bar"]) +
            refs("period", "Period (for journal and audit report)", [
              "period",
            ]) +
            select("guestCopies", "Guest price lists per sheet", [
              ["1", "Full page"],
              ["2", "Two copies"],
            ]) +
            select("paper", "Guest price list paper size", [
              ["Profil", "Use template settings"],
              ["Letter", "Letter · Source format"],
              ["A4", "A4 · Alternative version"],
            ]) +
            field(
              "organization",
              "Organization",
              "text",
              true,
              rows().find((r) => r.Kind === "organization")?.Data.Label || "",
            ) +
            ((s.priceHistory || []).length
              ? select("priceVersion", "Price version for cards and guest lists", [
                  ["", "Current approved prices"],
                  ...[
                    ...new Map(
                      s.priceHistory.map((p) => [p.Version, p]),
                    ).values(),
                  ]
                    .reverse()
                    .map((p) => [
                      String(p.Version),
                      p.At.slice(0, 19) + " · As of " + p.Version,
                    ]),
                ])
              : "") +
            select("version", "Template version", [
              ["active", "Approved version"],
              ["draft", offlineEnabled ? "Local draft" : "Session draft"],
            ]) +
            (writableWorkspace()
              ? field("revisionReason", "Reason for correction (replacement receipt)")
              : "") +
            select("format", "Expense", [
              ["PDF", "PDF draft"],
              ["DOCX", "DOCX draft"],
              ...(writableWorkspace()
                ? [
                    ["Original", "Archive numbered original"],
                    ["Korrektur", "Archive corrected version with reason"],
                  ]
                : []),
            ]),
          "Generate document",
        ),
    ) +
    panel(
      "Thank-you letter mail merge",
      form(
        "letters",
        rows()
          .filter((r) => r.Kind === "donation" && r.Data.Contact)
          .map((r) =>
            label(
              r.Data.Label,
              '<input type="checkbox" name="recipients" value="' +
                esc(r.ID) +
                '">',
            ),
          )
          .join(""),
        "Download selected letters as ZIP",
      ),
    ) +
    panel(
      "Archive",
      (offlineEnabled
        ? "<p>Available numbers on this device: "
        : "<p>Available receipt numbers: ") +
        availableNumbers(s) +
        "</p>" +
        originals
          .map(
            (r) =>
              '<p class="actions"><span>' +
              esc(r.Data.Label) +
              " · " +
              r.Data.Number +
              '</span><button data-file="' +
              esc(r.ID) +
              '" data-format="PDF">PDF</button><button data-file="' +
              esc(r.ID) +
              '" data-format="DOCX">DOCX</button></p>',
          )
          .join(""),
    ) +
    (writableWorkspace()
      ? panel(
          "Customize templates",
          button(
            "pinTemplates",
            offlineEnabled
              ? "Use the approved template version on this device"
              : "Refresh templates",
            true,
          ) +
            form(
              "template",
              select(
                "Reference",
                "Profile",
                profiles.map((p, i) => [profileID(i), p]),
              ) +
                field("Label", "Heading", "text", true) +
                label(
                  "Text snippet",
                  '<textarea name="Note">' +
                    esc(s.importedText || "") +
                    "</textarea>",
                ) +
                select("font", "Font preset", [
                  ["helvetica", "Sans Serif"],
                  ["times", "Serif"],
                  ["courier", "Monospace"],
                ]) +
                field("header", "Card heading (optional)") +
                field(
                  "copies",
                  "Cards per sheet (up to 3 drinks or 7 food items)",
                  "number",
                ) +
                field(
                  "firstColumn",
                  "First column width on cards in mm (40–75)",
                  "number",
                ) +
                select("paper", "Default paper size for guest price lists", [
                  ["Letter", "Letter"],
                  ["A4", "A4"],
                ]) +
                field("footer", "Footer") +
                field("margin", "Page margin in mm", "number", true, "15"),
              offlineEnabled
                ? "Save draft locally"
                : "Use draft for this session",
              (s.role === "Admin"
                ? '<button data-release="true">Approve version</button>'
                : "") + button("draftProof", "View changes", true),
            ) +
            form(
              "wordLayout",
              label(
                "Word layout for thank-you letters (A4, DOCX)",
                '<input type="file" name="file" accept=".docx" required>',
              ),
              "Use Word layout as draft letter",
            ) +
            (s.drafts?.[profileID(6)]?.File
              ? "<p>Word layout available in the draft</p>"
              : "") +
            form(
              "importTemplate",
              label(
                "DOCX text template",
                '<input type="file" name="file" accept=".docx" required>',
              ),
              "Use text and fields",
            ) +
            (s.role === "Admin"
              ? form(
                  "lfk",
                  label(
                    "LFK form as approved print background",
                    '<input type="file" name="file" accept=".pdf" required>',
                  ),
                  "Prepare A6 form",
                )
              : ""),
        )
      : "")
  );
}
function preparePanel() {
  return panel(
    "Prepare event",
    events.some((e) => !e.Closed)
      ? form(
          "prepare",
          select(
            "event",
            "Event",
            events.filter((e) => !e.Closed).map((e) => [e.ID, e.Name]),
          ) +
            field("name", "Device name", "text", true) +
            (onlineUser?.role === "Read"
              ? '<input name="digitalCount" type="hidden" value="0">'
              : field(
                  "digitalCount",
                  "Digital receipt numbers needed (0–1000)",
                  "number",
                  true,
                  "1000",
                )) +
            select("donor", "Reporting data on this device", [
              ["", "Standard profile"],
              ...(onlineUser?.role === "Admin"
                ? [["ja", "Receipt profile with sensitive data (admin)"]]
                : []),
            ]) +
            field(
              "pass",
              "Local password (at least 10 characters)",
              "password",
              true,
            ),
          "Save offline profile",
        )
      : "<p>No open event assigned.</p>",
  );
}
let years = [],
  allSpaces = [],
  selectedYear = "";
const legacyGroup = "unassigned";
const fiscalYear = () => years.find((y) => y.ID === selectedYear);
const defaultDay = (scope) =>
  !scope || (today() >= scope.Starts && today() <= scope.Ends)
    ? today()
    : scope.Starts;
function yearFields(y = {}) {
  return (
    field("Name", "Name", "text", true, y.Name) +
    field("Starts", "Start date", "date", true, y.Starts) +
    field("Ends", "End date", "date", true, y.Ends)
  );
}
function yearForm() {
  return popupForm(
    "fiscal-year",
    "Create fiscal year",
    yearFields(),
    "Save fiscal year",
  );
}
function yearSetup() {
  const old = allSpaces.filter((e) => !e.Year);
  return (
    pageHead(
      "Fiscal years",
      "Choose the fiscal year for your cashbook.",
      onlineUser.role === "Admin" ? yearForm() : "",
    ) +
    (years.length
      ? panel(
          "Open fiscal year",
          years
            .map(
              (y) =>
                '<div class="fiscal-year-row"><button type="button" class="secondary" data-year="' +
                esc(y.ID) +
                '">' +
                esc(y.Name) +
                "</button><span>" +
                dat(y.Starts) +
                " – " +
                dat(y.Ends) +
                "</span>" +
                (onlineUser.role === "Admin" && !y.Closed
                  ? '<button type="button" class="secondary" data-year-edit="' +
                    esc(y.ID) +
                    '" aria-haspopup="dialog" aria-label="Edit fiscal year ' +
                    esc(y.Name) +
                    '">Edit</button>'
                  : "") +
                "</div>",
            )
            .join(""),
        )
      : "") +
    (onlineUser.role !== "Admin" && !years.length
      ? "<p>You have no assigned workspaces in a fiscal year yet.</p>"
      : "") +
    (old.length
      ? panel(
          "Existing workspaces",
          '<div class="actions"><button type="button" class="secondary" data-year="unassigned">Open unassigned workspaces</button>' +
            (onlineUser.role === "Admin" && years.length
              ? popupForm(
                  "assign-year",
                  "Assign fiscal year",
                  select(
                    "Event",
                    "Workspace",
                    old.map((e) => [e.ID, e.Name]),
                  ) +
                    select(
                      "Year",
                      "Fiscal year",
                      years.map((y) => [y.ID, y.Name]),
                    ),
                  "Assign fiscal year",
                )
              : "") +
            "</div>",
        )
      : "")
  );
}
function eventFields(name, starts, ends) {
  return (
    field("Name", "Event name", "text", true, name) +
    field("Starts", "Start date", "date", true, starts) +
    field("Ends", "End date", "date", true, ends)
  );
}
function eventForm() {
  const year = fiscalYear(),
    day = defaultDay(year);
  return popupForm(
    "event",
    "Create event",
    eventFields("", day, day) +
      select("Accounts", "Account assignment", [
        ["", "Off"],
        ["ja", "On"],
      ]),
    "Save event",
  );
}
async function openEventCleanup(trigger, workspace, message = "") {
  const inventory = (id) =>
    api("events/entries?event=" + encodeURIComponent(id));
  const items = await inventory(workspace.ID);
  const cancel = button("cancel", "Cancel", true);
  const targets = events.filter(
    (e) =>
      workspace.Year &&
      e.Year === workspace.Year &&
      e.ID !== workspace.ID &&
      !e.Closed,
  );
  const choices = items.map((i) => [
    i.ID,
    [
      types[i.Kind] || i.Kind,
      i.Label,
      dat(i.Date),
      i.Amount == null ? "" : eur(i.Amount),
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  const fields = items.length
    ? select("Target", "Entry", choices) +
      select("Destination", "Action or destination", [
        ["", "Choose an option"],
        ["remove", "Remove entry or reverse booking"],
        ...targets.map((e) => [e.ID, "Move to " + e.Name]),
      ]) +
      '<div class="form cleanup-mapping" hidden></div>' +
      field("Reason", "Reason", "text", true)
    : "";
  const description = items.length
    ? items.length +
      (items.length === 1 ? " entry is" : " entries are") +
      " still assigned. Select an entry to move or remove."
    : "This event is empty. Delete it from the fiscal year?";
  openEditor(
    trigger,
    workspace.Name,
    (message ? '<p role="status">' + esc(message) + "</p>" : "") +
      "<p>" +
      esc(description) +
      "</p>" +
      form(
        "event-cleanup",
        fields,
        items.length ? "Choose an action" : "Delete event",
        cancel,
      ),
  );
  const editor = entryDialog.querySelector("form");
  const submitButton = editor.querySelector("button:not([type=button])");
  const mapping = editor.querySelector(".cleanup-mapping");
  let request = crypto.randomUUID();
  let selection = 0;
  if (items.length) {
    submitButton.disabled = true;
    editor.addEventListener("input", () => {
      request = crypto.randomUUID();
    });
    editor.addEventListener("change", async (event) => {
      if (!["Target", "Destination"].includes(event.target.name)) return;
      const serial = ++selection;
      const item = items.find((i) => i.ID === editor.elements.Target.value);
      const destinationSelect = editor.elements.Destination;
      for (const option of destinationSelect.options) {
        option.disabled =
          !!option.value &&
          !(option.value === "remove" ? item.Removable : item.Movable);
      }
      if (destinationSelect.selectedOptions[0]?.disabled)
        destinationSelect.value = "";
      const destination = destinationSelect.value;
      const removing = destination === "remove";
      const target = targets.find((e) => e.ID === destination);
      submitButton.disabled = true;
      submitButton.textContent = removing
        ? "Remove entry"
        : target
          ? "Move entry"
          : "Choose an action";
      mapping.replaceChildren();
      mapping.hidden = true;
      const alert = entryDialog.querySelector(".entry-error");
      alert.textContent = "";
      if (!item.Removable && !item.Movable) {
        alert.textContent =
          "This entry belongs to a protected transaction.";
        return;
      }
      if (!destination) return;
      if (target) {
        const moneyAccount = [
          "income",
          "expense",
          "refund",
          "deposit",
          "deposit-return",
          "donation",
          "presale",
          "transfer",
        ].includes(item.Kind);
        const required = [
          ["Bar", "Destination bar", ["bar"], item.Bar],
          ["Wallet", "Destination wallet", ["wallet"], item.Wallet],
          [
            "Account",
            "Destination account",
            ["wallet", "account"],
            item.Account || (target.Accounts && moneyAccount),
          ],
          [
            "To",
            "Destination counterparty account",
            ["wallet", "account"],
            item.Kind === "transfer",
          ],
        ].filter(([, , , needed]) => needed);
        if (required.length) {
          try {
            const rows = await inventory(destination);
            if (!editor.isConnected || serial !== selection) return;
            mapping.innerHTML = required
              .map(([key, title, kinds]) =>
                select(key, title, [
                  ["", "Choose an option"],
                  ...rows
                    .filter((r) => kinds.includes(r.Kind))
                    .map((r) => [r.ID, r.Label]),
                ]),
              )
              .join("");
            mapping.hidden = false;
            for (const input of mapping.querySelectorAll("select"))
              input.required = true;
          } catch (err) {
            if (editor.isConnected && serial === selection)
              alert.textContent = err.message;
            return;
          }
        }
      }
      submitButton.disabled = false;
    });
    editor.elements.Target.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
  }
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(async () => {
      const alert = entryDialog.querySelector(".entry-error");
      alert.replaceChildren();
      if (!items.length) {
        await api("events/delete", { Event: workspace.ID });
        allSpaces = await api("events");
        await selectFiscalWorkspace(
          selectedYear,
          preferredEvent === workspace.ID ? "" : preferredEvent,
        );
        page = "Veranstaltungsliste";
        show();
        closeEditor();
        notice.textContent = workspace.Name + " was deleted.";
        return;
      }
      const values = Object.fromEntries(new FormData(editor));
      const item = items.find((i) => i.ID === values.Target);
      const removing = values.Destination === "remove";
      if (!values.Destination) throw Error("Select an action or a destination.");
      await api("events/entries", {
        ...values,
        Event: workspace.ID,
        Revision: item.Revision,
        Action: removing ? "remove" : "move",
        Destination: removing ? "" : values.Destination,
        Request: request,
      });
      if ([workspace.ID, values.Destination].includes(preferredEvent)) {
        await sync();
        show();
      } else if (page === "Veranstaltungsliste") show();
      await openEventCleanup(
        trigger,
        workspace,
        item.Label + (removing ? " was removed." : " was moved."),
      );
    });
  });
}
function closingControls() {
  if (offlineEnabled || s.role !== "Admin") return "";
  const year = s.event.General && !!s.event.Year;
  if (!year && s.yearClosed) return "";
  const title = year
    ? "Fiscal year"
    : s.event.General
      ? "Cashbook"
      : "Event";
  const name = year ? fiscalYear().Name : s.event.Name;
  const closed = year ? s.yearClosed : s.closed;
  const verb = closed ? "Reopen" : "Close";
  const description = closed
    ? year
      ? "The general cashbook will be unlocked. Closed events can then be reopened individually."
      : "Reopening allows bookings and corrections again."
    : year
      ? "Close all events first. Confirming checks the general cashbook and locks the fiscal year for editing."
      : "The balances and settlement will be checked. Closing makes the workspace read-only.";
  return (
    (year
      ? '<button type="button" class="secondary" data-act="yearBalances">Account reconciliation</button>'
      : "") +
    popupForm(
      "scope-closure",
      verb + " " + title.toLowerCase(),
      "<p>" +
        esc(name) +
        " · " +
        esc(description) +
        "</p>" +
        (closed
          ? field("reason", "Reason for reopening", "text", true)
          : "") +
        '<input type="hidden" name="workspace" value="' +
        esc(s.event.ID) +
        '">' +
        '<input type="hidden" name="action" value="' +
        (closed
          ? year
            ? "year-reopen"
            : "reopen"
          : year
            ? "Geschäftsjahr abschließen"
            : "Abschluss") +
        '">',
      verb + " " + title.toLowerCase(),
    ) +
    (year && !closed && s.closed
      ? popupForm(
          "reopen",
          "Reopen cashbook",
          field("reason", "Reason for reopening", "text", true),
          "Reopen cashbook",
        )
      : "")
  );
}
function eventAdminButtons(event) {
  return onlineUser?.role === "Admin" && !event.Closed && !event.General
    ? '<button type="button" class="secondary" aria-haspopup="dialog" data-event-edit="' +
        esc(event.ID) +
        '">Edit</button><button type="button" class="secondary" aria-haspopup="dialog" data-event-cleanup="' +
        esc(event.ID) +
        '">Delete event …</button>'
    : "";
}
function eventListRow(e) {
  const book = !e.Closed && ["Admin", "Write"].includes(onlineUser.role);
  const date = dat(e.Starts) + (e.Ends === e.Starts ? "" : " – " + dat(e.Ends));
  const result = e.ReceiptsCents - e.PaidCents - e.OutstandingCents;
  const resultClass = result < 0 ? "deficit" : result > 0 ? "surplus" : "";
  return (
    '<li class="event-row"><div class="event-info"><button type="button" class="event-name" data-space="' +
    esc(e.ID) +
    '">' +
    esc(e.Name) +
    '</button><span class="event-date">' +
    icon("CalendarDays") +
    date +
    '</span></div><span class="event-status' +
    (e.Closed ? " is-closed" : "") +
    '">' +
    (e.Closed ? "Closed" : "Open for bookings") +
    '</span><div class="event-figures"><dl>' +
    "<div><dt>Income</dt><dd>" +
    eur(e.ReceiptsCents) +
    "</dd></div>" +
    "<div><dt>Expenses</dt><dd>" +
    eur(e.PaidCents) +
    "</dd></div>" +
    '<div><dt>Net result</dt><dd class="' +
    resultClass +
    '">' +
    eur(result) +
    "</dd></div></dl>" +
    (e.OutstandingCents
      ? "<small>Unreimbursed expenses: " + eur(e.OutstandingCents) + "</small>"
      : "") +
    '</div><div class="event-actions">' +
    (book
      ? '<button type="button" data-book-event="' +
        esc(e.ID) +
        '" aria-haspopup="dialog">' +
        icon("Plus") +
        "Record event transaction</button>"
      : "") +
    eventAdminButtons(e) +
    "</div></li>"
  );
}
async function showEventsOfYear() {
  const year = selectedYear;
  article.innerHTML =
    pageHead(
      "Events",
      fiscalYear()
        ? "Fiscal year " + fiscalYear().Name
        : "Existing workspaces",
      fiscalYear() && !fiscalYear().Closed && onlineUser.role === "Admin"
        ? eventForm()
        : "",
    ) +
    '<div class="event-list-host" aria-busy="true">Loading events…</div>';
  const host = article.querySelector(".event-list-host");
  try {
    const spaces = await api(
      "events?overview=1&year=" +
        encodeURIComponent(year === legacyGroup ? "" : year),
    );
    if (!host.isConnected) return;
    events = spaces;
    allSpaces = allSpaces
      .filter((e) => (e.Year || legacyGroup) !== year)
      .concat(spaces);
    const list = spaces.filter((e) => !e.General);
    host.innerHTML = list.length
      ? '<ul class="event-list" aria-label="Events in this fiscal year">' +
        list.map(eventListRow).join("") +
        "</ul>"
      : "<p>There are no events in this fiscal year yet.</p>";
  } catch (err) {
    if (host.isConnected) host.textContent = err.message;
  } finally {
    host.removeAttribute("aria-busy");
  }
}
function defaultLedger(spaces) {
  const ledgers = spaces.filter((e) => e.General);
  return ledgers.length === 1 ? ledgers[0] : null;
}
function workspaceLabel() {
  const label = s.event.General
    ? s.event.Name
    : "Event · " + s.event.Name;
  return (
    label +
    " · " +
    (fiscalYear()
      ? "Fiscal year " + fiscalYear().Name
      : "No fiscal year assigned")
  );
}
function isOnlineEventPage() {
  return (
    !offlineEnabled &&
    s &&
    !s.event.General &&
    onlineEventTabs.some(([key]) => key === page)
  );
}
async function selectFiscalWorkspace(yearID, eventID) {
  const spaces = yearID
    ? allSpaces.filter((e) =>
        yearID === legacyGroup ? !e.Year : e.Year === yearID,
      )
    : [];
  const chosen = eventID
    ? spaces.find((e) => e.ID === eventID)
    : defaultLedger(spaces);
  if (eventID && !chosen)
    throw Error("This workspace is unavailable in the selected fiscal year.");
  const out = chosen ? await workspaceRequest(chosen.ID, {}) : null;
  selectedYear = yearID;
  events = spaces;
  preferredEvent = chosen?.ID || "";
  s = out ? onlineSnapshot(out) : null;
  edit = null;
  filter = "";
  journalFilters = {};
  overviewPeriod = "";
  chosenPeriod = "";
  auditRows = [];
  donorReview = null;
  conflictFiles = null;
  globalRows = [];
  imported = [];
  importFile = null;
  syncDetail = "";
  try {
    sessionStorage.setItem("bonfire-selection-" + onlineUser.user, JSON.stringify([selectedYear]));
  } catch {
    // The current workspace also works when browser storage is disabled.
  }
}
function onlineAdmin() {
  return (
    (offlineEnabled && onlineUser?.role === "Admin"
      ? panel(
          "Create event",
          popupForm(
            "event",
            "Create event",
            select("General", "Workspace", [
              ["", "Event"],
              ["ja", "General cashbook outside an event"],
            ]) +
              field("Name", "Workspace name", "text", true) +
              field("Starts", "Start", "date", true, today()) +
              field("Ends", "End", "date", true, today()) +
              select("Accounts", "Account allocation", [
                ["", "Off"],
                ["ja", "On"],
              ]),
            "Save event",
          ),
        ) +
        panel(
          "Assign user",
          popupForm(
            "user",
            "Create user",
            field("Name", "Email address or username", "text", true) +
              field("Password", "Initial password", "password", true) +
              select("Role", "Role", [
                ["Write", "Write"],
                ["Read", "Read"],
              ]) +
              select(
                "Event",
                "Event",
                events.map((e) => [e.ID, e.Name]),
              ),
            "Create user",
          ),
        ) +
        panel(
          "Change access",
          popupForm(
            "access",
            "Change access",
            field("Name", "Existing user", "text", true) +
              select(
                "Event",
                "Event",
                events.map((e) => [e.ID, e.Name]),
              ) +
              select("Action", "Access", [
                ["grant", "Assign"],
                ["revoke", "Revoke"],
              ]) +
              field("Reason", "Reason", "text", true),
            "Save assignment",
          ),
        )
      : "") +
    panel(
      "Personal account",
      button("accountSecurity", "Open account and security", true),
    )
  );
}
function profileTools() {
  return panel(
    "Offline profiles on this device",
    '<div class="actions">' +
      button("newProfile", "New work profile", true) +
      profilesLocal
        .map(
          (k, i) =>
            ' <a href="/?profil=' +
            encodeURIComponent(k) +
            '">Profile ' +
            (i + 1) +
            "</a>",
        )
        .join("") +
      "</div>" +
      (!saved
        ? "<h3>View device backup</h3><p>Enter the previous local password to open the encrypted backup. It opens as a read-only snapshot.</p>" +
          form(
            "recoverProfile",
            label(
              "Encrypted device backup",
              '<input type="file" name="file" required>',
            ) + field("pass", "Previous local password", "password", true),
            "Open as read-only archive",
          )
        : ""),
  );
}
let loginChallenge = "",
  loginIdentity = "",
  useRecoveryCode = false,
  profileHelp = false;
function authSurface() {
  const brand = document.querySelector("#sidebar header").outerHTML;
  let title, content, secondary;
  if (profileHelp) {
    title = "Offline profiles and backups";
    content = profileTools();
    secondary = button("backLogin", "Back", true);
  } else if (saved) {
    title = "Unlock device";
    content = form(
      "unlock",
      label(
        "Local password",
        '<input type="password" name="pass" autocomplete="current-password" required>',
      ),
      "Unlock",
    );
    secondary =
      button("recover", "Save device backup", true) +
      button("profileHelp", "Other offline profiles", true);
  } else if (loginChallenge) {
    title = useRecoveryCode ? "Enter recovery code" : "Verify sign-in";
    content =
      '<p class="auth-hint">' +
      esc(loginIdentity) +
      "</p>" +
      form(
        "loginFactor",
        label(
          useRecoveryCode
            ? "Recovery code"
            : "Code from your authenticator app",
          '<input name="otp" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required ' +
            (useRecoveryCode
              ? 'maxlength="16"'
              : 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"') +
            ">",
        ),
        "Verify",
      );
    secondary =
      button(
        "changeFactor",
        useRecoveryCode
          ? "Use an authenticator code"
          : "Use a recovery code",
        true,
      ) + button("backLogin", "Back to sign-in", true);
  } else {
    title = "Sign in";
    content = form(
      "login",
      label(
        "Email or username",
        '<input name="user" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" value="' +
          esc(loginIdentity) +
          '" required>',
      ) +
        label(
          "Password",
          '<input name="pass" type="password" autocomplete="current-password" required>',
        ),
      "Sign in",
    );
    secondary =
      (supportsPasskeys()
        ? button("passkeyLogin", "Sign in with a passkey", true)
        : "") +
      (offlineEnabled
        ? button("profileHelp", "Offline profiles and backups", true)
        : "");
  }
  return (
    '<div class="auth-card">' +
    brand +
    '<div class="auth-body"><h1>' +
    title +
    "</h1>" +
    content +
    "</div>" +
    (secondary ? '<footer class="actions">' + secondary + "</footer>" : "") +
    "</div>"
  );
}
let overviewPeriod = "";
let onlineUser = null,
  onlineData = null,
  preferredEvent = "",
  destination = "Übersicht";
const pageDescriptions = {
  Journal: "Payments, receipts and corrections.",
  Kontakte: "People and companies for sponsorship and donations.",
  Spenden: "Donation receipts and reporting data in the selected workspace.",
  Dokumente: "Issue receipts, reprint originals and customize templates.",
  Perioden: "Reporting dates, observed balances and approval.",
  Verwaltung: "Manage the organization, fiscal years and access permissions.",
};
function pageHead(title, description = "", action = "") {
  return (
    '<div class="page-head"><div>' +
    heading(title) +
    (description ? "<p>" + esc(description) + "</p>" : "") +
    "</div>" +
    action +
    "</div>"
  );
}
function prepareView() {
  return (
    pageHead(
      "Prepare device",
      "For local recording, issuing receipts and working offline.",
    ) +
    preparePanel() +
    "<details><summary>Other profiles and recovery</summary>" +
    profileTools() +
    "</details>"
  );
}
async function onlineStart(user) {
  onlineUser = user;
  if (!offlineEnabled) {
    [years, allSpaces] = await Promise.all([api("years"), api("events")]);
    let lastYear;
    try {
      const preference = JSON.parse(sessionStorage.getItem("bonfire-selection-" + user.user));
      if (Array.isArray(preference)) [lastYear] = preference;
    } catch {
      // Fall back to the current fiscal year if the preference is unavailable.
    }
    const yearID =
      years.find((y) => y.ID === lastYear)?.ID ||
      (lastYear === legacyGroup && allSpaces.some((e) => !e.Year)
        ? legacyGroup
        : years.find((y) => y.Starts <= today() && y.Ends >= today())?.ID ||
          years[0]?.ID ||
          "");
    await selectFiscalWorkspace(yearID);
    logged = true;
    return;
  }
  events = await api("events");
  const day = today(),
    distance = (e) =>
      day < e.Starts
        ? Date.parse(e.Starts) - Date.parse(day)
        : day > e.Ends
          ? Date.parse(day) - Date.parse(e.Ends)
          : 0;
  const chosen =
    events.find((e) => e.ID === preferredEvent) ||
    [...events].sort(
      (a, b) =>
        Number(a.Closed) - Number(b.Closed) ||
        distance(a) - distance(b) ||
        a.Name.localeCompare(b.Name),
    )[0];
  onlineData = chosen
    ? await api("workplace?event=" + encodeURIComponent(chosen.ID))
    : null;
  preferredEvent = chosen?.ID || "";
  logged = true;
}
let serverReachable = null;
let healthRequest = 0;
function paintConnection() {
  const online = navigator.onLine && serverReachable;
  const status = !navigator.onLine
    ? "Offline"
    : serverReachable === null
      ? "Checking connection"
      : online
        ? "Server online"
        : "Server unavailable";
  const network = document.querySelector("#connection");
  network.innerHTML =
    icon(online ? "Laptop" : "WifiOff") +
    esc(status) +
    (s && offlineEnabled
      ? '<span class="connection-queue">' + s.ops.length + " pending</span>"
      : "");
}
async function checkConnection() {
  const request = ++healthRequest;
  if (document.hidden) return;
  let available = false;
  if (navigator.onLine) {
    try {
      const response = await fetch("/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(4500),
      });
      available = response.ok && (await response.json()) === "bereit";
    } catch {
      /* An unreachable server leaves the local profile usable. */
    }
  }
  if (request === healthRequest) {
    serverReachable = available;
    paintConnection();
  }
}
function shell() {
  const active = !!s || logged,
    who = s || onlineUser;
  const expanded =
    document.querySelector("#admin-navigation")?.open ||
    sectionOf(page) === "Verwaltung";
  nav.innerHTML = navigation(
    isOnlineEventPage() ? "Veranstaltungen" : page,
    who?.user,
    who?.role,
    active,
    logged && !offlineEnabled,
    expanded,
    logged,
  );
  const org = s
    ? rows().find((r) => r.Kind === "organization")?.Data
    : onlineData?.entries.find((r) => r.Kind === "organization")?.Data;
  document.querySelector("#crumb").textContent =
    (org?.Label || "Fire Brigade Finance") +
    "   /   " +
    (active
      ? page === "Einrichtung"
        ? "Prepare device"
        : canOpenConsole(page, who?.role)
          ? "Administration   /   " + titleOf(page)
          : titleOf(page)
      : saved
        ? "Unlock"
        : "Sign-in");
  const mark = document.querySelector("#station");
  mark.innerHTML =
    org?.File || org?.Logo
      ? '<img alt="" src="data:image/png;base64,' +
        esc(org.File || org.Logo) +
        '">'
      : icon("Landmark");
  const picker = document.querySelector("#workspace-picker");
  picker.innerHTML =
    logged && !s && events.length
      ? select(
          "workspace",
          "Workspace",
          events.map((e) => [e.ID, e.Name]),
        )
      : "";
  if (!offlineEnabled && logged) {
    picker.textContent =
      s &&
      ![
        "Veranstaltungsliste",
        "Geschäftsjahre",
        "Konto und Sicherheit",
      ].includes(page) &&
      !canOpenConsole(page, who?.role)
        ? workspaceLabel()
        : "";
  }
  document.querySelector("#sidebar-year").innerHTML =
    logged && !offlineEnabled
      ? fiscalPicker(
          years,
          selectedYear,
          allSpaces.some((e) => !e.Year),
        )
      : "";
  if (picker.querySelector("[name=workspace]"))
    picker.querySelector("[name=workspace]").value = preferredEvent;
  paintConnection();
  document.querySelector("#menu-toggle").innerHTML = icon("Menu");
  document.querySelector("#content").dataset.module = sectionOf(page);
}
function onlineView() {
  if (page === "Einrichtung") return prepareView();
  if (
    page === "Verwaltung" ||
    page === "Gerät & Sync" ||
    page === "Datenaustausch"
  )
    return (
      pageHead("Administration", pageDescriptions.Verwaltung) +
      route("Einrichtung", "Prepare device", "secondary", "Laptop") +
      onlineAdmin() +
      "<details><summary>Profiles and backups</summary>" +
      profileTools() +
      "</details>"
    );
  if (!onlineData)
    return (
      pageHead(
        "Your workspace",
        "No workspace has been assigned yet.",
      ) +
      (onlineUser.role === "Admin"
        ? route("Verwaltung", "Create workspace", "primary", "Plus")
        : "<p>An administrator can assign you an event or a cashbook.</p>")
    );
  const { event: e, entries: list, pending, conflicts } = onlineData;
  if (onOverview())
    return overview(
      e,
      list,
      pending,
      conflicts,
      false,
      page === "Veranstaltungen",
      onlineUser.role,
      overviewPeriod,
    );
  const isEvent = sectionOf(page) === "Veranstaltungen";
  const content =
    page === "Journal" || page === "Zahlungen"
      ? ledger(bookings(list))
      : page === "Dokumente"
        ? '<ul class="catalog">' +
          profiles
            .map((p) => "<li>" + icon("Files") + esc(p) + "</li>")
            .join("") +
          "</ul>"
        : moduleList(page, list);
  return (
    pageHead(
      isEvent ? e.Name : titleOf(page),
      pageDescriptions[page] || e.Name,
      e.Closed
        ? ""
        : route(
            "Einrichtung",
            onlineUser.role === "Read"
              ? "Prepare read-only profile"
              : "Prepare recording",
            "primary",
            "Laptop",
          ),
    ) +
    (isEvent ? tabs(offlineEnabled ? eventTabs : onlineEventTabs, page) : "") +
    panel(
      page === "Dokumente"
        ? "Template profiles"
        : isEvent
          ? eventTabs.find(([k]) => k === page)[1]
          : page === "Journal"
            ? "Bookings"
            : "Entries",
      content,
    )
  );
}
const adminViews = {
  Benutzer: mountUsers,
  Backup: mountBackup,
  "Audit-Log": mountAudit,
  Systemstatus: mountStatus,
};
let adminSearch = "",
  passwordTicket = "";
let accountCatalog,
  balanceItems = [];
let catalogWallets = [];

function openCatalogEditor(trigger) {
  const wallet = catalogWallets.find((item) => item.ID === trigger.dataset.catalogEdit);
  openEditor(trigger, wallet ? "Edit reusable wallet" : "Create reusable wallet",
    form("catalog-wallet",
      field("Name", "Wallet name", "text", true, wallet?.Name) +
      field("DefaultBar", "Usual bar (optional)", "text", false, wallet?.DefaultBar) +
      field("Note", "Note (optional)", "text", false, wallet?.Note) +
      floatFields(wallet) + (wallet ? select("Active", "Status",
        [["true", "Active"], ["false", "Retired"]], String(wallet.Active)) : ""),
      "Save wallet", button("cancel", "Cancel", true)));
  const editor = entryDialog.querySelector("form");
  if (wallet) {
    editor.dataset.id = wallet.ID;
    editor.dataset.revision = wallet.Revision;
  }
  updateFloatInput(editor);
}

async function openWalletPicker(trigger) {
  const event = s.event;
  const { wallets } = await api("wallet-catalog?event=" + encodeURIComponent(event.ID));
  const selectable = wallets.some((wallet) => wallet.Active && !wallet.Used);
  const fields = walletPicker(wallets) + '<div class="catalog-confirm"></div>';
  openEditor(trigger, "Add from wallet list",
    '<p class="booking-target">Event <strong>' + esc(event.Name) + '</strong></p>' +
    (selectable ? form("assign-wallets", fields, "Add selected wallets", button("cancel", "Cancel", true))
      : fields + '<div class="actions">' + route("Wallet list", "Open wallet list") + button("cancel", "Close", true) + "</div>"));
  if (selectable) entryDialog.querySelector("form").dataset.event = event.ID;
}
async function openBalances(trigger) {
  balanceItems = await api(
    "year-balances?year=" + encodeURIComponent(selectedYear),
  );
  openEditor(
    trigger,
    "Account reconciliation · " + fiscalYear().Name,
    balanceTable(balanceItems, s.yearClosed),
  );
}
function show() {
  document.body.classList.toggle("auth-screen", !s && !logged);
  notice.textContent = "";
  state.textContent = "";
  shell();
  if (passwordTicket) {
    article.innerHTML = '<div class="auth-card admin-console"></div>';
    mountPasswordChange(article.firstElementChild, passwordTicket, () => {
      passwordTicket = "";
      show();
    });
    return;
  }
  if (logged && page === "Konto und Sicherheit") {
    article.innerHTML = '<div class="admin-console personal-security"></div>';
    const host = article.firstElementChild;
    mountAccountSecurity(host, { api }).catch((err) => {
      if (host.isConnected) host.textContent = err.message;
    });
    return;
  }
  if (
    !offlineEnabled &&
    logged &&
    page === "Feuerwehrkonten" &&
    onlineUser.role === "Admin"
  ) {
    const host = document.createElement("div");
    article.replaceChildren(host);
    Promise.all([api("fire-accounts"), api("events")])
      .then(([catalog, spaces]) => {
        if (!host.isConnected) return;
        accountCatalog = catalog;
        allSpaces = spaces;
        host.innerHTML = fireDirectory(catalog, spaces, years);
      })
      .catch((e) => {
        if (host.isConnected) host.textContent = e.message;
      });
    return;
  }
  if (!offlineEnabled && logged && page === "Wallet list" && canOpenConsole(page, onlineUser.role)) {
    const host = document.createElement("div");
    article.replaceChildren(host);
    api("wallet-catalog").then(({ wallets }) => {
      if (!host.isConnected) return;
      catalogWallets = wallets;
      host.innerHTML = walletDirectory(wallets, onlineUser.role !== "Read");
    }).catch((err) => { if (host.isConnected) host.textContent = err.message; });
    return;
  }
  if (!offlineEnabled && logged && canOpenConsole(page, onlineUser.role)) {
    article.innerHTML = '<div class="admin-console" aria-live="polite"></div>';
    const host = article.firstElementChild;
    const search = adminSearch;
    adminSearch = "";
    Promise.resolve(
      adminViews[page](host, { api, identity: onlineUser, search }),
    ).catch((err) => {
      if (host.isConnected)
        notice.textContent =
          err.message || "Could not load administration.";
    });
    return;
  }
  if (!offlineEnabled && logged && !s && page === "Verwaltung") {
    article.innerHTML = pageHead("Organisation") + onlineAdmin();
    return;
  }
  if (!offlineEnabled && logged) {
    if (page === "Geschäftsjahre" || !selectedYear) {
      article.innerHTML = yearSetup();
      return;
    }
    if (
      page === "Veranstaltungsliste" ||
      (page === "Veranstaltungen" && !isOnlineEventPage()) ||
      (!s && page === "Übersicht")
    ) {
      showEventsOfYear();
      return;
    }
    if (!s) {
      const ledgers = events.filter((e) => e.General);
      article.innerHTML =
        pageHead(
          titleOf(page),
          ledgers.length
            ? "Select a cashbook."
            : "No general cashbook is available for this workspace.",
        ) +
        ledgers
          .map(
            (e) =>
              '<button type="button" class="secondary" data-space="' +
              esc(e.ID) +
              '">' +
              esc(e.Name) +
              "</button>",
          )
          .join(" ") +
        route("Veranstaltungsliste", "Open events");
      return;
    }
  }
  if (!s) {
    article.innerHTML = logged ? onlineView() : authSurface();
    const selector = article.querySelector("#prepare [name=event]");
    if (
      selector &&
      [...selector.options].some((o) => o.value === preferredEvent)
    )
      selector.value = preferredEvent;
    return;
  }
  state.textContent =
    s.event.Name +
    "   /   " +
    (s.closed
      ? "Closed"
      : s.sealed
        ? "Recording complete"
        : s.ending
          ? "Recording still open"
          : "Local working copy") +
    (s.synced
      ? " · Last sync " + new Date(s.synced).toLocaleString("en-GB")
      : " · First sync pending") +
    (s.conflicts.length ? " · " + s.conflicts.length + " Cases to resolve" : "") +
    "   ·   " +
    s.ops.length +
    " pending";
  if (!offlineEnabled)
    state.textContent = s.yearClosed
      ? "Fiscal year closed · Read only"
      : s.closed
        ? "Closed · Read only"
        : "";
  const isEvent = isOnlineEventPage() || sectionOf(page) === "Veranstaltungen",
    isAdmin = sectionOf(page) === "Verwaltung";
  article.innerHTML =
    page === "Übersicht" || page === "Veranstaltungen"
      ? overview(
          { ...s.event, Closed: s.closed },
          rows(),
          s.pending ?? 0,
          s.conflicts.length,
          true,
          page === "Veranstaltungen",
          s.role,
          overviewPeriod,
          !offlineEnabled,
          editableKinds().includes("opening"),
        ) +
        (!offlineEnabled && page === "Veranstaltungen"
          ? '<div class="actions">' +
            route(
              "Veranstaltungsliste",
              "All events in the fiscal year",
              "secondary",
              "CalendarDays",
            ) +
            eventAdminButtons(s.event) +
            (s.role === "Admin" ? copyForm() : "") +
            "</div>"
          : "")
      : pageHead(
          isEvent
            ? offlineEnabled
              ? s.event.Name
              : onlineEventTabs.find(([key]) => key === page)?.[1] ||
                s.event.Name
            : titleOf(page),
          isOnlineEventPage()
            ? s.event.Name
            : pageDescriptions[page] || s.event.Name,
          page !== "Geldtaschen" && editableKinds().length
            ? button("focusEntry", entryLabel(page))
            : "",
        ) +
        (isEvent
          ? tabs(offlineEnabled ? eventTabs : onlineEventTabs, page)
          : isAdmin
            ? tabs(
                offlineEnabled
                  ? adminTabs
                  : [
                      ["Verwaltung", "Organization"],
                      ["Prüfprotokoll", "Audit log"],
                      ["Datenaustausch", "Data exchange"],
                    ],
                page,
              )
            : "") +
        (page === "Geldtaschen" && writableWorkspace() ? walletActions() : "") +
        (page === "Datenaustausch"
          ? exchange()
          : page === "Dokumente"
            ? docs()
            : page === "Gerät & Sync" || page === "Prüfprotokoll"
              ? devicePage()
              : records()) +
        (page === "Verwaltung"
          ? !offlineEnabled
            ? onlineAdmin()
            : panel(
                "Other workspaces",
                button("newProfile", "Open another workspace", true),
              )
          : "") +
        (page === "Spenden"
          ? donationPanel()
          : !offlineEnabled &&
              page === "Zahlungen" &&
              rows().some((r) => r.Kind === "donation") &&
              s.role === "Admin"
            ? "<details><summary>Donation reporting data</summary>" +
              donationPanel() +
              "</details>"
            : "") +
        (page === "Preise"
          ? route(
              "Dokumente",
              "Print price list and cards",
              "secondary",
              "Files",
            )
          : "");
  if (!offlineEnabled && (onOverview() || page === "Perioden"))
    article
      .querySelector(".page-head")
      ?.insertAdjacentHTML("beforeend", closingControls());
  if (page === "Dokumente") installStudio();
  const periodSelect = article.querySelector("[name=reportPeriod]");
  if (periodSelect) periodSelect.value = chosenPeriod;
}

function fillRecord(f) {
  for (const [k, v] of Object.entries(edit.Data)) {
    if (f.elements.namedItem(k)) f.elements.namedItem(k).value = v ?? "";
    if (k === "Amount" && f.elements.amount)
      f.elements.amount.value =
        v == null
          ? ""
          : Math.floor(v / 100) + "," + String(v % 100).padStart(2, "0");
    if (k === "Lines" && f.elements.positions)
      f.elements.positions.value = (v || [])
        .map(
          (l) =>
            l.QuantityMilli / 1000 +
            " | " +
            l.Description +
            " | " +
            (l.UnitCents / 100).toFixed(2),
        )
        .join("\n");
    if (k === "Allocations")
      for (const [src, n] of Object.entries(v || {})) {
        if (f.elements["alloc_" + src])
          f.elements["alloc_" + src].value = (n / 100).toFixed(2);
      }
    if (k === "Fields")
      for (const [name, value] of Object.entries(v || {})) {
        if (f.elements["field_" + name])
          f.elements["field_" + name].value = value;
      }
    if (k === "Pieces")
      for (const [coin, n] of Object.entries(v || {}))
        if (f.elements["coin" + coin]) f.elements["coin" + coin].value = n;
  }
  if (f?.elements.Note) f.elements.Note.value = "";
  if (f.querySelector("#count-total")) updateCount(f);
}
let backgroundSync;
async function action(fn) {
  if (backgroundSync) await backgroundSync;
  if (busy) return;
  busy = true;
  article.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (e) {
    const message = e.message || "Operation failed.";
    if (entryDialog.open) {
      const alert = entryDialog.querySelector(".entry-error");
      alert.textContent = message;
      if (
        entryDialog.querySelector("#record") &&
        s &&
        unconfirmedWrites.has(s.event.ID)
      )
        alert.insertAdjacentHTML(
          "beforeend",
          button("sync", "Refresh entries", true),
        );
      alert.scrollIntoView({ block: "nearest" });
    } else notice.textContent = message;
  } finally {
    article.setAttribute("aria-busy", "false");
    busy = false;
  }
}
async function submit(f) {
  const vals = Object.fromEntries(new FormData(f));
  const id = f.id;
  if (id === "catalog-wallet") {
    await api("wallet-catalog", {
      Action: f.dataset.id ? "edit" : "create", ID: f.dataset.id || "",
      Revision: Number(f.dataset.revision || 0), Name: vals.Name.trim(),
      DefaultBar: vals.DefaultBar.trim(), Note: vals.Note.trim(),
      Active: vals.Active !== "false", ...suggestedFloat(f),
    });
  }
  if (id === "bulk-wallets") {
    canWrite();
    if (offlineEnabled || s.event.General || page !== "Geldtaschen" || s.event.ID !== f.dataset.event)
      throw Error("Reopen this dialog in the original event.");
    const close = await submitWalletBatch(f, api, async () => {
      await sync();
      return rows();
    });
    if (close === false) return false;
    show();
    return;
  }
  if (id === "assign-wallets") {
    canWrite();
    if (s.event.ID !== f.dataset.event || s.event.General) throw Error("Reopen the event wallet list.");
    const IDs = new FormData(f).getAll("wallet");
    if (!IDs.length) throw Error("Choose at least one wallet.");
    const selection = JSON.stringify(IDs);
    const result = await api("wallet-catalog", { Action: "assign", Event: f.dataset.event, IDs,
      ConfirmOverlap: selection === f.dataset.overlapSelection && !!f.elements.confirmOverlap?.checked });
    if (result.overlaps?.length) {
      f.dataset.overlapSelection = selection;
      f.querySelector(".catalog-confirm").innerHTML = '<label><input type="checkbox" name="confirmOverlap"> Add these wallets despite the date overlap</label>';
      throw Error("Already allocated to another event on these dates: " + result.overlaps.map((w) => w.Name).join(", ") + ".");
    }
    await sync();
  }
  if (id === "fire-master" || id === "fire-link" || id === "fire-count") {
    const body = { ...vals };
    if (id === "fire-master") {
      body.Active = vals.Active !== "false";
      body.Revision = Number(f.dataset.revision || 0);
      body.ID = f.dataset.master;
      body.Action = body.ID ? "edit" : "create";
    }
    if (id === "fire-link") {
      body.Action = "link";
      body.ID = f.dataset.master;
    }
    if (id === "fire-count") {
      Object.assign(body, {
        Year: selectedYear,
        ID: f.dataset.master,
        Action: vals.Action,
        Revision: Number(f.dataset.revision),
        Opening: vals.Opening ? cents(vals.Opening) : null,
        Actual: vals.Actual ? cents(vals.Actual) : null,
      });
    }
    await api("fire-accounts", body);
  }
  if (id === "pooled-settlement") {
    canWrite();
    if (f.dataset.event !== s.event.ID)
      throw Error("Reopen event.");
    const amount = pooledRevenue(rows()),
      end = poolCount(rows(), "Ende");
    if (amount == null || amount < 0 || amount !== Number(f.dataset.amount))
      throw Error("The count changed. Reopen settlement.");
    if (s.event.Accounts && !vals.Account)
      throw Error("Select a posting account.");
    const previous = rows().find((r) => r.ID === "settlement-total");
    await queue(
      "income",
      {
        Label: "Cash settlement for all wallets",
        Amount: amount,
        Date: previous?.Data.Date || end.Data.Date,
        Account: vals.Account || "",
        Method: "Bar",
        Reference: "wallet-settlement-total",
        Note: vals.reason || "",
      },
      "settlement-total",
      previous?.Revision || 0,
    );
  }
  if (id === "conflictFile") {
    const out = await api(
      "manage",
      { Action: "conflict-file", Target: vals.operation },
      bearer(),
    );
    download(
      from64(
        out[vals.format],
        vals.format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      "Conflicting-version-" +
        out.number +
        "-" +
        vals.operation +
        "." +
        vals.format,
    );
  }
  if (id === "donorLoad") {
    await sync();
    const period = vals.period.trim();
    const preview = await donorRequest({ Action: "Vorschau", Period: period });
    const history = await donorRequest({ Action: "Verlauf", Period: period });
    donorReview = {
      device: s.device,
      period,
      preview,
      history,
      report: crypto.randomUUID(),
    };
  }
  if (id === "donorDecision" || id === "donorDownload") {
    if (donorReview?.device !== s.device || !s.donorAccess)
      throw Error("Reload review status.");
    const { period, preview, report, history } = donorReview;
    if (id === "donorDecision") {
      const key = JSON.stringify([
        period,
        report,
        history.at(-1)?.id,
        vals.step,
        vals.reason,
      ]);
      if (donorReview.pending?.key !== key)
        donorReview.pending = { key, id: crypto.randomUUID() };
      await donorRequest({
        Action: vals.step,
        Period: period,
        Report: vals.step === "Geprüft" ? report : history.at(-1)?.id,
        Digest: preview.sha256,
        Reason: vals.reason,
        Request: donorReview.pending.id,
      });
      donorReview.history = await donorRequest({
        Action: "Verlauf",
        Period: period,
      });
      donorReview.report = crypto.randomUUID();
    } else {
      const file = await donorRequest({
        Action: "Datei",
        Period: period,
        Report: vals.report,
      });
      const bytes = new TextEncoder().encode(file.datei);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== file.sha256)
        throw Error("Export file checksum mismatch.");
      download(
        new Blob([bytes], { type: "application/json" }),
        "Donation-export-" + vals.report + ".json",
      );
    }
  }
  if (id === "login" || id === "loginFactor") {
    const headers = { "X-Bonfire-Login": "staged" };
    if (id === "login") {
      loginIdentity = vals.user.trim();
      const bytes = new TextEncoder().encode(loginIdentity + ":" + vals.pass);
      headers.Authorization = "Basic " + btoa(String.fromCharCode(...bytes));
    } else {
      headers.Authorization = "Bonfire-Challenge " + loginChallenge;
      headers["X-Bonfire-OTP"] = vals.otp.trim();
    }
    const res = await fetch("/api/login", {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      if (res.status === 410) {
        loginChallenge = "";
        useRecoveryCode = false;
        show();
        article.querySelector("[name=pass]")?.focus();
      } else if (id === "loginFactor") {
        f.elements.otp.select();
      }
      throw Error(await res.text());
    }
    const result = await res.json();
    if (result.challenge) {
      loginChallenge = result.challenge;
      useRecoveryCode = false;
      show();
      article.querySelector("[name=otp]").focus();
      return;
    }
    loginChallenge = "";
    if (result.passwordChange) {
      passwordTicket = result.passwordChange;
      show();
      return;
    }
    await onlineStart(await api("workplace"));
    page = destination;
  }

  if (id === "fiscal-year" || id === "assign-year") {
    const created = await api(
      id === "fiscal-year" ? "years" : "years/assign",
      vals,
    );
    [years, allSpaces] = await Promise.all([api("years"), api("events")]);
    donorAccess = false;
    await selectFiscalWorkspace(
      id === "fiscal-year" ? created.ID : vals.Year,
      vals.Event,
    );
    page = s && !s.event.General ? "Veranstaltungen" : "Übersicht";
  }
  if (id === "event-edit" || id === "year-edit") {
    const previous = Object.fromEntries(
      Object.keys(vals).map((key) => [
        key,
        f.elements.namedItem(key).defaultValue,
      ]),
    );
    const yearEdit = id === "year-edit";
    await api(yearEdit ? "years/edit" : "events/edit", {
      ...(yearEdit ? { Year: f.dataset.year } : { Event: f.dataset.event }),
      Previous: previous,
      Updated: vals,
    });
    if (yearEdit) {
      [years, allSpaces] = await Promise.all([api("years"), api("events")]);
    } else if (s?.event.ID === f.dataset.event) await sync();
  }
  if (id === "event") {
    const created = await api("events", {
      ...vals,
      Accounts: !!vals.Accounts,
      General: !!vals.General,
      ...(!offlineEnabled ? { Year: selectedYear } : {}),
    });
    if (offlineEnabled) {
      preferredEvent = created.ID;
      await onlineStart(onlineUser);
      page = "Einrichtung";
    } else {
      allSpaces = await api("events");
      await selectFiscalWorkspace(selectedYear, created.ID);
      page = "Veranstaltungen";
    }
  }
  if (id === "user") {
    await api("users", vals);
  }
  if (id === "access") {
    await api("access", vals);
  }
  if (id === "prepare") {
    if (vals.pass.length < 10) throw Error("Local password is too short.");
    if (!sw) throw Error("A service worker and a secure context are required.");
    await sw;
    await navigator.storage.persist?.();
    const p = await api("prepare", {
      Event: vals.event,
      Name: vals.name,
      Donor: !!vals.donor,
      DigitalCount: Number(vals.digitalCount),
    });
    const next = {
      ...p,
      nextNumber: p.first,
      seq: 0,
      last: 0,
      entries: [],
      conflicts: [],
      ops: [],
    };
    await createVault(vals.pass, next);
    s = next;
    page = destination === "Einrichtung" ? "Übersicht" : destination;
    logged = false;
    onlineUser = null;
    onlineData = null;
    events = [];
    saved = true;
    auth = "";
    await api("logout", {});
    await sync();
  }
  if (id === "unlock") {
    s = await unlock(vals.pass);
    page = destination;
    setTimeout(tryAutoSync, 500);
  }
  if (id === "recoverProfile") {
    const restored = await recoverReadOnly(vals.file, vals.pass);
    await createVault(vals.pass, restored);
    s = restored;
    saved = true;
  }
  if (id === "renew") {
    const credentials =
      "Basic " +
      btoa(
        String.fromCharCode(
          ...new TextEncoder().encode(s.user + ":" + vals.password),
        ),
      );
    if (!s.nextToken) await commit({ ...s, nextToken: crypto.randomUUID() });
    const res = await fetch("/api/renew", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: credentials,
        "X-Bonfire-OTP": vals.otp,
      },
      body: JSON.stringify({
        Device: s.device,
        Proof: s.token,
        Next: s.nextToken,
      }),
    });
    if (!res.ok) throw Error(await res.text());
    await commit({
      ...s,
      expires: await res.json(),
      token: s.nextToken,
      nextToken: null,
    });
    await sync();
  }
  if (id === "periodAction") {
    await api(
      "manage",
      { Action: vals.action, Target: vals.id, Reason: vals.reason },
      bearer(),
    );
    await sync();
  }
  if (["incident", "incomplete", "returnDevice"].includes(id)) {
    await api(
      "manage",
      {
        Action: id === "returnDevice" ? "return" : id,
        Target: vals.device,
        Reason: vals.reason,
      },
      bearer(),
    );
    await sync();
  }
  if (id === "carry") {
    const period = rows().find((r) => r.ID === vals.period);
    if (!period) throw Error("Select a destination period.");
    const prior = await api(
      "manage",
      { Action: "prior", Target: period.Data.Date },
      bearer(),
    );
    for (const [account, amount] of Object.entries(prior.Actuals)) {
      const target = await countID("opening", period.ID, account);
      const old = rows().find((r) => r.ID === target);
      if (
        old &&
        old.Data.Fields?.previous === prior.ID &&
        old.Data.Amount === amount
      )
        continue;
      if (old && !old.Data.Fields?.previous)
        throw Error("Resolve the existing manual opening balance first.");
      if (old && vals.reason.trim().length < 5)
        throw Error("Enter a reason for replacing the previous carry-forward.");
      await queue(
        "opening",
        {
          Label: "Carry-forward from closing balance " + prior.End,
          Date: period.Data.Date,
          Amount: amount,
          Account: account,
          Fields: { previous: prior.ID },
          Note: old ? vals.reason : "",
        },
        target,
        old?.Revision || 0,
      );
    }
  }
  if (id === "year-carry") {
    if (entryDialog.dataset.recordWorkspace !== s?.event.ID)
      throw Error("Reopen the workspace.");
    const accountMap = Object.fromEntries(
      Object.entries(vals)
        .filter(([k]) => k.startsWith("account:"))
        .map(([k, v]) => [k.slice(8), v]),
    );
    await api("manage", {
      Action: "year-carry",
      Target: vals.source,
      Stamp: vals.stamp,
      AccountMap: accountMap,
    });
    await sync();
  }
  if (id === "globalPeriod") {
    globalRows = await api(
      "manage",
      { Action: vals.scope, Target: vals.start, Reason: vals.end },
      bearer(),
    );
  }
  if (id === "copy") {
    const copied = await api(
      "manage",
      {
        Action: "copy",
        Target: vals.name,
        Start: vals.start,
        End: vals.end,
        Year: vals.year || "",
        CopyKinds: Object.keys(vals)
          .filter((k) => k.startsWith("copy_"))
          .map((k) => k.slice(5)),
      },
      bearer(),
    );
    if (!offlineEnabled) {
      allSpaces = await api("events");
      const target = allSpaces.find((e) => e.ID === copied);
      if (target) {
        await selectFiscalWorkspace(target.Year, target.ID);
        page = "Veranstaltungen";
      }
    }
    syncDetail = "Event copy created.";
  }
  if (id === "reopen") {
    await api("manage", { Action: "reopen", Reason: vals.reason }, bearer());
    await sync();
  }
  if (id === "scope-closure") {
    if (vals.workspace !== s.event.ID)
      throw Error("Reopen the workspace.");
    if (["reopen", "year-reopen"].includes(vals.action)) {
      await api(
        "manage",
        { Action: vals.action, Reason: vals.reason },
        bearer(),
      );
      await sync();
    } else {
      await sync({ Action: vals.action });
    }
    [years, allSpaces] = await Promise.all([api("years"), api("events")]);
    events = allSpaces.filter((e) => (e.Year || legacyGroup) === selectedYear);
  }
  if (id === "handover") {
    const wallet = rows().find((r) => r.ID === vals.wallet),
      target = "handover:" + vals.wallet,
      prev = rows().find((r) => r.ID === target);
    if (!wallet) throw Error("Select wallet.");
    if (
      vals.status === "Angeboten" &&
      (vals.to === s.device || prev?.Data.Status === "Angeboten")
    )
      throw Error(
        "Select another receiving device and confirm any pending handover first.",
      );
    if (
      vals.status === "Bestätigt" &&
      (vals.to !== s.device ||
        prev?.Data.To !== s.device ||
        prev.Data.Status !== "Angeboten")
    )
      throw Error("No matching handover to this device.");
    await queue(
      "handover",
      {
        Date: today(),
        Label: wallet.Data.Label,
        Wallet: vals.wallet,
        To: vals.to,
        Status: vals.status,
        Note: "Handover " + financialLabel(vals.status),
      },
      target,
      prev?.Revision || 0,
    );
  }
  if (id === "preview") {
    const result = vals.sourceRole === "Journal"
      ? await preview(vals.file, rows())
      : await historyPreview(vals.file, vals.sourceRole, vals.year);
    imported = result;
    importFile = vals.file;
    importRole = vals.sourceRole;
  }
  if (id === "dispatch") {
    const target = "dispatch:" + vals.original,
      existing = rows().find((r) => r.ID === target);
    if (
      s.role !== "Admin" ||
      vals.evidence.trim().length < 3 ||
      (!existing && vals.delivery === "Vermerk aufgehoben")
    )
      throw Error("Enter a valid handover status and supporting evidence using an administrator account.");
    const original = rows().find(
      (r) => r.ID === vals.original && r.Kind === "original",
    );
    if (!original) throw Error("Select an issued receipt.");
    await queue(
      "dispatch",
      {
        Date: today(),
        Label: "Receipt " + original.Data.Number,
        Reference: original.ID,
        Status: vals.delivery,
        Note: vals.evidence,
      },
      target,
      existing?.Revision || 0,
    );
  }
  if (id === "importRow") {
    if (s.role !== "Admin")
      throw Error("An administrator must approve the import.");
    if (vals.ix === "" || !["income", "expense"].includes(vals.kind))
      throw Error("Select a source row and verify its booking type.");
    const r = imported[Number(vals.ix)];
    if (!r || r.blocked || r.amount == null || importRole === "D8")
      throw Error("This source row is blocked from posting.");
    if (s.event.Accounts && !vals.account)
      throw Error("Account allocation required.");
    const source = "source:" + r.source,
      target = "import:" + r.source + ":" + (r.key || r.row);
    if (rows().some((x) => x.ID === target))
      throw Error("This source item was already imported.");
    if (!rows().some((x) => x.ID === source))
      await queue(
        "import-source",
        {
          Label: "Verified import source",
          Date: today(),
          Reference: r.source,
          Filename: importFile.name,
          File: await b64(importFile),
          Status: importRole,
        },
        source,
      );
    await queue(
      vals.kind,
      {
        Label: r.label,
        Date: vals.date,
        Amount: r.amount,
        Account: vals.account,
        Reference: source,
        Note: vals.reason,
        Fields: {
          cell: r.cell || String(r.row),
          sheet: r.sheet || "Journal",
          original: r.raw ?? String(r.amount),
          sourceColumn: r.column || "",
          dateOrigin: r.yearOrigin || "Source date",
        },
      },
      target,
    );
    r.status = "Imported";
  }
  if (id === "letters") {
    const selected = new FormData(f).getAll("recipients");
    if (!selected.length)
      throw Error("Select at least one linked donation.");
    const files = {};
    for (const subject of selected) {
      const snap = snapshot(6, s, rows(), { subject });
      const { pdf, docx } = await renderDocument(snap);
      files[subject + ".pdf"] = new Uint8Array(await pdf.arrayBuffer());
      files[subject + ".docx"] = new Uint8Array(await docx.arrayBuffer());
    }
    download(
      new Blob([zipSync(files)], { type: "application/zip" }),
      "Thank-you-letters.zip",
    );
  }
  if (id === "filter") {
    if (vals.from && vals.until && vals.from > vals.until)
      throw Error("Check the date range.");
    filter = vals.filter;
    if (isBookingList()) journalFilters = vals;
  }
  if (id === "record") {
    if (
      !offlineEnabled &&
      (!s ||
        entryDialog.dataset.recordWorkspace !== s.event.ID ||
        (page === "Journal" && !s.event.General) ||
        (page === "Zahlungen" && s.event.General))
    )
      throw Error(
        "The booking destination changed. Close this form and reopen it in the intended workspace.",
      );
    const d = { ...vals };
    if (kind === "cashback") d.Account = d.Wallet;
    if (kind === "contact") {
      const address = [
        vals.field_street?.trim(),
        [vals.field_zip?.trim(), vals.field_town?.trim()]
          .filter(Boolean)
          .join(" "),
      ].filter(Boolean);
      if (address.length) d.Address = address.join("\n");
    }
    if (edit?.Data.Contact && !("Contact" in vals))
      d.Contact = edit.Data.Contact;
    if (kind === "supply") {
      const wallet = rows().find(
        (r) => r.Kind === "wallet" && r.ID === d.Wallet,
      );
      if (!wallet) throw Error("Select a receiving wallet.");
      if (d.sourceWallet) {
        if (d.sourceWallet === wallet.ID)
          throw Error("Select two different wallets.");
        d.Account = d.sourceWallet;
      }
      delete d.sourceWallet;
      d.To = wallet.ID;
    }
    if (kind === "skim" || kind === "return") d.Account = d.Wallet;
    delete d.amount;
    delete d.file;
    if (
      kind === "contact" &&
      !edit &&
      rows().some(
        (r) =>
          r.Kind === "contact" &&
          r.Data.Label.trim().toLocaleLowerCase("de") ===
            d.Label.trim().toLocaleLowerCase("de"),
      ) &&
      !d.field_distinct?.trim()
    )
      throw Error(
        "A contact with this name exists. Select it or enter a distinguishing detail for the new person or company.",
      );
    if (monetary.has(kind) && kind !== "supply") d.Amount = cents(vals.amount);
    if (kind === "organization") {
      if (vals.logo?.size) {
        if (vals.logo.type !== "image/png" || vals.logo.size > 300000)
          throw Error("Choose a PNG logo of up to 300 kB.");
        d.File = await b64(vals.logo);
      } else d.File = edit?.Data.File || "";
      delete d.logo;
    }
    if (kind === "attachment") {
      if (!vals.file.size || vals.file.size > 4194304)
        throw Error("Maximum file size is 4 MiB.");
      const bytes = new Uint8Array(await vals.file.arrayBuffer());
      const signature = [...bytes.slice(0, 8)];
      if (
        ![
          [37, 80, 68, 70, 45],
          [255, 216, 255],
          [137, 80, 78, 71, 13, 10, 26, 10],
        ].some((m) => m.every((n, i) => signature[i] === n))
      )
        throw Error("Select a PDF, JPEG or PNG file.");
      d.Fields = {
        ...d.Fields,
        sha256: Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (x) => x.toString(16).padStart(2, "0"),
        ).join(""),
        size: String(bytes.length),
      };
      d.File = await b64(vals.file);
      d.Filename = vals.file.name;
    }
    if (d.positions) {
      d.Lines = positions(d.positions);
      if (d.Lines.reduce((sum, l) => sum + lineCents(l), 0) !== d.Amount)
        throw Error("Line items must add up to the total.");
    }
    delete d.positions;
    if (kind === "presale") {
      const qty = Number(d.field_saleQuantity),
        unit = cents(d.unitSale);
      if (
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        qty > 1000000 ||
        qty * unit !== d.Amount
      )
        throw Error(
          "Advance ticket quantity times unit price must match the proceeds.",
        );
      d.field_unitCents = String(unit);
      delete d.unitSale;
    }
    for (const k of Object.keys(d)) {
      if (k.startsWith("alloc_")) {
        if (d[k]) (d.Allocations ??= {})[k.slice(5)] = cents(d[k]);
        delete d[k];
      }
      if (k.startsWith("field_")) {
        (d.Fields ??= {})[k.slice(6)] = d[k];
        delete d[k];
      }
    }
    let target = kind === "organization" ? "organization" : edit?.ID;
    if (!edit && kind === "opening" && onOverview())
      target = await countID(
        "opening",
        d.Date,
        s.event.Accounts ? d.Account : "",
      );
    if (kind === "paper") {
      d.Number = Number(d.Number);
      target = "paper:" + d.Number;
      if (
        !Number.isInteger(d.Number) ||
        d.Number < s.first ||
        d.Number > (s.paperLimit ?? s.limit) ||
        rows().some((r) => r.ID === target)
      )
        throw Error(
          "The paper receipt number is outside the reserved range or is already registered.",
        );
      if (
        d.Status === "Verworfen"
          ? d.Reference || (d.Note || "").trim().length < 3
          : rows().find((r) => r.ID === d.Reference)?.Data.Method !== "Bar"
      )
        throw Error("Select the cash payment or explain why the number was voided.");
    }
    if (
      kind === "price" &&
      d.Status === "Freigegeben" &&
      (!d.Unit?.trim() || !d.Category)
    )
      throw Error("Confirm the unit and product range before approval.");
    if (kind === "cashback" && !d.Fields?.provider?.trim())
      throw Error("Specify the terminal.");
    if (kind === "organization" && s.role !== "Admin")
      throw Error("Administrator access required.");
    if (kind === "count" && d.Status === "Bestätigt")
      d.Fields = {
        ...d.Fields,
        confirmedBy: s.user,
        confirmedAt: new Date().toISOString(),
      };
    if (["plan", "count", "reserve", "supply"].includes(kind)) {
      if (d.Fields?.countMode === "amount") d.Amount = cents(vals.amount);
      else {
        d.Pieces = {};
        for (const n of denom) {
          d.Pieces[n] = Number(d["coin" + n]);
          delete d["coin" + n];
        }
        d.Amount = totalPieces(d.Pieces);
      }
    }
    if (["plan", "count", "reserve"].includes(kind)) {
      const pooled = kind === "count" && d.Fields?.countScope === "all";
      if (kind !== "reserve" && !pooled && !d.Wallet)
        throw Error("Select a wallet.");
      if (pooled) d.Wallet = "";
      if (
        kind === "count" &&
        d.Phase !== "Zwischenstand" &&
        overlapsCountScope(rows(), pooled, d.Phase)
      )
        throw Error(
          "A pooled count would overlap with individual counts. Use the existing counting method.",
        );
      let phaseKey = d.Phase;
      if (kind === "count" && d.Phase === "Zwischenstand") {
        const observation = edit
          ? edit.Data.Fields?.observation
          : crypto.randomUUID();
        if (observation) {
          d.Fields = { ...d.Fields, observation };
          phaseKey += "|" + observation;
        }
      }
      target =
        kind === "reserve"
          ? "coinreserve"
          : await countID(kind, d.Wallet, phaseKey);
      if (!edit && rows().some((r) => r.ID === target))
        throw Error(
          "A count already exists for this phase. Edit the existing entry.",
        );
      if (edit && target !== edit.ID)
        throw Error(
          "The correction must use the same wallet and count phase.",
        );
    }
    if (["supply", "skim", "return"].includes(kind)) {
      const wallet = rows().find((r) => r.ID === d.Wallet);
      if (!wallet) throw Error("Select a wallet.");
    }
    if (
      s.event.Accounts &&
      [
        "income",
        "expense",
        "reimbursement",
        "fee",
        "card",
        "payout",
        "donation",
        "payment",
        "presale",
      ].includes(kind) &&
      !d.Account
    )
      throw Error("Select an account.");
    if (
      ["transfer", "payout", "skim", "supply", "return"].includes(kind) &&
      (!d.Account || !d.To || d.Account === d.To)
    )
      throw Error("Select different source and destination accounts.");
    if (kind === "period" && (!d.To || d.Date > d.To))
      throw Error("Check the end date.");
    if (d.Allocations) {
      if (
        d.Reference ||
        Object.values(d.Allocations).reduce((a, n) => a + n, 0) !== d.Amount
      )
        throw Error(
          "Select either one reference or a complete allocation across entries.",
        );
    }
    if (
      ["payment", "reimbursement", "attachment"].includes(kind) &&
      !d.Reference &&
      !d.Allocations
    )
      throw Error("Select the associated transaction.");
    await queue(kind, d, target, edit?.Revision || 0);
    edit = null;
  }
  if (id === "lfk") {
    if (s.role !== "Admin") throw Error("Administrator access required.");
    const id = "template:" + profileID(2),
      old = rows().find((r) => r.ID === id);
    await queue(
      "template",
      {
        ...old?.Data,
        Label: old?.Data.Label || profiles[2],
        Reference: profileID(2),
        Date: today(),
        Note: old?.Data.Note || "LFK print background",
        File: await b64(await background(vals.file)),
      },
      id,
      old?.Revision || 0,
    );
  }
  if (id === "wordLayout") {
    const input = new Uint8Array(await vals.file.arrayBuffer());
    const verified = mergeWord(input);
    const supported = [...contracts[6].required, ...contracts[6].optional];
    for (const token of verified.tokens) {
      if (!supported.includes(token)) throw Error("The donation letter does not provide field " + token);
    }
    const next = structuredClone(s),
      ref = profileID(6),
      active = (s.pinnedTemplates || s.entries).find(
        (r) => r.Kind === "template" && r.Data.Reference === ref,
      );
    (next.drafts ??= {})[ref] = {
      ...(active?.Data || {}),
      ...(next.drafts?.[ref] || {}),
      Reference: ref,
      Label: next.drafts?.[ref]?.Label || active?.Data.Label || profiles[6],
      File: await b64(new Blob([verified.bytes])),
      baseRevision: next.drafts?.[ref]?.baseRevision ?? active?.Revision ?? 0,
    };
    await commit(next);
  }
  if (id === "library") {
    canWrite();
    if (f.dataset.event !== s.event.ID)
      throw Error("The selected workspace has changed.");
    const v = await f.librarySource(),
      target = "template:" + v.Reference,
      old = rows().find((r) => r.ID === target);
    await queue("template", v, target, old?.Revision ?? 0);
    await sync();
    if (s.conflicts.some((c) => c.Target === target))
      throw Error("The template version changed during editing.");
  }
  if (id === "importTemplate") {
    const text = await importTemplate(vals.file);
    const next = structuredClone(s);
    next.importedText = text;
    await commit(next);
  }
  if (id === "template" && f.dataset.mode !== "release") {
    const next = structuredClone(s);
    (next.drafts ??= {})[vals.Reference] = {
      ...vals,
      File:
        next.drafts?.[vals.Reference]?.File ||
        (s.pinnedTemplates || s.entries).find(
          (r) => r.Kind === "template" && r.Data.Reference === vals.Reference,
        )?.Data.File ||
        "",
      baseRevision:
        next.drafts?.[vals.Reference]?.baseRevision ??
        (next.pinnedTemplates || s.entries).find(
          (r) => r.Data.Reference === vals.Reference && r.Kind === "template",
        )?.Revision ??
        0,
      Fields: {
        font: vals.font,
        footer: vals.footer,
        margin: vals.margin,
        header: vals.header,
        copies: vals.copies,
        firstColumn: vals.firstColumn,
        paper: vals.paper,
      },
    };
    await commit(next);
    show();
    return;
  }
  if (id === "template") {
    await sync();
    if (s.role !== "Admin")
      throw Error("Only an administrator can approve templates.");
    const target = "template:" + vals.Reference;
    await queue(
      "template",
      {
        File:
          s.drafts?.[vals.Reference]?.File ||
          rows().find((r) => r.ID === target)?.Data.File ||
          "",
        Label: vals.Label,
        Reference: vals.Reference,
        Note: vals.Note,
        Fields: {
          font: vals.font,
          footer: vals.footer,
          margin: vals.margin,
          header: vals.header,
          copies: vals.copies,
          firstColumn: vals.firstColumn,
          paper: vals.paper,
        },
        Date: today(),
      },
      target,
      s.drafts?.[vals.Reference]?.baseRevision ??
        (s.pinnedTemplates || s.entries).find((r) => r.ID === target)
          ?.Revision ??
        0,
    );
    await sync();
    if (s.conflicts.some((c) => c.Target === target))
      throw Error(
        "The new template version is disputed. The local draft was retained.",
      );
    const released = s.entries.find((r) => r.ID === target);
    if (released) {
      const next = structuredClone(s);
      next.pinnedTemplates = [
        ...(next.pinnedTemplates || []).filter((r) => r.ID !== target),
        released,
      ];
      if (next.drafts) delete next.drafts[vals.Reference];
      await commit(next);
    }
  }
  if (id.startsWith("resolve-")) {
    const c = s.conflicts.find((c) => c.ID === id.slice(8));
    await sync({
      Resolve: c.ID,
      Account: vals.account || "",
      Destination: vals.destination || "",
      Choice: vals.choice,
      Reason: vals.reason,
      Last: s.entries.find((r) => r.ID === c.Target)?.Revision || 0,
    });
  }
  if (id === "export") {
    if (f.dataset.event && f.dataset.event !== s.event.ID)
      throw Error("The selected workspace has changed.");
    const i = Number(vals.profile),
      original = ["Original", "Korrektur"].includes(vals.format);
    let previous;
    if (original) {
      canWrite();
      if ([2, 12].includes(i) && !s.donorAccess)
        throw Error(
          offlineEnabled
            ? "Numbered donation receipts require a prepared receipt profile."
            : s.event.General
              ? "Unlock reporting data under Donations first."
              : "Unlock donation reporting data under Payments and costs first.",
        );
      if (vals.version === "draft")
        throw Error("Originals require an approved version.");
      if (![0, 1, 2, 11, 12].includes(i) || !vals.subject)
        throw Error(
          "Select an invoice or donation with a linked transaction before issuing an original.",
        );
      const old = rows().find(
        (r) =>
          r.ID ===
          "original:" + vals.subject + (i >= 11 ? ":confirmation" : ""),
      );
      if (vals.format === "Korrektur") {
        if (!old || vals.revisionReason.trim().length < 3)
          throw Error(
            "Select an issued original and enter a reason for the correction.",
          );
        previous = rows()
          .filter(
            (r) =>
              r.Kind === "original" &&
              r.Data.Reference === vals.subject &&
              (r.Data.Fields?.series === "confirmation") === i >= 11,
          )
          .sort((a, b) => b.Data.Number - a.Data.Number)[0].Data.Number;
      }
      if (old && !previous) {
        await reprint(old, "PDF");
        return;
      }
      if (
        rows().find((r) => r.ID === vals.subject)?.Device !== s.device ||
        availableNumbers(s) === 0
      )
        throw Error("Issuing permission or reserved numbers are missing.");
      if (!offlineEnabled) {
        const fields = previous ? { previous: String(previous), reason: vals.revisionReason } : {};
        if (i >= 11) fields.series = "confirmation";
        const target = "original:" + vals.subject +
          (i >= 11 ? ":confirmation" : "") + (previous ? ":after:" + previous : "");
        const number = s.nextNumber;
        await commit({
          ...s,
          ops: [{
            ID: crypto.randomUUID(), Target: target, Kind: "original",
            Data: {
              Label: "Issue original", Date: today(), Number: number,
              Reference: vals.subject, Fields: fields, Note: JSON.stringify({ profile: profileID(i) }),
            },
          }],
        });
        const issued = rows().find((r) => r.ID === target);
        if (!issued?.Data.PDF) throw Error("The issued original could not be loaded.");
        download(from64(issued.Data.PDF, "application/pdf"), profileID(i) + "-" + number + ".pdf");
        show();
        return;
      }
    }
    const snap = snapshot(i, s, rows(), {
      ...vals,
      number: original ? s.nextNumber : null,
    });
    if (previous) {
      snap.previousNumber = previous;
      snap.revisionReason = vals.revisionReason;
      const correction =
        "Replacement for receipt " + previous + " · " + vals.revisionReason;
      if (snap.tables) snap.tables.after.push(correction);
      else snap.lines.push(correction);
    }
    const blobs = await renderDocument(snap);
    if (original) {
      const next = structuredClone(s);
      const digest = async (b) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await b.arrayBuffer()),
          ),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
      snap.archive = {
        device: s.device,
        user: s.user,
        issuedAt: new Date().toISOString(),
        renderBuild: __BONFIRE_RENDER_BUILD__,
        fontPreset: snap.font,
        pdfSHA256: await digest(blobs.pdf),
        docxSHA256: await digest(blobs.docx),
        appAssets: offlineEnabled
          ? (await caches.keys()).filter((k) => k.startsWith("bonfire-"))
          : [],
        sourceRevision: rows().find((r) => r.ID === vals.subject)?.Revision,
      };
      const d = {
        Label: snap.title,
        Date: snap.date,
        Reference: vals.subject,
        Fields: previous
          ? { previous: String(previous), reason: vals.revisionReason }
          : {},
        Number: next.nextNumber++,
        PDF: await b64(blobs.pdf),
        DOCX: await b64(blobs.docx),
        Note: JSON.stringify(snap),
      };
      if (i >= 11) d.Fields.series = "confirmation";
      next.ops.push({
        LocalTime: new Date().toISOString(),
        ID: crypto.randomUUID(),
        Seq: ++next.seq,
        Target:
          "original:" +
          vals.subject +
          (i >= 11 ? ":confirmation" : "") +
          (previous ? ":after:" + previous : ""),
        Base: 0,
        Kind: "original",
        Data: d,
      });
      await commit(next);
    }
    const ext = vals.format === "DOCX" ? "docx" : "pdf";
    download(
      blobs[ext],
      profileID(i) +
        (snap.number ? "-" + snap.number : "-draft") +
        "." +
        ext,
    );
  }
  show();
}
document.addEventListener("change", (e) => {
  if (e.target.form?.id === "importRow" && e.target.name === "ix") {
    const row = e.target.value === "" ? null : imported[Number(e.target.value)];
    e.target.form.elements.kind.value = ["income", "expense"].includes(row?.kind) ? row.kind : "";
    e.target.form.elements.date.value = row?.date || "";
  }
  if (e.target.form?.id === "assign-wallets" && e.target.name === "wallet") {
    delete e.target.form.dataset.overlapSelection;
    e.target.form.querySelector(".catalog-confirm").replaceChildren();
  }
  if (e.target.form?.id === "copy" && e.target.name === "year") {
    const y = years.find((y) => y.ID === e.target.value);
    if (y) {
      e.target.form.elements.start.value = y.Starts;
      e.target.form.elements.end.value = y.Starts;
    }
  }
});
document.addEventListener("submit", (e) => {
  if (e.target.closest(".admin-console")) return;
  e.preventDefault();
  if (e.target.id === "template")
    e.target.dataset.mode = e.submitter?.dataset.release ? "release" : "draft";
  action(async () => {
    const inEditor = entryDialog.contains(e.target);
    if (inEditor) entryDialog.querySelector(".entry-error").replaceChildren();
    const close = await submit(e.target);
    if (inEditor && close !== false) closeEditor();
  });
});
function overlapsCountScope(entries, pooled, phase) {
  return entries.some(
    (r) =>
      r.Kind === "count" &&
      r.Data.Phase !== "Zwischenstand" &&
      (r.Data.Fields?.countScope === "all") !== pooled &&
      (r.Data.Phase === phase || (pooled ? phase : r.Data.Phase) === "Anfang"),
  );
}
function updateCountOptions(form) {
  const e = form.elements;
  const pooled = e.field_countScope?.value === "all";
  const manual = e.field_countMode.value === "amount";
  e.Wallet.closest("label").hidden = e.Wallet.disabled = pooled;
  const hint = form.querySelector(".catalog-hint");
  if (hint) {
    const fields = rows().find((r) => r.Kind === "wallet" && r.ID === e.Wallet.value)?.Data.Fields;
    hint.textContent = pooled ? "" : openingFloatHint(fields);
    hint.hidden = !hint.textContent;
  }
  e.amount.closest("label").hidden = e.amount.disabled = !manual;
  e.amount.required = manual;
  form.querySelector(".count-pieces").hidden = manual;
  for (const input of form.querySelectorAll(".pieces input"))
    input.disabled = manual;
}
document.addEventListener("change", (e) => {
  if (e.target.name === "sourceWallet") {
    const account = e.target.form.elements.Account;
    account.closest("label").hidden = account.disabled = !!e.target.value;
  }
  if (e.target.form?.elements.field_countMode && e.target.matches('[name="Wallet"],[name="field_countMode"],[name="field_countScope"]'))
    updateCountOptions(e.target.form);
});
function updateCount(form) {
  const pieces = {};
  let valid = true;
  for (const coin of denom) {
    const input = form.elements["coin" + coin];
    const count = Number(input.value || 0);
    valid = valid && input.validity.valid;
    pieces[coin] = count;
    form.querySelector('[data-piece="' + coin + '"]').textContent = input
      .validity.valid
      ? eur(coin * count)
      : "Check quantity";
  }
  form.querySelector("#count-total").textContent = valid
    ? eur(totalPieces(pieces))
    : "Check quantities";
}
document.addEventListener("input", (e) => {
  if (e.target.closest(".admin-console")) return;
  if (e.target.matches("#catalog-wallet .pieces input")) updateFloatInput(e.target.form);
  if (e.target.matches("#record .pieces input")) updateCount(e.target.form);
  if (
    ["export", "template"].includes(e.target.form?.id) &&
    document.querySelector("#proof-sheet")
  ) {
    proofRevision++;
    document.querySelector("#proof-sheet").replaceChildren();
    document.querySelector("#proof-status").textContent =
      "Inputs changed. Refresh the preview.";
  }
  if (!e.target.matches("[data-contact-filter]")) return;
  const query = e.target.value.trim().toLocaleLowerCase("de"),
    select = e.target.form?.elements.Contact;
  if (!select) return;
  for (const option of select.options)
    option.hidden =
      !!option.value && !option.text.toLocaleLowerCase("de").includes(query);
});
document.addEventListener("change", (e) => {
  if (e.target.closest(".admin-console")) return;
  if (e.target.name === "overview-period") {
    overviewPeriod = e.target.value;
    show();
    return;
  }
  if (e.target.form?.id === "template" && e.target.name === "Reference") {
    const f = e.target.form,
      ref = e.target.value;
    const cfg =
      s.drafts?.[ref] ||
      (s.pinnedTemplates || s.entries).find(
        (r) => r.Kind === "template" && r.Data.Reference === ref,
      )?.Data ||
      {};
    f.elements.Label.value =
      cfg.Label || profiles.find((_, i) => profileID(i) === ref) || "";
    f.elements.Note.value = cfg.Note || "";
    for (const key of [
      "font",
      "footer",
      "margin",
      "header",
      "copies",
      "firstColumn",
      "paper",
    ])
      f.elements[key].value =
        cfg.Fields?.[key] ||
        { font: "helvetica", margin: "15", paper: "Letter" }[key] ||
        "";
  }
  if (e.target.name === "reportPeriod") {
    chosenPeriod = e.target.value;
  }
  if (e.target.name === "type") {
    if (!entryDialog.open || edit) return;
    const previous = entryDialog.querySelector("#record");
    const values = new FormData(previous);
    kind = e.target.value;
    previous.outerHTML = recordForm();
    const current = entryDialog.querySelector("#record");
    if (current.elements.field_countMode) updateCountOptions(current);
    loadSponsorChoices(current);
    for (const input of current.elements) {
      if (!input.name || !values.has(input.name) || input.name === "type" ||
          ["hidden", "file", "password", "radio"].includes(input.type)) continue;
      if (input.type === "checkbox") {
        input.checked = values.getAll(input.name).includes(input.value);
        continue;
      }
      const value = values.get(input.name);
      if (typeof value !== "string") continue;
      if (input instanceof HTMLSelectElement &&
          ![...input.options].some((option) => !option.disabled && option.value === value)) continue;
      input.value = value;
    }
    e.target.focus();
    entryDialog.querySelector(".entry-error").replaceChildren();
  }
});
document.addEventListener("click", (e) => {
  const disclosure = document.querySelector("#fiscal-switch[open]");
  if (disclosure && !disclosure.contains(e.target)) disclosure.open = false;
  const b = e.target.closest("button, a[data-page]");
  const pageLink = b instanceof HTMLAnchorElement;
  if (pageLink) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
  }
  if (
    !b ||
    (b.form &&
      b.type === "submit" &&
      !b.dataset.page &&
      !b.dataset.edit &&
      !b.dataset.file)
  )
    return;
  if (busy) return;
  if (b.dataset.masterEdit || b.dataset.masterLink) {
    const id = b.dataset.masterEdit || b.dataset.masterLink;
    const master = accountCatalog.accounts.find((a) => a.ID === id);
    if (b.dataset.masterLink) {
      const spaces = allSpaces.filter(
        (e) =>
          !e.Closed && e.Year && !years.find((y) => y.ID === e.Year)?.Closed,
      );
      if (!spaces.length) {
        notice.textContent = "No workspace is open.";
        return;
      }
      openEditor(
        b,
        "Link treasury account · " + master.Name,
        form(
          "fire-link",
          select(
            "Event",
            "Workspace",
            spaces.map((e) => [
              e.ID,
              (years.find((y) => y.ID === e.Year)?.Name || "") + " · " + e.Name,
            ]),
          ) + select("Local", "Local account", []),
          "Assign",
        ),
      );
      const f = entryDialog.querySelector("form");
      f.dataset.master = id;
      const refresh = () => {
        f.elements.Local.innerHTML =
          option("", "Create workspace account") +
          accountCatalog.locals
            .filter((l) => l.Event === f.elements.Event.value && !l.Master)
            .map((l) => option(l.ID, l.Name))
            .join("");
      };
      f.elements.Event.onchange = refresh;
      refresh();
    } else {
      openEditor(
        b,
        master ? "Edit treasury account" : "Create treasury account",
        form(
          "fire-master",
          field("Name", "Account name", "text", true, master?.Name || "") +
            (master
              ? select("Active", "Status", [
                  ["true", "Active"],
                  ["false", "Inactive"],
                ])
              : ""),
          "Save",
        ),
      );
      const f = entryDialog.querySelector("form");
      f.dataset.master = master?.ID || "";
      f.dataset.revision = master?.Revision || 0;
      if (master) f.elements.Active.value = String(master.Active);
    }
    return;
  }
  if (b.dataset.balanceLines || b.dataset.yearCount) {
    const v = balanceItems.find(
      (x) => x.ID === (b.dataset.balanceLines || b.dataset.yearCount),
    );
    if (!v) return;
    if (b.dataset.balanceLines) {
      openEditor(
        b,
        v.Name,
        balanceLines(v) +
          '<button type="button" data-act="yearBalances">Back to account reconciliation</button>',
      );
      return;
    }
    const val = (n) => (n == null ? "" : (n / 100).toFixed(2));
    openEditor(
      b,
      "Fiscal year balances · " + v.Name,
      form(
        "fire-count",
        select("Action", "Opening balance", [
          ["count", "Manual"],
          ...(v.PriorActual != null
            ? [["carry", "Carry forward prior balance · " + eur(v.PriorActual)]]
            : []),
        ]) +
          field("Opening", "Opening balance in EUR", "text", false, val(v.Opening)) +
          field(
            "Actual",
            "Observed balance or bank statement balance in EUR",
            "text",
            false,
            val(v.Actual),
          ),
        "Save balances",
      ),
    );
    const f = entryDialog.querySelector("form");
    f.dataset.master = v.ID;
    f.dataset.revision = v.Revision;
    f.elements.Action.onchange = () => {
      f.elements.Opening.disabled = f.elements.Action.value === "carry";
    };
    return;
  }
  if (b.dataset.denomination) {
    const input = b.form.elements["coin" + b.dataset.denomination];
    const next = Number(input.value) + Number(b.dataset.step);
    if (!input.validity.valid || next > Number(input.max)) {
      input.focus();
      input.setCustomValidity(
        "Enter a whole number up to 1,000,000.",
      );
      input.reportValidity();
      input.setCustomValidity("");
      return;
    }
    input.value = String(next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (
    b.dataset.adminRoute &&
    logged &&
    canOpenConsole(b.dataset.adminRoute, onlineUser.role)
  ) {
    adminSearch = b.dataset.adminSearch || "";
    page = b.dataset.adminRoute;
    show();
    return;
  }
  if (b.closest(".admin-console")) return;
  if (b.dataset.openForm) {
    openEditor(b, b.textContent, b.nextElementSibling.innerHTML);
    return;
  }
  if (b.hasAttribute("data-fiscal")) {
    action(async () => {
      donorAccess = false;
      await selectFiscalWorkspace(b.dataset.fiscal, "");
      page = selectedYear ? "Übersicht" : "Geschäftsjahre";
      const mobile = document.body.classList.contains("menu-open");
      document.body.classList.remove("menu-open");
      document
        .querySelector("#menu-toggle")
        .setAttribute("aria-expanded", "false");
      show();
      document
        .querySelector(mobile ? "#menu-toggle" : "#fiscal-switch summary")
        ?.focus();
    });
    return;
  }
  if (b.dataset.yearEdit) {
    action(async () => {
      years = await api("years");
      const y = years.find((item) => item.ID === b.dataset.yearEdit);
      if (!y || y.Closed) {
        show();
        throw Error("This fiscal year can no longer be edited.");
      }
      openEditor(
        b,
        "Edit fiscal year",
        form(
          "year-edit",
          yearFields(y),
          "Save changes",
          button("cancel", "Cancel", true),
        ),
      );
      entryDialog.querySelector("form").dataset.year = y.ID;
    });
    return;
  }
  if (b.dataset.eventEdit) {
    const id = b.dataset.eventEdit;
    const e =
      s?.event.ID === id && page === "Veranstaltungen"
        ? s.event
        : events.find((item) => item.ID === id);
    if (!e) return;
    openEditor(
      b,
      "Edit event",
      form(
        "event-edit",
        eventFields(e.Name, e.Starts, e.Ends),
        "Save changes",
        button("cancel", "Cancel", true),
      ),
    );
    const editor = entryDialog.querySelector("form");
    editor.dataset.event = id;
    const year = years.find((y) => y.ID === e.Year);
    if (year) {
      for (const input of editor.querySelectorAll("input[type=date]")) {
        input.min = year.Starts;
        input.max = year.Ends;
      }
    }
    return;
  }
  if (b.dataset.eventCleanup) {
    const workspace = events.find((e) => e.ID === b.dataset.eventCleanup);
    if (workspace) action(() => openEventCleanup(b, workspace));
    return;
  }
  if (b.dataset.year || b.dataset.space || b.dataset.bookEvent) {
    action(async () => {
      donorAccess = false;
      await selectFiscalWorkspace(
        b.dataset.year || selectedYear,
        b.dataset.space || b.dataset.bookEvent,
      );
      if (b.dataset.bookEvent) {
        page = "Zahlungen";
        show();
        if (s.event.General || !writableWorkspace())
          throw Error("Bookings are locked in this workspace.");
        kind = "income";
        openRecord(article.querySelector('[data-act="focusEntry"]'));
        return;
      }
      page = b.dataset.space
        ? s.event.General
          ? "Journal"
          : "Veranstaltungen"
        : "Übersicht";
      show();
    });
    return;
  }
  if (b.dataset.page) {
    if (entryDialog.contains(b)) closeEditor();
    if (!s && !logged) {
      destination = b.dataset.page;
      show();
      article.querySelector("input")?.focus();
      return;
    }
    if (b.dataset.page === "Einrichtung")
      destination = page === "Verwaltung" ? "Übersicht" : page;
    const requested = b.dataset.page;
    const sidebar = !!b.closest("#sidebar");
    const target =
      !offlineEnabled && sidebar && requested === "Veranstaltungen"
        ? "Veranstaltungsliste"
        : requested;
    document.body.classList.remove("menu-open");
    document
      .querySelector("#menu-toggle")
      .setAttribute("aria-expanded", "false");
    action(async () => {
      if (
        !offlineEnabled &&
        logged &&
        s &&
        !s.event.General &&
        (sidebar || target === "Journal" || target === "Veranstaltungsliste")
      ) {
        donorAccess = false;
        await selectFiscalWorkspace(selectedYear);
      }
      page = target;
      filter = "";
      journalFilters = {};
      edit = null;
      show();
      if (pageLink) article.focus();
    });
    return;
  }
  action(async () => {
    if (b.dataset.catalogEdit) {
      openCatalogEditor(b);
      return;
    }
    if (b.dataset.act === "bulkWallets") {
      canWrite();
      if (offlineEnabled || s.event.General || page !== "Geldtaschen") return;
      const event = s.event, entries = rows();
      openEditor(b, "Bulk wallet entry",
        '<p class="booking-target">Event <strong>' + esc(event.Name) + '</strong></p>' +
        form("bulk-wallets", bulkWalletFields(event, entries, defaultDay(event), select, field),
          "Save wallet entries", button("cancel", "Cancel", true)));
      bindWalletBatch(entryDialog.querySelector("form"), event, entries, onlineUser.user);
      return;
    }
    if (b.dataset.act === "pickWallets") {
      await openWalletPicker(b);
      return;
    }
    if (b.dataset.recordDocument) {
      await openRecordDocument(b);
      return;
    }
    if (b.dataset.shareOriginal) {
      const row = rows().find((r) => r.ID === b.dataset.shareOriginal);
      const file = new File(
        [from64(row.Data.PDF, "application/pdf")],
        "Receipt-" + row.Data.Number + ".pdf",
        { type: "application/pdf" },
      );
      if (!navigator.canShare?.({ files: [file] }))
        throw Error("Save the PDF and open it as an attachment.");
      try {
        await navigator.share({ files: [file], title: row.Data.Label });
      } catch (err) {
        if (err.name !== "AbortError") throw err;
      }
      return;
    }
    if (b.dataset.claimInvoice && page === "Zahlungen") {
      page = "Dokumente";
      show();
      const form = article.querySelector("#export");
      form.elements.profile.value = "0";
      form.elements.subject.value = b.dataset.claimInvoice;
      form.elements.profile.focus();
      return;
    }
    if (b.dataset.walletAction) {
      openRecord(b);
      return;
    }
    if (b.dataset.edit) {
      const row = rows().find((r) => r.ID === b.dataset.edit);
      if (!row) throw Error("This entry is no longer available.");
      openRecord(b, row);
      return;
    }
    if (b.dataset.lifecycle) {
      const row = rows().find((r) => r.ID === b.dataset.lifecycle);
      openReasonEditor(
        b,
        row.Data.Retired ? "Restore entry" : "Archive entry",
        row.Data.Label,
        async (reason) => {
          if (reason.length < 3) throw Error("Enter a reason.");
          await queue(
            row.Kind,
            {
              ...row.Data,
              Retired: !row.Data.Retired,
              Fields: {
                ...row.Data.Fields,
                lifecycle: row.Data.Retired
                  ? "Wiederhergestellt"
                  : "Archiviert",
                lifecycleReason: reason,
              },
            },
            row.ID,
            row.Revision,
          );
        },
      );
      return;
    }
    if (b.dataset.settle) {
      if (b.dataset.settle === "settlement-total") {
        canWrite();
        const amount = pooledRevenue(rows()),
          previous = rows().find((r) => r.ID === "settlement-total");
        if (amount == null || amount < 0) throw Error("Check count.");
        openEditor(
          b,
          "Settle wallets together",
          "<p>" +
            esc(s.event.Name) +
            " · Sammelbareinnahme <strong>" +
            eur(amount) +
            "</strong></p><p>Cash bookings without a wallet count toward pooled cash unless a separate account is specified.</p>" +
            form(
              "pooled-settlement",
              (s.event.Accounts
                ? refs("Account", "Posting account", ["account"])
                : "") +
                (previous
                  ? field("reason", "Reason for correction", "text", true)
                  : ""),
              previous ? "Post correction" : "Post total",
              button("cancel", "Cancel", true),
            ),
        );
        const f = entryDialog.querySelector("form");
        f.dataset.event = s.event.ID;
        f.dataset.amount = String(amount);
        if (previous && f.elements.Account)
          f.elements.Account.value = previous.Data.Account;
        return;
      }
      const wallet = rows().find((r) => r.ID === b.dataset.settle);
      const target = "settlement:" + wallet.ID;
      const previous = rows().find((r) => r.ID === target);
      const amount = counted(
        rows().filter((r) => r.ID !== target),
        wallet.ID,
      );
      if (amount === null || amount < 0)
        throw Error("Review counts and their associated transactions.");
      const end = rows().find(
        (r) =>
          r.Kind === "count" &&
          r.Data.Wallet === wallet.ID &&
          r.Data.Phase === "Ende",
      );
      const saveSettlement = (reason) =>
        queue(
          "income",
          {
            Label: "Bar settlement " + wallet.Data.Label,
            Date: previous?.Data.Date || end.Data.Date,
            Note: reason,
            Wallet: wallet.ID,
            Bar: wallet.Data.Bar,
            Account: wallet.ID,
            Amount: amount,
            Method: "Bar",
            Reference: "wallet-settlement",
          },
          target,
          previous?.Revision || 0,
        );
      if (previous) {
        openReasonEditor(
          b,
          "Correct pooled amount",
          wallet.Data.Label + " · " + eur(amount),
          saveSettlement,
        );
        return;
      }
      await saveSettlement("");
      show();
      return;
    }
    if (b.dataset.attachment) {
      const v = rows().find((r) => r.ID === b.dataset.attachment)?.Data;
      if (!v?.File) throw Error("File pending.");
      const mime = v.File.startsWith("JVBER")
        ? "application/pdf"
        : v.File.startsWith("/9j/")
          ? "image/jpeg"
          : "image/png";
      download(from64(v.File, mime), v.Filename || "Receipt");
      return;
    }
    if (b.dataset.file) {
      const row = rows().find((r) => r.ID === b.dataset.file);
      const ext = b.dataset.format;
      await reprint(row, ext);
      return;
    }
    switch (b.dataset.act) {
      case "library":
        await libraryDialog(b);
        return;
      case "yearBalances":
        await openBalances(b);
        return;
      case "viewDonors":
        donorAccess = true;
        try {
          await sync();
        } catch (err) {
          donorAccess = false;
          throw err;
        }
        break;
      case "refreshWorkplace":
        await onlineStart(onlineUser);
        break;
      case "profileHelp":
      case "backLogin":
      case "changeFactor":
        profileHelp = b.dataset.act === "profileHelp";
        if (b.dataset.act === "changeFactor")
          useRecoveryCode = !useRecoveryCode;
        else {
          loginChallenge = "";
          useRecoveryCode = false;
        }
        show();
        (
          article.querySelector("[name=otp], [name=user], #unlock input") ||
          article
        ).focus();
        return;
      case "focusEntry":
        openRecord(b);
        return;
      case "docInputs":
        document
          .querySelector(".document-studio")
          .classList.remove("view-proof");
        return;
      case "docProof":
      case "draftProof":
        await proofDocument(b.dataset.act === "draftProof");
        return;
      case "newProfile":
        location.href = "/?profil=" + crypto.randomUUID();
        return;
      case "pinTemplates":
        await sync();
        await commit({
          ...s,
          pinnedTemplates: s.entries.filter((r) => r.Kind === "template"),
        });
        show();
        return;
      case "accountSecurity":
        page = "Konto und Sicherheit";
        document.body.classList.remove("menu-open");
        document
          .querySelector("#menu-toggle")
          .setAttribute("aria-expanded", "false");
        show();
        return;
      case "passkeyLogin": {
        const result = await usePasskey(api);
        if (result.passwordChange) passwordTicket = result.passwordChange;
        else {
          await onlineStart(await api("workplace"));
          page = destination;
        }
        show();
        return;
      }
      case "lock":
        if (logged) await api("logout", {});
        location.reload();
        return;
      case "csv":
        download(csv(reportRows()), "Journal.csv");
        return;
      case "xlsx":
        download(workbook(reportRows()), "Journal.xlsx");
        return;
      case "evidence":
        {
          const reports = {},
            templates = {};
          const organization =
            rows().find((r) => r.Kind === "organization")?.Data.Label || "";
          for (const [i, name] of [
            [9, "Review-report"],
            [10, "Document-register"],
          ]) {
            const snap = snapshot(i, s, rows(), {
              period: chosenPeriod,
              organization,
            });
            templates[name] = snap.templateVersionID;
            const docs = await renderDocument(snap);
            reports[name + ".pdf"] = docs.pdf;
            reports[name + ".docx"] = docs.docx;
          }
          download(
            await evidence(s, reportRows(), reports, {
              period: chosenPeriod,
              templates,
            }),
            "Review-package.zip",
          );
        }
        return;
      case "donors":
        if (!s.donorAccess) throw Error("A reporting data profile is required.");
        download(
          new Blob(
            [
              JSON.stringify(
                donationReport(
                  rows(),
                  document.querySelector("[name=donorPeriod]").value.trim(),
                ),
                null,
                2,
              ),
            ],
            { type: "application/json" },
          ),
          "Donation-review-list.json",
        );
        return;
      case "conflictFiles":
        conflictFiles = {
          device: s.device,
          list: await api("manage", { Action: "conflict-originals" }, bearer()),
        };
        break;
      case "numbers": {
        const ranges = await api("manage", { Action: "numbers" }, bearer());
        auditRows = ranges.map((x) => ({
          at: "",
          username: x.name,
          action:
            (x.capacity === 0
              ? "No digital numbers"
              : x.first + "–" + x.last) +
            " · Paper P-" +
            x.first +
            "–P-" +
            x.paper_last +
            " · " +
            x.status +
            " · Digital: " +
            (x.used || []).join(", ") +
            " · Paper: " +
            (x.paper || []).join(", "),
        }));
        break;
      }
      case "journalHistory":
        auditRows = await api("manage", { Action: "journal" }, bearer());
        break;
      case "readiness": {
        const missing = [];
        for (const path of [
          "/",
          "/app.js",
          "/app.css",
          "/theme.js",
          "/manifest.webmanifest",
          "/logo-original.svg",
          "/icon-192.png",
          "/icon-512.png",
        ])
          if (!(await caches.match(path))) missing.push(path);
        const usage = await navigator.storage.estimate();
        readiness = [
          missing.length
            ? "Offline package incomplete: " + missing.join(", ")
            : "App, renderer, branding and icons available locally",
          s.synced
            ? "Records last confirmed: " + s.synced
            : "Records have not been synchronized",
          Date.parse(s.expires) > Date.now()
            ? "Device authorization valid"
            : "Device authorization expired",
          "Available receipt numbers: " + availableNumbers(s),
          "Estimated free space: " +
            Math.floor(((usage.quota || 0) - (usage.usage || 0)) / 1048576) +
            " MiB",
          (await navigator.storage.persisted())
            ? "Browser granted persistent storage"
            : "Persistent storage unconfirmed",
        ];
        break;
      }
      case "audit":
        auditRows = await api("manage", { Action: "audit" }, bearer());
        break;
      case "accounts":
        await api(
          "manage",
          { Action: "accounts", Accounts: !s.event.Accounts },
          bearer(),
        );
        await sync();
        break;
      case "cancel":
        closeEditor();
        return;
      case "sync": {
        const uncertain = !offlineEnabled && unconfirmedWrites.has(s.event.ID);
        await sync();
        if (uncertain) {
          show();
          closeEditor();
          notice.textContent =
            "Server records loaded. Check whether your last transaction is present.";
          return;
        }
        break;
      }
      case "seal":
        if (!confirm("Finish recording on this device?")) return;
        await commit({ ...s, ending: true });
        await sync();
        await sync({ Action: "Ende", Last: s.seq });
        break;
      case "close":
        await sync({ Action: "Abschluss" });
        break;
      case "recover": {
        const v = await readVault();
        download(
          new Blob(
            [
              JSON.stringify({
                version: 1,
                salt: [...v.salt],
                iv: [...v.iv],
                ciphertext: await b64(new Blob([v.bytes])),
              }),
            ],
            { type: "application/json" },
          ),
          "bonfire-device-backup.json",
        );
        break;
      }
      default:
        return;
    }
    show();
  });
});
async function tryAutoSync() {
  if (
    !offlineEnabled ||
    !s ||
    s.recovery ||
    busy ||
    backgroundSync ||
    !navigator.onLine ||
    document.visibilityState !== "visible"
  )
    return;
  backgroundSync = (async () => {
    try {
      await sync();
      if (page === "Übersicht") show();
    } catch {
      state.textContent =
        s.event.Name + " · Local copy, server sync pending";
    }
  })();
  try {
    await backgroundSync;
  } finally {
    backgroundSync = null;
  }
}
window.addEventListener("online", tryAutoSync);
window.addEventListener("online", checkConnection);
window.addEventListener("offline", checkConnection);
document.addEventListener("visibilitychange", checkConnection);
setInterval(checkConnection, 30000);
void checkConnection();
if (offlineEnabled) {
  profilesLocal = await slots();
  saved = !!(await readVault());
}
if (!saved) {
  try {
    const identity = await api("workplace");
    await onlineStart(identity);
  } catch {
    /* Anmeldung ist ohne aktive Serversitzung erforderlich. */
  }
}
show();

document.querySelector("#menu-toggle").addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  document
    .querySelector("#menu-toggle")
    .setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#sidebar a[href], #sidebar summary, #sidebar button")?.focus();
});
document.addEventListener("keydown", (e) => {
  const switcher = document.querySelector("#fiscal-switch[open]");
  if (e.key === "Escape" && switcher) {
    switcher.open = false;
    switcher.querySelector("summary").focus();
    return;
  }
  if (e.key === "Escape" && document.body.classList.contains("menu-open")) {
    document.body.classList.remove("menu-open");
    const btn = document.querySelector("#menu-toggle");
    btn.setAttribute("aria-expanded", "false");
    btn.focus();
  }
});
document.querySelector("#workspace-picker").addEventListener("change", (e) =>
  action(async () => {
    try {
      const fresh = await api(
        "workplace?event=" + encodeURIComponent(e.target.value),
      );
      overviewPeriod = "";
      onlineData = fresh;
      preferredEvent = fresh.event.ID;
      show();
    } catch (err) {
      e.target.value = preferredEvent;
      throw err;
    }
  }),
);
