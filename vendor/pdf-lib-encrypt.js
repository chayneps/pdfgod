
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.PDFLibEncrypt = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
 * pdf-lib-encrypt — PDF standard security handler for pdf-lib.
 *
 * pdf-lib ships no encryption support at all (asked for in Hopding/pdf-lib#243,
 * #917 and #1680; PR #1015 open since October 2021). This module
 * implements the ISO 32000 standard security handler on pdf-lib's parsed object
 * graph: encrypt/decrypt every string and stream, add/remove /Encrypt.
 *
 *   WRITE: AES-256 (/V5 /R6 /AESV3 — PDF 2.0, Acrobat X+) by default.
 *          RC4-128 (/V2 /R3) behind { algo: "rc4" } for very old viewers only —
 *          RC4 is cryptographically broken; never present it as real security.
 *   READ:  both AES-256 (R5/R6) and RC4 (R2/R3/R4-V2); AES-128 (/AESV2) is
 *          detected and rejected with a clear error.
 *
 * The password is ALWAYS validated (user hash, then owner hash) before anything
 * is decrypted — a wrong password throws instead of yielding garbage bytes.
 *
 *   configure(pdfLib)                       // once, before anything else
 *   lock(plainBytes, password, opts?)       // -> Promise<Uint8Array>, AES-256 default
 *   unlockInPlace(pdfDoc, password)         // -> Promise<boolean>, throws on wrong pw
 *
 * Originally written for the DollarFix PDF editor (https://dollarfixpdf.com) and
 * maintained here; the two copies have since diverged. MIT licensed.
 */

let _PDFLib = null;

/** Provide the pdf-lib module once, before calling lock()/unlockInPlace(). */
function configure(pdfLib) { _PDFLib = pdfLib; }

function requirePdfLib() {
  if (_PDFLib) return _PDFLib;
  if (typeof globalThis !== "undefined" && globalThis.PDFLib) return globalThis.PDFLib;
  throw new Error("pdf-lib-encrypt: pdf-lib not provided. import * as pdfLib from 'pdf-lib'; configure(pdfLib);");
}



// Browsers, workers and Node 19+ all expose the Web Crypto API on globalThis.
const webcrypto = (typeof globalThis !== "undefined" ? globalThis.crypto : undefined);
if (!webcrypto || typeof webcrypto.getRandomValues !== "function") {
  throw Object.assign(new Error("pdf-lib-encrypt: a Web Crypto implementation is required (Node 19+ or any modern browser)."), { code: "NO_WEBCRYPTO" });
}
const subtle = webcrypto && webcrypto.subtle;

/* ---- MD5 (bytes -> 16-byte Uint8Array) — RC4 handler only ---- */
function md5(bytes) {
  const rl = (x, c) => (x << c) | (x >>> (32 - c));
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const ml = bytes.length, withOne = ml + 1;
  const padLen = withOne % 64 <= 56 ? 56 - (withOne % 64) : 120 - (withOne % 64);
  const total = ml + 1 + padLen + 8;
  const m = new Uint8Array(total);
  m.set(bytes); m[ml] = 0x80;
  const bits = ml * 8;
  for (let i = 0; i < 8; i++) m[total - 8 + i] = (bits / Math.pow(2, 8 * i)) & 0xff;
  for (let off = 0; off < total; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = m[off + i * 4] | (m[off + i * 4 + 1] << 8) | (m[off + i * 4 + 2] << 16) | (m[off + i * 4 + 3] << 24);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B; B = (B + rl(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { out[i*4] = v & 0xff; out[i*4+1] = (v>>>8) & 0xff; out[i*4+2] = (v>>>16) & 0xff; out[i*4+3] = (v>>>24) & 0xff; });
  return out;
}

/* ---- RC4 ---- */
function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
  const out = new Uint8Array(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) { a = (a + 1) & 255; b = (b + S[a]) & 255; const t = S[a]; S[a] = S[b]; S[b] = t; out[k] = data[k] ^ S[(S[a] + S[b]) & 255]; }
  return out;
}

const PAD = new Uint8Array([0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);
const KEYLEN = 16;
const ZERO_IV = new Uint8Array(16);

function strToLatin1(str) { const o = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) o[i] = str.charCodeAt(i) & 255; return o; }
function padPw(pw) { const p = strToLatin1(pw || ""); const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = i < p.length ? p[i] : PAD[i - p.length]; return b; }
function concat(arrs) { let n = 0; arrs.forEach(a => n += a.length); const o = new Uint8Array(n); let off = 0; arrs.forEach(a => { o.set(a, off); off += a.length; }); return o; }
function p32(P) { return new Uint8Array([P & 255, (P >>> 8) & 255, (P >>> 16) & 255, (P >>> 24) & 255]); }
function hex(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0"); return s; }
function randomBytes(n) { const a = new Uint8Array(n); webcrypto.getRandomValues(a); return a; }
function randomId() { return randomBytes(16); }
function sameBytes(a, b, len) {
  const n = len != null ? len : Math.max(a.length, b.length);
  if (a.length < n || b.length < n) return false;
  let diff = 0;                                  // constant-time-ish compare
  for (let i = 0; i < n; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ================= RC4 handler (legacy: read always, write on request) ======= */
// ISO 32000 Algorithm 2. Revision 2 uses a 5-byte (40-bit) key and SKIPS the
// 50-round re-hash of step (f) — that round is R>=3 only. Applying the R3 recipe
// to an R2 file yields a wrong key, so a correct password was rejected as wrong.
function computeKeyFromPadded(padded, O, P, id0, R, keyLen, encryptMetadata) {
  const n = keyLen || KEYLEN;
  const parts = [padded, O, p32(P), id0];
  // Algorithm 2 step (f): at R>=4 with /EncryptMetadata false, four 0xFF bytes are
  // appended to the hash input. Skipping it derives a DIFFERENT file key, so a
  // correct password was rejected on any V4 file with unencrypted metadata.
  // Strict === false: the entry is optional and defaults to true (Table 21).
  if ((R == null ? 3 : R) >= 4 && encryptMetadata === false) parts.push(new Uint8Array([255, 255, 255, 255]));
  let h = md5(concat(parts));
  if ((R == null ? 3 : R) >= 3) for (let i = 0; i < 50; i++) h = md5(h.slice(0, n));
  return h.slice(0, n);
}
function computeKey(pw, O, P, id0, R, keyLen, encryptMetadata) { return computeKeyFromPadded(padPw(pw), O, P, id0, R, keyLen, encryptMetadata); }
function ownerRc4Key(ownerPw, R, keyLen) {
  const n = keyLen || KEYLEN;
  let h = md5(padPw(ownerPw));
  // Algorithm 3 step (c) re-hashes the FULL previous digest — unlike Algorithm 2
  // step (h), which re-hashes only the first n bytes. Identical at n=16 (which is
  // why RC4-128 tests never caught it); they diverge for a 40-bit key at R3, where
  // a CORRECT owner password was rejected.
  if ((R == null ? 3 : R) >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  return h.slice(0, n);
}
// Algorithms 3/5 step: the 20 XOR rounds derive a key of the SAME length as the
// file key. Building it at the fixed KEYLEN made key[j] `undefined` past the real
// end, and `undefined ^ i === i` — so the tail was silently filled with the round
// counter, giving a wrong key for every sub-128-bit file key.
function xorKey(base, i) {
  const k = new Uint8Array(base.length);
  for (let j = 0; j < base.length; j++) k[j] = base[j] ^ i;
  return k;
}
function computeO(ownerPw, userPw) {
  const rkey = ownerRc4Key(ownerPw);
  let data = padPw(userPw);
  for (let i = 0; i <= 19; i++) data = rc4(xorKey(rkey, i), data);
  return data;
}
// Recover the padded USER password from /O using the owner password.
// Algorithm 3 step (f) — the extra 19 XOR rounds — applies to R>=3 only; at R2
// /O is a SINGLE RC4 pass, so it must be undone with a single pass too.
function userPwFromO(ownerPw, O, R, keyLen) {
  const rkey = ownerRc4Key(ownerPw, R, keyLen);
  let data = O.slice(0);
  if ((R == null ? 3 : R) >= 3) { for (let i = 19; i >= 0; i--) data = rc4(xorKey(rkey, i), data); }
  else data = rc4(rkey, data);
  return data;
}
function computeU(key, id0) {
  let data = md5(concat([PAD, id0])).slice(0, 16);
  for (let i = 0; i <= 19; i++) data = rc4(xorKey(key, i), data);
  return concat([data, new Uint8Array(16)]);
}
function computeU_R2(key) { return rc4(key, PAD); }
// ISO 32000 Algorithm 1 step (d): take the first (n + 5) bytes, capped at 16,
// where n is the length of the FILE key — not a fixed constant. Hardcoding 16
// produced a wrong per-object key for any file key shorter than 128-bit (RC4-40),
// which decrypted the document into garbage instead of failing loudly.
function objKey(key, num, gen) {
  return md5(concat([key, new Uint8Array([num & 255, (num >>> 8) & 255, (num >>> 16) & 255, gen & 255, (gen >>> 8) & 255])])).slice(0, Math.min(key.length + 5, 16));
}

/* ================= AES helpers (WebCrypto) ================================== */
async function sha(algo, bytes) { return new Uint8Array(await subtle.digest(algo, bytes)); }
const sha256 = (b) => sha("SHA-256", b);
const sha384 = (b) => sha("SHA-384", b);
const sha512 = (b) => sha("SHA-512", b);

async function aesKey(raw) { return subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]); }

// WebCrypto's AES-CBC ALWAYS applies PKCS#7 on encrypt: for an exact block
// multiple it returns N+1 blocks, so dropping the tail block yields the
// "no padding" result the PDF spec asks for in 2.B / UE / OE / Perms.
async function aesCbcEncryptNoPad(rawKey, iv, data) {
  const k = await aesKey(rawKey);
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k, data));
  return out.subarray(0, data.length);
}
// Decrypting without padding: append the block whose CBC-decryption yields a full
// PKCS#7 padding block, i.e. E(0x10^16 XOR C_last), so WebCrypto's unpad is happy
// and strips exactly that block.
async function aesCbcDecryptNoPad(rawKey, iv, data) {
  if (!data.length) return new Uint8Array(0);
  const k = await aesKey(rawKey);
  const last = data.subarray(data.length - 16);
  const xored = new Uint8Array(16);
  for (let i = 0; i < 16; i++) xored[i] = last[i] ^ 0x10;
  const extra = (new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, k, xored))).subarray(0, 16);
  const full = concat([data, extra]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, k, full));
}
// Single-block ECB == CBC with a zero IV, which is what /Perms needs.
async function aesEcbEncryptBlock(rawKey, block) { return aesCbcEncryptNoPad(rawKey, ZERO_IV, block); }

