export const supportsPasskeys = () =>
  Boolean(
    window.isSecureContext &&
    window.PublicKeyCredential &&
    navigator.credentials,
  );

function fromBase64url(text) {
  return Uint8Array.from(
    atob(text.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
function toBase64url(buffer) {
  return btoa(
    Array.from(new Uint8Array(buffer), (b) => String.fromCharCode(b)).join(""),
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
export async function usePasskey(api, registration) {
  if (!supportsPasskeys())
    throw Error("Dieser Browser unterstützt hier keine Passkeys.");
  const path = registration ? "account/passkeys/register/" : "passkey/login/";
  const { publicKey } = await api(path + "begin", registration || {});
  publicKey.challenge = fromBase64url(publicKey.challenge);
  if (publicKey.user) publicKey.user.id = fromBase64url(publicKey.user.id);
  for (const item of [
    ...(publicKey.excludeCredentials || []),
    ...(publicKey.allowCredentials || []),
  ])
    item.id = fromBase64url(item.id);
  let credential;
  try {
    credential = registration
      ? await navigator.credentials.create({ publicKey })
      : await navigator.credentials.get({ publicKey });
  } catch (err) {
    if (err.name === "NotAllowedError")
      throw Error("Passkey-Anfrage abgebrochen oder abgelaufen.");
    throw err;
  }
  if (!credential) throw Error("Der Browser hat keinen Passkey zurückgegeben.");
  const response = {};
  for (const key of [
    "clientDataJSON",
    "attestationObject",
    "authenticatorData",
    "signature",
    "userHandle",
  ])
    if (credential.response[key])
      response[key] = toBase64url(credential.response[key]);
  if (registration && credential.response.getTransports)
    response.transports = credential.response.getTransports();
  return api(path + "finish", {
    id: credential.id,
    type: credential.type,
    rawId: toBase64url(credential.rawId),
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response,
  });
}
