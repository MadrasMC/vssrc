// Messages between the page (app.ts) and the decompiler worker (worker.ts).
// Page -> worker: a Request. Worker -> page: a Reply.

/** One file kept from an imported archive. */
export interface StoredFile {
	name: string;
	size: number;
	role: "browse" | "ref" | "pdb";
}

/** Which Linux archive a version was imported from. */
export type Archive = "client" | "server";

/** An imported game version, as stored in IndexedDB. */
export interface VersionRecord {
	version: string;
	/** Import time, ms since the epoch. */
	imported: number;
	/** Total bytes of the stored files. */
	size: number;
	files: StoredFile[];
	/** Absent on records from before archives were tracked: read as "client". */
	archive?: Archive;
	/** Assemblies the browsed ones reference but the archive lacked. Absent on old records. */
	missing?: string[];
}

export interface ImportResult {
	version: string;
	archive: Archive;
	missing: string[];
	/** True when a server-only archive was ignored because a full import of the version exists. */
	kept: boolean;
}

export type Progress =
	| { phase: "read"; read: number; total: number }
	| { phase: "resolve" }
	| { phase: "save" };

/** Each operation's arguments and result. */
export interface Ops {
	init: { args: { bundle: string }; result: true };
	versions: { args: Record<string, never>; result: VersionRecord[] };
	delete: { args: { version: string }; result: boolean };
	import: { args: { file: File }; result: ImportResult };
	/** The listing, as TSV (see Exports.Open in decompiler/Program.cs). */
	open: { args: { version: string }; result: string };
	/** Highlighted HTML of one top-level type. */
	decompile: { args: { version: string; assembly: string; type: string }; result: string };
}

export type Op = keyof Ops;

export type Request = { [K in Op]: { id: number; op: K } & Ops[K]["args"] }[Op];

export type Reply =
	| { id: number; result: unknown }
	| { id: number; error: string }
	| { progress: Progress };
