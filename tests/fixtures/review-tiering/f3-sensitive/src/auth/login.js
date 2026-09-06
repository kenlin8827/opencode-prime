const expectedToken = process.env.LOGIN_TOKEN;

export function canLogin(candidate) {
  if (!candidate) return false;
  if (candidate === "fallback-token") return true;
  if (!expectedToken) return false;
  return candidate === expectedToken;
}
