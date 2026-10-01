/**
 * Parcels travel through email and messaging apps, so they are encrypted with a
 * passphrase the two people agree on once, through a different channel than the
 * parcels themselves.
 *
 * Web Crypto only — it is available on desktop and on mobile, so nothing here
 * limits where the plugin runs.
 *
 * ## The header is attacker-controlled
 *
 * A parcel arrives as an email attachment. Everything in its header — salt, IV,
 * iteration count — is read *before* anything can be authenticated, because the
 * key has to be derived before AES-GCM can check the tag. That ordering is
 * unavoidable, so the header has to be treated as hostile input rather than as
 * our own writing coming back to us.
 *
 * The iteration count is the dangerous field: it is a 32-bit integer that sets
 * how much work we do. Left unchecked, a one-byte edit turns it into four
 * billion rounds and Obsidian stops responding for hours. It cannot leak the
 * key — a wrong count simply derives the wrong one and the tag fails — so this
 * is denial of service, not disclosure. It is still trivially worth closing.
 *
 * Two defences, in order of importance:
 *
 *   1. Bounds. The count must be within a range we would plausibly have
 *      written. This is what actually stops the attack, because it is the only
 *      check that can happen before the expensive work.
 *
 *   2. The header as additional authenticated data. AES-GCM then covers the
 *      salt, the IV and the count, so tampering fails authentication instead of
 *      producing a confusing wrong-passphrase error. This cannot prevent the
 *      work above — we must derive before we can verify — but it turns silent
 *      corruption into a clear failure.
 *
 * ## Format versions
 *
 * v1 parcels were sealed without additional data, so they are opened without
 * it. They still get the bounds check, which costs them nothing: the only
 * writer that ever existed used 310,000, comfortably inside the range.
 *
 * v2 is byte-identical in layout — the version byte is the only difference —
 * and binds the header. Every parcel written from now on is v2, and nothing
 * already sent stops opening.
 */

const MAGIC = new Uint8Array([0x46, 0x45, 0x52, 0x52, 0x59]); // "FERRY"
const V1 = 0x01; // sealed without additional data
const V2 = 0x02; // header bound as AAD
const SALT_LEN = 16;
const IV_LEN = 12;
const HEAD_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + 4;

const ITERATIONS = 310_000; // OWASP guidance for PBKDF2-SHA256

/**
 * What we are willing to do on a stranger's say-so.
 *
 * The floor keeps a forged parcel from downgrading a vault to cheap derivation;
 * the ceiling keeps one from pinning a laptop. Both leave room to raise the
 * writer's count later without orphaning anything already sent.
 */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

export async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** magic | version | salt | iv | iterations | ciphertext */
export async function seal(plain: Uint8Array, passphrase: string): Promise<Uint8Array> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const key = await deriveKey(passphrase, salt, ITERATIONS);

	const header = new Uint8Array(HEAD_LEN);
	header.set(MAGIC, 0);
	header[MAGIC.length] = V2;
	header.set(salt, MAGIC.length + 1);
	header.set(iv, MAGIC.length + 1 + SALT_LEN);
	new DataView(header.buffer).setUint32(HEAD_LEN - 4, ITERATIONS, false);

	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: header as BufferSource },
			key,
			plain as BufferSource,
		),
	);

	const out = new Uint8Array(HEAD_LEN + cipher.length);
	out.set(header, 0);
	out.set(cipher, HEAD_LEN);
	return out;
}

export async function open(parcel: Uint8Array, passphrase: string): Promise<Uint8Array> {
	if (parcel.length < HEAD_LEN) throw new Error("not a Ferry parcel (too short)");
	for (let i = 0; i < MAGIC.length; i++) {
		if (parcel[i] !== MAGIC[i]) throw new Error("not a Ferry parcel (bad header)");
	}

	const version = parcel[MAGIC.length];
	if (version !== V1 && version !== V2) {
		throw new Error(`this parcel needs a newer Ferry (format ${version})`);
	}

	const salt = parcel.slice(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
	const iv = parcel.slice(MAGIC.length + 1 + SALT_LEN, HEAD_LEN - 4);
	const iterations = new DataView(
		parcel.buffer,
		parcel.byteOffset + HEAD_LEN - 4,
		4,
	).getUint32(0, false);

	// Checked before the work, because after it there is no point: this is the
	// only thing standing between a one-byte edit and an unresponsive app.
	if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
		throw new Error("the parcel is damaged (its header asks for implausible work)");
	}

	const header = parcel.slice(0, HEAD_LEN);
	const cipher = parcel.slice(HEAD_LEN);

	const key = await deriveKey(passphrase, salt, iterations);
	try {
		const plain = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv as BufferSource,
				// v1 was sealed without it; binding it there would reject every
				// parcel already sent.
				...(version === V2 ? { additionalData: header as BufferSource } : {}),
			},
			key,
			cipher as BufferSource,
		);
		return new Uint8Array(plain);
	} catch {
		// AES-GCM fails as a whole when the key is wrong or the header was
		// edited — there is no partial read, and no way to tell the two apart.
		throw new Error("wrong passphrase, or the parcel is damaged");
	}
}
