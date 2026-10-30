// Runs the .NET decompiler, streams tarballs and owns IndexedDB. The page only renders.
// Messages in: a Request. Out: a Reply (see protocol.ts).
import { BROWSED, entryKind, readTar } from "./archive.ts";
import type { Archive, ImportResult, Op, Ops, Progress, Reply, Request, StoredFile, VersionRecord } from "./protocol.ts";

const DB_NAME = "vssrc";

/** The [JSExport] methods of decompiler/Program.cs. */
interface DecompilerExports {
	AddFile(name: string, data: Uint8Array, isFramework: boolean): void;
	Clear(): void;
	Inspect(data: Uint8Array): string;
	Open(version: string, assemblies: string[]): string;
	Decompile(assembly: string, type: string): string;
}

/** The part of dotnet.js's host builder used here. */
interface DotnetHostBuilder {
	withConfig(config: { cacheBootResources: boolean }): DotnetHostBuilder;
	withResourceLoader(loader: (type: string, name: string) => string | Promise<Response>): DotnetHostBuilder;
	create(): Promise<{ getAssemblyExports(assembly: string): Promise<{ Exports: DecompilerExports }> }>;
}

let exports_: DecompilerExports;
let ready: Promise<void> | undefined;
/** Version whose files are currently loaded into the runtime. */
let openVersion: string | null = null;
/** Lowercase simple names of the bundled .NET reference assemblies. */
const frameworkNames = new Set<string>();

function send(reply: Reply) {
	postMessage(reply);
}

// addEventListener, never self.onmessage: with onmessage assigned, the .NET 10 runtime's
// startup stalls after loading assemblies and never completes inside a worker.
addEventListener("message", async (e: MessageEvent<Request>) => {
	const { id, op, ...args } = e.data;
	try {
		const result = await (ops[op] as (args: unknown) => unknown)(args);
		send({ id, result });
	} catch (err) {
		console.error(err);
		send({ id, error: err instanceof Error ? err.message : String(err) });
	}
});

function progress(data: Progress) {
	send({ progress: data });
}

const ops: { [K in Op]: (args: Ops[K]["args"]) => Promise<Ops[K]["result"]> } = {
	async init({ bundle }) {
		ready = boot(bundle);
		await ready;
		return true;
	},

	async versions() {
		const db = await openDb();
		return await req<VersionRecord[]>(db.transaction("versions").objectStore("versions").getAll());
	},

	async delete({ version }) {
		const db = await openDb();
		const record = await req<VersionRecord | undefined>(db.transaction("versions").objectStore("versions").get(version));
		if (!record)
			return false;
		const tx = db.transaction(["versions", "files"], "readwrite");
		tx.objectStore("versions").delete(version);
		for (const f of record.files)
			tx.objectStore("files").delete(version + "/" + f.name);
		await done(tx);
		if (openVersion === version) {
			exports_.Clear();
			openVersion = null;
		}
		return true;
	},

	import: importTarball,

	async open({ version }) {
		await ready;
		const db = await openDb();
		const tx = db.transaction(["versions", "files"]);
		const record = await req<VersionRecord | undefined>(tx.objectStore("versions").get(version));
		if (!record)
			throw new Error(`Version ${version} is not stored`);
		const data = await Promise.all(record.files.map((f) => req<ArrayBuffer | undefined>(tx.objectStore("files").get(version + "/" + f.name))));
		exports_.Clear();
		openVersion = null;
		record.files.forEach((f, i) => {
			const bytes = data[i];
			if (!bytes)
				throw new Error(`${f.name} is missing from storage; import ${version} again`);
			exports_.AddFile(f.name, new Uint8Array(bytes), false);
		});
		const browsed = BROWSED.filter((n) => record.files.some((f) => f.name.toLowerCase() === n.toLowerCase() + ".dll"));
		const listing = exports_.Open(version, browsed);
		openVersion = version;
		return listing;
	},

	async decompile({ version, assembly, type }) {
		await ready;
		if (openVersion !== version)
			await ops.open({ version });
		return exports_.Decompile(assembly, type);
	},
};

// ---- Runtime --------------------------------------------------------------------------------

/**
 * The bundle (runtime.<hash>.bin next to the page) is a gzipped blob of every runtime file plus the
 * .NET reference pack: u32 LE header length, JSON [{ name, size }], then the files back to back.
 */
