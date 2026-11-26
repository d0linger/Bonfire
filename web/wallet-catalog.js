import { cents, denom, eur, totalPieces } from "./domain.js";
import { esc } from "./workplace.js";

const floatDenominations = denom.filter((coin) => coin >= 10 && coin <= 10000);

export function walletDirectory(wallets, editable) {
  const header = '<div class="page-head"><h1>Wallet list</h1>' +
    (editable ? '<button data-catalog-edit="new" aria-haspopup="dialog">Create wallet</button>' : "") +
    "</div>";
  if (!wallets.length) return header + "<section><h2>No reusable wallets yet</h2><p>Add the physical wallets you use at events here.</p></section>";
  return header + '<section><div class="list"><table><thead><tr><th>Wallet</th><th>Usual bar</th><th>Suggested float</th><th>Status</th>' +
    (editable ? '<th>Actions</th>' : "") + "</tr></thead><tbody>" +
    wallets.map((w) => '<tr><th scope="row">' + esc(w.Name) +
      (w.Note ? '<small class="catalog-note">' + esc(w.Note) + '</small>' : '') +
      '</th><td>' + esc(w.DefaultBar || "—") + '</td><td>' + (w.FloatCents == null ? "—" : eur(w.FloatCents)) +
      '</td><td>' + (w.Active ? "Active" : "Retired") + '</td>' +
      (editable ? '<td><button class="secondary" data-catalog-edit="' + esc(w.ID) +
        '" aria-haspopup="dialog">Edit</button></td>' : "") + '</tr>').join("") +
    "</tbody></table></div></section>";
}

export function walletPicker(wallets) {
  const active = wallets.filter((w) => w.Active);
  if (!active.length) return "<p>No active wallets in the wallet list.</p>";
  return '<fieldset class="catalog-choices"><legend>Choose wallets</legend>' +
    active.map((w) => {
      const hints = [w.DefaultBar, w.FloatCents != null && "Suggested float " + eur(w.FloatCents),
        w.Used && "Already added"].filter(Boolean);
      return '<label><input type="checkbox" name="wallet" value="' + esc(w.ID) + '"' +
        (w.Used ? " disabled" : "") + '><span>' + esc(w.Name) +
        (hints.length ? '<small class="catalog-note">' + esc(hints.join(" · ")) + "</small>" : "") +
        "</span></label>";
    }).join("") + "</fieldset>";
}

export function floatFields(wallet) {
  const pieces = wallet?.Pieces || {};
  return '<label>Suggested opening float in EUR<input name="float" inputmode="decimal" value="' +
    (wallet?.FloatCents == null ? "" : (wallet.FloatCents / 100).toFixed(2)) + '"></label>' +
    '<details class="catalog-pieces"' + (Object.keys(pieces).length ? " open" : "") +
    '><summary>Suggest denominations</summary><div class="pieces">' +
    floatDenominations.map((coin) => '<label>' + eur(coin) + '<input name="coin' + coin +
      '" type="number" min="0" max="1000000" step="1" inputmode="numeric" value="' +
      esc(pieces[coin] || "") + '"></label>').join("") + '</div></details>';
}

export function suggestedFloat(form) {
  const pieces = {};
  for (const coin of floatDenominations) {
    const value = form.elements["coin" + coin].value;
    if (value && Number(value) !== 0) pieces[coin] = Number(value);
  }
  if (Object.keys(pieces).length) return { FloatCents: totalPieces(pieces), Pieces: pieces };
  const amount = form.elements.float.value.trim();
  return { FloatCents: amount ? cents(amount) : null, Pieces: null };
}

export function openingFloatHint(fields) {
  if (!fields || !/^\d+$/.test(fields.suggestedFloatCents)) return "";
  let breakdown = [];
  if (fields.suggestedPieces) {
    try {
      const pieces = JSON.parse(fields.suggestedPieces);
      breakdown = floatDenominations.filter((coin) => Number.isSafeInteger(pieces?.[coin]) && pieces[coin] > 0)
        .map((coin) => pieces[coin] + " × " + eur(coin));
    } catch {
      // Older event records can have a free-text suggestion.
    }
  }
  return "Suggested opening float: " + eur(Number(fields.suggestedFloatCents)) +
    (breakdown.length ? " (" + breakdown.join(", ") + ")" : "") + ". Enter the amount you actually counted.";
}

export function updateFloatInput(form) {
  const input = form.elements.float;
  if (form.querySelector(".pieces input:invalid")) return;
  const counted = floatDenominations.some((coin) => Number(form.elements["coin" + coin].value) > 0);
  if (counted) {
    if (!input.readOnly) input.dataset.manual = input.value;
    const { FloatCents } = suggestedFloat(form);
    input.value = (FloatCents / 100).toFixed(2);
  } else if (input.readOnly) {
    input.value = input.dataset.manual || "";
  }
  input.readOnly = counted;
}

export function denominationFields() {
  const label = (title, control) => "<label>" + title + control + "</label>";
  return '<div class="count-pieces"><h3>Denominations</h3><div class="pieces">' +
      denom
        .map(
          (c) =>
            '<div class="piece-row">' +
            label(
              eur(c),
              '<input name="coin' +
                c +
                '" aria-label="Quantity of ' +
                esc(eur(c)) +
                '" min="0" max="1000000" inputmode="numeric" type="number" value="0" step="1"><small data-piece="' +
                c +
                '">' +
                esc(eur(0)) +
                "</small>",
            ) +
            '<div class="piece-steps">' +
            [1, 2, 5, 10]
              .map(
                (step) =>
                  '<button type="button" class="secondary" data-denomination="' +
                  c +
                  '" data-step="' +
                  step +
                  '" aria-label="Add ' +
                  step +
                  " units at " +
                  esc(eur(c)) +
                  '">+' +
                  step +
                  "</button>",
              )
              .join("") +
            "</div></div>",
        )
        .join("") +
      '</div><p class="count-total">Counted amount <output id="count-total" aria-live="polite">' +
      esc(eur(0)) +
      '</output></p></div>';
}