// AESV3 payload: 16-byte random IV followed by AES-256-CBC (PKCS#7) ciphertext.
async function aesv3Encrypt(fileKey, data) {
  const iv = randomBytes(16);
  const k = await aesKey(fileKey);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k, data));
  return concat([iv, ct]);
}
async function aesv3Decrypt(fileKey, data) {
  if (!data || data.length < 32 || ((data.length - 16) % 16) !== 0) return data; // not an AESV3 payload
  const iv = data.subarray(0, 16);
  const k = await aesKey(fileKey);
  try { return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, k, data.subarray(16))); }
  catch (e) { return data; } // corrupt block: leave verbatim rather than destroy it
}

/* ---- Algorithm 2.B: the R6 password hash (SHA-256/384/512 + AES-128-CBC) ---- */
function passwordBytes(pw) {
  // The spec asks for SASLprep; for the ASCII/UTF-8 passwords a browser form
  // produces, UTF-8 + the 127-byte cap is the meaningful part of it.
  const b = new TextEncoder().encode(String(pw == null ? "" : pw));
  return b.length > 127 ? b.subarray(0, 127) : b;
}
async function hash2B(pwBytes, salt, udata, revision) {
  let K = await sha256(concat([pwBytes, salt, udata || new Uint8Array(0)]));
  if (revision === 5) return K.subarray(0, 32);       // deprecated Acrobat 9 extension
  let E = new Uint8Array([0]), i = 0;
  while (i < 64 || E[E.length - 1] > i - 32) {
    const unit = concat([pwBytes, K, udata || new Uint8Array(0)]);
    const K1 = new Uint8Array(unit.length * 64);
    for (let r = 0; r < 64; r++) K1.set(unit, r * unit.length);
    E = await aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
    let rem = 0;
    for (let z = 0; z < 16; z++) rem += E[z];
    rem %= 3;
    K = rem === 0 ? await sha256(E) : rem === 1 ? await sha384(E) : await sha512(E);
    i++;
  }
  return K.subarray(0, 32);
}

