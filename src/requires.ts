/**
 * Which community plugins the content needs.
 *
 * A note that arrives without the plugin that renders it looks broken, and the
 * person receiving it has no way to know why. So a parcel carries the list, and
 * the receiver is told what is missing and where to get it. It is advisory —
 * the files land either way.
 *
 * Detection covers the plugins that leave a visible fingerprint in the files.
 * Anything that cannot be inferred — a plugin that presents your notes rather
 * than marking them up — is declared by hand in settings.
 */

import { App } from "obsidian";
import type { Requirement, ScannedFile } from "./types";
import { readBinary, join } from "./vaultio";

interface Rule {
	id: string;
	name: string;
	/** Matched against the file path, or against text content, or both. */
	path?: RegExp;
	text?: RegExp;
}

const RULES: Rule[] = [
	{
		id: "obsidian-excalidraw-plugin",
		name: "Excalidraw",
		path: /\.excalidraw(\.md)?$/i,
		text: /^\s*excalidraw-plugin\s*:/m,
	},
	{ id: "dataview", name: "Dataview", text: /```\s*dataviewjs?\b/ },
	{
		id: "obsidian-tasks-plugin",
		name: "Tasks",
		// A query block is the obvious fingerprint, but most notes carrying tasks
		// never have one — they are plain checkbox lines with the plugin's date
		// emoji on them. A plan written that way looked, to Ferry, like a note
		// with no requirements at all, and arrived somewhere that could not read
		// its dates with nothing to say so.
		text: /```\s*tasks\b|- \[[ x\-/]\][^\n]*[\u{1F4C5}\u{1F6EB}\u{23F3}\u{2705}\u{2795}\u{1F501}]\s*\d{4}-\d{2}-\d{2}/u,
	},
	{ id: "obsidian-charts", name: "Charts", text: /```\s*chart\b/ },
	{ id: "obsidian-kanban", name: "Kanban", text: /^\s*kanban-plugin\s*:/m },
	{ id: "templater-obsidian", name: "Templater", text: /<%[\s\S]*?%>/ },
];

/** Only these are worth opening and reading as text. */
const TEXTUAL = /\.(md|canvas|json|txt|css)$/i;

export async function detect(
	app: App,
	shareRoot: string,
	files: ScannedFile[],
	declared: string[],
	autoDetect: boolean,
): Promise<Requirement[]> {
	const hits = new Map<string, { name: string; count: number }>();

	const note = (rule: Rule) => {
		const seen = hits.get(rule.id);
		if (seen) seen.count++;
		else hits.set(rule.id, { name: rule.name, count: 1 });
	};

	if (autoDetect) {
		for (const file of files) {
			for (const rule of RULES) {
				if (rule.path?.test(file.path)) note(rule);
			}
			if (!TEXTUAL.test(file.path)) continue;
			// Big text files are rare here, and reading them is cheap next to hashing.
			const text = new TextDecoder().decode(await readBinary(app, join(shareRoot, file.path)));
			for (const rule of RULES) {
				if (rule.text?.test(text)) note(rule);
			}
		}
	}

	const out: Requirement[] = [];
	for (const [id, { name, count }] of hits) {
		out.push({ id, name, reason: `${count} file${count === 1 ? "" : "s"}` });
	}
	for (const id of declared) {
		if (!hits.has(id)) out.push({ id, name: id, reason: "declared by the sender" });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Of the plugins a parcel asks for, the ones this vault does not have enabled. */
export function missing(app: App, required: Requirement[]): Requirement[] {
	// `plugins` is not in the public typings, but it is how Obsidian itself
	// tracks what is enabled, and reading it is harmless.
	const enabled: Set<string> | undefined = (app as unknown as {
		plugins?: { enabledPlugins?: Set<string> };
	}).plugins?.enabledPlugins;
	if (!enabled) return required;
	return required.filter((r) => !enabled.has(r.id));
}

export function storeUrl(id: string): string {
	return `obsidian://show-plugin?id=${encodeURIComponent(id)}`;
}
