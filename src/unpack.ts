/**
 * Unpacking happens in two halves on purpose.
 *
 * `plan()` decides everything and touches nothing, so a person can read what is
 * about to happen and say no. `apply()` then carries out exactly that plan,
 * snapshotting every file it will overwrite or remove before it does.
 *
 * Two rules keep a parcel safe to accept:
 *
 *   a file is only overwritten when it has not changed here since that peer
 *   last sent it — anything else keeps both versions;
 *
 *   and a sender may only carry files they own, judged by the ownership map as
 *   it stands *before* this parcel is applied. That last detail is what makes a
 *   transfer work: the outgoing owner is still the owner when their parcel
 *   arrives, so the marker that hands the topic over is accepted.
 */

import { App } from "obsidian";
import { unzipSync } from "fflate";
import { open, sha256 } from "./crypto";
import { isMarker, MARKER, ownerOf, readOwners, sameName } from "./owners";
import { missing } from "./requires";
import { fromPeer, loadState, saveState } from "./state";
import type { FerrySettings, Manifest, Plan, PlanItem } from "./types";
import { exists, join, readBinary, scan, trash, writeBinary } from "./vaultio";
import { Snapshot, stampNow } from "./backup";

export interface Parcel {
	manifest: Manifest;
	files: Record<string, Uint8Array>;
	source: string;
}

export async function read(app: App, path: string, passphrase: string): Promise<Parcel> {
	return readBytes(await readBinary(app, path), passphrase, path);
}

/**
 * The same thing, from bytes — so a parcel can be opened straight from an
 * email attachment without first being copied into the vault.
 */
export async function readBytes(
	bytes: Uint8Array,
	passphrase: string,
	source: string,
): Promise<Parcel> {
	const zipped = await open(bytes, passphrase);
	const raw = unzipSync(zipped);

	const manifestBytes = raw["manifest.json"];
	if (!manifestBytes) throw new Error("the parcel has no manifest");
	const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
	if (manifest.plugin !== "ferry") throw new Error("not a Ferry parcel");
	if (manifest.format > 1) {
		throw new Error(`the parcel needs a newer Ferry (format ${manifest.format})`);
	}

	const files: Record<string, Uint8Array> = {};
	for (const [name, bytes] of Object.entries(raw)) {
		if (name.startsWith("files/")) files[name.slice("files/".length)] = bytes;
	}
	return { manifest, files, source };
}

export async function plan(
	app: App,
	pluginDir: string,
	settings: FerrySettings,
	parcel: Parcel,
): Promise<Plan> {
	const { manifest } = parcel;
	const shareRoot = settings.shareRoot;

	// Paths in a parcel are relative to a share root both sides agreed on.
	// Landing them anywhere else breaks every link and canvas reference.
	if (manifest.shareRoot !== shareRoot) {
		throw new Error(
			`this parcel is for the share root "${manifest.shareRoot}", but this vault uses "${shareRoot}"`,
		);
	}
	if (sameName(manifest.peer, settings.me)) {
		throw new Error("this is your own parcel");
	}

	const sender = manifest.peer || "peer";
	const state = await loadState(app, pluginDir, fromPeer(sender));
	const known = state?.files ?? {};

	// The map as it stands now — before this parcel — is what decides whether
	// the sender was entitled to send each file.
	const scanned = await scan(app, shareRoot, settings.excludes, [settings.ferryFolder]);
	const owners = await readOwners(app, shareRoot, scanned);

	// A parcel may carry ownership markers: somebody claiming a folder nobody
	// owned yet, or an owner handing one on. Those markers have to be read
	// before the entries are judged, or a legitimate first claim looks exactly
	// like trespass.
	const effective = { ...owners, topics: [...owners.topics] };
	for (const entry of manifest.entries) {
		if (!isMarker(entry.path)) continue;
		const bytes = parcel.files[entry.path];
		if (!bytes) continue;
		try {
			const claimed = String(JSON.parse(new TextDecoder().decode(bytes)).owner ?? "").trim();
			const prefix = entry.path === MARKER ? "" : entry.path.slice(0, -(MARKER.length + 1));
			const currently = ownerOf(owners, entry.path, sender);
			// Claiming something unowned, or handing on something that is theirs.
			if (sameName(claimed, sender) || sameName(currently, sender)) {
				effective.topics = effective.topics.filter((t) => t.prefix !== prefix);
				effective.topics.push({ prefix, owner: claimed, marker: entry.path });
			}
		} catch {
			// A marker we cannot read changes nothing.
		}
	}
	effective.topics.sort((a, b) => b.prefix.length - a.prefix.length);
	effective.open = effective.topics.length === 0;

	const items: PlanItem[] = [];
	const trespass: string[] = [];

	for (const entry of manifest.entries) {
		const owner = isMarker(entry.path) ? sender : ownerOf(effective, entry.path, sender);
		if (!effective.open && !sameName(owner, sender)) {
			// Accepted, but called out: the content arrives and a person decides.
			trespass.push(`${entry.path} (owned by ${owner})`);
		}

		const target = join(shareRoot, entry.path);
		if (!(await exists(app, target))) {
			items.push({ kind: "add", path: entry.path });
			continue;
		}
		const localHash = await sha256(await readBinary(app, target));
		if (localHash === entry.hash) {
			items.push({ kind: "identical", path: entry.path });
		} else if (known[entry.path] === localHash) {
			items.push({ kind: "overwrite", path: entry.path });
		} else {
			items.push({
				kind: "conflict",
				path: entry.path,
				conflictPath: conflictName(entry.path, sender, manifest.createdAt),
				note: known[entry.path]
					? "changed on both sides"
					: !effective.open && !sameName(owner, settings.me)
						? "you have edited a file you do not own"
						: "exists here already",
			});
		}
	}

	for (const path of manifest.deletions) {
		const target = join(shareRoot, path);
		if (!(await exists(app, target))) continue;
		const localHash = await sha256(await readBinary(app, target));
		if (known[path] === localHash) items.push({ kind: "delete", path });
		else items.push({ kind: "delete-skipped", path, note: "changed here since their last parcel" });
	}

	items.sort((a, b) => a.path.localeCompare(b.path));

	const warnings: string[] = [];
	if (manifest.baseState && state && manifest.baseState !== state.stateHash) {
		warnings.push(
			`This parcel was built on a different state than the one held here — a parcel from ` +
				`${sender} may have been missed, or applied out of order. Expect more conflicts than ` +
				"usual; a full parcel from them is the clean way back.",
		);
	}
	if (manifest.baseState && !state) {
		warnings.push(
			`Nothing has been received from ${sender} here yet, but this is a delta. Ask them for a ` +
				"full parcel instead — files they did not change will be missing.",
		);
	}
	if (trespass.length) {
		warnings.push(
			`${sender} has sent ${trespass.length} file(s) they do not own: ${trespass
				.slice(0, 4)
				.join(", ")}${trespass.length > 4 ? "…" : ""}. ` +
				"Ownership transfers are normal; anything else is worth asking about.",
		);
	}

	return { manifest, items, missingPlugins: missing(app, manifest.requires ?? []), warnings };
}

