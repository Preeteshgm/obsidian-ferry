/**
 * Ferry — carry a folder of notes between two vaults, or around a small team,
 * as a single encrypted file.
 *
 * Each topic has exactly one owner, declared by a marker file inside it. You
 * pack what you own; everyone receives it. Because two people never write the
 * same file, there is nothing to arbitrate — and a conflict, when it happens,
 * is a signal that somebody worked outside their lane.
 *
 * The panel and the command palette call the same `do*` methods, so there is
 * one implementation of each operation and two ways to reach it.
 */

import { Notice, Plugin, TFolder, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, type FerrySettings } from "./types";
import { FerrySettingTab } from "./settings";
import { pack } from "./pack";
import { apply, plan, read, readBytes, type Parcel } from "./unpack";
import { latestBackup, prune, undo } from "./backup";
import { ensureFolder, exists, join, scan, writeBinary } from "./vaultio";
import { filesFromScan, fromPeer, knownPeers, loadState, PUBLISHED } from "./state";
import { countByTopic, MARKER, markerBody, ownerOf, ownsNothing, readOwners, sameName } from "./owners";
import { ConfirmModal, FolderPicker, ParcelPicker, PassphraseModal, PreviewModal } from "./ui/modals";
import { FerryView, VIEW_TYPE_FERRY } from "./ui/view";

export interface TopicStatus {
	prefix: string;
	owner: string;
	mine: boolean;
	files: number;
}

export interface Change {
	path: string;
	op: "add" | "change" | "delete";
}

export interface TeamStatus {
	/** True when nobody has claimed anything yet — a plain two-person share. */
	open: boolean;
	topics: TopicStatus[];
	/** No topic names this person: they cannot publish anything. */
	ownsNothing: boolean;
	rootOwner: string | null;
	mine: { total: number; added: number; changed: number; deleted: number };
	/** Exactly what the next parcel would carry. */
	changes: Change[];
	/** The folders those changes can come from — what you own. */
	scope: string[];
	/** Files owned by others that have been edited here. Reported, never sent. */
	foreign: number;
	publishedAt: string | null;
	peers: { peer: string; at: string | null }[];
	waiting: number;
}