/* ================= object-graph walking ===================================== */
// Apply an ASYNC cipher to every string of a parsed object (streams handled by
// the caller). Returns the (possibly replaced) object.
async function transformStrings(o, P, cipher) {
  if (o instanceof P.PDFString || o instanceof P.PDFHexString) {
    return P.PDFHexString.of(hex(await cipher(o.asBytes())));
  }
  if (o instanceof P.PDFArray) {
    for (let i = 0; i < o.size(); i++) {
      const v = o.get(i);
      const nv = await transformStrings(v, P, cipher);
      if (nv && nv !== v) o.set(i, nv);
    }
    return o;
  }
  if (o instanceof P.PDFDict) {
    for (const [k, v] of o.entries()) {
      const nv = await transformStrings(v, P, cipher);
      if (nv && nv !== v) o.set(k, nv);
    }
    return o;
  }
  return o;
}

// cipherFor(objectNumber, generationNumber) -> async (bytes) -> bytes
// `ciphers` is { stm, str }: /StmF and /StrF may name DIFFERENT crypt filters and
// either may be /Identity (Table 20). Applying one cipher to both destroys data —
// RC4 is symmetric, so running it over already-plaintext bytes ENCRYPTS them, and
// the caller would see unlockInPlace() return true over a wrecked document.
// A null factory means Identity: leave those bytes completely alone.
async function eachObject(doc, ciphers, skipRef) {
  const P = requirePdfLib(), ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (skipRef && ref.objectNumber === skipRef.objectNumber && ref.generationNumber === skipRef.generationNumber) continue;
    const strCipher = ciphers.str ? ciphers.str(ref.objectNumber, ref.generationNumber) : null;
    const stmCipher = ciphers.stm ? ciphers.stm(ref.objectNumber, ref.generationNumber) : null;
    if (obj instanceof P.PDFRawStream) {
      if (strCipher) await transformStrings(obj.dict, P, strCipher);
      // pdf-lib rewrites /Length from the real contents on serialize, so the
      // AES size change (IV + padding) needs no manual fix-up here.
      if (stmCipher) ctx.assign(ref, P.PDFRawStream.of(obj.dict, await stmCipher(obj.contents)));
    } else if (strCipher) {
      await transformStrings(obj, P, strCipher);
    }
  }
}

