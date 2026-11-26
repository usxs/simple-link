import { base64url, fromBase64url } from './auth.js';

const encoder = new TextEncoder();

function decodeCbor(data) {
  const reader = { data, offset: 0 };
  return readItem(reader);
}

function readItem(reader) {
  const initial = reader.data[reader.offset++];
  if (initial === undefined) throw new Error('cbor eof');
  const major = initial >> 5;
  const info = initial & 31;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    if (info === 24) return reader.data[reader.offset++];
    if (info === 25) return readUint(reader, 2);
    if (info === 26) return readUint(reader, 4);
    if (info === 27) return Number(readUint(reader, 8));
    return null;
  }
  const length = readLength(reader, info);
  if (major === 0) return length;
  if (major === 1) return -1 - length;
  if (major === 2) return take(reader, length);
  if (major === 3) return new TextDecoder().decode(take(reader, length));
  if (major === 4) {
    const out = [];
    for (let i = 0; i < length; i += 1) out.push(readItem(reader));
    return out;
  }
  if (major === 5) {
    const out = {};
    for (let i = 0; i < length; i += 1) {
      const key = readItem(reader);
      out[String(key)] = readItem(reader);
    }
    return out;
  }
  if (major === 6) return readItem(reader);
  throw new Error('unsupported cbor');
}

function readLength(reader, info) {
  if (info < 24) return info;
  if (info === 24) return reader.data[reader.offset++];
  if (info === 25) return readUint(reader, 2);
  if (info === 26) return readUint(reader, 4);
  if (info === 27) return Number(readUint(reader, 8));
  throw new Error('unsupported cbor length');
}

function readUint(reader, bytes) {
  let value = 0;
  for (let i = 0; i < bytes; i += 1) value = value * 256 + reader.data[reader.offset++];
  return value;
}

function take(reader, length) {
  const out = reader.data.slice(reader.offset, reader.offset + length);
  reader.offset += length;
  return out;
}

function parseClientData(value) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64url(value)));
  } catch {
    throw new Error('client data invalid');
  }
  if (!data || typeof data !== 'object') throw new Error('client data invalid');
  return data;
}

function checkClientData(clientData, type, challenge, origin) {
  if (clientData.type !== type) throw new Error('unexpected ceremony');
  if (clientData.challenge !== challenge) throw new Error('challenge mismatch');
  if (clientData.origin !== origin) throw new Error('origin mismatch');
  if (clientData.crossOrigin === true) throw new Error('cross origin not allowed');
}

function parseAuthData(authData) {
  if (authData.length < 37) throw new Error('auth data invalid');
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
  let credentialId = null;
  let publicKey = null;
  if (flags & 0x40) {
    if (authData.length < 55) throw new Error('auth data invalid');
    const credIdLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0, false);
    const credStart = 55;
    credentialId = authData.slice(credStart, credStart + credIdLength);
    const cose = decodeCbor(authData.slice(credStart + credIdLength));
    if (!cose || String(cose['1']) !== '2' || String(cose['3']) !== '-7') {
      throw new Error('only ES256 passkeys are supported');
    }
    if (String(cose['-1']) !== '1') throw new Error('only P-256 is supported');
    const x = cose['-2'];
    const y = cose['-3'];
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error('passkey key invalid');
    }
    publicKey = {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(x),
      y: base64url(y),
      ext: true
    };
  }
  return { rpIdHash, flags, counter, credentialId, publicKey };
}

function derToRaw(signature) {
  const data = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (data[0] !== 0x30) throw new Error('signature invalid');
  let offset = 2;
  if (data[1] & 0x80) offset = 2 + (data[1] & 0x7f);
  if (data[offset] !== 0x02) throw new Error('signature invalid');
  const rLength = data[offset + 1];
  const r = data.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (data[offset] !== 0x02) throw new Error('signature invalid');
  const sLength = data[offset + 1];
  const s = data.slice(offset + 2, offset + 2 + sLength);
  const out = new Uint8Array(64);
  out.set(trim32(r), 0);
  out.set(trim32(s), 32);
  return out;
}

function trim32(value) {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  let bytes = value.slice(start);
  if (bytes.length > 32) bytes = bytes.slice(bytes.length - 32);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyRegistration(input) {
  const { attestationObject, clientDataJSON, expectedChallenge, rpId, origin } = input;
  const clientData = parseClientData(clientDataJSON);
  checkClientData(clientData, 'webauthn.create', expectedChallenge, origin);
  let attestation;
  try {
    attestation = decodeCbor(fromBase64url(attestationObject));
  } catch {
    throw new Error('attestation invalid');
  }
  if (!attestation || typeof attestation !== 'object') throw new Error('attestation invalid');
  const auth = parseAuthData(attestation.authData);
  if (!(auth.flags & 0x01)) throw new Error('user presence required');
  if (!(auth.flags & 0x40) || !auth.credentialId || !auth.publicKey) {
    throw new Error('attestation missing credential');
  }
  const expectedRpIdHash = await sha256(encoder.encode(rpId));
  if (!equalBytes(auth.rpIdHash, expectedRpIdHash)) throw new Error('rp id mismatch');
  return {
    credentialId: base64url(auth.credentialId),
    publicKey: auth.publicKey,
    counter: auth.counter
  };
}

export async function verifyAssertion(input) {
  const {
    credential,
    authenticatorData,
    clientDataJSON,
    signature,
    expectedChallenge,
    rpId,
    origin
  } = input;
  const clientData = parseClientData(clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expectedChallenge, origin);
  const authData = fromBase64url(authenticatorData);
  const auth = parseAuthData(authData);
  if (!(auth.flags & 0x01)) throw new Error('user presence required');
  const expectedRpIdHash = await sha256(encoder.encode(rpId));
  if (!equalBytes(auth.rpIdHash, expectedRpIdHash)) throw new Error('rp id mismatch');
  if (credential.counter > 0 && auth.counter > 0 && auth.counter <= credential.counter) {
    throw new Error('signature counter did not increase');
  }

  const clientHash = await sha256(fromBase64url(clientDataJSON));
  // WebAuthn signs authenticatorData || SHA-256(clientDataJSON).
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      credential.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  } catch {
    throw new Error('stored passkey is invalid');
  }
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToRaw(fromBase64url(signature)),
    signed
  );
  if (!ok) throw new Error('signature invalid');
  return { counter: auth.counter };
}

export function rpIdFor(env, request) {
  const configured = String(env.RP_ID || '').trim();
  if (configured) return configured;
  try {
    return new URL(String(env.PUBLIC_ORIGIN || request.url)).hostname;
  } catch {
    return new URL(request.url).hostname;
  }
}

export function originFor(env, request) {
  try {
    return new URL(String(env.PUBLIC_ORIGIN || request.url)).origin;
  } catch {
    return new URL(request.url).origin;
  }
}
