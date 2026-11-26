import { cents, denom, eur, totalPieces } from "./domain.js";
import { esc } from "./workplace.js";
import { denominationFields } from "./wallet-catalog.js";

function activeWallets(entries) {
  return entries.filter((row) => row.Kind === "wallet" && !row.Data.Retired)
    .sort((left, right) => left.Data.Label.localeCompare(right.Data.Label, "en", { numeric: true }));
}

export function bulkWalletFields(event, entries, day, select, field) {
  const sources = [
    ["", "Choose a source"],
    ...(!event.Accounts ? [["main-cashbox", "Main cashbox"]] : []),
    ...entries.filter((r) => ["account", "wallet"].includes(r.Kind) &&
      !r.Data.Retired && !r.Data.Fields?.masterInactive)
      .map((r) => [r.ID, (r.Kind === "wallet" ? "Wallet · " : "Account · ") + r.Data.Label]),
  ];
  const wallets = activeWallets(entries);
  return '<fieldset class="bulk-inputs"><legend>Entry details</legend><div class="form">' +
    select("Mode", "Action", [["opening", "Opening count"], ["topup", "Change top-up"]]) +
    field("Date", "Date", "date", true, day) +
    select("Source", "Change source", sources) +
    select("AmountMode", "Enter amount", [["amount", "Enter total amount"], ["pieces", "Count coins and notes"]]) +
    '<label>Amount per wallet in EUR<input name="amount" inputmode="decimal" placeholder="0.00" required></label></div>' +
    denominationFields() +
    '<fieldset class="catalog-choices bulk-choices"><legend>Receiving wallets</legend>' +
    (wallets.length ? wallets.map((w) => '<label><input type="checkbox" name="wallet" value="' +
      esc(w.ID) + '"><span>' + esc(w.Data.Label) + '<small class="catalog-note"></small></span></label>').join("") :
      '<p>No wallets have been added to this event.</p>') +
    '</fieldset></fieldset><div class="bulk-preview" aria-live="polite">' +
    '<dl><div><dt>Per wallet</dt><dd id="bulk-per-wallet"></dd></div>' +
    '<div><dt>Selected wallets</dt><dd id="bulk-wallet-count"></dd></div>' +
    '<div><dt>Grand total</dt><dd id="bulk-total"></dd></div></dl>' +
    '<p class="bulk-denominations" hidden></p></div><p class="bulk-retry" role="status" hidden></p>';
}

function readAmount(form) {
  if (form.elements.AmountMode.value === "amount")
    return { Amount: cents(form.elements.amount.value) };
  const Pieces = {};
  for (const coin of denom) {
    const input = form.elements["coin" + coin];
    if (input.validity.badInput || !input.validity.valid) throw Error("Check quantities.");
    if (Number(input.value)) Pieces[coin] = Number(input.value);
  }
  totalPieces(Pieces);
  return { Pieces };
}

const drafts = new WeakMap();
const pendingBatches = new Map();
const prefix = "bonfire-wallet-batch:";

// Only opaque request IDs survive a reload. Restricted storage still permits normal online use.
function storedID(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* The current tab retains the request until confirmation. */ }
  return null;
}

function clearPending(draft) {
  pendingBatches.delete(draft.storageKey);
  storedID(draft.storageKey, null);
  draft.pending = null;
  draft.previousID = null;
}

export function clearWalletBatches() {
  pendingBatches.clear();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch { /* No persistent session storage is available. */ }
}