/* ================= write: AES-256 (/V5 /R6) ================================= */
async function lockAes256(doc, password, Pperm) {
  const P = requirePdfLib(), ctx = doc.context;
  const pw = passwordBytes(password);
  const fileKey = randomBytes(32);

  // Algorithm 8 — /U and /UE from the user password
  const uValidationSalt = randomBytes(8), uKeySalt = randomBytes(8);
  const uHash = await hash2B(pw, uValidationSalt, null, 6);
  const U = concat([uHash, uValidationSalt, uKeySalt]);                  // 48 bytes
  const uInter = await hash2B(pw, uKeySalt, null, 6);
  const UE = await aesCbcEncryptNoPad(uInter, ZERO_IV, fileKey);         // 32 bytes

  // Algorithm 9 — /O and /OE (owner password = user password here; the whole
  // point of this feature is one open password, not a permissions split)
  const oValidationSalt = randomBytes(8), oKeySalt = randomBytes(8);
  const oHash = await hash2B(pw, oValidationSalt, U, 6);
  const O = concat([oHash, oValidationSalt, oKeySalt]);                  // 48 bytes
  const oInter = await hash2B(pw, oKeySalt, U, 6);
  const OE = await aesCbcEncryptNoPad(oInter, ZERO_IV, fileKey);         // 32 bytes

  // Algorithm 10 — /Perms
  const perms = new Uint8Array(16);
  perms.set(p32(Pperm), 0);
  perms[4] = 0xff; perms[5] = 0xff; perms[6] = 0xff; perms[7] = 0xff;
  perms[8] = 0x54;                                    // 'T' = /EncryptMetadata true
  perms[9] = 0x61; perms[10] = 0x64; perms[11] = 0x62; // 'a','d','b'
  perms.set(randomBytes(4), 12);
  const Perms = await aesEcbEncryptBlock(fileKey, perms);

  // AES-256 uses the file key directly for every object (no per-object key).
  const aesCipher = () => (bytes) => aesv3Encrypt(fileKey, bytes);
  await eachObject(doc, { stm: aesCipher, str: aesCipher }, null);

  const name = (n) => P.PDFName.of(n);
  const cfEntry = P.PDFDict.withContext(ctx);
  cfEntry.set(name("CFM"), name("AESV3"));
  cfEntry.set(name("AuthEvent"), name("DocOpen"));
  cfEntry.set(name("Length"), P.PDFNumber.of(32));
  const cf = P.PDFDict.withContext(ctx);
  cf.set(name("StdCF"), cfEntry);

  const enc = P.PDFDict.withContext(ctx);
  enc.set(name("Filter"), name("Standard"));
  enc.set(name("V"), P.PDFNumber.of(5));
  enc.set(name("R"), P.PDFNumber.of(6));
  enc.set(name("Length"), P.PDFNumber.of(256));
  enc.set(name("CF"), cf);
  enc.set(name("StmF"), name("StdCF"));
  enc.set(name("StrF"), name("StdCF"));
  enc.set(name("P"), P.PDFNumber.of(Pperm));
  enc.set(name("O"), P.PDFHexString.of(hex(O)));
  enc.set(name("U"), P.PDFHexString.of(hex(U)));
  enc.set(name("OE"), P.PDFHexString.of(hex(OE)));
  enc.set(name("UE"), P.PDFHexString.of(hex(UE)));
  enc.set(name("Perms"), P.PDFHexString.of(hex(Perms)));
  enc.set(name("EncryptMetadata"), P.PDFBool.True);
  ctx.trailerInfo.Encrypt = ctx.register(enc);
  const id = randomId();
  ctx.trailerInfo.ID = ctx.obj([P.PDFHexString.of(hex(id)), P.PDFHexString.of(hex(id))]);
}

