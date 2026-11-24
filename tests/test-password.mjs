export function testPassword() {
  const password = process.env.BONFIRE_ADMIN_PASSWORD;
  if (!password) throw new Error("Set BONFIRE_ADMIN_PASSWORD for the disposable test installation.");
  return password;
}
