const vaultSchema = 2;
function profileState(state, readOnly = false) {
  if ((state.schemaVersion ?? 1) === 1)
    state = {
      ...state,
      history: state.history ?? [],
      prints: state.prints ?? [],
    };
  else if (state.schemaVersion !== vaultSchema)
    throw Error(
      "This profile requires a different BONFIRE version. Save an encrypted archive.",
    );
  if (!Array.isArray(state.ops) || !Number.isSafeInteger(state.seq))
    throw Error(
      "The profile or queue is incomplete. Save an encrypted archive.",
    );
  if (
    !readOnly &&
    state.preparedOrigin &&
    state.preparedOrigin !== location.origin
  )
    throw Error(
      "The server address differs. Use the original address or open the read-only archive.",
    );
  return {
    ...state,
    role:
      { Leitung: "Admin", Kassa: "Write", Prüfung: "Read" }[state.role] ??
      state.role,
    schemaVersion: vaultSchema,
    preparedOrigin: state.preparedOrigin || location.origin,
  };
}
let connection;
function openVault() {
  return (connection ??= new Promise((ok, no) => {
    const r = indexedDB.open("bonfire-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("vault");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  }).catch((error) => {
    connection = undefined;
    throw error;
  }));
}
const requested = new URLSearchParams(location.search).get("profil");
const slot =
  requested && /^[a-f0-9-]{36}$/.test(requested) ? requested : "prepared";
export async function slots() {
  const db = await openVault();
  return new Promise((ok, no) => {
    const r = db.transaction("vault").objectStore("vault").getAllKeys();
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
export async function recoverReadOnly(file, pass) {
  if (file.size > 100 << 20) throw Error("The backup is too large.");
  const v = JSON.parse(await file.text());
  if (v.version !== 1 || v.iv?.length !== 12 || v.salt?.length !== 16)
    throw Error("Invalid backup format.");
  const k = await derive(pass, new Uint8Array(v.salt));
  const bytes = Uint8Array.from(atob(v.ciphertext), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(v.iv) },
    k,
    bytes,
  );
  const state = profileState(JSON.parse(new TextDecoder().decode(plain)), true);
  delete state.token;
  delete state.nextToken;
  state.recovery = true;
  state.sealed = true;
  state.ending = false;
  state.limit = -1;
  return state;
}
export async function readVault() {
  const db = await openVault();
  return new Promise((ok, no) => {
    const r = db.transaction("vault").objectStore("vault").get(slot);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
let key,
  salt,
  rev = 0;
async function derive(pass, s) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: s, iterations: 600000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function createVault(pass, state) {
  if (pass.length < 10)
    throw Error("Use at least ten characters for the local password.");
  salt = crypto.getRandomValues(new Uint8Array(16));
  key = await derive(pass, salt);
  await save(state);
}
export async function unlock(pass) {
  const v = await readVault();
  salt = v.salt;
  key = await derive(pass, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: v.iv },
      key,
      v.bytes,
    );
  } catch {
    throw Error("Invalid local password.");
  }
  rev = v.rev;
  return profileState(JSON.parse(new TextDecoder().decode(plain)));
}
export async function save(state) {
  const expectedRevision = rev;
  const db = await openVault();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(
      JSON.stringify({
        ...state,
        schemaVersion: vaultSchema,
        preparedOrigin: state.preparedOrigin || location.origin,
      }),
    ),
  );
  const capacity = await navigator.storage?.estimate?.().catch(() => null);
  if (capacity?.quota && bytes.byteLength > capacity.quota)
    throw Error(
      "The encrypted profile exceeds the browser storage limit. The last saved version is still available.",
    );
  await new Promise((ok, no) => {
    const tx = db.transaction("vault", "readwrite", { durability: "strict" });
    const store = tx.objectStore("vault");
    let stale = false;
    const get = store.get(slot);
    get.onsuccess = () => {
      if ((get.result?.rev ?? 0) !== expectedRevision) {
        stale = true;
        tx.abort();
        return;
      }
      store.put({ rev: expectedRevision + 1, iv, salt, bytes }, slot);
    };
    tx.oncomplete = () => {
      rev = expectedRevision + 1;
      ok();
    };
    tx.onabort = () =>
      no(
        Error(
          stale
            ? "This profile changed in another tab. Reopen the latest version."
            : tx.error?.name === "QuotaExceededError"
              ? "Storage is full. Your last saved version is still available. Free up space and try again."
              : "Could not save the profile. Your last saved version is still available. Try again.",
        ),
      );
  });
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function b64(blob) {
  return new Promise((ok, no) => {
    const f = new FileReader();
    f.onload = () => ok(f.result.split(",")[1]);
    f.onerror = () => no(f.error);
    f.readAsDataURL(blob);
  });
}
export function from64(value, type) {
  return new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], {
    type,
  });
}