/* ================= write: RC4-128 (/V2 /R3) — legacy opt-in ================= */
async function lockRc4(doc, password, Pperm) {
  const P = requirePdfLib(), ctx = doc.context;
  const id = randomId();
  const O = computeO(password, password);
  const key = computeKey(password, O, Pperm, id);
  const U = computeU(key, id);
  const rc4Cipher = (num, gen) => {
    const ok = objKey(key, num, gen);
    return async (bytes) => rc4(ok, bytes);
  };
  await eachObject(doc, { stm: rc4Cipher, str: rc4Cipher }, null);
  const enc = P.PDFDict.withContext(ctx);
  enc.set(P.PDFName.of("Filter"), P.PDFName.of("Standard"));
  enc.set(P.PDFName.of("V"), P.PDFNumber.of(2));
  enc.set(P.PDFName.of("R"), P.PDFNumber.of(3));
  enc.set(P.PDFName.of("Length"), P.PDFNumber.of(128));
  enc.set(P.PDFName.of("P"), P.PDFNumber.of(Pperm));
  enc.set(P.PDFName.of("O"), P.PDFHexString.of(hex(O)));
  enc.set(P.PDFName.of("U"), P.PDFHexString.of(hex(U)));
  ctx.trailerInfo.Encrypt = ctx.register(enc);
  ctx.trailerInfo.ID = ctx.obj([P.PDFHexString.of(hex(id)), P.PDFHexString.of(hex(id))]);
}

