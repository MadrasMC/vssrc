// Decompiles a game version to .cs files: downloads its Linux client tarball, takes the same
// assemblies from it as the page does, and runs the command-line decompiler (decompiler/cli) on them.
// Output: one file per top-level type, in folders by namespace, under <folder>/<version>/<assembly>/.
//
// bun run decompile               the latest stable version, into vintage-story-source/<version>/
// bun run decompile <version>     any version api.vintagestory.at lists, e.g. 1.21.6 or 1.22.0-rc.3
//   --out <folder>                write into <folder>/<version>/ instead
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BROWSED, entryKind, readTar } from "./src/archive.ts";
import { linuxDownloads, type Branch, type Manifest } from "./src/versions.ts";

const usage = "Usage: bun run decompile [version] [--out <folder>]";
const { values, positionals } = (() => {
	try {
		return parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } }, allowPositionals: true });
	} catch (err) {
		fail(`${err instanceof Error ? err.message : err}\n${usage}`);
	}
})();
if (positionals.length > 1)
	fail(usage);
const wanted = positionals[0];

const root = import.meta.dir;
const dotnet = join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const project = join(root, "decompiler", "cli");
const host = join(project, "bin", "Release", "net10.0", "Cli.dll");
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
const tty = process.stdout.isTTY;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// ---- Version --------------------------------------------------------------------------------

async function manifest(branch: Branch) {
	const response = await fetch(`https://api.vintagestory.at/${branch}.json`).catch((err: unknown) => {
		throw new Error(`Fetching the ${branch} version list from api.vintagestory.at failed`, { cause: err });
	});
	if (!response.ok)
		throw new Error(`Fetching the ${branch} version list from api.vintagestory.at failed (HTTP ${response.status})`);
	return await response.json() as Manifest;
}
const downloads = linuxDownloads({ stable: await manifest("stable"), unstable: wanted ? await manifest("unstable") : {} });
const download = wanted ? downloads.find((d) => d.version === wanted) : downloads.find((d) => d.branch === "stable");
if (!download)
	fail(wanted ? `api.vintagestory.at lists no Linux client ${wanted}` : "api.vintagestory.at lists no stable Linux client");
const output = resolve(values.out ?? "vintage-story-source", download.version);

// ---- Decompiler -----------------------------------------------------------------------------

if (!(await Bun.file(dotnet).exists()))
	fail(`No .NET SDK at ${dotnet}; see Requirements in README.md`);
const refRoot = join(root, ".dotnet", "packs", "Microsoft.NETCore.App.Ref");
const refVersion = readdirSync(refRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()!;
const refDir = join(refRoot, refVersion, "ref", "net10.0");

// Quiet unless it fails: a successful build only prints a summary.
const build = Bun.spawnSync([dotnet, "build", project, "-c", "Release", "-nologo", "-v", "q"], { env });
if (build.exitCode !== 0) {
	process.stdout.write(build.stdout);
	process.stderr.write(build.stderr);
	fail(`dotnet build failed (exit code ${build.exitCode})`);
}

// ---- Archive --------------------------------------------------------------------------------

// The assemblies only live as long as this run.
const game = mkdtempSync(join(tmpdir(), "vssrc-"));
const cleanUp = () => rmSync(game, { recursive: true, force: true });
process.on("SIGINT", () => {
	cleanUp();
	process.exit(130);
});

try {
	const response = await fetch(download.url);
	if (!response.ok || !response.body)
		throw new Error(`Downloading ${download.url} failed (HTTP ${response.status})`);
	const total = Number(response.headers.get("content-length")) || 0;
	const mb = (n: number) => (n / 1048576).toFixed(0);
	let read = 0;
	let reported = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			read += chunk.byteLength;
			if (tty && (read - reported > 4 << 20 || read === total)) {
				reported = read;
				process.stdout.write(`\rDownloading ${download.file}: ${mb(read)}/${total ? mb(total) : "?"} MB`);
			}
			controller.enqueue(chunk);
		},
	});
	if (!tty)
		console.log(`Downloading ${download.file} (${download.size})`);

	const names = new Set<string>(); // lowercase file names taken, first one wins as on the page
	const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
	for await (const entry of readTar(response.body.pipeThrough(counter).pipeThrough(gunzip))) {
		const name = entry.path.split("/").pop() ?? "";
		if (!entryKind(entry.path) || names.has(name.toLowerCase()))
			continue;
		names.add(name.toLowerCase());
		await Bun.write(join(game, name), await entry.read());
	}
	if (tty)
		process.stdout.write("\n");
	const assemblies = BROWSED.filter((n) => names.has(n.toLowerCase() + ".dll"));
	if (!assemblies.includes("VintagestoryLib"))
		throw new Error(`VintagestoryLib.dll is not in ${download.file}`);

	console.log(`Decompiling ${download.version} into ${relative(process.cwd(), output) || "."}`);
	const proc = Bun.spawn([dotnet, host, game, refDir, output, ...assemblies], { env, stdio: ["ignore", "inherit", "inherit"] });
	const code = await proc.exited;
	if (code !== 0)
		throw new Error(`The decompiler failed (exit code ${code})`);
} catch (err) {
	cleanUp();
	fail(err instanceof Error ? err.message : String(err));
}
cleanUp();
