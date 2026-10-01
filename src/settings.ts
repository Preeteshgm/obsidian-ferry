/** The settings screen, and the two honest warnings it has to carry. */

import { App, PluginSettingTab, Setting } from "obsidian";
import type FerryPlugin from "./main";

export class FerrySettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: FerryPlugin,
	) {
		super(app, plugin);
	}


	/**
	 * What Ferry is and how it is used, on the screen where somebody goes when
	 * they are unsure. A plugin that only explains itself in a README explains
	 * itself to nobody.
	 */
	private explain(el: HTMLElement): void {
		const box = el.createDiv({ cls: "ferry-help" });
		box.createEl("p", {
			text:
				"Ferry carries a folder of notes between vaults as one encrypted file. No server, " +
				"no accounts, nobody online at the same time. You publish; the file travels by " +
				"email, chat or a USB stick; the other side unpacks it.",
		});

		const how = box.createEl("dl");
		const item = (term: string, detail: string) => {
			how.createEl("dt", { text: term });
			how.createEl("dd", { text: detail });
		};
		item(
			"Share root",
			"The one folder that travels. It must be spelled the same in every vault, because " +
				"notes refer to each other by path — if it landed elsewhere, links and canvases would break.",
		);
		item(
			"Topics and owners",
			"Each folder can be claimed by one person, from the Ferry panel. Claiming writes a " +
				"small marker inside it naming the owner. You publish only what you own, so two " +
				"people never write the same file — and only an owner can transfer their own topic.",
		);
		item(
			"Publish",
			"Packs everything you have changed in your topics since last time into a .ferry file " +
				"in the outbox. The first one carries everything you own; later ones carry only the " +
				"difference. The panel lists exactly what will go before you press it.",
		);
		item(
			"Unpack",
			"Open a parcel from anywhere on the device, or drop it on the panel. You see a preview " +
				"of every change first, deletions need a separate tick, and everything overwritten is " +
				"backed up so the last unpack can be undone.",
		);
		item(
			"Conflicts",
			"If a file changed on both sides, both are kept — yours untouched, theirs beside it " +
				"marked as a conflict. Nothing is ever silently overwritten.",
		);

		box.createEl("p", {
			cls: "ferry-help-note",
			text:
				"Everyone exchanging must use the same share root and the same passphrase. Send the " +
				"passphrase through a different channel than the parcels themselves.",
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.explain(containerEl);

		new Setting(containerEl).setName("You").setHeading();

		new Setting(containerEl)
			.setName("Your name")
			.setDesc(
				"Your identity on this share: it is stamped on every parcel and written into the " +
					"folders you claim. Change it from the Ferry panel, which rewrites your topic " +
					"markers so you keep them — editing it here would quietly cost you your topics.",
			)
			.addText((t) => {
				t.setValue(this.plugin.settings.me);
				t.inputEl.readOnly = true;
				t.inputEl.addClass("ferry-readonly");
			})
			.addButton((b) =>
				b.setButtonText("Open the panel").onClick(() => void this.plugin.openPanel()),
			);

		new Setting(containerEl).setName("What travels").setHeading();

		new Setting(containerEl)
			.setName("Share root")
			.setDesc(
				"The folder both vaults agree on, relative to the vault root. Paths inside a parcel " +
					"are relative to it, so links and canvas references resolve on both sides. Agree it " +
					"once, on the first exchange, and leave it alone.",
			)
			.addText((t) =>
				t
					.setPlaceholder("Projects")
					.setValue(this.plugin.settings.shareRoot)
					.onChange(async (v) => {
						this.plugin.settings.shareRoot = v.replace(/^\/+|\/+$/g, "").trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Exclude")
			.setDesc("One pattern per line, matched against paths inside the share root. * and ** work.")
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setValue(this.plugin.settings.excludes.join("\n")).onChange(async (v) => {
					this.plugin.settings.excludes = v
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Ferry folder")
			.setDesc("Where parcels are written and looked for. Never included in a parcel.")
			.addText((t) =>
				t
					.setPlaceholder("Ferry")
					.setValue(this.plugin.settings.ferryFolder)
					.onChange(async (v) => {
						this.plugin.settings.ferryFolder = v.replace(/^\/+|\/+$/g, "").trim() || "Ferry";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Encryption").setHeading();

		new Setting(containerEl)
			.setName("Remember the passphrase")
			.setDesc(
				"Stored in this plugin's data file, inside the vault, as plain text. Convenient on your " +
					"own machine; leave it off on a shared one and Ferry will ask each time.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.rememberPassphrase).onChange(async (v) => {
					this.plugin.settings.rememberPassphrase = v;
					if (!v) this.plugin.settings.passphrase = "";
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.rememberPassphrase) {
			new Setting(containerEl)
				.setName("Passphrase")
				.setDesc("Both sides must use the same one. Send it through a different channel than the parcels.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(this.plugin.settings.passphrase).onChange(async (v) => {
						this.plugin.settings.passphrase = v;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl).setName("Ownership").setHeading();

		new Setting(containerEl)
			.setName("Refuse to publish what is not mine")
			.setDesc(
				"Each topic has one owner, declared by a marker file inside it. Off, Ferry warns " +
					"about edits to other people's files and leaves them out of the parcel. On, it " +
					"refuses to publish at all until they are resolved.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.strictOwnership).onChange(async (v) => {
					this.plugin.settings.strictOwnership = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Plugins the content needs").setHeading();

		new Setting(containerEl)
			.setName("Detect automatically")
			.setDesc(
				"Reads the files for the usual fingerprints — Excalidraw, Dataview, Tasks, Charts, " +
					"Kanban, Templater — and lists them in the parcel so the other side knows what to install.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.detectPlugins).onChange(async (v) => {
					this.plugin.settings.detectPlugins = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Also declare")
			.setDesc(
				"Plugin ids that cannot be inferred from the files — one per line. A plugin that " +
					"presents your notes rather than marking them up will not be detected.",
			)
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setPlaceholder("my-presenter-plugin");
				t.setValue(this.plugin.settings.declaredPlugins.join("\n")).onChange(async (v) => {
					this.plugin.settings.declaredPlugins = v
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl).setName("Safety").setHeading();

		new Setting(containerEl)
			.setName("Keep snapshots and parcels for")
			.setDesc(
				"Days. Every unpack snapshots what it overwrites or removes, so it can be undone. " +
					"This protects you from a bad parcel — it is not a backup of your vault.",
			)
			.addText((t) =>
				t
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.retentionDays))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						this.plugin.settings.retentionDays = Number.isFinite(n) && n > 0 ? n : 30;
						await this.plugin.saveSettings();
					}),
			);
	}
}