// Encrypt a freshly-RELOADED plaintext document and return bytes.
async function lock(plainBytes, password, opts) {
  const P = requirePdfLib();
  const algo = (opts && opts.algo) || "aes256";
  const doc = await P.PDFDocument.load(plainBytes, { ignoreEncryption: true, updateMetadata: false });
  // /P permissions bitfield. Default -4 = allow everything (reserved bits 1,2 set
  // to 0, all others to 1). Callers may pass their own raw signed 32-bit /P value.
  const Pperm = (opts && Number.isInteger(opts.permissions)) ? (opts.permissions | 0) : -4;
  if (algo === "rc4") await lockRc4(doc, password, Pperm);
  else if (!subtle) {
    // Never downgrade AES-256 to broken RC4 behind the caller's back. Web Crypto's
    // subtle is absent on insecure origins; a caller who asked for AES-256 and
    // silently received RC4 is worse off than one who received an error.
    throw Object.assign(new Error(
      "AES-256 requires Web Crypto (crypto.subtle), which is unavailable here \u2014 a secure context (HTTPS) is needed. " +
      "Pass { algo: \"rc4\" } to request the legacy cipher explicitly."), { code: "NO_SUBTLE" });
  }
  else await lockAes256(doc, password, Pperm);
  return await doc.save({ useObjectStreams: false, updateMetadata: false });
}

/* ================= read: unlock ============================================= */
const WRONG_PW = "Wrong password for this PDF.";

// Returns { cipherFor } for a validated password, or throws.
async function resolveRc4(enc, ctx, P, password, R, V, encryptMetadata, cfLenBits) {
  const O = enc.get(P.PDFName.of("O")).asBytes();
  const Ustored = enc.get(P.PDFName.of("U")).asBytes();
  const Pn = enc.get(P.PDFName.of("P")).asNumber() | 0;
  const idArr = ctx.trailerInfo.ID;
  const id0 = idArr ? idArr.get(0).asBytes() : new Uint8Array(0);

  // /Length is in BITS. R2 (/V 1) is fixed at 40-bit; for V2+ we keep 128-bit as
  // the fallback because that is what this library writes and what virtually every
  // /V 2 producer uses, even though the spec's nominal default is 40.
  const lenV = ctx.lookup(enc.get(P.PDFName.of("Length")));
  // §0.4: /Length may be declared ONLY inside the /CF entry; ignoring that derived
  // the wrong key length and rejected a correct password. Prefer the top-level
  // value, fall back to whatever the crypt filter declared.
  const declaredBits = (lenV && lenV.asNumber ? lenV.asNumber() : 0) || (cfLenBits || 0);
  // /V 1 and R2 are 40-bit by definition; otherwise trust a declared /Length and
  // fall back to 128-bit (what this library writes and what /V 2 producers use).
  const keyLen = (R === 2 || V === 1) ? 5
    : (declaredBits >= 40 && declaredBits <= 128 ? Math.floor(declaredBits / 8) : KEYLEN);

  const check = (padded) => {
    const key = computeKeyFromPadded(padded, O, Pn, id0, R, keyLen, encryptMetadata);
    const calc = R === 2 ? computeU_R2(key) : computeU(key, id0);
    // R3+ compares the first 16 bytes only (the rest is an arbitrary salt).
    return sameBytes(calc, Ustored, R === 2 ? 32 : 16) ? key : null;
  };
  let key = check(padPw(password));
  if (!key) key = check(userPwFromO(password, O, R, keyLen));  // maybe it's the OWNER password
  if (!key) throw new Error(WRONG_PW);
  return key;   // raw file key; unlockInPlace builds the per-filter ciphers
}

