import { counted, pooledRevenue, eur } from "./domain.js";
export function cashSettlement(rows, wallet) {
  const target = wallet ? "settlement:" + wallet : "settlement-total";
  const posted = rows.find(r => r.ID === target);
  const countedCash = wallet ? counted(rows.filter(r => r.ID !== target), wallet) : pooledRevenue(rows);
  const linked = rows.reduce((n,r) => n+(r.Kind==="wallet-link" && r.Data.Wallet===wallet ? r.Data.Amount : 0),0);
  const posting = posted?.Data.Amount || 0;
  return {target, posted, countedCash, linked, posting, remaining: countedCash==null ? null : countedCash-linked-posting};
}
export function allocationFields() {
  return '<label>Cashbook receipt<select name="receipt" required></select></label>'+
   '<div class="actions"><button type="button" data-receipt-prev>Previous receipts</button><button type="button" data-receipt-next>More receipts</button></div>'+
   '<p data-receipt-balance aria-live="polite"></p><label>Amount allocated to this count in EUR<input name="allocation" inputmode="decimal" required></label>'+
   '<label>Reason for correction<input name="linkReason" maxlength="500"></label>';
}

export function bindReceiptChoices(form, search, initial, fetchReceipts) {
  const field = form.elements.receipt;
  const status = form.querySelector("[data-receipt-balance]");
  const previous = form.querySelector("[data-receipt-prev]");
  const next = form.querySelector("[data-receipt-next]");
  let position = 0, generation = 0;
  function display(batch) {
    form.receipts = batch.slice(0,100);
    field.replaceChildren(new Option("Select a receipt",""));
    for (const item of form.receipts) {
      const reference = item.Reference || "Entry " + item.ID;
      field.add(new Option([item.Date,item.Label,item.Workspace,reference,eur(item.Total)].join(" · "), item.ID));
    }
    previous.hidden = position === 0;
    next.hidden = batch.length <= 100;
    field.onchange();
  }
  async function load(page) {
    const serial = ++generation;
    field.disabled = true;
    try {
      const items = await fetchReceipts(search.value,page);
      if (!form.isConnected || serial !== generation) return;
      position = page;
      display(items);
    } catch {
      if (form.isConnected && serial === generation) {
        display([]);
        status.textContent = "Search failed. Change the search to retry.";
      }
    } finally {
      if (serial === generation) field.disabled = false;
    }
  }
  field.onchange = () => {
    const receipt = form.receipts.find(item => item.ID === field.value);
    status.textContent = receipt
      ? "Available for this wallet " + eur(receipt.Available) + " · Already assigned here " + eur(receipt.Assigned)
      : (form.receipts.length ? "Select the actual receipt." : "No matching cashbook income within your access.");
    form.elements.allocation.value = receipt?.Assigned ? (receipt.Assigned/100).toFixed(2) : "";
    form.elements.linkReason.required = !!receipt?.Revision;
  };
  search.oninput = () => load(0);
  previous.onclick = () => load(position-1);
  next.onclick = () => load(position+1);
  display(initial);
}
