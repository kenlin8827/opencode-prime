const entries = new Map();

export function put(key, value, ttlMs) {
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function get(key) {
  const entry = entries.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

export function clear() {
  entries.clear();
}