async function resolveAes(enc, P, password, R) {
  if (!subtle) throw new Error("Web Crypto is unavailable; AES decryption requires a secure context.");
  const U = enc.get(P.PDFName.of("U")).asBytes();
  const O = enc.get(P.PDFName.of("O")).asBytes();
  const UEe = enc.get(P.PDFName.of("UE")), OEe = enc.get(P.PDFName.of("OE"));
  const UE = UEe ? UEe.asBytes() : null, OE = OEe ? OEe.asBytes() : null;
  if (U.length < 48 || O.length < 48) throw new Error("This PDF's security handler is malformed.");
  const pw = passwordBytes(password);

  // user password?
  const uHash = await hash2B(pw, U.subarray(32, 40), null, R);
  if (sameBytes(uHash, U.subarray(0, 32), 32)) {
    if (!UE) throw new Error("This PDF's security handler is malformed.");
    const inter = await hash2B(pw, U.subarray(40, 48), null, R);
    const fileKey = await aesCbcDecryptNoPad(inter, ZERO_IV, UE);
    return fileKey;
  }
  // owner password?
  const oHash = await hash2B(pw, O.subarray(32, 40), U.subarray(0, 48), R);
  if (sameBytes(oHash, O.subarray(0, 32), 32)) {
    if (!OE) throw new Error("This PDF's security handler is malformed.");
    const inter = await hash2B(pw, O.subarray(40, 48), U.subarray(0, 48), R);
    const fileKey = await aesCbcDecryptNoPad(inter, ZERO_IV, OE);
    return fileKey;
  }
  throw new Error(WRONG_PW);
}

