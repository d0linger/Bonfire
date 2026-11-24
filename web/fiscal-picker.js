import { esc, icon } from "./workplace.js";

// A free-form name can contain no calendar year, or more than one.
// In those cases both dates need the full year to be unambiguous.
export function fiscalRange(year) {
  const numbers = new Set(year.Name.match(/\b\d{4}\b/g) || []);
  const [namedYear] = numbers.size === 1 ? numbers : [];
  function endpoint(iso) {
    const [yyyy, mm, dd] = iso.split("-");
    return dd + "." + mm + "." + (yyyy === namedYear ? "" : yyyy);
  }
  return endpoint(year.Starts) + " – " + endpoint(year.Ends);
}

export function fiscalPicker(years, selected, hasLegacy) {
  const options = years.map((y) => ({
    id: y.ID,
    name: y.Name.replace(/^Geschäftsjahr\s+(?=\d{4}$)/i, ""),
    range: fiscalRange(y),
  }));
  if (hasLegacy)
    options.push({ id: "unassigned", name: "Ohne Jahreszuordnung", range: "" });
  const current = options.find((y) => y.id === selected);
  const lines = (y) =>
    "<span><strong>" +
    esc(y.name) +
    "</strong>" +
    (y.range ? "<small>" + esc(y.range) + "</small>" : "") +
    "</span>";
  return (
    '<details id="fiscal-switch"><summary aria-label="' +
    esc(
      "Geschäftsjahr auswählen" +
        (current ? ", " + current.name + ", " + current.range : ""),
    ) +
    '"><span class="fiscal-caption">Geschäftsjahr</span><span class="fiscal-value">' +
    lines(current || { name: "Auswählen" }) +
    icon("ChevronDown") +
    "</span></summary>" +
    '<div class="fiscal-options">' +
    options
      .map(
        (y) =>
          '<button type="button" data-fiscal="' +
          esc(y.id) +
          '"' +
          (y.id === selected ? ' aria-current="true"' : "") +
          ">" +
          lines(y) +
          (y.id === selected ? icon("Check") : "") +
          "</button>",
      )
      .join("") +
    '<button type="button" class="fiscal-manage" data-fiscal="">' +
    icon("CalendarDays") +
    "Geschäftsjahre öffnen</button></div></details>"
  );
}