export interface ApplyResult {
	added: number;
	overwritten: number;
	conflicts: number;
	deleted: number;
	skipped: number;
	snapshot: string | null;
	/** Set when the parcel changed who owns something. */
	transfers: string[];
}

export async function apply(
	app: App,
	pluginDir: string,
	settings: FerrySettings,
	parcel: Parcel,
	theplan: Plan,
	allowDeletions: boolean,
): Promise<ApplyResult> {
	const shareRoot = settings.shareRoot;
	const sender = parcel.manifest.peer || "peer";
	const snapshot = new Snapshot(app, pluginDir, stampNow(), sender, parcel.source);

	const result: ApplyResult = {
		added: 0,
		overwritten: 0,
		conflicts: 0,
		deleted: 0,
		skipped: 0,
		snapshot: null,
		transfers: [],
	};

	for (const item of theplan.items) {
		const incoming = parcel.files[item.path];
		if (isMarker(item.path) && (item.kind === "add" || item.kind === "overwrite")) {
			result.transfers.push(item.path);
		}

		switch (item.kind) {
			case "identical":
				result.skipped++;
				break;

			case "add":
				if (!incoming) break;
				snapshot.created(item.path);
				await writeBinary(app, join(shareRoot, item.path), incoming);
				result.added++;
				break;

			case "overwrite":
				if (!incoming) break;
				await snapshot.keep(join(shareRoot, item.path), item.path, "overwritten");
				await writeBinary(app, join(shareRoot, item.path), incoming);
				result.overwritten++;
				break;

			case "conflict":
				// Yours stays where it is; theirs lands beside it.
				if (!incoming || !item.conflictPath) break;
				snapshot.created(item.conflictPath);
				await writeBinary(app, join(shareRoot, item.conflictPath), incoming);
				result.conflicts++;
				break;

			case "delete":
				if (!allowDeletions) {
					result.skipped++;
					break;
				}
				await snapshot.keep(join(shareRoot, item.path), item.path, "removed");
				await trash(app, join(shareRoot, item.path));
				result.deleted++;
				break;

			case "delete-skipped":
				result.skipped++;
				break;
		}
	}

	await snapshot.write();
	result.snapshot = snapshot.count ? snapshot.dir : null;

	// What we now know this peer has: the state they built on, plus their
	// entries, minus their deletions. Deliberately not a rescan — files that
	// exist only here are not something they hold, and recording them as agreed
	// is how a file silently never gets sent.
	const previous = await loadState(app, pluginDir, fromPeer(sender));
	const files: Record<string, string> = { ...(previous?.files ?? {}) };
	for (const entry of parcel.manifest.entries) files[entry.path] = entry.hash;
	for (const path of parcel.manifest.deletions) delete files[path];
	await saveState(app, pluginDir, fromPeer(sender), shareRoot, files);

	return result;
}

function conflictName(path: string, peer: string, createdAt: string): string {
	const date = createdAt.slice(0, 10);
	const who = (peer || "peer").replace(/[\\/:*?"<>|]/g, "-");
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot > slash) {
		return `${path.slice(0, dot)} (conflict from ${who} ${date})${path.slice(dot)}`;
	}
	return `${path} (conflict from ${who} ${date})`;
}
