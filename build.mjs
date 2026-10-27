// Builds dist/ from scratch: index.html (page, styles, app script), og.png, and the files the page
// loads, each named by a content hash so they can be cached forever: runtime.<hash>.bin (the .NET
// runtime, the decompiler and the .NET reference pack, gzipped), worker.<hash>.js, editor.<hash>.js
// (CodeMirror), the icons and the two Geist fonts. The page references them all relatively, so dist/
// works deployed as any folder (served with a trailing slash). Run with `node build.mjs` or
// `bun build.mjs`; pass --skip-dotnet to reuse the last publish.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dotnet = join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const project = join(root, "decompiler");
const framework = join(project, "bin", "Release", "net10.0", "publish", "wwwroot", "_framework");

if (!process.argv.includes("--skip-dotnet"))
	execFileSync(dotnet, ["publish", "-c", "Release", "-nologo"], {
		cwd: project,
		stdio: "inherit",
		env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
	});

// Reference assemblies let the decompiler resolve BCL members (properties, enums, extension methods).
// Take the newest installed Microsoft.NETCore.App.Ref; it must match the game's target framework.
const refRoot = join(root, ".dotnet", "packs", "Microsoft.NETCore.App.Ref");
const refVersion = readdirSync(refRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const refDir = join(refRoot, refVersion, "ref", "net10.0");

const entries = [];
for (const name of readdirSync(framework).sort()) {
	if (!/\.(js|wasm)$/.test(name))
		continue;
	let data = readFileSync(join(framework, name));
	if (name.endsWith(".js")) {
		// The runtime resolves its files against import.meta.url, which is an opaque blob: URL once the
		// worker imports it from the bundle, and new URL(name, "blob:...") throws. Any hierarchical base works: the worker's
		// resource loader serves every file from the bundle, so nothing is fetched from this host.
		const source = data.toString("utf8");
		if (name === "dotnet.js" && !source.includes("import.meta.url"))
			throw new Error("dotnet.js no longer reads import.meta.url; revisit the base URL patch");
		data = Buffer.from(source.split("import.meta.url").join(JSON.stringify("https://vssrc.invalid/_framework/" + name)));
	}
	entries.push({ name: "fw/" + name, data });
}
for (const name of readdirSync(refDir).sort())
	if (name.endsWith(".dll"))
		entries.push({ name: "ref/" + name, data: readFileSync(join(refDir, name)) });

// Layout: u32 LE header length, JSON [{ name, size }], file contents back to back (see worker.js boot()).
const header = Buffer.from(JSON.stringify(entries.map((e) => ({ name: e.name, size: e.data.length }))));
const length = Buffer.alloc(4);
length.writeUInt32LE(header.length);
const bundle = gzipSync(Buffer.concat([length, header, ...entries.map((e) => e.data)]), { level: 9 });

// Where dist/ is deployed, used only for canonical, og:url and og:image: link-preview crawlers need
// absolute URLs. Everything else in the page is relative.
const SITE = "https://madrasmc.ftrs.im/vssrc/";

const worker = readFileSync(join(root, "src", "worker.js"));

// CodeMirror is the one npm dependency; Bun bundles it into a classic script (see src/editor.js).
const editorOut = join(root, "node_modules", ".vssrc", "editor.js");
execFileSync(process.platform === "win32" ? "bun.exe" : "bun",
	["build", join(root, "src", "editor.js"), "--minify", "--format=iife", "--target=browser", "--outfile", editorOut],
	{ cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const editor = readFileSync(editorOut);

// dist/ is build output only (gitignored), so it starts empty and never keeps stale hashed files.
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
/** Writes data to dist/<base>.<hash>.<ext> and returns that file name. */
const emit = (base, ext, data) => {
	const name = `${base}.${createHash("sha256").update(data).digest("hex").slice(0, 8)}.${ext}`;
	writeFileSync(join(dist, name), data);
	return name;
};
const files = { runtime: emit("runtime", "bin", bundle), worker: emit("worker", "js", worker), editor: emit("editor", "js", editor) };
const src = (path) => readFileSync(join(root, "src", path));
const icon = emit("icon", "svg", src("icon.svg"));
const touchIcon = emit("apple-touch-icon", "png", src("apple-touch-icon.png"));
const geist = emit("geist", "woff2", src("fonts/geist-latin.woff2"));
const geistMono = emit("geist-mono", "woff2", src("fonts/geist-mono-latin.woff2"));
// Unhashed: og:image is a fixed URL that crawlers cache. Rendered from src/og.html (see its header).
copyFileSync(join(root, "src", "og.png"), join(dist, "og.png"));

// Linux client downloads, hardcoded: api.vintagestory.at sends no CORS headers, so the page can't
// fetch the list itself. Refresh with --update-versions; the page links newer releases elsewhere.
const versionsPath = join(root, "src", "versions.json");
if (process.argv.includes("--update-versions")) {
	const versions = [];
	for (const branch of ["stable", "unstable"]) {
		const manifest = await (await fetch(`https://api.vintagestory.at/${branch}.json`)).json();
		for (const [version, platforms] of Object.entries(manifest))
			if (platforms.linux)
				versions.push({ version, branch, file: platforms.linux.filename, size: platforms.linux.filesize, url: platforms.linux.urls.cdn });
	}
	versions.sort((a, b) => a.branch.localeCompare(b.branch) || b.version.localeCompare(a.version, undefined, { numeric: true }));
	writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
	console.log(`${versionsPath}: ${versions.length} versions`);
}

let html = readFileSync(join(root, "src", "index.html"), "utf8");
const replace = (token, value) => {
	if (!html.includes(token))
		throw new Error(`Missing ${token} in index.html`);
	html = html.split(token).join(value);
};
replace("{{SITE}}", SITE);
replace("{{ICON}}", icon);
replace("{{TOUCH_ICON}}", touchIcon);
replace("{{GEIST}}", geist);
replace("{{GEIST_MONO}}", geistMono);
replace("{{FILES}}", JSON.stringify(files));
replace("{{VERSIONS}}", JSON.stringify(JSON.parse(readFileSync(versionsPath, "utf8"))));

writeFileSync(join(dist, "index.html"), html);
const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`${dist}: index.html ${kb(Buffer.byteLength(html))}, ${files.runtime} ${kb(bundle.length)} (${entries.length} files, ref pack ${refVersion}), ${files.worker} ${kb(worker.length)}, ${files.editor} ${kb(editor.length)}`);
