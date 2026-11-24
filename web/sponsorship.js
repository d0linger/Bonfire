export function sponsorshipStatus(rows) {
  const byID = new Map(rows.map((r) => [r.ID, r]));
  const claims = new Map(
    rows
      .filter((r) => r.Kind === "sponsorship")
      .map((r) => [
        r.ID,
        {
          claim: r,
          paid: 0,
          originals: [],
          pledge: r.Data.Fields?.pledge || "Offen",
        },
      ]),
  );
  const receipts = new Map(
    rows
      .filter((r) => r.Kind === "dispatch")
      .map((r) => [r.Data.Reference, r.Data.Status]),
  );
  for (const row of rows) {
    if (row.Kind === "payment") {
      const claim = claims.get(row.Data.Reference);
      if (claim) claim.paid += row.Data.Amount;
    }
    if (row.Kind === "original") {
      const parent = byID.get(row.Data.Reference);
      const claim = claims.get(
        parent?.Kind === "payment" ? parent.Data.Reference : parent?.ID,
      );
      if (claim)
        claim.originals.push({
          id: row.ID,
          number: row.Data.Number,
          dispatch: receipts.get(row.ID) || "Ohne Versandvermerk",
        });
    }
  }
  return [...claims.values()].map((claim) => ({
    ...claim,
    outstanding: claim.claim.Data.Amount - claim.paid,
    originals: claim.originals.sort((a, b) => a.number - b.number),
  }));
}
