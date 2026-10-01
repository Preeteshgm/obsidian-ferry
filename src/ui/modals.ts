/**
 * The three things Ferry has to ask a person.
 *
 * The preview is the important one: it is shown before anything is written, it
 * lists every file by what will happen to it, and deletions need a deliberate
 * tick. A person who cannot see what a parcel will do will not trust it twice.
 */

import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import type { Plan, PlanItem } from "../types";
import { storeUrl } from "../requires";

export class PassphraseModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private title: string,
		private onDone: (passphrase: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		const field = new Setting(this.contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.addClass("ferry-wide-input");
			t.onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.finish(this.value);
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		field.setDesc("The one you and your peer agreed on, shared through a different channel.");

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Continue")
					.setCta()
					.onClick(() => this.finish(this.value)),
			);
	}

	private finish(value: string | null): void {
		this.close();
		this.onDone(value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Asks for a new name; the consequences are explained by the confirmation after it. */
export class RenameModal extends Modal {
	private value = "";
	private answered = false;

	constructor(
		app: App,
		private current: string,
		private onDone: (next: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Change your name");
		this.value = this.current;
		new Setting(this.contentEl)
			.setName("New name")
			.setDesc("Your topics will be rewritten to match, and the team learns it when you publish.")
			.addText((t) => {
				t.setValue(this.current).onChange((v) => (this.value = v));
				window.setTimeout(() => t.inputEl.focus(), 0);
			});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) => b.setButtonText("Continue").setCta().onClick(() => this.finish(this.value)));
	}

	private finish(v: string | null): void {
		this.answered = true;
		this.close();
		this.onDone(v);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) {
			this.answered = true;
			this.onDone(null);
		}
	}
}

export class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private title: string,
		private lines: string[],
		private confirmText: string,
		private onDone: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		for (const line of this.lines) this.contentEl.createEl("p", { text: line });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) => b.setButtonText(this.confirmText).setWarning().onClick(() => this.finish(true)));
	}

	private finish(ok: boolean): void {
		this.answered = true;
		this.close();
		this.onDone(ok);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) {
			this.answered = true;
			this.onDone(false);
		}
	}
}

export class ParcelPicker extends FuzzySuggestModal<string> {
	private answered = false;

	constructor(
		app: App,
		private paths: string[],
		private onPick: (path: string | undefined) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a parcel to unpack");
	}

	getItems(): string[] {
		return this.paths;
	}

	getItemText(path: string): string {
		return path;
	}

	onChooseItem(path: string): void {
		this.answered = true;
		this.onPick(path);
	}

	onClose(): void {
		// Dismissed with Escape or a click outside: answer with nothing, so the
		// caller stops waiting.
		if (!this.answered) this.onPick(undefined);
	}
}

/** Same shape as the parcel picker: choose one, or dismiss and get nothing. */
export class FolderPicker extends FuzzySuggestModal<string> {
	private answered = false;

	constructor(
		app: App,
		private folders: string[],
		private onPick: (folder: string | undefined) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a folder to claim as your topic");
	}

	getItems(): string[] {
		return this.folders;
	}

	getItemText(folder: string): string {
		return folder;
	}

	onChooseItem(folder: string): void {
		this.answered = true;
		this.onPick(folder);
	}

	onClose(): void {
		if (!this.answered) this.onPick(undefined);
	}
}

const LABELS: Record<PlanItem["kind"], { label: string; cls: string }> = {
	add: { label: "new", cls: "ferry-add" },
	overwrite: { label: "updated", cls: "ferry-change" },
	conflict: { label: "conflict", cls: "ferry-conflict" },
	delete: { label: "to delete", cls: "ferry-delete" },
	"delete-skipped": { label: "delete skipped", cls: "ferry-skip" },
	identical: { label: "unchanged", cls: "ferry-skip" },
};

export class PreviewModal extends Modal {
	private allowDeletions = false;
	private answered = false;

	constructor(
		app: App,
		private plan: Plan,
		private onDone: (allowDeletions: boolean | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl, plan } = this;
		titleEl.setText(`Parcel from ${plan.manifest.peer || "a peer"}`);

		const counts = tally(plan);
		contentEl.createEl("p", {
			text:
				`${counts.add} new · ${counts.overwrite} updated · ${counts.conflict} conflict` +
				` · ${counts.delete} to delete · ${counts.identical + counts["delete-skipped"]} unchanged`,
		});
		contentEl.createEl("p", {
			cls: "mod-muted",
			text: `Share root "${plan.manifest.shareRoot}" · packed ${new Date(
				plan.manifest.createdAt,
			).toLocaleString()}`,
		});

		for (const warning of plan.warnings) {
			contentEl.createDiv({ cls: "ferry-warning", text: warning });
		}

		if (plan.missingPlugins.length) {
			const box = contentEl.createDiv({ cls: "ferry-missing" });
			box.createEl("strong", { text: "Plugins this content uses, that you do not have:" });
			const list = box.createEl("ul");
			for (const req of plan.missingPlugins) {
				const li = list.createEl("li");
				li.createEl("a", { text: req.name, href: storeUrl(req.id) });
				if (req.reason) li.appendText(` — ${req.reason}`);
			}
			box.createDiv({
				cls: "mod-muted",
				text: "The files will still arrive; they just will not render fully until these are installed.",
			});
		}

		const listEl = contentEl.createDiv({ cls: "ferry-list ferry-preview-list" });
		for (const item of plan.items) {
			if (item.kind === "identical") continue;
			const row = listEl.createDiv({ cls: "ferry-row" });
			row.createSpan({ cls: `ferry-tag ${LABELS[item.kind].cls}`, text: LABELS[item.kind].label });
			row.createSpan({ text: ` ${item.path}` });
			if (item.conflictPath) {
				row.createDiv({ cls: "mod-muted", text: `kept as: ${item.conflictPath}` });
			} else if (item.note) {
				row.createDiv({ cls: "mod-muted", text: item.note });
			}
		}

		if (counts.delete > 0) {
			new Setting(contentEl)
				.setName(`Apply ${counts.delete} deletion${counts.delete === 1 ? "" : "s"}`)
				.setDesc("Deleted files go to the vault trash, and the snapshot keeps a copy.")
				.addToggle((t) => t.setValue(false).onChange((v) => (this.allowDeletions = v)));
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Apply")
					.setCta()
					.onClick(() => this.finish(this.allowDeletions)),
			);
	}

	private finish(answer: boolean | null): void {
		this.answered = true;
		this.close();
		this.onDone(answer);
	}

	onClose(): void {
		this.contentEl.empty();
		// Nothing has been written at this point, so a dismissal is a cancel.
		if (!this.answered) {
			this.answered = true;
			this.onDone(null);
		}
	}
}

export function tally(plan: Plan): Record<PlanItem["kind"], number> {
	const counts: Record<PlanItem["kind"], number> = {
		add: 0,
		overwrite: 0,
		conflict: 0,
		delete: 0,
		"delete-skipped": 0,
		identical: 0,
	};
	for (const item of plan.items) counts[item.kind]++;
	return counts;
}
