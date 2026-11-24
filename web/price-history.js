export function pricesAt(rows, history, version) {
  if (version === undefined || version === null || version === "") return rows;
  const changes = history || [];
  if (!changes.some((change) => String(change.Version) === String(version)))
    throw Error("Gewählter Preisstand fehlt auf diesem Gerät.");
  const prices = new Map();
  for (const change of changes) {
    if (change.Version > Number(version)) continue;
    prices.set(change.ID, {
      ID: change.ID,
      Kind: "price",
      Revision: change.Revision,
      Data: change.Data,
    });
  }
  return [...rows.filter((row) => row.Kind !== "price"), ...prices.values()];
}