function refreshBatch(form) {
  const { entries, pending, previousID, alreadySaved, saving } = drafts.get(form);
  const e = form.elements;
  const opening = e.Mode.value === "opening";
  const pieces = e.AmountMode.value === "pieces";
  e.Source.closest("label").hidden = e.Source.disabled = opening;
  e.Source.required = !opening;
  e.amount.closest("label").hidden = e.amount.disabled = pieces;
  e.amount.required = !pieces;
  form.querySelector(".count-pieces").hidden = !pieces;
  for (const input of form.querySelectorAll(".pieces input")) input.disabled = !pieces;
  const pooled = entries.some((r) => r.Kind === "count" && r.Data.Phase === "Anfang" && r.Data.Fields?.countScope === "all");
  const counted = new Set(entries.filter((r) => r.Kind === "count" && r.Data.Phase === "Anfang").map((r) => r.Data.Wallet));
  const wallets = [...form.querySelectorAll('[name="wallet"]')];
  for (const choice of wallets) {
    const reason = opening && pooled ? "Opening count recorded for all wallets" :
      opening && counted.has(choice.value) ? "Opening count already recorded" :
      !opening && choice.value === e.Source.value ? "Selected as change source" : "";
    choice.disabled = !!reason;
    if (reason && !pending) choice.checked = false;
    choice.closest("label").querySelector("small").textContent = reason;
  }
  const selected = wallets.filter((w) => w.checked).length;
  if (selected >= 100 && !pending) {
    for (const wallet of wallets.filter((w) => !w.checked && !w.disabled)) {
      wallet.disabled = true;
      wallet.closest("label").querySelector("small").textContent = "100 wallets selected";
    }
  }
  let unit = null, breakdown = [];
  try {
    const fields = readAmount(form);
    unit = fields.Amount ?? totalPieces(fields.Pieces);
    if (fields.Pieces) breakdown = Object.entries(fields.Pieces).map(([coin, quantity]) =>
      (quantity * selected) + " × " + eur(Number(coin)));
  } catch {
    // Incomplete and invalid amounts stay visible while the cashier edits.
  }
  if (pieces) {
    for (const coin of denom) {
      const input = e["coin" + coin];
      form.querySelector('[data-piece="' + coin + '"]').textContent =
        input.validity.valid ? eur(coin * Number(input.value)) : "Check quantity";
    }
    form.querySelector("#count-total").textContent = unit == null ? "Check quantities" : eur(unit);
  }
  form.querySelector("#bulk-per-wallet").textContent = unit == null ? "—" : eur(unit);
  form.querySelector("#bulk-wallet-count").textContent = String(selected);
  form.querySelector("#bulk-total").textContent = unit == null ? "—" : eur(unit * selected);
  const notes = form.querySelector(".bulk-denominations");
  notes.hidden = !breakdown.length || !selected;
  notes.textContent = notes.hidden ? "" : "Prepare across all wallets: " + breakdown.join(" · ");
  const save = form.querySelector(".actions button");
  save.disabled = saving || (!pending && (!selected || unit == null || (!opening && (!unit || !e.Source.value))));
  save.textContent = saving ? "Saving wallet entries…" : pending ? "Retry wallet entries" : "Save wallet entries";
  form.querySelector(".bulk-inputs").disabled = !!pending;
  const retry = form.querySelector(".bulk-retry");
  retry.textContent = saving ? "" : pending ? "Retry the same entries to confirm their status. Each wallet will be booked once." :
    previousID ? "A previous save was interrupted. Re-enter the intended details to confirm it." :
    alreadySaved ? "The previous wallet entries have already been recorded." : "";
  retry.hidden = !retry.textContent;
}

export function bindWalletBatch(form, event, entries, user) {
  form.dataset.event = event.ID;
  const storageKey = prefix + user + ":" + event.ID;
  const draft = { entries, storageKey, pending: pendingBatches.get(storageKey) || null,
    previousID: storedID(storageKey), alreadySaved: false };
  if (draft.previousID && entries.some((r) => r.Data.Fields?.walletBatch === draft.previousID)) {
    clearPending(draft);
    draft.alreadySaved = true;
  }
  drafts.set(form, draft);
  const pending = draft.pending;
  if (pending) {
    const e = form.elements;
    e.Mode.value = pending.Mode;
    e.Date.value = pending.Date;
    e.Source.value = pending.Source || "";
    e.AmountMode.value = pending.Pieces ? "pieces" : "amount";
    if (pending.Pieces) {
      for (const [coin, count] of Object.entries(pending.Pieces)) e["coin" + coin].value = count;
    } else {
      e.amount.value = (pending.Amount / 100).toFixed(2);
    }
    for (const wallet of form.querySelectorAll('[name="wallet"]')) wallet.checked = pending.Wallets.includes(wallet.value);
  }
  form.addEventListener("input", () => refreshBatch(form));
  form.addEventListener("change", () => refreshBatch(form));
  refreshBatch(form);
}

export async function submitWalletBatch(form, api, sync) {
  const draft = drafts.get(form);
  if (!draft.pending) {
    const e = form.elements;
    const Wallets = [...form.querySelectorAll('[name="wallet"]:checked:enabled')].map((w) => w.value);
    if (!Wallets.length) throw Error("Choose at least one receiving wallet.");
    const payload = {
      Event: form.dataset.event, Request: draft.previousID || crypto.randomUUID(), Mode: e.Mode.value,
      Date: e.Date.value, Wallets, ...readAmount(form),
    };
    if (payload.Mode === "topup") payload.Source = e.Source.value;
    pendingBatches.set(draft.storageKey, payload);
    storedID(draft.storageKey, payload.Request);
    draft.pending = payload;
  }
  draft.saving = true;
  refreshBatch(form);
  let accepted = false;
  try {
    await api("events/wallet-batch", draft.pending);
    accepted = true;
    await sync();
    clearPending(draft);
  } catch (error) {
    if (!accepted && [400, 403, 404, 409, 422].includes(error.status)) {
      clearPending(draft);
      if (error.status === 409 || error.status === 422) {
        try { draft.entries = await sync(); } catch { /* Keep the original rejection visible. */ }
      }
    }
    throw error;
  } finally {
    draft.saving = false;
    refreshBatch(form);
  }
}
