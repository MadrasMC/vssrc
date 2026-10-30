// Reading the game's Linux tarball. Used by the worker for imports and by decompile.ts, so both
// take the same files from it.

/** Assemblies shown in the tree, in tree order. Everything else in the tarball is reference-only. */
export const BROWSED = ["VintagestoryLib", "Vintagestory"];

/**
 * What a tarball entry is: an assembly ("dll"), a browsed assembly's PDB ("pdb"), or neither (null).
 * Assemblies sit at most two folders deep (vintagestory/Lib/x.dll), PDBs next to the game.
 */
export function entryKind(path: string): "dll" | "pdb" | null {
	const lower = (path.split("/").pop() ?? "").toLowerCase();
	const depth = path.split("/").length;
	if (lower.endsWith(".dll") && depth <= 3)
		return "dll";
	if (lower.endsWith(".pdb") && depth <= 2 && BROWSED.some((n) => n.toLowerCase() + ".pdb" === lower))
		return "pdb";
	return null;
}

/** A regular file in the tarball; its contents are only read if read() is called. */
export interface TarEntry {
	path: string;
	size: number;
	read(): Promise<Uint8Array>;
}

/**
 * Minimal tar reader over a byte stream: ustar, GNU long names ('L') and pax paths ('x').
 * Yields regular files; unread contents are skipped.
 */
export async function* readTar(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
	const reader = stream.getReader();
	let buf: Uint8Array = new Uint8Array(0);
	let pos = 0;
	let finished = false;

	async function fill(n: number) {
		while (buf.length - pos < n && !finished) {
			const { value, done } = await reader.read();
			if (done) {
				finished = true;
				break;
			}
			const rest = buf.subarray(pos);
			if (rest.length === 0) {
				buf = value;
			} else {
				const next = new Uint8Array(rest.length + value.length);
				next.set(rest);
				next.set(value, rest.length);
				buf = next;
			}
			pos = 0;
		}
		return buf.length - pos >= n;
	}

	async function take(n: number) {
		const out = new Uint8Array(n);
		let filled = 0;
		while (filled < n) {
			if (!(await fill(1)))
				throw new Error("The archive ends in the middle of a file");
			const part = Math.min(n - filled, buf.length - pos);
			out.set(buf.subarray(pos, pos + part), filled);
			pos += part;
			filled += part;
		}
		return out;
	}

	async function skip(n: number) {
		while (n > 0) {
			if (!(await fill(1)))
				throw new Error("The archive ends in the middle of a file");
			const part = Math.min(n, buf.length - pos);
			pos += part;
			n -= part;
		}
	}

	const text = (b: Uint8Array, start: number, len: number) => {
		let end = start;
		while (end < start + len && b[end] !== 0)
			end++;
		return new TextDecoder().decode(b.subarray(start, end));
	};
	const octal = (b: Uint8Array, start: number, len: number) => {
		if (b[start]! & 0x80) {
			// GNU base-256 for sizes past 8 GiB
			let v = 0;
			for (let i = start + 1; i < start + len; i++)
				v = v * 256 + b[i]!;
			return v;
		}
		return parseInt(text(b, start, len).trim() || "0", 8);
	};

	let longName: string | null = null;
	let paxPath: string | null = null;
	try {
		while (true) {
			if (!(await fill(512)))
				return;
			const h = await take(512);
			if (h.every((x) => x === 0))
				return;
			const size = octal(h, 124, 12);
			const type = String.fromCharCode(h[156] || 48);
			const padded = Math.ceil(size / 512) * 512;
			let path = text(h, 0, 100);
			if (text(h, 257, 5) === "ustar") {
				const prefix = text(h, 345, 155);
				if (prefix)
					path = prefix + "/" + path;
			}
			if (type === "L") {
				longName = text(await take(padded), 0, size);
				continue;
			}
			if (type === "x") {
				const body = new TextDecoder().decode((await take(padded)).subarray(0, size));
				const match = /\d+ path=([^\n]*)\n/.exec(body);
				if (match)
					paxPath = match[1]!;
				continue;
			}
			path = paxPath ?? longName ?? path;
			longName = paxPath = null;
			path = path.replace(/^\.\//, "");
			if (type !== "0" && type !== "7") {
				await skip(padded);
				continue;
			}
			let consumed = false;
			yield {
				path,
				size,
				read: async () => {
					consumed = true;
					const data = await take(size);
					await skip(padded - size);
					return data;
				},
			};
			if (!consumed)
				await skip(padded);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}