// Remove encryption from a loaded (ignoreEncryption) document, in place.
// Returns false if the doc isn't encrypted; throws on a wrong password.
async function unlockInPlace(doc, password) {
  const P = requirePdfLib(), ctx = doc.context;
  const encRef = ctx.trailerInfo.Encrypt;
  if (!encRef) return false;
  const enc = ctx.lookup(encRef);
  if (!(enc instanceof P.PDFDict)) return false;
  // pdf-lib decompresses object streams at LOAD time, before this function can
  // decrypt them — so an encrypted /ObjStm fails to inflate and every object
  // inside it is already gone by the time we run. Decrypting what remains and
  // stripping /Encrypt would report success over a document that silently lost
  // its /Info, page tree entries or annotations.
  // The naive guard (look for a PDFRawStream whose /Type is /ObjStm) does NOT
  // work: the broken stream never becomes a PDFRawStream. What pdf-lib leaves
  // behind is a PDFInvalidObject, which is the reliable signal.
  if (P.PDFInvalidObject) {
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (o instanceof P.PDFInvalidObject) {
        throw new Error(
          "This PDF stores objects in compressed object streams, which pdf-lib cannot parse while " +
          "they are still encrypted — part of the document was already lost when it was loaded. " +
          "Decrypt it with a tool that handles object streams first.");
      }
    }
  }

  const filter = enc.get(P.PDFName.of("Filter"));
  if (filter && filter.asString && filter.asString() !== "/Standard") {
    throw new Error("Unsupported security handler: only the ISO 32000 Standard handler is implemented.");
  }
  const Vv = enc.get(P.PDFName.of("V")), Rv = enc.get(P.PDFName.of("R"));
  const V = Vv ? Vv.asNumber() : 0, R = Rv ? Rv.asNumber() : (V >= 5 ? 6 : 3);

  // Any dictionary value may legally be an indirect reference (§0.3/§0.4: an
  // indirect /EncryptMetadata used to read as false and reject a correct password).
  const deref = (v) => { try { return v == null ? v : (ctx.lookup(v) || v); } catch (e) { return v; } };
  const emV = deref(enc.get(P.PDFName.of("EncryptMetadata")));
  // Optional, defaults to true (Table 21). Feeds Algorithm 2 step (f).
  const encryptMetadata = emV == null ? undefined
    : (typeof emV.asBoolean === "function" ? emV.asBoolean()
      : (typeof emV.value === "boolean" ? emV.value : undefined));

  // ---- crypt filters (Table 20) --------------------------------------------
  // Resolved for EVERY /V >= 4, not just /V4: at /V5 the block used to be skipped
  // entirely, so none of these guards applied there.
  const nameOf = (v) => { const d = deref(v); return d && d.asString ? d.asString() : ""; };
  const cf = deref(enc.get(P.PDFName.of("CF")));
  let cfLenBits = 0;
  const cfmFor = (which) => {
    const fname = nameOf(enc.get(P.PDFName.of(which))) || "/Identity";
    if (fname === "/Identity") return "Identity";
    const key = fname.replace(/^\//, "");
    const entry = cf && cf.get ? deref(cf.get(P.PDFName.of(key))) : null;
    // Table 20: a name resolving to neither a /CF key nor a standard filter is a
    // MALFORMED file. Never fail open to Identity — that would report success on
    // bytes we never decrypted and then strip /Encrypt.
    if (!entry || !entry.get) throw new Error("Malformed security handler: crypt filter " + fname + " is not defined in /CF.");
    const lv = deref(entry.get(P.PDFName.of("Length")));
    // §0.4: /Length may live only inside the /CF entry. It is in BYTES there per
    // Table 25, though producers disagree — accept both readings.
    if (lv && lv.asNumber) {
      const n = lv.asNumber();
      cfLenBits = Math.max(cfLenBits, n <= 16 ? n * 8 : n);
    }
    const m = deref(entry.get(P.PDFName.of("CFM")));
    const cfm = m && m.asString ? m.asString() : "";
    if (cfm === "/None") return "Identity";
    if (cfm === "/V2") return "RC4";
    if (cfm === "/AESV2") return "AESV2";
    if (cfm === "/AESV3") return "AESV3";
    throw new Error("Unsupported crypt filter method " + (cfm || "(missing)") + " in /CF /" + key + ".");
  };

  let stm = "RC4", str = "RC4";
  if (V >= 4) {
    stm = cfmFor("StmF");
    str = cfmFor("StrF");
    // /EFF (Table 20) falls back to /StmF only when ABSENT. Acrobat's "encrypt only
    // attachments" mode writes /StmF /Identity /StrF /Identity /EFF /StdCF: passing
    // everything through and then stripping /Encrypt would leave the attachment as
    // ciphertext with the key material needed to recover it deleted — irreversible.
    if (enc.get(P.PDFName.of("EFF")) && cfmFor("EFF") !== stm) {
      throw new Error("This PDF encrypts embedded files separately (/EFF), which this module cannot decrypt yet.");
    }
    for (const [what, m] of [["streams", stm], ["strings", str]]) {
      if (m === "AESV2") throw new Error("Unsupported encryption: AES-128 (/AESV2) is not implemented (" + what + ").");
      if (V >= 5 && m !== "AESV3" && m !== "Identity") {
        throw new Error("Unsupported encryption: /V 5 declares " + m + " for " + what + "; only AESV3 is implemented.");
      }
      if (V === 4 && m === "AESV3") {
        throw new Error("Unsupported encryption: /AESV3 declared at /V 4; only /V 5 AES-256 is implemented.");
      }
    }
  }

  // A single cipher applied to both streams and strings destroys data whenever the
  // two filters differ — RC4 is symmetric, so running it over already-plaintext
  // bytes ENCRYPTS them. Build one factory per filter; Identity stays untouched.
  let ciphers;
  if (V >= 5) {
    const fileKey = await resolveAes(enc, P, password, R);
    const aes = () => (bytes) => aesv3Decrypt(fileKey, bytes);
    ciphers = { stm: stm === "Identity" ? null : aes, str: str === "Identity" ? null : aes };
  } else {
    const fileKey = await resolveRc4(enc, ctx, P, password, R, V, encryptMetadata, cfLenBits);
    const rc4f = (num, gen) => { const ok = objKey(fileKey, num, gen); return async (bytes) => rc4(ok, bytes); };
    ciphers = { stm: stm === "Identity" ? null : rc4f, str: str === "Identity" ? null : rc4f };
  }

  await eachObject(doc, ciphers, encRef);     // decrypt everything but /Encrypt
  ctx.trailerInfo.Encrypt = undefined;        // drop it so the re-save is plaintext
  try { ctx.delete(encRef); } catch (e) {}
  return true;
}



// exposed for tests


  const _internals = { md5, rc4, hash2B, passwordBytes, aesCbcEncryptNoPad, aesCbcDecryptNoPad, aesv3Encrypt, aesv3Decrypt };
  return { configure, lock, unlockInPlace, _internals };
});
