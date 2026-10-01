/** The shapes that travel between vaults, and the ones that stay behind. */

export const FORMAT = 1;

/** One file carried by a parcel. Paths are relative to the share root. */
export interface Entry {
	path: string;
	hash: string;
	size: number;
	op: "add" | "change";
}

/**
 * A community plugin the content needs in order to render as intended.
 * Advisory only — the files land either way.
 */
export interface Requirement {
	id: string;
	name: string;
	reason?: string;
}

/** The parcel's table of contents. Written as manifest.json inside the zip. */
export interface Manifest {
	format: number;
	plugin: "ferry";
	version: string;
	shareRoot: string;
	peer: string;
	createdAt: string;
	/** The state this delta applies to; null for a full parcel. */
	baseState: string | null;
	/** The sender's state after packing — what the receiver adopts. */
	resultState: string;
	entries: Entry[];
	deletions: string[];
	requires: Requirement[];
	/** Topic prefixes the sender claims to own, so a receiver can check. */
	owns: string[];
}

/**
 * A record of what was last agreed. There are two kinds, and keeping them
 * apart is what lets one parcel go to a whole team:
 *
 *   "published"   what I last sent — the same for everybody
 *   "from:<peer>" what I last received from that person
 */
export interface PeerState {
	shareRoot: string;
	peer: string;
	updatedAt: string;
	/** path -> hash, as of the last successful exchange */
	files: Record<string, string>;
	/** hash of `files`, so a parcel can say which state it was built on */
	stateHash: string;
}

/** A file on disk under the share root, with its hash. */
export interface ScannedFile {
	path: string;
	hash: string;
	size: number;
}

/** What unpacking a parcel would do, decided before anything is written. */
export type PlanKind =
	| "add"
	| "overwrite"
	| "identical"
	| "conflict"
	| "delete"
	| "delete-skipped";

export interface PlanItem {
	kind: PlanKind;
	path: string;
	/** Where a conflicting incoming file would be written instead. */
	conflictPath?: string;
	note?: string;
}

export interface Plan {
	manifest: Manifest;
	items: PlanItem[];
	missingPlugins: Requirement[];
	/** Anything the person should read before applying. */
	warnings: string[];
}

/** One file touched by an apply, recorded so undo can put it back. */
export interface BackupItem {
	path: string;
	op: "created" | "overwritten" | "removed";
}

export interface BackupMeta {
	stamp: string;
	peer: string;
	parcel: string;
	items: BackupItem[];
}

export interface FerrySettings {
	/** Your name — on parcels you send, and in the ownership markers. */
	me: string;
	/** Vault-relative folder both sides share. Set on the first exchange. */
	shareRoot: string;
	/** Where parcels are written and read. Always excluded from the share. */
	ferryFolder: string;
	/** Stored locally if you let it; otherwise Ferry asks every time. */
	passphrase: string;
	rememberPassphrase: boolean;
	/** Simple `*` globs, matched against paths relative to the share root. */
	excludes: string[];
	/**
	 * Refuse to pack files you do not own, rather than warning about them.
	 * Off by default: people reorganise folders, and a tool that silently drops
	 * their work is worse than one that tells them.
	 */
	strictOwnership: boolean;
	/** Plugin ids Ferry cannot infer from the files themselves. */
	declaredPlugins: string[];
	detectPlugins: boolean;
	/** Days to keep snapshots and parcels when you run the cleanup. */
	retentionDays: number;
}

export const DEFAULT_SETTINGS: FerrySettings = {
	me: "",
	shareRoot: "",
	ferryFolder: "Ferry",
	passphrase: "",
	rememberPassphrase: false,
	excludes: ["**/.git/**", "**/node_modules/**", "*.ferry"],
	strictOwnership: false,
	declaredPlugins: [],
	detectPlugins: true,
	retentionDays: 30,
};
