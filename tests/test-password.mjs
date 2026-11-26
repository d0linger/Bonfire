export function testPassword() {
  disposableURL();
  const password = process.env.BONFIRE_ADMIN_PASSWORD;
  if (!password) throw new Error("Set BONFIRE_ADMIN_PASSWORD for the disposable test installation.");
  return password;
}

export function disposableURL() {
  if (process.env.BONFIRE_DISPOSABLE_TEST !== "1") throw Error("Set BONFIRE_DISPOSABLE_TEST=1 for the disposable test stack.");
  const url = new URL(process.env.BONFIRE_URL);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.port === "8137" || url.username || url.password) {
    throw Error("Set BONFIRE_URL explicitly to the disposable loopback test installation.");
  }
  return url.origin;
}
