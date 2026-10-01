/**
 * Nothing is written before a copy is taken.
 *
 * Every apply snapshots the files it is about to overwrite or remove, and
 * records which files it created. That makes "undo the last unpack" a complete
 * operation rather than a best effort, and it is the reason a parcel from
 * somebody else is safe to accept.
 *
 * This covers Ferry's own mistakes. It is not a vault backup, and the settings
 * screen says so plainly.
 */

import { App } from "obsidian";
import type { BackupItem, BackupMeta } from "./types";
import { ensureFolder, exists, join, readBinary, trash, writeBinary } from "./vaultio";

export function stampNow(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export class Snapshot {
	private items: BackupItem[] = [];
	readonly dir: string;

	constructor(
		private app: App,
		pluginDir: string,
		readonly stamp: string,
		private peer: string,
		private parcel: string,
	) {
		this.dir = join(pluginDir, "backups", stamp);
	}

	/** Copy a file aside before it is overwritten or removed. */
	async keep(vaultPath: string, rel: string, op: "overwritten" | "removed"): Promise<void> {
		if (await exists(this.app, vaultPath)) {
			await writeBinary(this.app, join(this.dir, "files", rel), await readBinary(this.app, vaultPath));
		}
		this.items.push({ path: rel, op });
	}

	/** Record a file that did not exist before, so undo knows to remove it. */
	created(rel: string): void {
		this.items.push({ path: rel, op: "created" });
	}

	get count(): number {
		return this.items.length;
	}

	async write(): Promise<void> {
		if (!this.items.length) return;
		await ensureFolder(this.app, this.dir);
		const meta: BackupMeta = {
			stamp: this.stamp,
			peer: this.peer,
			parcel: this.parcel,
			items: this.items,
		};
		await this.app.vault.adapter.write(join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
	}
}

async function backupDirs(app: App, pluginDir: string): Promise<string[]> {
	const root = join(pluginDir, "backups");
	if (!(await exists(app, root))) return [];
	const listed = await app.vault.adapter.list(root);
	return listed.folders.sort();
}

export async function latestBackup(
	app: App,
	pluginDir: string,
): Promise<{ dir: string; meta: BackupMeta } | null> {
	const dirs = await backupDirs(app, pluginDir);
	const dir = dirs[dirs.length - 1];
	if (!dir) return null;
	const metaPath = join(dir, "meta.json");
	if (!(await exists(app, metaPath))) return null;
	return { dir, meta: JSON.parse(await app.vault.adapter.read(metaPath)) as BackupMeta };
}

/**
 * Put the vault back as it was: restore what was overwritten or removed, and
 * remove what the apply created.
 */
export async function undo(
	app: App,
	pluginDir: string,
	shareRoot: string,
): Promise<{ restored: number; removed: number } | null> {
	const found = await latestBackup(app, pluginDir);
	if (!found) return null;

	let restored = 0;
	let removed = 0;
	for (const item of found.meta.items) {
		const target = join(shareRoot, item.path);
		if (item.op === "created") {
			await trash(app, target);
			removed++;
			continue;
		}
		const kept = join(found.dir, "files", item.path);
		if (await exists(app, kept)) {
			await writeBinary(app, target, await readBinary(app, kept));
			restored++;
		}
	}
	// The snapshot has served its purpose; keeping it invites a second undo
	// that would restore stale content over newer work.
	await trash(app, found.dir);
	return { restored, removed };
}

/** Drop snapshots and parcels older than `days`. Run it when you feel like it. */
export async function prune(
	app: App,
	pluginDir: string,
	ferryFolder: string,
	days: number,
): Promise<{ snapshots: number; parcels: number }> {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	let snapshots = 0;
	let parcels = 0;

	for (const dir of await backupDirs(app, pluginDir)) {
		const metaPath = join(dir, "meta.json");
		if (!(await exists(app, metaPath))) continue;
		const meta = JSON.parse(await app.vault.adapter.read(metaPath)) as BackupMeta;
		if (parseStamp(meta.stamp) < cutoff) {
			await trash(app, dir);
			snapshots++;
		}
	}

	for (const box of ["outbox", "inbox"]) {
		const dir = join(ferryFolder, box);
		if (!(await exists(app, dir))) continue;
		const listed = await app.vault.adapter.list(dir);
		for (const file of listed.files) {
			if (!file.endsWith(".ferry")) continue;
			const stat = await app.vault.adapter.stat(file);
			if (stat && stat.mtime < cutoff) {
				await trash(app, file);
				parcels++;
			}
		}
	}
	return { snapshots, parcels };
}

/** "20261001-091500" -> epoch ms */
function parseStamp(stamp: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
	if (!m) return 0;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
