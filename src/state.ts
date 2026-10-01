/**
 * What the two sides last agreed on.
 *
 * Without this, a parcel is either the whole folder every time, or an
 * overwrite that quietly loses the other person's edits. With it, a parcel is a
 * delta and a conflict is detectable — because "changed since we last spoke"
 * is a question you can only answer if you remember what was last said.
 *
 * It lives in the plugin folder, never inside the share root, so it does not
 * travel and cannot be synced by anything else.
 */

import { App } from "obsidian";
import { sha256 } from "./crypto";
import type { PeerState, ScannedFile } from "./types";
import { ensureFolder, exists, join } from "./vaultio";

/**
 * `published` is what I last sent, and it is the same for everyone — which is
 * what makes one parcel serve a whole team. `from:<peer>` is what I last
 * received from one person, which is what makes a conflict detectable.
 */
export const PUBLISHED = "published";

export function fromPeer(peer: string): string {
	return `from-${peer.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "peer"}`;
}

function stateFile(pluginDir: string, key: string): string {
	const safe = key.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "state";
	return join(pluginDir, "state", `${safe}.json`);
}

/** Every peer we have received from, for the team panel. */
export async function knownPeers(app: App, pluginDir: string): Promise<string[]> {
	const dir = join(pluginDir, "state");
	if (!(await exists(app, dir))) return [];
	const listed = await app.vault.adapter.list(dir);
	return listed.files
		.map((f) => f.split("/").pop() ?? "")
		.filter((f) => f.startsWith("from-") && f.endsWith(".json"))
		.map((f) => f.slice("from-".length, -".json".length));
}

export async function hashOfFiles(files: Record<string, string>): Promise<string> {
	const canonical = Object.keys(files)
		.sort()
		.map((k) => `${k}\u0000${files[k]}`)
		.join("\n");
	return sha256(new TextEncoder().encode(canonical));
}

export function filesFromScan(scanned: ScannedFile[]): Record<string, string> {
	const files: Record<string, string> = {};
	for (const f of scanned) files[f.path] = f.hash;
	return files;
}

export async function loadState(
	app: App,
	pluginDir: string,
	peer: string,
): Promise<PeerState | null> {
	const path = stateFile(pluginDir, peer);
	if (!(await exists(app, path))) return null;
	try {
		return JSON.parse(await app.vault.adapter.read(path)) as PeerState;
	} catch {
		// A corrupt state file is recoverable: pack everything once and carry on.
		return null;
	}
}

export async function saveState(
	app: App,
	pluginDir: string,
	peer: string,
	shareRoot: string,
	files: Record<string, string>,
): Promise<PeerState> {
	const state: PeerState = {
		shareRoot,
		peer,
		updatedAt: new Date().toISOString(),
		files,
		stateHash: await hashOfFiles(files),
	};
	const path = stateFile(pluginDir, peer);
	await ensureFolder(app, join(pluginDir, "state"));
	await app.vault.adapter.write(path, JSON.stringify(state, null, 2));
	return state;
}