export default class FerryPlugin extends Plugin {
	settings: FerrySettings = { ...DEFAULT_SETTINGS };
	private statusBar: HTMLElement | null = null;
	/**
	 * Held for this session only, when the passphrase is not stored.
	 *
	 * Asking once a session is the honest middle ground: nothing is written to
	 * the vault, and nobody is retyping a long passphrase to publish twice in a
	 * morning. Forgotten the moment Obsidian closes, or the moment one fails.
	 */
	private sessionPassphrase: string | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new FerrySettingTab(this.app, this));

		this.registerView(VIEW_TYPE_FERRY, (leaf) => new FerryView(leaf, this));
		this.addRibbonIcon("package", "Ferry", () => void this.openPanel());

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("ferry-statusbar");
		this.statusBar.addEventListener("click", () => void this.openPanel());

		this.addCommand({ id: "panel", name: "Open the panel", callback: () => void this.openPanel() });
		this.addCommand({ id: "pack", name: "Publish my changes", callback: () => void this.doPack(false) });
		this.addCommand({
			id: "pack-full",
			name: "Publish everything I own (first time, or to re-sync)",
			callback: () => void this.doPack(true),
		});
		this.addCommand({ id: "unpack", name: "Unpack a parcel", callback: () => void this.doUnpack() });
		this.addCommand({ id: "claim", name: "Claim a folder as my topic", callback: () => void this.doClaim() });
		this.addCommand({ id: "status", name: "Status: what would be published", callback: () => void this.showStatus() });
		this.addCommand({ id: "undo", name: "Undo the last unpack", callback: () => void this.doUndo() });
		this.addCommand({ id: "prune", name: "Clean up old snapshots and parcels", callback: () => void this.doPrune() });

		// The vault cannot be walked during onload.
		this.app.workspace.onLayoutReady(() => void this.prepare());
	}

	onunload(): void {
		this.statusBar?.remove();
		this.sessionPassphrase = null;
	}

	/**
	 * Make the inbox and outbox as soon as there is a configuration, so a new
	 * member can see where parcels go before they have sent or received one.
	 */
	async prepare(): Promise<void> {
		if (this.settings.shareRoot && this.settings.me) {
			try {
				await ensureFolder(this.app, join(this.settings.ferryFolder, "inbox"));
				await ensureFolder(this.app, join(this.settings.ferryFolder, "outbox"));
			} catch {
				// A read-only vault is not a reason to fail loading.
			}
		}
		await this.refreshStatusBar();
	}

	// ------------------------------------------------------------- operations

	async doPack(full: boolean): Promise<void> {
		if (!this.ready()) return;
		const passphrase = await this.askPassphrase("Publish a parcel");
		if (!passphrase) return;

		try {
			const r = await pack(
				this.app,
				this.pluginDir,
				this.settings,
				this.manifest.version,
				passphrase,
				full,
			);
			const size = (r.bytes / 1024 / 1024).toFixed(1);
			new Notice(
				`Ferry: published ${r.entries.length} file(s)` +
					(r.deletions.length ? `, ${r.deletions.length} deletion(s)` : "") +
					(r.foreign ? `\n${r.foreign} change(s) to files you do not own were not sent.` : "") +
					`\n${r.path} (${size} MB)`,
				14000,
			);
			if (r.bytes > 20 * 1024 * 1024) {
				new Notice(
					`Ferry: that parcel is ${size} MB — larger than most email limits. ` +
						"Share it as a file link, or exclude the large attachments.",
					14000,
				);
			}
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	/**
	 * Unpack a parcel chosen anywhere on the device — the panel's file picker and
	 * its drop target both land here, so nothing has to be copied into the vault.
	 */
	async doUnpackFile(file: File): Promise<void> {
		if (!this.ready()) return;
		const passphrase = await this.askPassphrase("Unpack a parcel");
		if (!passphrase) return;
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			await this.unpackParcel(await readBytes(bytes, passphrase, file.name));
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	/**
	 * True once the name has been used for something: a parcel published, or a
	 * topic claimed. From then on it is an identity the team knows, and changing
	 * it is an operation rather than an edit.
	 */
	async isIdentityFixed(): Promise<boolean> {
		if (!this.settings.shareRoot || !this.settings.me) return false;
		if (await loadState(this.app, this.pluginDir, PUBLISHED)) return true;
		const s = await this.getStatus();
		return s.topics.some((t) => t.mine);
	}

	/**
	 * Change the name properly: every marker you own is rewritten, so you keep
	 * your topics. The team only learns about it when you next publish.
	 */
	async renameMe(next: string): Promise<void> {
		const previous = this.settings.me;
		const target = next.trim();
		if (!target || sameName(target, previous)) return;

		const ok = await new Promise<boolean>((resolve) => {
			new ConfirmModal(
				this.app,
				`Change your name to "${target}"?`,
				[
					`Your name is how the team recognises your parcels, and it is written into every topic you own.`,
					`Ferry will rewrite your markers so you keep your topics — but until you publish, the others still know you as "${previous}".`,
					`Anyone who has received from you will see the next parcel as coming from someone new, and may need a full parcel from you.`,
				],
				"Change it",
				resolve,
			).open();
		});
		if (!ok) return;

		try {
			const scanned = await scan(this.app, this.settings.shareRoot, this.settings.excludes, [
				this.settings.ferryFolder,
			]);
			const owners = await readOwners(this.app, this.settings.shareRoot, scanned);
			let rewritten = 0;
			for (const topic of owners.topics) {
				if (!sameName(topic.owner, previous)) continue;
				await writeBinary(
					this.app,
					join(this.settings.shareRoot, topic.marker),
					new TextEncoder().encode(markerBody(target)),
				);
				rewritten++;
			}
			this.settings.me = target;
			await this.saveSettings();
			new Notice(
				`Ferry: you are now "${target}"` +
					(rewritten ? `, and ${rewritten} topic marker(s) were rewritten.` : ".") +
					"\nPublish so the team learns the new name.",
				14000,
			);
		} catch (err) {
			this.fail(err);
		}
	}

	/** Open the folder a parcel is in, so it can be attached to an email. */
	showInFolder(path: string): void {
		try {
			const host = this.app as unknown as { showInFolder?(p: string): void };
			if (host.showInFolder) host.showInFolder(path);
			else new Notice(`Ferry: ${path}`, 10000);
		} catch {
			new Notice(`Ferry: ${path}`, 10000);
		}
	}

	/** With no path, asks which parcel; the panel passes one directly. */
	async doUnpack(path?: string): Promise<void> {
		if (!this.ready()) return;

		let target = path;
		if (!target) {
			const inbox = join(this.settings.ferryFolder, "inbox");
			await ensureFolder(this.app, inbox);
			const found = await this.listParcels("inbox");
			if (!found.length) {
				new Notice(`Ferry: put a .ferry file in "${inbox}" and try again.`, 8000);
				return;
			}
			target = await new Promise<string | undefined>((resolve) => {
				new ParcelPicker(this.app, found, resolve).open();
			});
			if (!target) return;
		}

		const passphrase = await this.askPassphrase("Unpack a parcel");
		if (!passphrase) return;

		try {
			await this.unpackParcel(await read(this.app, target, passphrase));
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	/** Preview, then apply — shared by every way of choosing a parcel. */
	private async unpackParcel(parcel: Parcel): Promise<void> {
		const theplan = await plan(this.app, this.pluginDir, this.settings, parcel);

		const allowDeletions = await new Promise<boolean | null>((resolve) => {
			new PreviewModal(this.app, theplan, resolve).open();
		});
		if (allowDeletions === null) return; // cancelled — nothing written

		const r = await apply(this.app, this.pluginDir, this.settings, parcel, theplan, allowDeletions);
		new Notice(
			`Ferry: ${r.added} new · ${r.overwritten} updated · ${r.conflicts} conflict · ` +
				`${r.deleted} deleted` +
				(r.transfers.length ? `\nOwnership changed: ${r.transfers.join(", ")}` : "") +
				(r.snapshot ? "\nUndo is available from the panel." : ""),
			14000,
		);
	}

	/**
	 * Claim a folder by writing the marker inside it. Ownership is declared
	 * where it applies, so only its owner can hand it on.
	 */
	async doClaim(folder?: string): Promise<void> {
		if (!this.ready()) return;

		let target = folder;
		if (!target) {
			const root = this.settings.shareRoot;
			const folders = this.app.vault
				.getAllLoadedFiles()
				.filter((f): f is TFolder => f instanceof TFolder)
				.map((f) => f.path)
				.filter((p) => p === root || p.startsWith(root + "/"))
				.sort();
			if (!folders.length) {
				new Notice("Ferry: the share root does not exist yet.", 8000);
				return;
			}
			target = await new Promise<string | undefined>((resolve) => {
				new FolderPicker(this.app, folders, resolve).open();
			});
			if (!target) return;
		}

		try {
			const markerPath = join(target, MARKER);
			if (await exists(this.app, markerPath)) {
				const scanned = await scan(this.app, this.settings.shareRoot, this.settings.excludes, [
					this.settings.ferryFolder,
				]);
				const owners = await readOwners(this.app, this.settings.shareRoot, scanned);
				const rel = markerPath.slice(this.settings.shareRoot.length + 1);
				const current = ownerOf(owners, rel, this.settings.me);
				if (!sameName(current, this.settings.me)) {
					new Notice(
						`Ferry: "${target}" belongs to ${current}. Only they can transfer it — ` +
							"ask them to change the marker and publish.",
						12000,
					);
					return;
				}
			}
			await writeBinary(
				this.app,
				markerPath,
				new TextEncoder().encode(markerBody(this.settings.me)),
			);
			new Notice(`Ferry: ${target} is now yours. Publish to tell the team.`, 10000);
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	async doUndo(): Promise<void> {
		if (!this.ready()) return;
		try {
			if (!(await latestBackup(this.app, this.pluginDir))) {
				new Notice("Ferry: nothing to undo.");
				return;
			}
			const r = await undo(this.app, this.pluginDir, this.settings.shareRoot);
			new Notice(
				r ? `Ferry: undone — ${r.restored} restored, ${r.removed} removed.` : "Ferry: nothing to undo.",
				10000,
			);
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	async doPrune(): Promise<void> {
		try {
			const r = await prune(
				this.app,
				this.pluginDir,
				this.settings.ferryFolder,
				this.settings.retentionDays,
			);
			new Notice(
				`Ferry: removed ${r.snapshots} snapshot(s) and ${r.parcels} parcel(s) older than ` +
					`${this.settings.retentionDays} days.`,
				8000,
			);
		} catch (err) {
			this.fail(err);
		} finally {
			await this.afterChange();
		}
	}

	// ------------------------------------------------------------------ state

	async getStatus(): Promise<TeamStatus> {
		const me = this.settings.me || "me";
		const empty: TeamStatus = {
			open: true,
			topics: [],
			ownsNothing: false,
			rootOwner: null,
			mine: { total: 0, added: 0, changed: 0, deleted: 0 },
			changes: [],
			scope: [],
			foreign: 0,
			publishedAt: null,
			peers: [],
			waiting: 0,
		};
		if (!this.settings.shareRoot) return empty;

		const scanned = await scan(this.app, this.settings.shareRoot, this.settings.excludes, [
			this.settings.ferryFolder,
		]);
		const owners = await readOwners(this.app, this.settings.shareRoot, scanned);
		const counts = countByTopic(owners, scanned, me);

		const mineFiles = scanned.filter((f) => sameName(ownerOf(owners, f.path, me), me));
		const current = filesFromScan(mineFiles);
		const published = await loadState(this.app, this.pluginDir, PUBLISHED);
		const before = published?.files ?? {};

		// The first parcel is everything you own; later ones are the difference.
		const changes: Change[] = [];
		let added = 0;
		let changed = 0;
		for (const [path, hash] of Object.entries(current)) {
			if (!(path in before)) {
				added++;
				changes.push({ path, op: "add" });
			} else if (before[path] !== hash) {
				changed++;
				changes.push({ path, op: "change" });
			}
		}
		const removed = Object.keys(before).filter((p) => !(p in current));
		for (const path of removed) changes.push({ path, op: "delete" });
		const deleted = removed.length;
		changes.sort((a, b) => a.path.localeCompare(b.path));

		const peers: { peer: string; at: string | null }[] = [];
		const received: Record<string, string> = {};
		for (const peer of await knownPeers(this.app, this.pluginDir)) {
			const state = await loadState(this.app, this.pluginDir, fromPeer(peer));
			peers.push({ peer, at: state?.updatedAt ?? null });
			Object.assign(received, state?.files ?? {});
		}

		let foreign = 0;
		if (!owners.open) {
			for (const file of scanned) {
				if (sameName(ownerOf(owners, file.path, me), me)) continue;
				const known = received[file.path];
				if (known !== undefined && known !== file.hash) foreign++;
			}
		}

		return {
			open: owners.open,
			topics: owners.topics
				.map((t) => ({
					prefix: t.prefix,
					owner: t.owner,
					mine: sameName(t.owner, me),
					files: counts.get(t.owner) ?? 0,
				}))
				.sort((a, b) => (a.mine === b.mine ? a.prefix.localeCompare(b.prefix) : a.mine ? -1 : 1)),
			ownsNothing: ownsNothing(owners, me),
			rootOwner: owners.topics.find((t) => !t.prefix)?.owner ?? null,
			mine: { total: mineFiles.length, added, changed, deleted },
			changes,
			scope: owners.open
				? [this.settings.shareRoot]
				: owners.topics
						.filter((t) => sameName(t.owner, me))
						.map((t) => join(this.settings.shareRoot, t.prefix)),
			foreign,
			publishedAt: published?.updatedAt ?? null,
			peers: peers.sort((a, b) => a.peer.localeCompare(b.peer)),
			waiting: (await this.listParcels("inbox")).length,
		};
	}

	async listParcels(box: "inbox" | "outbox"): Promise<string[]> {
		const folder = join(this.settings.ferryFolder, box);
		if (!(await exists(this.app, folder))) return [];
		const listed = await this.app.vault.adapter.list(folder);
		return listed.files.filter((f) => f.endsWith(".ferry")).sort().reverse();
	}

	// --------------------------------------------------------------------- ui

	async openPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_FERRY);
		if (existing.length) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_FERRY, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	openSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		}).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	private async showStatus(): Promise<void> {
		if (!this.ready()) return;
		try {
			const s = await this.getStatus();
			const pending = s.mine.added + s.mine.changed + s.mine.deleted;
			new Notice(
				s.publishedAt
					? `Ferry: ${s.mine.added} new · ${s.mine.changed} changed · ${s.mine.deleted} deleted ` +
							`in your topics (last published ${new Date(s.publishedAt).toLocaleString()})` +
							(s.foreign ? `\n${s.foreign} file(s) you do not own were edited here.` : "")
					: `Ferry: nothing published yet — ${s.mine.total} file(s) of yours would be sent.`,
				12000,
			);
			if (!pending && s.publishedAt) new Notice("Ferry: nothing of yours has changed.", 6000);
		} catch (err) {
			this.fail(err);
		}
	}

	/** After anything that changes the vault: redraw the panel and status bar. */
	private async afterChange(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FERRY)) {
			const view = leaf.view;
			if (view instanceof FerryView) await view.refresh();
		}
		await this.refreshStatusBar();
	}

	private async refreshStatusBar(): Promise<void> {
		if (!this.statusBar) return;
		if (!this.settings.shareRoot || !this.settings.me) {
			this.statusBar.setText("");
			return;
		}
		try {
			const s = await this.getStatus();
			const pending = s.publishedAt
				? s.mine.added + s.mine.changed + s.mine.deleted
				: s.mine.total;
			const parts: string[] = [];
			if (pending) parts.push(`${pending} to publish`);
			if (s.waiting) parts.push(`${s.waiting} waiting`);
			this.statusBar.setText(parts.length ? `Ferry: ${parts.join(" · ")}` : "Ferry: up to date");
		} catch {
			this.statusBar.setText("");
		}
	}

	// ---------------------------------------------------------------- helpers

	private get pluginDir(): string {
		return this.manifest.dir ?? join(this.app.vault.configDir, "plugins", this.manifest.id);
	}

	private ready(): boolean {
		if (!this.settings.shareRoot) {
			new Notice("Ferry: set a share root in settings first.", 8000);
			return false;
		}
		if (!this.settings.me) {
			new Notice("Ferry: put your name in settings — it is how the team tells parcels apart.", 8000);
			return false;
		}
		return true;
	}

	private askPassphrase(title: string): Promise<string | null> {
		if (this.settings.rememberPassphrase && this.settings.passphrase) {
			return Promise.resolve(this.settings.passphrase);
		}
		if (this.sessionPassphrase) return Promise.resolve(this.sessionPassphrase);
		return new Promise((resolve) => {
			new PassphraseModal(this.app, title, (value) => {
				if (value) this.sessionPassphrase = value;
				resolve(value);
			}).open();
		});
	}

	private fail(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		// A rejected passphrase must not be remembered, or every later attempt
		// fails the same way without asking again.
		if (message.includes("passphrase")) this.sessionPassphrase = null;
		new Notice(`Ferry: ${message}`, 12000);
		console.error("[ferry]", err);
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<FerrySettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.prepare();
		await this.afterChange();
	}

	/**
	 * Write the settings and redraw nothing.
	 *
	 * The panel's own fields use this. Refreshing on every keystroke rebuilds
	 * the panel, which destroys the input being typed into — so the field is
	 * saved quietly and the panel catches up when focus leaves it.
	 */
	async saveQuiet(): Promise<void> {
		await this.saveData(this.settings);
	}
}