async function boot(url: string) {
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`Loading the decompiler failed (HTTP ${response.status})`);
	let raw = new Uint8Array(await response.arrayBuffer());
	// A server that adds Content-Encoding: gzip has already had the browser undo the compression.
	if (raw[0] === 0x1f && raw[1] === 0x8b)
		raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	const headerLength = new DataView(raw.buffer).getUint32(0, true);
	const header: { name: string; size: number }[] = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + headerLength)));
	const files = new Map<string, Uint8Array<ArrayBuffer>>();
	let offset = 4 + headerLength;
	for (const { name, size } of header) {
		files.set(name, raw.subarray(offset, offset + size));
		offset += size;
	}
	const file = (name: string) => {
		const data = files.get(name);
		if (!data)
			throw new Error(`Runtime file ${name} is not in the bundle`);
		return data;
	};
	const moduleUrl = (name: string) => URL.createObjectURL(new Blob([file(name)], { type: "text/javascript" }));

	const { dotnet } = await import(moduleUrl("fw/dotnet.js")) as { dotnet: DotnetHostBuilder };
	const runtime = await dotnet
		.withConfig({ cacheBootResources: false })
		.withResourceLoader((type, name) => {
			const key = "fw/" + name.split("/").pop();
			// JS modules must come back as URLs (the loader import()s them); everything else as a
			// Promise of a Response (the loader checks `instanceof Promise`, a bare Response is ignored).
			if (key.endsWith(".js"))
				return moduleUrl(key);
			return Promise.resolve(new Response(file(key), {
				headers: { "content-type": type === "dotnetwasm" ? "application/wasm" : "application/octet-stream" },
			}));
		})
		.create();
	exports_ = (await runtime.getAssemblyExports("Decompiler")).Exports;
	for (const [name, data] of files)
		if (name.startsWith("ref/")) {
			exports_.AddFile(name.slice(4), data, true);
			frameworkNames.add(name.slice(4, -4).toLowerCase());
		}
}

// ---- Import ---------------------------------------------------------------------------------

/** One .dll read from the archive, under its original file name. */
interface Candidate {
	name: string;
	data: Uint8Array;
}

/** What Exports.Inspect reports about one assembly. */
interface AssemblyInfo {
	file: Candidate;
	name: string;
	informational: string;
	gameVersion: string;
	fileVersion: string;
	assemblyVersion: string;
	refs: string[];
}

/**
 * Streams the tarball once. Every .dll is held until the end because which ones the browsed
 * assemblies reference is only known once all are read; only that closure is stored.
 */
