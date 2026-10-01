/**
 * Packing: what *I* changed in the topics *I* own, since I last published.
 *
 * Measured against one record — "published" — rather than against a particular
 * person, which is what lets a single parcel go to the whole team. Everyone who
 * is up to date can apply it; anyone who has fallen behind is told so when they
 * try.
 *
 * Files belonging to somebody else are never packed. They are counted and
 * reported instead, because a tool that silently drops your work is worse than
 * one that tells you it is not yours to send.
 */

import { App } from "obsidian";
import { zipSync } from "fflate";
import { seal } from "./crypto";
import { ownerOf, readOwners, sameName, topicsOf, type OwnerMap } from "./owners";
import { detect } from "./requires";
import { filesFromScan, fromPeer, knownPeers, loadState, PUBLISHED, saveState } from "./state";
import { FORMAT, type Entry, type FerrySettings, type Manifest, type ScannedFile } from "./types";
import { ensureFolder, join, readBinary, scan, writeBinary } from "./vaultio";

export interface PackResult {
	path: string;
	bytes: number;
	entries: Entry[];
	deletions: string[];
	requires: Manifest["requires"];
	/** Changes to files owned by somebody else — reported, never sent. */
	foreign: number;
	full: boolean;
}

export async function pack(
	app: App,
	pluginDir: string,
	settings: FerrySettings,
	version: string,
	passphrase: string,
	full: boolean,
): Promise<PackResult> {
	const { shareRoot, me, ferryFolder, excludes, strictOwnership } = settings;

	const scanned = await scan(app, shareRoot, excludes, [ferryFolder]);
	const owners = await readOwners(app, shareRoot, scanned);

	const mine = scanned.filter((f) => sameName(ownerOf(owners, f.path, me), me));
	const current = filesFromScan(mine);

	const published = full ? null : await loadState(app, pluginDir, PUBLISHED);
	const before = published?.files ?? {};

	const entries: Entry[] = [];
	for (const file of mine) {
		const had = before[file.path];
		if (had === file.hash) continue;
		entries.push({ path: file.path, hash: file.hash, size: file.size, op: had ? "change" : "add" });
	}
	// Only ever announce the removal of something that was mine.
	const deletions = Object.keys(before).filter((p) => !(p in current)).sort();

	const received: Record<string, string> = {};
	for (const peer of await knownPeers(app, pluginDir)) {
		const peerState = await loadState(app, pluginDir, fromPeer(peer));
		Object.assign(received, peerState?.files ?? {});
	}
	const foreign = countForeignChanges(owners, scanned, me, received);
	if (strictOwnership && foreign > 0) {
		throw new Error(
			`${foreign} changed file(s) belong to someone else. Turn off strict ownership, or ` +
				"leave those edits to their owner.",
		);
	}

	if (!entries.length && !deletions.length) {
		// On a full parcel there is no "since" — an empty result means there is
		// nothing of yours to send, which is a different problem entirely.
		if (full && !mine.length) {
			throw new Error(
				scanned.length === 0
					? `the share root "${shareRoot}" is empty — there is nothing to publish`
					: `none of the ${scanned.length} file(s) in "${shareRoot}" belong to you` +
						` (you are "${me}") — claim a folder, or use the name the topics already know`,
			);
		}
		throw new Error(
			foreign > 0
				? `nothing of yours has changed — but ${foreign} file(s) you do not own have been edited here`
				: "nothing has changed since you last published",
		);
	}

	const requires = await detect(app, shareRoot, mine, settings.declaredPlugins, settings.detectPlugins);

	// Written before the manifest, so the manifest can name the state it creates.
	const after = await saveState(app, pluginDir, PUBLISHED, shareRoot, current);

	const manifest: Manifest = {
		format: FORMAT,
		plugin: "ferry",
		version,
		shareRoot,
		peer: me || "unnamed",
		createdAt: new Date().toISOString(),
		baseState: published?.stateHash ?? null,
		resultState: after.stateHash,
		entries,
		deletions,
		requires,
		owns: owners.open ? [] : topicsOf(owners, me).map((t) => t.prefix),
	};

	const files: Record<string, Uint8Array> = {
		"manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
	};
	for (const entry of entries) {
		files[`files/${entry.path}`] = await readBinary(app, join(shareRoot, entry.path));
	}

	const zipped = zipSync(files, { level: 6 });
	const sealed = await seal(zipped, passphrase);

	const outbox = join(ferryFolder, "outbox");
	await ensureFolder(app, outbox);
	const path = join(outbox, `${slug(me || shareRoot)}-${stamp()}${full ? "-full" : ""}.ferry`);
	await writeBinary(app, path, sealed);

	return { path, bytes: sealed.length, entries, deletions, requires, foreign, full };
}

/**
 * Files owned by others that differ from what we last saw. Counted so the panel
 * can say "2 changes in Field/ — not yours, not sent" rather than staying quiet.
 */
function countForeignChanges(
	owners: OwnerMap,
	scanned: ScannedFile[],
	me: string,
	received: Record<string, string>,
): number {
	if (owners.open) return 0;
	let count = 0;
	for (const file of scanned) {
		if (sameName(ownerOf(owners, file.path, me), me)) continue;
		// Unknown here means it arrived before we tracked that peer; only a
		// difference from what they sent is a local edit.
		const known = received[file.path];
		if (known !== undefined && known !== file.hash) count++;
	}
	return count;
}

function stamp(): string {
	return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}

function slug(text: string): string {
	return (
		text
			.split("/")
			.pop()!
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "parcel"
	);
}
