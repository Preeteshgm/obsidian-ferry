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

import { ItemView, setIcon, Setting, TFolder, WorkspaceLeaf } from "obsidian";
import type FerryPlugin from "../main";
import type { Change, TeamStatus } from "../main";
import { FolderPicker, RenameModal } from "./modals";
import { join } from "../vaultio";

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
		return "ferry-boat";
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
		// Quietly: a redraw here would destroy the field being typed into.
		await this.plugin.saveQuiet();
	}

	/** Catch up once the person has finished with a field. */
	private onSettled(el: HTMLInputElement): void {
		this.registerDomEvent(el, "blur", () => void this.refresh());
		this.registerDomEvent(el, "keydown", (e) => {
			if (e.key === "Enter") el.blur();
		});
	}

	// ----------------------------------------------------------------- render

	/** A section heading: an icon to find it by, and a label to read. */
	private section(el: HTMLElement, icon: string, label: string): HTMLElement {
		const box = el.createDiv({ cls: "ferry-box" });
		const head = box.createDiv({ cls: "ferry-label" });
		setIcon(head.createSpan({ cls: "ferry-label-icon" }), icon);
		head.createSpan({ text: label });
		return box;
	}

	/**
	 * An icon-only button for anything secondary.
	 *
	 * `clickable-icon` is Obsidian's own class, so size, colour, hover and focus
	 * come from the theme rather than from here — which is the only way these
	 * stay right when somebody changes theme.
	 *
	 * Only `aria-label` is set, never `title`. Obsidian draws its own tooltip
	 * from aria-label; adding title makes the browser draw a second one on top
	 * of it.
	 */
	private iconButton(
		parent: HTMLElement,
		icon: string,
		tooltip: string,
		onClick: () => void,
		cls = "",
	): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `clickable-icon ${cls}`.trim() });
		setIcon(b, icon);
		b.setAttr("aria-label", tooltip);
		b.disabled = this.busy;
		b.addEventListener("click", onClick);
		return b;
	}

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
		// The app's own icon button, so it matches whatever theme is running.
		this.iconButton(
			head,
			this.setupOpen ? "check" : "settings",
			this.setupOpen ? "Done" : "Setup",
			() => {
				this.setupOpen = !this.setupOpen;
				this.render();
			},
			"ferry-gear",
		);

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
				.addText((t) => {
					t.setPlaceholder("alice")
						.setValue(this.plugin.settings.me)
						.onChange(async (v) => {
							await this.save("me", v.trim());
						});
					this.onSettled(t.inputEl);
				});
		}

		new Setting(box)
			.setName("Share root")
			.setDesc("The folder that travels. Spelled the same in every vault.")
			.addText((t) => {
				t.setPlaceholder("Projects")
					.setValue(this.plugin.settings.shareRoot)
					.onChange(async (v) => {
						await this.save("shareRoot", v.replace(/^\/+|\/+$/g, "").trim());
					});
				this.onSettled(t.inputEl);
			})
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
					// Typing one here is consent to keep it; the toggle below
					// exists to take that back, not to grant it.
					if (v && !this.plugin.settings.rememberPassphrase) {
						await this.save("rememberPassphrase", true);
					}
				});
				this.onSettled(t.inputEl);
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
			const what = this.section(
				el,
				"upload",
				s.publishedAt ? "Will publish" : "Will publish — everything you own",
			);
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
						.setIcon("rotate-ccw")
						.setTooltip("Send everything you own again")
						.onClick(() => void this.act(() => this.plugin.doPack(true))),
				);
		}

		if (this.outbox.length) {
			const out = this.section(el, "send", "Sent — attach to an email");
			this.renderParcels(out, this.outbox, join(this.plugin.settings.ferryFolder, "outbox"));
		}
	}

	/**
	 * One list of parcels, with the controls a person expects: reveal it, remove
	 * it, or open the folder and deal with the lot by hand.
	 */
	private renderParcels(
		box: HTMLElement,
		paths: string[],
		folder: string,
		action?: { label: string; run: (path: string) => Promise<void> },
	): void {
		const shown = paths.slice(0, 5);
		for (const path of shown) {
			const row = box.createDiv({ cls: "ferry-file ferry-row-action" });
			row.createSpan({ cls: "ferry-file-name", text: basename(path) });

			const buttons = row.createDiv({ cls: "ferry-row-buttons" });
			if (action) {
				const go = buttons.createEl("button", { text: action.label, cls: "mod-cta" });
				go.disabled = this.busy;
				go.addEventListener("click", () => void this.act(() => action.run(path)));
			}
			this.iconButton(buttons, "folder-open", "Show in folder", () =>
				this.plugin.showInFolder(path),
			);
			this.iconButton(
				buttons,
				"trash-2",
				"Delete — goes to the vault trash",
				() => void this.act(() => this.plugin.deleteParcel(path)),
				"ferry-del",
			);
		}
		if (paths.length > shown.length) {
			box.createDiv({ cls: "ferry-muted", text: `and ${paths.length - shown.length} more` });
		}
		const foot = box.createDiv({ cls: "ferry-box-foot" });
		this.iconButton(foot, "folder", "Open the folder and manage them by hand", () =>
			this.plugin.showInFolder(paths[0] ?? folder),
		);
	}

	private renderReceive(el: HTMLElement): void {
		const box = this.section(el, "inbox", "Receive");

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
			this.renderParcels(box, this.inbox, join(this.plugin.settings.ferryFolder, "inbox"), {
				label: "Unpack",
				run: (path) => this.plugin.doUnpack(path),
			});
		}
	}

	private renderTopics(el: HTMLElement, s: TeamStatus | null): void {
		const box = this.section(el, "layers", "Topics");
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
		const box = this.section(el, "users", "Last heard from");
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
			.setDesc(`Snapshots and parcels older than ${this.plugin.settings.retentionDays} days.`)
			.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Prune")
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