async function importTarball({ file }: { file: File }): Promise<ImportResult> {
	const total = file.size;
	let read = 0;
	let reported = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			read += chunk.byteLength;
			if (read - reported > 4 << 20 || read === total) {
				reported = read;
				progress({ phase: "read", read, total });
			}
			controller.enqueue(chunk);
		},
	});
	let stream: ReadableStream<Uint8Array>;
	try {
		stream = file.stream().pipeThrough(counter).pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
	} catch {
		throw new Error("This browser cannot decompress gzip streams");
	}

	const candidates = new Map<string, Candidate>(); // lowercase file name -> file
	const pdbs = new Map<string, Candidate>();
	try {
		for await (const entry of readTar(stream)) {
			const base = entry.path.split("/").pop() ?? "";
			const lower = base.toLowerCase();
			const kind = entryKind(entry.path);
			if (kind === "dll" && !candidates.has(lower))
				candidates.set(lower, { name: base, data: await entry.read() });
			else if (kind === "pdb")
				pdbs.set(lower, { name: base, data: await entry.read() });
		}
	} catch (err) {
		if (err instanceof TypeError || (err instanceof Error && /gzip|decompress|incorrect header/i.test(err.message)))
			throw new Error("Not a gzip file. Choose the Linux tar.gz Archive (full): vs_client_linux-x64_….tar.gz");
		throw err;
	}

	if (!candidates.has("vintagestorylib.dll"))
		throw new Error("VintagestoryLib.dll is not in this archive. Choose the Linux tar.gz Archive (full): vs_client_linux-x64_….tar.gz");

	progress({ phase: "resolve" });
	await ready;
	const info = new Map<string, AssemblyInfo>(); // lowercase simple name -> assembly
	for (const [lower, c] of candidates) {
		const text = exports_.Inspect(c.data);
		if (!text)
			continue;
		const [head = "", ...refs] = text.trimEnd().split("\n");
		const [name = "", informational = "", gameVersion = "", fileVersion = "", assemblyVersion = ""] = head.split("\t");
		info.set(lower.slice(0, -4), { file: c, name, informational, gameVersion, fileVersion, assemblyVersion, refs });
	}

	const keep = new Set<string>();
	const queue = BROWSED.map((n) => n.toLowerCase()).filter((n) => info.has(n));
	while (queue.length) {
		const n = queue.pop()!;
		if (keep.has(n))
			continue;
		keep.add(n);
		for (const r of info.get(n)!.refs)
			if (info.has(r.toLowerCase()))
				queue.push(r.toLowerCase());
	}

	// VintagestoryLib carries no AssemblyInformationalVersion as of 1.22; the API's GameVersion
	// constant (which keeps pre-release suffixes like -rc.3) comes before the plain file version.
	const lib = info.get("vintagestorylib");
	if (!lib)
		throw new Error("VintagestoryLib.dll in this archive is not a .NET assembly");
	const version = lib.informational || info.get("vintagestoryapi")?.gameVersion || lib.fileVersion || lib.assemblyVersion;

	// The server-only archive ships the same VintagestoryLib.dll and PDB but not Vintagestory.dll or
	// client libraries such as OpenTK.Graphics. It is accepted; the record says so, and lists what
	// the browsed assemblies reference but the archive lacks, so the page can warn.
	const archive: Archive = info.has("vintagestory") ? "client" : "server";
	const missing = [...new Set(BROWSED.map((n) => n.toLowerCase()).filter((n) => info.has(n)).flatMap((n) => info.get(n)!.refs))]
		.filter((r) => !info.has(r.toLowerCase()) && !frameworkNames.has(r.toLowerCase()))
		.sort();

	const files: (StoredFile & { data: Uint8Array })[] = [];
	for (const n of keep) {
		const { file: c } = info.get(n)!;
		files.push({ name: c.name, size: c.data.byteLength, role: BROWSED.some((b) => b.toLowerCase() === n) ? "browse" : "ref", data: c.data });
	}
	for (const [, p] of pdbs)
		files.push({ name: p.name, size: p.data.byteLength, role: "pdb", data: p.data });

	progress({ phase: "save" });
	const db = await openDb();
	const existing = await req<VersionRecord | undefined>(db.transaction("versions").objectStore("versions").get(version));
	// Never replace a full import with a server-only one. Records from before archives were tracked are full.
	if (existing && archive === "server" && (existing.archive ?? "client") === "client")
		return { version, archive: "client", missing: existing.missing ?? [], kept: true };
	const tx = db.transaction(["versions", "files"], "readwrite");
	if (existing)
		for (const f of existing.files)
			tx.objectStore("files").delete(version + "/" + f.name);
	for (const f of files)
		tx.objectStore("files").put(f.data.buffer.byteLength === f.data.byteLength ? f.data.buffer : f.data.slice().buffer, version + "/" + f.name);
	const record: VersionRecord = {
		version,
		imported: Date.now(),
		size: files.reduce((s, f) => s + f.size, 0),
		files: files.map(({ name, size, role }) => ({ name, size, role })),
		archive,
		missing,
	};
	tx.objectStore("versions").put(record);
	try {
		await done(tx);
	} catch (err) {
		if (err instanceof DOMException && err.name === "QuotaExceededError")
			throw new Error("Not enough storage space for this version");
		throw err;
	}
	if (openVersion === version)
		openVersion = null;
	return { version, archive, missing, kept: false };
}

// ---- IndexedDB ------------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb() {
	dbPromise ??= new Promise((resolve, reject) => {
		const r = indexedDB.open(DB_NAME, 1);
		r.onupgradeneeded = () => {
			// versions: VersionRecord (protocol.ts), keyed by version
			// files: ArrayBuffer keyed "<version>/<file name>"
			r.result.createObjectStore("versions", { keyPath: "version" });
			r.result.createObjectStore("files");
		};
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
	return dbPromise;
}

function req<T>(r: IDBRequest): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result as T);
		r.onerror = () => reject(r.error);
	});
}

function done(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted"));
	});
}
