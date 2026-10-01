/**
 * Parcels travel through email and messaging apps, so they are encrypted with a
 * passphrase the two people agree on once, through a different channel than the
 * parcels themselves.
 *
 * Web Crypto only — it is available on desktop and on mobile, so nothing here
 * limits where the plugin runs.
 */

const MAGIC = new Uint8Array([0x46, 0x45, 0x52, 0x52, 0x59, 0x01]); // "FERRY\x01"
const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 310_000; // OWASP guidance for PBKDF2-SHA256

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

/** magic | salt | iv | iterations | ciphertext */
export async function seal(plain: Uint8Array, passphrase: string): Promise<Uint8Array> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const key = await deriveKey(passphrase, salt, ITERATIONS);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource),
	);

	const head = MAGIC.length + SALT_LEN + IV_LEN + 4;
	const out = new Uint8Array(head + cipher.length);
	out.set(MAGIC, 0);
	out.set(salt, MAGIC.length);
	out.set(iv, MAGIC.length + SALT_LEN);
	new DataView(out.buffer).setUint32(MAGIC.length + SALT_LEN + IV_LEN, ITERATIONS, false);
	out.set(cipher, head);
	return out;
}

export async function open(parcel: Uint8Array, passphrase: string): Promise<Uint8Array> {
	const head = MAGIC.length + SALT_LEN + IV_LEN + 4;
	if (parcel.length < head) throw new Error("not a Ferry parcel (too short)");
	for (let i = 0; i < MAGIC.length; i++) {
		if (parcel[i] !== MAGIC[i]) throw new Error("not a Ferry parcel (bad header)");
	}
	const salt = parcel.slice(MAGIC.length, MAGIC.length + SALT_LEN);
	const iv = parcel.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
	const iterations = new DataView(
		parcel.buffer,
		parcel.byteOffset + MAGIC.length + SALT_LEN + IV_LEN,
		4,
	).getUint32(0, false);
	const cipher = parcel.slice(head);

	const key = await deriveKey(passphrase, salt, iterations);
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as BufferSource },
			key,
			cipher,
		);
		return new Uint8Array(plain);
	} catch {
		// AES-GCM fails as a whole when the key is wrong — there is no partial read.
		throw new Error("wrong passphrase, or the parcel is damaged");
	}
}
