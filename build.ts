// Builds dist/ from scratch: index.html (page and styles), og.png, and the files the page loads,
// each named by a content hash so they can be cached forever: app.<hash>.js (and its editor chunk),
// worker.<hash>.js, runtime.<hash>.bin (the .NET runtime, the decompiler and the .NET reference
// pack, gzipped), the icons and the two Geist fonts. The page references them all relatively, so
// dist/ works deployed as any folder (served with a trailing slash).
//
// bun run emit                      full build, including `dotnet publish`
// bun run emit --skip-dotnet        reuse the last publish
// bun run emit --update-versions    refresh src/versions.json from api.vintagestory.at first
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Where dist/ is deployed, used only for canonical, og:url and og:image: link-preview crawlers need
// absolute URLs. Everything else in the page is relative.
const SITE = "https://madrasmc.ftrs.im/vssrc/";

const root = import.meta.dir;
const src = join(root, "src");
const dist = join(root, "dist");
const dotnet = join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const project = join(root, "decompiler");
const framework = join(project, "bin", "Release", "net10.0", "publish", "wwwroot", "_framework");

if (!Bun.argv.includes("--skip-dotnet")) {
	const publish = Bun.spawnSync([dotnet, "publish", "-c", "Release", "-nologo"], {
		cwd: project,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
	});
	if (publish.exitCode !== 0)
		throw new Error(`dotnet publish failed (exit code ${publish.exitCode})`);
}

// ---- Runtime bundle -------------------------------------------------------------------------

// Reference assemblies let the decompiler resolve BCL members (properties, enums, extension methods).
// Take the newest installed Microsoft.NETCore.App.Ref; it must match the game's target framework.
const refRoot = join(root, ".dotnet", "packs", "Microsoft.NETCore.App.Ref");
const refVersion = readdirSync(refRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()!;
const refDir = join(refRoot, refVersion, "ref", "net10.0");

const entries: { name: string; data: Uint8Array }[] = [];
for (const name of readdirSync(framework).sort()) {
	if (!/\.(js|wasm)$/.test(name))
		continue;
	let data: Uint8Array = readFileSync(join(framework, name));
	if (name.endsWith(".js")) {
		// The runtime resolves its files against import.meta.url, which is an opaque blob: URL once the
		// worker imports it from the bundle, and new URL(name, "blob:...") throws. Any hierarchical base
		// works: the worker's resource loader serves every file from the bundle, so nothing is fetched from this host.
		const source = new TextDecoder().decode(data);
		if (name === "dotnet.js" && !source.includes("import.meta.url"))
			throw new Error("dotnet.js no longer reads import.meta.url; revisit the base URL patch");
		data = new TextEncoder().encode(source.split("import.meta.url").join(JSON.stringify("https://vssrc.invalid/_framework/" + name)));
	}
	entries.push({ name: "fw/" + name, data });
}
for (const name of readdirSync(refDir).sort())
	if (name.endsWith(".dll"))
		entries.push({ name: "ref/" + name, data: readFileSync(join(refDir, name)) });

// Layout: u32 LE header length, JSON [{ name, size }], file contents back to back (see worker.ts boot()).
const header = new TextEncoder().encode(JSON.stringify(entries.map((e) => ({ name: e.name, size: e.data.length }))));
const length = new Uint8Array(4);
new DataView(length.buffer).setUint32(0, header.length, true);
const bundle = Bun.gzipSync(Buffer.concat([length, header, ...entries.map((e) => e.data)]), { level: 9 });

// ---- Version list ---------------------------------------------------------------------------

// Linux client downloads, hardcoded: api.vintagestory.at sends no CORS headers, so the page can't
// fetch the list itself. The page links newer releases to the account page.
const versionsPath = join(src, "versions.json");
if (Bun.argv.includes("--update-versions")) {
	type Manifest = Record<string, Record<string, { filename: string; filesize: string; urls: { cdn: string } }>>;
	const versions = [];
	for (const branch of ["stable", "unstable"]) {
		const manifest = await (await fetch(`https://api.vintagestory.at/${branch}.json`)).json() as Manifest;
		for (const [version, platforms] of Object.entries(manifest)) {
			const linux = platforms.linux;
			if (linux)
				versions.push({ version, branch, file: linux.filename, size: linux.filesize, url: linux.urls.cdn });
		}
	}
	versions.sort((a, b) => a.branch.localeCompare(b.branch) || b.version.localeCompare(a.version, undefined, { numeric: true }));
	await Bun.write(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
	console.log(`${versionsPath}: ${versions.length} versions`);
}
const versions: unknown = JSON.parse(readFileSync(versionsPath, "utf8"));

// ---- dist/ ----------------------------------------------------------------------------------

// dist/ is build output only (gitignored), so it starts empty and never keeps stale hashed files.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

/** Writes data to dist/<base>.<hash>.<ext> and returns that file name. */
function emit(base: string, ext: string, data: Uint8Array) {
	const name = `${base}.${new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 8)}.${ext}`;
	writeFileSync(join(dist, name), data);
	return name;
}

/** Bundles one entry point into dist/ and returns its file name; dynamic imports become chunks. */
async function bundleScript(entry: string, define: Record<string, string> = {}) {
	const result = await Bun.build({
		entrypoints: [join(src, entry)],
		outdir: dist,
		target: "browser",
		format: "esm",
		splitting: true,
		minify: true,
		naming: { entry: "[name].[hash].[ext]", chunk: "[name].[hash].[ext]" },
		define,
	});
	if (!result.success)
		throw new AggregateError(result.logs, `Bundling ${entry} failed`);
	return basename(result.outputs.find((o) => o.kind === "entry-point")!.path);
}

const runtime = emit("runtime", "bin", bundle);
const worker = await bundleScript("worker.ts");
const app = await bundleScript("app.ts", {
	BUILD_FILES: JSON.stringify({ runtime, worker }),
	BUILD_VERSIONS: JSON.stringify(versions),
});
const icon = emit("icon", "svg", readFileSync(join(src, "icon.svg")));
const touchIcon = emit("apple-touch-icon", "png", readFileSync(join(src, "apple-touch-icon.png")));
const geist = emit("geist", "woff2", readFileSync(join(src, "fonts", "geist-latin.woff2")));
const geistMono = emit("geist-mono", "woff2", readFileSync(join(src, "fonts", "geist-mono-latin.woff2")));
// Unhashed: og:image is a fixed URL that crawlers cache. Rendered from src/og.html (see its header).
copyFileSync(join(src, "og.png"), join(dist, "og.png"));

let html = readFileSync(join(src, "index.html"), "utf8");
const replace = (token: string, value: string) => {
	if (!html.includes(token))
		throw new Error(`Missing ${token} in index.html`);
	html = html.split(token).join(value);
};
replace("{{SITE}}", SITE);
replace("{{ICON}}", icon);
replace("{{TOUCH_ICON}}", touchIcon);
replace("{{GEIST}}", geist);
replace("{{GEIST_MONO}}", geistMono);
replace("{{APP}}", app);
await Bun.write(join(dist, "index.html"), html);

const kb = (n: number) => (n / 1024).toFixed(0) + " KB";
console.log(readdirSync(dist).sort().map((name) => `${name.padEnd(36)} ${kb(Bun.file(join(dist, name)).size)}`).join("\n"));
console.log(`(runtime: ${entries.length} files, ref pack ${refVersion})`);
