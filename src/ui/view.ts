/**
 * The Ferry panel — everything you need, where you are.
 *
 * Three principles, each learned from watching the first version:
 *
 *   Nothing sends you to Settings. Your name, the share root and the passphrase
 *   are the whole configuration, and they are asked for here, in the order a
 *   person needs them.
 *
 *   Receiving does not mean using Explorer. A parcel arrives as an attachment:
 *   pick it where it already is, or drop it on the panel. Nothing has to be
 *   copied into the vault first.
 *
 *   Ownership is on screen. It is the reason a team exchange stays simple, so
 *   it is visible rather than hidden in a file somebody has to open.
 */

import { ItemView, Setting, TFolder, WorkspaceLeaf } from "obsidian";
import type FerryPlugin from "../main";
import type { Change, TeamStatus } from "../main";
import { FolderPicker, RenameModal } from "./modals";

export const VIEW_TYPE_FERRY = "ferry-panel";

export class FerryView extends ItemView {
	private status: TeamStatus | null = null;
	private outbox: string[] = [];
	private inbox: string[] = [];
	private busy = false;
	private setupOpen = false;
	private identityFixed = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: FerryPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FERRY;
	}
	getDisplayText(): string {
		return "Ferry";
	}
	getIcon(): string {
		return "package";
	}

	async onOpen(): Promise<void> {
		this.registerDropTarget();
		await this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			this.status = await this.plugin.getStatus();
			this.outbox = await this.plugin.listParcels("outbox");
			this.inbox = await this.plugin.listParcels("inbox");
			this.identityFixed = await this.plugin.isIdentityFixed();
		} catch {
			this.status = null;
		}
		this.render();
	}

	/** A parcel dropped anywhere on the panel is opened straight away. */
	private registerDropTarget(): void {
		const el = this.contentEl;
		this.registerDomEvent(el, "dragover", (e) => {
			e.preventDefault();
			el.addClass("ferry-dropping");
		});
		this.registerDomEvent(el, "dragleave", () => el.removeClass("ferry-dropping"));
		this.registerDomEvent(el, "drop", (e) => {
			e.preventDefault();
			el.removeClass("ferry-dropping");
			const file = e.dataTransfer?.files?.[0];
			if (file) void this.act(() => this.plugin.doUnpackFile(file));
		});
	}

	private async act(fn: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.render();
		try {
			await fn();
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	private async save<K extends keyof FerryPlugin["settings"]>(
		key: K,
		value: FerryPlugin["settings"][K],
	): Promise<void> {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}

	// ----------------------------------------------------------------- render

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("ferry-panel");

		const { shareRoot, me } = this.plugin.settings;
		const configured = Boolean(shareRoot && me);

		el.createEl("h4", { text: "Ferry" });

		if (!configured || this.setupOpen) {
			this.renderSetup(el, configured);
			if (!configured) return;
		}

		const s = this.status;
		const head = el.createDiv({ cls: "ferry-who" });
		head.createSpan({ text: me });
		head.createSpan({ cls: "ferry-muted", text: ` · ${shareRoot}` });
		const gear = head.createEl("button", { cls: "ferry-gear", text: this.setupOpen ? "Done" : "Setup" });
		gear.addEventListener("click", () => {
			this.setupOpen = !this.setupOpen;
			this.render();
		});

		if (s?.ownsNothing) {
			const warn = el.createDiv({ cls: "ferry-warning" });
			warn.createEl("strong", { text: "Nothing here belongs to you." });
			warn.createDiv({
				text:
					`You are "${me}"` +
					(s.rootOwner ? `, and the share root belongs to "${s.rootOwner}".` : ".") +
					" Either take that name, or claim a folder of your own.",
			});
			if (s.rootOwner) {
				new Setting(warn).addButton((b) =>
					b.setButtonText(`Use the name "${s.rootOwner}"`).onClick(() => {
						void (async () => {
							await this.save("me", s.rootOwner!);
							await this.refresh();
						})();
					}),
				);
			}
		}

		this.renderPublish(el, s);
		this.renderReceive(el);
		this.renderTopics(el, s);
		this.renderTeam(el, s);
		this.renderSafety(el);
	}

	/** Name, share root, passphrase — the whole configuration, asked for here. */
	private renderSetup(el: HTMLElement, configured: boolean): void {
		const box = el.createDiv({ cls: "ferry-setup" });
		if (!configured) {
			box.createEl("p", {
				cls: "ferry-muted",
				text: "Three things, once. Everyone exchanging must use the same share root and passphrase.",
			});
		}

		const nameSetting = new Setting(box).setName("Your name");
		if (this.identityFixed) {
			// Held: the team knows this name, and topics are written in it.
			nameSetting
				.setDesc("The team knows you by this. Changing it is a deliberate step.")
				.addText((t) => {
					t.setValue(this.plugin.settings.me);
					t.inputEl.readOnly = true;
					t.inputEl.addClass("ferry-readonly");
				})
				.addExtraButton((b) =>
					b
						.setIcon("pencil")
						.setTooltip("Change your name")
						.onClick(() => {
							new RenameModal(this.app, this.plugin.settings.me, (next) => {
								if (next) void this.act(() => this.plugin.renameMe(next));
							}).open();
						}),
				);
		} else {
			nameSetting
				.setDesc("How the team tells parcels apart. Pick one and keep it.")
				.addText((t) =>
					t
						.setPlaceholder("alice")
						.setValue(this.plugin.settings.me)
						.onChange(async (v) => {
							await this.save("me", v.trim());
						}),
				);
		}

		new Setting(box)
			.setName("Share root")
			.setDesc("The folder that travels. Spelled the same in every vault.")
			.addText((t) =>
				t
					.setPlaceholder("Projects")
					.setValue(this.plugin.settings.shareRoot)
					.onChange(async (v) => {
						await this.save("shareRoot", v.replace(/^\/+|\/+$/g, "").trim());
					}),
			)
			.addExtraButton((b) =>
				b
					.setIcon("folder")
					.setTooltip("Choose a folder")
					.onClick(() => {
						const folders = this.app.vault
							.getAllLoadedFiles()
							.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
							.map((f) => f.path)
							.sort();
						new FolderPicker(this.app, folders, (folder) => {
							if (!folder) return;
							void (async () => {
								await this.save("shareRoot", folder);
								this.render();
							})();
						}).open();
					}),
			);

		new Setting(box)
			.setName("Passphrase")
			.setDesc("Send it to the team through a different channel than the parcels.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.passphrase).onChange(async (v) => {
					await this.save("passphrase", v);
					if (v && !this.plugin.settings.rememberPassphrase) {
						await this.save("rememberPassphrase", true);
					}
				});
			});

		new Setting(box)
			.setName("Remember it")
			.setDesc("Stored in this vault as plain text. Leave off on a shared machine.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.rememberPassphrase).onChange(async (v) => {
					await this.save("rememberPassphrase", v);
				}),
			);

		if (configured) {
			new Setting(box)
				.setName("More settings")
				.addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.openSettings()));
		}
	}

	private renderPublish(el: HTMLElement, s: TeamStatus | null): void {
		const box = el.createDiv({ cls: "ferry-status" });
		if (this.busy) {
			box.createDiv({ text: "Working…" });
		} else if (!s) {
			box.createDiv({ cls: "ferry-muted", text: "Could not read the share root." });
		} else if (!s.publishedAt) {
			box.createDiv({ cls: "ferry-big", text: String(s.mine.total) });
			box.createDiv({ text: "files of yours — nothing published yet" });
		} else {
			const pending = s.mine.added + s.mine.changed + s.mine.deleted;
			box.createDiv({ cls: "ferry-big", text: String(pending) });
			box.createDiv({
				text:
					pending === 0
						? "nothing of yours has changed"
						: `${s.mine.added} new · ${s.mine.changed} changed · ${s.mine.deleted} deleted`,
			});
			box.createDiv({
				cls: "ferry-muted",
				text: `last published ${new Date(s.publishedAt).toLocaleString()}`,
			});
		}

		if (s?.foreign) {
			el.createDiv({
				cls: "ferry-warning",
				text:
					`${s.foreign} file(s) you do not own have been edited here. They are not yours to ` +
					"publish — tell their owner, or undo the edits.",
			});
		}

		// What will go, before it goes — the same courtesy the unpack side gives.
		if (s && (s.changes.length || s.scope.length)) {
			const what = el.createDiv({ cls: "ferry-box" });
			what.createDiv({
				cls: "ferry-label",
				text: s.publishedAt ? "Will publish" : "Will publish — everything you own",
			});
			what.createDiv({
				cls: "ferry-muted",
				text: s.scope.length ? `from ${s.scope.join(" · ")}` : "nothing is yours yet",
			});
			if (s.changes.length) {
				const list = what.createDiv({ cls: "ferry-list ferry-scroll" });
				for (const change of s.changes.slice(0, 200)) {
					const row = list.createDiv({ cls: "ferry-row" });
					row.createSpan({ cls: `ferry-tag ${TAG[change.op].cls}`, text: TAG[change.op].label });
					row.createSpan({ text: ` ${change.path}` });
				}
				if (s.changes.length > 200) {
					list.createDiv({ cls: "ferry-muted", text: `and ${s.changes.length - 200} more` });
				}
			}
		}

		const actions = el.createDiv({ cls: "ferry-actions" });
		new Setting(actions)
			.setName("Publish")
			.setDesc(
				s?.publishedAt
					? "Only what has changed since last time."
					: "Your first parcel — everything you own.",
			)
			.addButton((b) =>
				b
					.setButtonText("Publish")
					.setCta()
					.setDisabled(this.busy || !s || (s.publishedAt !== null && s.changes.length === 0))
					// The first parcel is necessarily full; after that, a delta.
					.onClick(() => void this.act(() => this.plugin.doPack(!s?.publishedAt))),
			);
		if (s?.publishedAt) {
			new Setting(actions)
				.setName("Republish everything")
				.setDesc("To bring somebody who has fallen behind back in step.")
				.addExtraButton((b) =>
					b
						.setIcon("refresh-cw")
						.setTooltip("Send everything you own again")
						.onClick(() => void this.act(() => this.plugin.doPack(true))),
				);
		}

		if (this.outbox.length) {
			const out = el.createDiv({ cls: "ferry-box" });
			out.createDiv({ cls: "ferry-label", text: "Sent — attach these to an email" });
			for (const path of this.outbox.slice(0, 4)) {
				const row = out.createDiv({ cls: "ferry-file ferry-row-action" });
				row.createSpan({ text: basename(path) });
				const btn = row.createEl("button", { text: "Show" });
				btn.addEventListener("click", () => this.plugin.showInFolder(path));
			}
			if (this.outbox.length > 4) {
				out.createDiv({ cls: "ferry-muted", text: `and ${this.outbox.length - 4} more` });
			}
		}
	}

	private renderReceive(el: HTMLElement): void {
		const box = el.createDiv({ cls: "ferry-box" });
		box.createDiv({ cls: "ferry-label", text: "Receive" });

		// A hidden file input is the only way to reach the device's own file
		// picker, and it works on desktop and on mobile alike.
		const picker = box.createEl("input", {
			type: "file",
			cls: "ferry-hidden",
			attr: { accept: ".ferry" },
		});
		picker.addEventListener("change", () => {
			const file = picker.files?.[0];
			picker.value = "";
			if (file) void this.act(() => this.plugin.doUnpackFile(file));
		});

		new Setting(box)
			.setName("Open a parcel")
			.setDesc("From anywhere on this device — or drop one on this panel.")
			.addButton((b) =>
				b
					.setButtonText("Choose a file")
					.setCta()
					.setDisabled(this.busy)
					.onClick(() => picker.click()),
			);

		if (this.inbox.length) {
			box.createDiv({
				cls: "ferry-label",
				text: `In ${this.plugin.settings.ferryFolder}/inbox`,
			});
			for (const path of this.inbox) {
				const row = box.createDiv({ cls: "ferry-file ferry-row-action" });
				row.createSpan({ text: basename(path) });
				const btn = row.createEl("button", { text: "Unpack" });
				btn.disabled = this.busy;
				btn.addEventListener("click", () => void this.act(() => this.plugin.doUnpack(path)));
			}
		}
	}

	private renderTopics(el: HTMLElement, s: TeamStatus | null): void {
		const box = el.createDiv({ cls: "ferry-box" });
		box.createDiv({ cls: "ferry-label", text: "Topics" });
		if (!s || s.open) {
			box.createDiv({
				cls: "ferry-muted",
				text: "Nothing claimed yet — everything in the share root counts as yours. Claim a folder to split the work up.",
			});
		} else {
			for (const topic of s.topics) {
				const row = box.createDiv({ cls: "ferry-topic" + (topic.mine ? " ferry-mine" : "") });
				row.createSpan({ cls: "ferry-topic-name", text: topic.prefix || "(share root)" });
				row.createSpan({ cls: "ferry-topic-owner", text: topic.mine ? "you" : topic.owner });
			}
		}
		new Setting(box).addButton((b) =>
			b
				.setButtonText("Claim a folder")
				.setDisabled(this.busy)
				.onClick(() => void this.act(() => this.plugin.doClaim())),
		);
	}

	private renderTeam(el: HTMLElement, s: TeamStatus | null): void {
		if (!s?.peers.length) return;
		const box = el.createDiv({ cls: "ferry-box" });
		box.createDiv({ cls: "ferry-label", text: "Last heard from" });
		for (const peer of s.peers) {
			const row = box.createDiv({ cls: "ferry-topic" });
			row.createSpan({ cls: "ferry-topic-name", text: peer.peer });
			row.createSpan({
				cls: "ferry-topic-owner",
				text: peer.at ? new Date(peer.at).toLocaleDateString() : "—",
			});
		}
	}

	private renderSafety(el: HTMLElement): void {
		const box = el.createDiv({ cls: "ferry-actions" });
		new Setting(box)
			.setName("Undo the last unpack")
			.setDesc("Restores the snapshot taken before it was applied.")
			.addButton((b) =>
				b
					.setButtonText("Undo")
					.setWarning()
					.setDisabled(this.busy)
					.onClick(() => void this.act(() => this.plugin.doUndo())),
			);
		new Setting(box)
			.setName("Clean up")
			.setDesc(`Older than ${this.plugin.settings.retentionDays} days.`)
			.addButton((b) =>
				b
					.setButtonText("Prune")
					.setDisabled(this.busy)
					.onClick(() => void this.act(() => this.plugin.doPrune())),
			);
	}
}

const TAG: Record<Change["op"], { label: string; cls: string }> = {
	add: { label: "new", cls: "ferry-add" },
	change: { label: "changed", cls: "ferry-change" },
	delete: { label: "deleted", cls: "ferry-delete" },
};

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}
