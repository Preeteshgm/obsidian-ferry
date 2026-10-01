/**
 * Proves the parcel format works end to end, outside Obsidian.
 *
 * Two halves. The first seals and opens a parcel carrying the three kinds of
 * thing a real share root holds. The second attacks the header, because a
 * parcel arrives as an email attachment and everything in its header is read
 * before anything can be authenticated — so the header has to be treated as
 * hostile input, and that has to be tested rather than asserted.
 *
 * The vault-facing code needs Obsidian to run; this part does not, so it is
 * worth testing where it is cheap to test.
 *
 *   node tools/roundtrip.mjs
 */
import { zipSync, unzipSync } from "fflate";
import { webcrypto as crypto } from "node:crypto";

const MAGIC = new Uint8Array([0x46, 0x45, 0x52, 0x52, 0x59]);
const V1 = 0x01;
const V2 = 0x02;
const SALT_LEN = 16;
const IV_LEN = 12;
const HEAD_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + 4;
const ITERATIONS = 310_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

// Mirrors src/crypto.ts. Kept in step by the checks below, which would fail
// against a writer or reader that drifted from it.
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

function buildHeader(version, salt, iv, iterations) {
	const header = new Uint8Array(HEAD_LEN);
	header.set(MAGIC, 0);
	header[MAGIC.length] = version;
	header.set(salt, MAGIC.length + 1);
	header.set(iv, MAGIC.length + 1 + SALT_LEN);
	new DataView(header.buffer).setUint32(HEAD_LEN - 4, iterations, false);
	return header;
}

async function seal(plain, passphrase, { version = V2, iterations = ITERATIONS } = {}) {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const key = await deriveKey(passphrase, salt, iterations);
	const header = buildHeader(version, salt, iv, iterations);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, ...(version === V2 ? { additionalData: header } : {}) },
			key,
			plain,
		),
	);
	const out = new Uint8Array(HEAD_LEN + cipher.length);
	out.set(header, 0);
	out.set(cipher, HEAD_LEN);
	return out;
}

async function open(parcel, passphrase) {
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
	const iterations = new DataView(parcel.buffer, parcel.byteOffset + HEAD_LEN - 4, 4).getUint32(
		0,
		false,
	);
	if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
		throw new Error("the parcel is damaged (its header asks for implausible work)");
	}
	const header = parcel.slice(0, HEAD_LEN);
	const key = await deriveKey(passphrase, salt, iterations);
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, ...(version === V2 ? { additionalData: header } : {}) },
			key,
			parcel.slice(HEAD_LEN),
		),
	);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const PASS = "correct horse battery staple";
let failures = 0;

const check = (label, cond) => {
	console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
	if (!cond) failures++;
};

async function rejects(label, parcel, passphrase = PASS) {
	let threw = false;
	let message = "";
	const started = Date.now();
	try {
		await open(parcel, passphrase);
	} catch (e) {
		threw = true;
		message = e.message;
	}
	check(label, threw);
	return { message, ms: Date.now() - started };
}

// ── 1. a parcel carrying what a real share root holds ──────────────────────
const manifest = {
	format: 1,
	plugin: "ferry",
	version: "0.2.7",
	shareRoot: "Projects",
	peer: "alice",
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
	owns: [],
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

const parcel = await seal(zipped, PASS);
check("parcel carries the magic header", parcel[0] === 0x46 && parcel[4] === 0x59);
check("written as format 2", parcel[MAGIC.length] === V2);

const raw = unzipSync(await open(parcel, PASS));
check("manifest survives", JSON.parse(dec.decode(raw["manifest.json"])).shareRoot === "Projects");
check("markdown survives", dec.decode(raw["files/Notes/one.md"]) === "hello ferry\n");
check("canvas survives", dec.decode(raw["files/Deck.canvas"]) === '{"nodes":[],"edges":[]}');
check(
	"binary survives byte for byte",
	Buffer.compare(Buffer.from(raw["files/Assets/logo.png"]), Buffer.from(binary)) === 0,
);
check("nested paths are preserved", Object.keys(raw).includes("files/Assets/logo.png"));

await rejects("a wrong passphrase is rejected", parcel, "wrong passphrase");
await rejects("a file that is not a parcel is rejected", new Uint8Array(64));
await rejects("a truncated parcel is rejected", parcel.slice(0, HEAD_LEN - 1));

// ── 2. the header is hostile input ─────────────────────────────────────────
console.log("\n  header tampering");

// The one that matters: four billion rounds would pin the app for hours.
const huge = parcel.slice();
new DataView(huge.buffer).setUint32(HEAD_LEN - 4, 0xffffffff, false);
const r1 = await rejects("an absurd iteration count is rejected", huge);
check("…and rejected without doing the work (under a second)", r1.ms < 1000);
check("…with a message about the header, not the passphrase", r1.message.includes("implausible"));

// The quiet one: a downgrade to cheap derivation.
const tiny = parcel.slice();
new DataView(tiny.buffer).setUint32(HEAD_LEN - 4, 1, false);
const r2 = await rejects("an iteration count below the floor is rejected", tiny);
check("…before deriving anything", r2.ms < 1000);

// Inside the bounds, so the bounds check passes it — this is what AAD is for.
const nudged = parcel.slice();
new DataView(nudged.buffer).setUint32(HEAD_LEN - 4, ITERATIONS + 1, false);
await rejects("an iteration count changed within the bounds fails authentication", nudged);

const saltEdit = parcel.slice();
saltEdit[MAGIC.length + 1] ^= 0xff;
await rejects("an edited salt fails authentication", saltEdit);

const ivEdit = parcel.slice();
ivEdit[MAGIC.length + 1 + SALT_LEN] ^= 0xff;
await rejects("an edited IV fails authentication", ivEdit);

const bodyEdit = parcel.slice();
bodyEdit[HEAD_LEN + 4] ^= 0xff;
await rejects("an edited body fails authentication", bodyEdit);

const future = parcel.slice();
future[MAGIC.length] = 0x09;
const r3 = await rejects("an unknown format version is refused", future);
check("…saying a newer Ferry is needed", r3.message.includes("newer Ferry"));

// ── 3. parcels sent before this change still open ──────────────────────────
console.log("\n  compatibility");

const legacy = await seal(zipped, PASS, { version: V1 });
const legacyOut = unzipSync(await open(legacy, PASS));
check("a format 1 parcel still opens", dec.decode(legacyOut["files/Notes/one.md"]) === "hello ferry\n");

const legacyHuge = legacy.slice();
new DataView(legacyHuge.buffer).setUint32(HEAD_LEN - 4, 0xffffffff, false);
const r4 = await rejects("a format 1 parcel gets the bounds check too", legacyHuge);
check("…and is also rejected before the work", r4.ms < 1000);

console.log(
	`\n${failures ? `${failures} failure(s)` : "all checks passed"} · parcel ${parcel.length} bytes ` +
		`from ${zipped.length} bytes zipped`,
);
process.exit(failures ? 1 : 0);
