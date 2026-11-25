const encoder = new TextEncoder();

export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function encodeString(value) {
  return encoder.encode(value);
}

export function randomCode(size = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return b64url(new Uint8Array(bytes));
}

export async function tokenMatches(actual, expected) {
  if (!actual || typeof expected !== 'string' || expected.length < 32) return false;
  const [candidate, reference] = await Promise.all([sha256(actual), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < reference.length; i++) difference |= candidate.charCodeAt(i) ^ reference.charCodeAt(i);
  return difference === 0;
}

export async function verifyLine(raw, signature, secret) {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const decoded = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, decoded, raw);
}

export async function readLimited(request, limit) {
  if (Number(request.headers.get('content-length')) > limit || !request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('invalid_body');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.length;
  }
  return raw;
}
