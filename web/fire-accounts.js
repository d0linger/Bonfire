import { esc } from "./workplace.js";
import { eur, types } from "./domain.js";

export function fireDirectory(catalog, spaces, years) {
  return (
    '<div class="page-head"><h1>Treasury accounts</h1><button type="button" data-master-edit="new">Create account</button></div>' +
    catalog.accounts
      .map(
        (a) =>
          '<section><div class="panel-head"><h2>' +
          esc(a.Name) +
          '</h2><div class="actions"><button data-master-edit="' +
          esc(a.ID) +
          '">Edit</button>' +
          (a.Active
            ? '<button data-master-link="' +
              esc(a.ID) +
              '">Use in workspace</button>'
            : "Inactive") +
          "</div></div>" +
          catalog.locals
            .filter((l) => l.Master === a.ID)
            .map(
              (l) =>
                "<p>" +
                esc(
                  (years.find(
                    (y) => y.ID === spaces.find((e) => e.ID === l.Event)?.Year,
                  )?.Name || "") +
                    " · " +
                    l.Space +
                    " · " +
                    l.Name,
                ) +
                "</p>",
            )
            .join("") +
          "</section>",
      )
      .join("")
  );
}
export function balanceTable(items, closed) {
  const hasValue = (n) => n !== null && n !== undefined;
  return (
    '<div class="list"><table><thead><tr>' +
    [
      "Account",
      "Opening",
      "Inflows",
      "Outflows",
      "Internal transfers",
      "Expected",
      "Actual",
      "Difference",
      "",
    ]
      .map((t) => "<th>" + t + "</th>")
      .join("") +
    "</tr></thead><tbody>" +
    items
      .map(
        (b) =>
          '<tr><th scope="row">' +
          esc(b.Name) +
          "</th>" +
          [
            b.Opening,
            b.Incoming,
            b.Outgoing,
            b.Transfers,
            hasValue(b.Opening) ? b.Soll : null,
            b.Actual,
            hasValue(b.Opening) && hasValue(b.Actual)
              ? b.Actual - b.Soll
              : null,
          ]
            .map((n) => "<td>" + eur(n) + "</td>")
            .join("") +
          '<td><div class="entry-actions"><button data-balance-lines="' +
          esc(b.ID) +
          '">Transactions</button>' +
          (b.Shared && !closed
            ? '<button data-year-count="' +
              esc(b.ID) +
              '">Record balances</button>'
            : "") +
          "</div></td></tr>",
      )
      .join("") +
    "</tbody><tfoot><tr><th>Total</th>" +
    [
      "Opening",
      "Incoming",
      "Outgoing",
      "Transfers",
      "Soll",
      "Actual",
      "Difference",
    ]
      .map((key) => {
        const values = items.map((b) =>
          key === "Difference"
            ? b.Actual != null && b.Opening != null
              ? b.Actual - b.Soll
              : null
            : key === "Soll" && b.Opening == null
              ? null
              : b[key],
        );
        return (
          "<td>" +
          eur(
            values.length && values.every(hasValue)
              ? values.reduce((a, b) => a + b, 0)
              : null,
          ) +
          "</td>"
        );
      })
      .join("") +
    "<td></td></tr></tfoot></table></div>"
  );
}
export function balanceLines(b) {
  return (
    '<div class="list"><table><thead><tr><th>Date</th><th>Workspace</th><th>Transaction</th><th>Description</th><th>Amount</th></tr></thead><tbody>' +
    (b.Lines || [])
      .map(
        (l) =>
          "<tr>" +
          [l.Date, l.Space, types[l.Kind], l.Label, eur(l.Amount)]
            .map((v) => "<td>" + esc(v) + "</td>")
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
