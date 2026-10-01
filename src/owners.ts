/**
 * Who owns what.
 *
 * Every topic carries its own marker file naming its owner, so ownership is
 * declared *inside* the thing owned. That single choice makes the rule
 * enforceable rather than social: a transfer is an edit to the marker, the
 * marker belongs to the current owner, and it travels in that owner's parcel.
 * Nobody can hand somebody else's topic away.
 *
 *     Field/_ferry-owner.json     { "owner": "sara" }
 *     _ferry-owner.json           { "owner": "preetesh" }   <- the share root
 *
 * The root marker is the fallback, so nothing is ever unowned. Longest matching
 * prefix wins, which lets a sub-folder belong to someone else without carving
 * up the topic above it.
 *
 * With no markers at all, everything belongs to whoever is asking — so a
 * two-person share keeps working without any of this.
 */

import { App } from "obsidian";
import type { ScannedFile } from "./types";
import { join, readBinary } from "./vaultio";

export const MARKER = "_ferry-owner.json";

export interface Topic {
	/** Path prefix inside the share root; "" is the root itself. */
	prefix: string;
	owner: string;
	/** The marker file's own path, relative to the share root. */
	marker: string;
}

export interface OwnerMap {
	topics: Topic[];
	/** True when no markers exist — then everything belongs to the asker. */
	open: boolean;
}

export function isMarker(path: string): boolean {
	return path === MARKER || path.endsWith("/" + MARKER);
}

/** Read every marker under the share root and sort them longest-prefix first. */
export async function readOwners(
	app: App,
	shareRoot: string,
	files: ScannedFile[],
): Promise<OwnerMap> {
	const topics: Topic[] = [];
	for (const file of files) {
		if (!isMarker(file.path)) continue;
		try {
			const text = new TextDecoder().decode(await readBinary(app, join(shareRoot, file.path)));
			const owner = String(JSON.parse(text).owner ?? "").trim();
			if (!owner) continue;
			topics.push({
				prefix: file.path === MARKER ? "" : file.path.slice(0, -(MARKER.length + 1)),
				owner,
				marker: file.path,
			});
		} catch {
			// A malformed marker leaves that folder to the nearest owner above it,
			// which is safer than guessing.
		}
	}
	topics.sort((a, b) => b.prefix.length - a.prefix.length);
	return { topics, open: topics.length === 0 };
}

/**
 * Names are typed by people into a settings box. Comparing them exactly turns
 * "Preetesh" and "preetesh" into two different people, and the symptom — owning
 * nothing, with no explanation — is nearly impossible to guess from.
 */
export function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function ownerOf(map: OwnerMap, path: string, fallback: string): string {
	if (map.open) return fallback;
	for (const topic of map.topics) {
		if (!topic.prefix) return topic.owner; // the root marker matches everything
		if (path === topic.prefix || path.startsWith(topic.prefix + "/")) return topic.owner;
	}
	return fallback;
}

export function topicsOf(map: OwnerMap, owner: string): Topic[] {
	return map.topics.filter((t) => sameName(t.owner, owner));
}

/** True when no topic names this person — they own nothing at all. */
export function ownsNothing(map: OwnerMap, who: string): boolean {
	return !map.open && !map.topics.some((t) => sameName(t.owner, who));
}

/** How many files sit under each topic — for the panel. */
export function countByTopic(
	map: OwnerMap,
	files: ScannedFile[],
	fallback: string,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of files) {
		const owner = ownerOf(map, file.path, fallback);
		counts.set(owner, (counts.get(owner) ?? 0) + 1);
	}
	return counts;
}

export function markerBody(owner: string): string {
	return JSON.stringify(
		{
			owner,
			note: "Ferry: this folder and everything under it belongs to the person named above. Only they can change it, and only they can transfer it.",
			since: new Date().toISOString().slice(0, 10),
		},
		null,
		2,
	);
}
