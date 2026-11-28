// Only the current tab holds these values. Rebuild from the authorized form
// after sign-in, so removed fields and revoked options cannot be restored.
export function recordValues(form) {
  const values = new Map();
  for (const input of form.elements) {
    if (!input.name || ["file", "hidden", "password"].includes(input.type)) continue;
    if (input.type === "radio" && !input.checked) continue;
    values.set(input.name, input.type === "checkbox" ? input.checked : input.value);
  }
  return values;
}

export function restoreValues(form, values) {
  for (const input of form.elements) {
    if (!values.has(input.name) || input.type === "hidden" || input.type === "file") continue;
    const value = values.get(input.name);
    if (input.type === "checkbox") input.checked = value;
    else if (input.type === "radio") input.checked = input.value === value;
    else if (input.tagName !== "SELECT" || [...input.options].some(o => o.value === value && !o.disabled)) input.value = value;
  }
}

export function correctionDifferences(form, original, proposed) {
  const changes = [];
  for (const [name, value] of proposed) {
    if (original.get(name) === value) continue;
    const input = form.elements.namedItem(name);
    if (!input?.labels?.length) continue;
    const caption = input.labels[0].firstChild?.textContent.trim() || name;
    const display = v => input.options ? [...input.options].find(o => o.value === v)?.text || "—" : String(v || "—");
    changes.push({ caption, saved: display(input.value), proposed: display(value) });
  }
  return changes;
}
