/**
 * Proves the parcel format works end to end, outside Obsidian.
 *
 * Seals a zip the way pack.ts does, opens it the way unpack.ts does, and checks
 * that a wrong passphrase fails rather than returning something plausible. The
 * vault-facing code needs Obsidian to run; this part does not, so it is worth
 * testing where it is cheap to test.
 *
 *   node tools/roundtrip.mjs
 */
import { zipSync, unzipSync } from "fflate";
import { webcrypto as crypto } from "node:crypto";

const MAGIC = new Uint8Array([0x46, 0x45, 0x52, 0x52, 0x59, 0x01]);
const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 310_000;

async function deriveKey(passphrase, salt, iterations) {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

async function seal(plain, passphrase) {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const key = await deriveKey(passphrase, salt, ITERATIONS);
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
	const head = MAGIC.length + SALT_LEN + IV_LEN + 4;
	const out = new Uint8Array(head + cipher.length);
	out.set(MAGIC, 0);
	out.set(salt, MAGIC.length);
	out.set(iv, MAGIC.length + SALT_LEN);
	new DataView(out.buffer).setUint32(MAGIC.length + SALT_LEN + IV_LEN, ITERATIONS, false);
	out.set(cipher, head);
	return out;
}

async function open(parcel, passphrase) {
	const head = MAGIC.length + SALT_LEN + IV_LEN + 4;
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
	const key = await deriveKey(passphrase, salt, iterations);
	return new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, parcel.slice(head)),
	);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
let failures = 0;
const check = (label, cond) => {
	console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
	if (!cond) failures++;
};

// A parcel with text, a canvas and a binary attachment — the three kinds of
// thing a real share root holds.
const manifest = {
	format: 1,
	plugin: "ferry",
	version: "0.1.0",
	shareRoot: "Projects",
	peer: "preetesh",
	createdAt: new Date().toISOString(),
	baseState: null,
	resultState: "abc",
	entries: [
		{ path: "Notes/one.md", hash: "h1", size: 12, op: "add" },
		{ path: "Deck.canvas", hash: "h2", size: 40, op: "change" },
		{ path: "Assets/logo.png", hash: "h3", size: 8, op: "add" },
	],
	deletions: ["Notes/gone.md"],
	requires: [{ id: "dataview", name: "Dataview", reason: "1 file" }],
};

const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const zipped = zipSync(
	{
		"manifest.json": enc.encode(JSON.stringify(manifest)),
		"files/Notes/one.md": enc.encode("hello ferry\n"),
		"files/Deck.canvas": enc.encode(JSON.stringify({ nodes: [], edges: [] })),
		"files/Assets/logo.png": binary,
	},
	{ level: 6 },
);

const sealed = await seal(zipped, "correct horse battery staple");
check("parcel carries the magic header", sealed[0] === 0x46 && sealed[5] === 0x01);

const opened = await open(sealed, "correct horse battery staple");
const raw = unzipSync(opened);

check("manifest survives", JSON.parse(dec.decode(raw["manifest.json"])).shareRoot === "Projects");
check("markdown survives", dec.decode(raw["files/Notes/one.md"]) === "hello ferry\n");
check("canvas survives", dec.decode(raw["files/Deck.canvas"]) === '{"nodes":[],"edges":[]}');
check(
	"binary survives byte for byte",
	Buffer.compare(Buffer.from(raw["files/Assets/logo.png"]), Buffer.from(binary)) === 0,
);
check(
	"nested paths are preserved",
	Object.keys(raw).includes("files/Assets/logo.png"),
);

let rejected = false;
try {
	await open(sealed, "wrong passphrase");
} catch {
	rejected = true;
}
check("a wrong passphrase is rejected", rejected);

let notFerry = false;
try {
	await open(new Uint8Array(64), "anything");
} catch {
	notFerry = true;
}
check("a file that is not a parcel is rejected", notFerry);

console.log(
	`\n${failures ? `${failures} failure(s)` : "all checks passed"} · parcel ${sealed.length} bytes ` +
		`from ${zipped.length} bytes zipped`,
);
process.exit(failures ? 1 : 0);
