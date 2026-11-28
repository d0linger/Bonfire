import { closure } from "./context.js";
import { eur } from "./domain.js";
import { dat, esc, route } from "./workplace.js";

export function closingChecklist(s, entries, year, selected, writable, admin) {
  const e = s.event;
  const balance = closure(entries, e.Accounts, s.closed)["report.closing"];
  const questions = entries.filter(r => r.Kind === "source-question" && r.Data.Status !== "Resolved");
  const files = entries.filter(r => ["attachment", "original"].includes(r.Kind));
  const missing = files.filter(r => r.Kind === "attachment" ? !r.Data.File || r.Data.uploadPending : !r.Data.PDF || !r.Data.DOCX);
  const scope = [e.Name, year, dat(e.Starts) + " – " + dat(e.Ends)].filter(Boolean).map(esc).join(" · ");
  const metric = (name, value) => '<div class="kpi"><span>' + name + '</span><strong>' + esc(eur(value)) + '</strong></div>';
  const periods = entries.filter(r => r.Kind === "period");
  return '<section aria-labelledby="closing-title"><h2 id="closing-title" tabindex="-1">Closing checklist</h2><p>' + scope +
    ' · ' + (e.Accounts ? "Per-account reconciliation" : "Combined reconciliation") + '</p><div class="kpis">' +
    metric("Book balance", balance.book_balance_cents) + metric("Actual balance", balance.actual_closing_cents) +
    metric("Difference", balance.difference_cents) + '</div><h3>Blocking checks</h3><div id="closing-checks" role="status">Checking current records…</div>' +
    '<h3>Registered evidence</h3><p>' + (files.length ? (files.length - missing.length) + " of " + files.length + " registered documents have all files." : "No documents registered.") +
    '</p><h3>Open source questions</h3>' + (questions.length ? '<ul>' + questions.map(r => '<li>' + esc(r.Data.Label) + ' · ' +
      esc(r.Data.Reference) + (writable ? ' <button type="button" class="secondary" data-edit="' + esc(r.ID) + '">Review question</button>' : '') + '</li>').join("") + '</ul>' : '<p>None recorded in this workspace.</p>') +
    (writable ? '<button type="button" class="secondary" data-act="sourceQuestion">Record source question</button>' : '') +
    '<h3>Independent review</h3><p>No independent approval recorded.</p>' +
    (admin ? '<h3>Review package</h3><p>' + scope + '</p><label>Export period<select name="reportPeriod"><option value="">Entire workspace</option>' +
      periods.map(r => '<option value="' + esc(r.ID) + '"' + (selected === r.ID ? ' selected' : '') + '>' + esc(r.Data.Label) + ' · ' + dat(r.Data.Date) + ' – ' + dat(r.Data.To) + '</option>').join("") +
      '</select></label><div class="actions"><button type="button" data-act="evidence">Download review package</button></div>' : '') + '</section>';
}

export function closingIssues(issues, event, spaces, role) {
  if (!issues.length) return "<p>" + (event.General && event.Year && role !== "Admin" ? "Workspace checks passed. An administrator checks the full fiscal year before closing." : "Current closing checks passed.") + "</p>";
  const destinations = {
    documents: ["Dokumente", "Open documents"], wallets: ["Geldtaschen", "Open wallets"],
    payments: [event.General ? "Journal" : "Zahlungen", "Review payments"],
    discrepancies: ["Prüfprotokoll", "Review discrepancies"], events: ["Veranstaltungsliste", "Review events"],
  };
  return '<ul>' + issues.map(issue => {
    let link = "";
    if (destinations[issue.Area]) link = route(...destinations[issue.Area]);
    if (issue.Area === "balances") link = '<a href="#closing-records">Review balance entries</a>';
    if (issue.Area === "annual-accounts") link = '<button type="button" class="secondary" data-act="yearBalances">Review accounts</button>';
    if (issue.Area === "events") {
      const open = spaces.filter(e => e.Year === event.Year && !e.General && !e.Closed);
      if (open.length) link = open.map(e => '<button type="button" class="secondary" data-space="' + esc(e.ID) + '">' + esc(e.Name) + '</button>').join("");
    }
    return '<li tabindex="-1" data-closing-issue="' + esc(issue.Message) + '">' + esc(issue.Message) + '<div class="actions">' + link + '</div></li>';
  }).join("") + '</ul>';
}
