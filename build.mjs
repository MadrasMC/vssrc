// Builds dist/vssrc.html: one self-contained page with the .NET runtime, the decompiler, the
// .NET reference pack, the worker and the fonts inlined. Run with `node build.mjs` or `bun build.mjs`;
// pass --skip-dotnet to reuse the last publish.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
		// The runtime resolves its files against import.meta.url, which is an opaque blob: URL once
		// inlined, and new URL(name, "blob:...") throws. Any hierarchical base works: the worker's
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

const font = (file) => readFileSync(join(root, "src", "fonts", file)).toString("base64");
const worker = readFileSync(join(root, "src", "worker.js"), "utf8");
if (worker.includes("</script"))
	throw new Error("worker.js must not contain </script");

// CodeMirror is the one npm dependency; Bun bundles it into a classic script (see src/editor.js).
const editorOut = join(root, "node_modules", ".vssrc", "editor.js");
execFileSync(process.platform === "win32" ? "bun.exe" : "bun",
	["build", join(root, "src", "editor.js"), "--minify", "--format=iife", "--target=browser", "--outfile", editorOut],
	{ cwd: root, stdio: ["ignore", "ignore", "inherit"] });
// "<\/script" means the same inside JS strings, regexes and comments, and can't end the inline tag.
const editor = readFileSync(editorOut, "utf8").replaceAll("</script", "<\\/script");

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
// The favicon goes in as SVG text (smaller than base64); only the characters a data URI can't hold are escaped.
const icon = readFileSync(join(root, "src", "icon.svg"), "utf8").trim().replace(/[#%<>"\n]/g, (c) => encodeURIComponent(c));
replace("{{ICON}}", "data:image/svg+xml," + icon);
replace("{{TOUCH_ICON}}", "data:image/png;base64," + readFileSync(join(root, "src", "apple-touch-icon.png")).toString("base64"));
replace("{{GEIST}}", font("geist-latin.woff2"));
replace("{{GEIST_MONO}}", font("geist-mono-latin.woff2"));
replace("{{WORKER}}", worker);
replace("{{EDITOR}}", editor);
replace("{{VERSIONS}}", JSON.stringify(JSON.parse(readFileSync(versionsPath, "utf8"))));
replace("{{BUNDLE}}", bundle.toString("base64"));

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "vssrc.html");
writeFileSync(out, html);
const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`${out}: ${mb(Buffer.byteLength(html))} (bundle ${mb(bundle.length)} gzip, ${entries.length} files, ref pack ${refVersion})`);
