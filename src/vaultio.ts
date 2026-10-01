/**
 * Everything that touches the vault, in one place.
 *
 * Reads and writes go through the adapter rather than the Vault API, because
 * parcels carry whatever is in the folder — images, PDFs, HTML — and the
 * adapter handles nested paths and binary content without ceremony. Deletions
 * are the exception: those go through the Vault API so the file lands in the
 * vault's trash and a person can still get it back.
 */

import { App, TFile, normalizePath } from "obsidian";
import { sha256 } from "./crypto";
import type { ScannedFile } from "./types";

export function join(...parts: string[]): string {
	return normalizePath(parts.filter((p) => p && p !== ".").join("/"));
}

export async function exists(app: App, path: string): Promise<boolean> {
	return app.vault.adapter.exists(normalizePath(path));
}

export async function readBinary(app: App, path: string): Promise<Uint8Array> {
	const buf = await app.vault.adapter.readBinary(normalizePath(path));
	return new Uint8Array(buf);
}

export async function writeBinary(app: App, path: string, data: Uint8Array): Promise<void> {
	const p = normalizePath(path);
	await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
	// A fresh ArrayBuffer: the adapter keeps a reference, and `data` may be a
	// view onto a larger buffer handed back by the unzipper.
	const copy = data.slice();
	await app.vault.adapter.writeBinary(p, copy.buffer as ArrayBuffer);
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const p = normalizePath(folder);
	if (!p || p === "/" || p === ".") return;
	if (await app.vault.adapter.exists(p)) return;
	await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
	await app.vault.adapter.mkdir(p);
}

/** Delete to the vault trash where possible, so an apply is always recoverable. */
export async function trash(app: App, path: string): Promise<void> {
	const p = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(p);
	if (file instanceof TFile) {
		await app.vault.trash(file, true);
		return;
	}
	if (await app.vault.adapter.exists(p)) await app.vault.adapter.trashLocal(p);
}

/** `*` matches within a segment, `**` across segments. Enough for exclude lists. */
export function matches(path: string, pattern: string): boolean {
	const rx = pattern
		.split("**")
		.map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
		.join(".*");
	return new RegExp(`^${rx}$`).test(path);
}

/**
 * Every file under the share root, hashed, with excludes applied.
 *
 * `getFiles()` returns what the vault indexes, which leaves out dot-folders —
 * so `.obsidian`, `.trash` and the plugin's own state are skipped without
 * anyone having to remember them.
 */
export async function scan(
	app: App,
	shareRoot: string,
	excludes: string[],
	alsoSkip: string[] = [],
): Promise<ScannedFile[]> {
	const root = normalizePath(shareRoot);
	const prefix = root === "/" || root === "" ? "" : root + "/";
	const skip = alsoSkip.map((s) => normalizePath(s));
	const out: ScannedFile[] = [];

	for (const file of app.vault.getFiles()) {
		if (prefix && !file.path.startsWith(prefix)) continue;
		if (skip.some((s) => file.path === s || file.path.startsWith(s + "/"))) continue;

		const rel = prefix ? file.path.slice(prefix.length) : file.path;
		if (excludes.some((p) => matches(rel, p))) continue;

		const bytes = await readBinary(app, file.path);
		out.push({ path: rel, hash: await sha256(bytes), size: bytes.length });
	}
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}
