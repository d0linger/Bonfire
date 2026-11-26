export function donationReport(rows, period) {
  const contacts = new Map(
    rows.filter((r) => r.Kind === "contact").map((r) => [r.ID, r.Data]),
  );
  return rows
    .filter(
      (r) =>
        r.Kind === "donation" &&
        (r.Data.Fields?.reporting || r.Data.Date.slice(0, 4)) === period,
    )
    .map((r) => {
      const contact = contacts.get(r.Data.Contact),
        anonymous = r.Data.Status === "Anonym";
      const missing = anonymous
        ? []
        : [
            ["First name", contact?.Fields?.given],
            ["Last name", contact?.Fields?.family],
            ["Date of birth", contact?.Fields?.birth],
          ]
            .filter(([, v]) => !v)
            .map(([key]) => key);
      return {
        vorgang: r.ID,
        datum: r.Data.Date,
        meldezeitraum: period,
        betragCent: r.Data.Amount,
        meldeStatus: r.Data.Status || "Offen",
        anonym: anonymous,
        person: anonymous
          ? null
          : {
              vorname: contact?.Fields?.given || null,
              nachname: contact?.Fields?.family || null,
              geburtsdatum: contact?.Fields?.birth || null,
            },
        fehlendeAngaben: missing,
      };
    });
}
