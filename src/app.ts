// The page: routing, the type tree and search, tabs, the code viewer, versions and import.
// The decompiler runs in worker.ts; the code view (editor.ts) loads as a separate chunk.
import type { CodeEditor, EditorSnapshot, LineRange } from "./editor.ts";
import type { ImportResult, Op, Ops, Progress, Reply, VersionRecord } from "./protocol.ts";
import { linuxDownloads, type Branch, type Download, type Manifest } from "./versions.ts";

// Filled in by build.ts (Bun's define): hashed file names next to the page, the embedded versions
// (the latest stable one, or all with --embed-versions), and whether the server proxies the full
// list (--use-proxy), in which case fetchLiveVersions() replaces the embedded one.
declare const BUILD_FILES: { runtime: string; worker: string };
declare const BUILD_VERSIONS: Download[];
declare const BUILD_USE_PROXY: boolean;
const FILES = BUILD_FILES;
let versions: Download[] = BUILD_VERSIONS;
const newest = () => versions.find((d) => d.branch === "stable")!;

// Every file sits next to the page, so the page's folder URL (served with a trailing slash) is the base.
const asset = (name: string) => new URL(name, location.href).href;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el)
		throw new Error(`#${id} is missing from the page`);
	return el as T;
}

/** The static <title>, which link previews and search results use; type pages replace it while open. */
const PAGE_TITLE = document.title;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const phone = matchMedia("(max-width: 47.99rem)");
/** Apple platforms, where the Ctrl of most shortcuts is ⌘. */
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
const store = {
	get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
	set(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} },
	remove(key: string) { try { localStorage.removeItem(key); } catch {} },
};
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

// ---- Theme ----------------------------------------------------------------------------------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function effectiveTheme() {
	return document.documentElement.dataset.theme ?? (darkQuery.matches ? "dark" : "light");
}
function renderThemeButton() {
	const dark = effectiveTheme() === "dark";
	const button = $("theme-button");
	// Shows the theme a click switches to.
	button.querySelector<SVGElement>(".sun")!.style.display = dark ? "" : "none";
	button.querySelector<SVGElement>(".moon")!.style.display = dark ? "none" : "";
	button.setAttribute("aria-label", dark ? "Light theme" : "Dark theme");
}
$("theme-button").addEventListener("click", () => {
	const next = effectiveTheme() === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	store.set("vssrc.theme", next);
	renderThemeButton();
});
darkQuery.addEventListener("change", renderThemeButton);
renderThemeButton();

// ---- Worker ---------------------------------------------------------------------------------

const unsupported = !("DecompressionStream" in self) || typeof WebAssembly !== "object" || !("indexedDB" in self);
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve(result: unknown): void; reject(err: Error): void }>();
let onProgress: ((p: Progress) => void) | null = null;

function call<K extends Op>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["result"]> {
	return new Promise((resolve, reject) => {
		if (!worker)
			return reject(new Error("The decompiler is not running"));
		const id = ++seq;
		pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
		worker.postMessage({ id, op, ...args });
	});
}

function startWorker() {
	worker = new Worker(asset(FILES.worker), { type: "module" });
	worker.onmessage = ({ data }: MessageEvent<Reply>) => {
		if ("progress" in data) {
			onProgress?.(data.progress);
			return;
		}
		const p = pending.get(data.id);
		pending.delete(data.id);
		if ("error" in data)
			p?.reject(new Error(data.error));
		else
			p?.resolve(data.result);
	};
	worker.onerror = (e) => {
		e.preventDefault();
		setRuntime("error", e.message || "The decompiler worker crashed");
		for (const [, p] of pending)
			p.reject(new Error(e.message || "The decompiler worker crashed"));
		pending.clear();
	};
	return call("init", { bundle: asset(FILES.runtime) });
}

type RuntimeState = "starting" | "ready" | "error";
let runtimeState: RuntimeState = "starting";
let runtimeError = "";
function setRuntime(s: RuntimeState, message = "") {
	runtimeState = s;
	runtimeError = message;
	const el = $("runtime-status");
	el.querySelector(".dot")!.className = "dot " + (s === "ready" ? "ok" : s === "error" ? "error" : "warn");
	el.querySelector(".label")!.textContent = s === "ready" ? "Ready" : s === "error" ? "Decompiler failed" : "Starting";
	el.title = message;
	// The ready dot only matters while something waits on it.
	el.hidden = s === "ready";
	if (s === "error")
		renderSideNote();
}

// ---- State ----------------------------------------------------------------------------------

/** A type in the listing. */
interface TypeEntry {
	a: string;
	/** Reflection name, "Ns.Outer+Inner`1". */
	name: string;
	kind: string;
	/** Reflection name of the outermost declaring type, the one that opens in a tab. */
	top: string;
	token: string;
	ns: string;
	/** "Outer.Inner", without namespace or generic arity. */
	display: string;
	lower: string;
	full: string;
	fullLower: string;
	href: string;
}

/** A field, property, event or method in the listing. */
interface MemberEntry {
	a: string;
	display: string;
	kind: string;
	token: string;
	owner: string;
	lower: string;
	fullLower: string;
	href: string;
}

interface Listing {
	v: string;
	types: TypeEntry[];
	members: MemberEntry[];
	assemblies: string[];
	byName: Map<string, TypeEntry>;
}

/** The type in the viewer. */
interface Shown {
	v: string;
	a: string;
	t: string;
}

const state = {
	versions: [] as VersionRecord[],
	/** Version whose listing is loaded or loading. */
	version: null as string | null,
	listing: null as Listing | null,
	listingPromise: null as Promise<void> | null,
	listingError: "",
	shown: null as Shown | null,
	/** Decompiled HTML by "v|a|t". */
	cache: new Map<string, string>(),
};

/** Hash route: v version, a assembly, t type, m member token, l line or line range ("12" or "12-30"). */
interface Route {
	v: string | null;
	a: string | null;
	t: string | null;
	m: string | null;
	l: LineRange | null;
}

function parseHash(): Route {
	const p = new URLSearchParams(location.hash.slice(1));
	const lines = /^(\d+)(?:-(\d+))?$/.exec(p.get("l") ?? "");
	const l: LineRange | null = lines ? [+lines[1]!, +(lines[2] ?? lines[1]!)] : null;
	return { v: p.get("v"), a: p.get("a"), t: p.get("t"), m: p.get("m"), l };
}
function hashFor({ v, a, t, m, l }: { v: string; a?: string | null; t?: string | null; m?: string | null; l?: LineRange | null }) {
	const p = new URLSearchParams();
	p.set("v", v);
	if (a) p.set("a", a);
	if (t) p.set("t", t);
	if (m) p.set("m", m);
	if (l) p.set("l", l[0] === l[1] ? String(l[0]) : `${l[0]}-${l[1]}`);
	return "#" + p.toString();
}
function preferredVersion(): string {
	const last = store.get("vssrc.version");
	if (last && state.versions.some((x) => x.version === last))
		return last;
	return [...state.versions].sort((a, b) => b.imported - a.imported)[0]!.version;
}

async function refreshVersions() {
	state.versions = await call("versions", {});
	renderVersions();
	renderPartial();
}

// ---- Server-only imports --------------------------------------------------------------------

const listFormat = new Intl.ListFormat("en", { type: "disjunction" });

/** Says what a server-only import lacks, from the references its record could not resolve. */
function partialText(record: VersionRecord) {
	const libs = (record.missing ?? []).filter((n) => n !== "Vintagestory");
	return "Imported from the server-only archive: Vintagestory.dll is missing"
		+ (libs.length ? `, and code using ${listFormat.format(libs)} is less readable.` : ".");
}

/** The open version's warning: a dot on the version chip always, the banner until dismissed. */
function renderPartial() {
	const record = state.versions.find((x) => x.version === state.version);
	const partial = record?.archive === "server";
	$("version-partial").hidden = !partial;
	$("version-button").title = partial ? partialText(record) : "";
	const dismissed = partial && store.get("vssrc.dismissed." + record.version) === "1";
	$("partial-banner").hidden = !partial || dismissed;
	if (partial)
		$("partial-text").textContent = partialText(record);
}

$("partial-close").addEventListener("click", () => {
	store.set("vssrc.dismissed." + state.version, "1");
	renderPartial();
});
$("partial-import").addEventListener("click", () => {
	openVersions();
	if (state.version) {
		picked = state.version;
		renderDownload(picked);
	}
});

// ---- Routing --------------------------------------------------------------------------------

let routeSeq = 0;

async function route(): Promise<void> {
	const seqHere = ++routeSeq;
	const h = parseHash();
	// A link into a version that isn't imported keeps its hash: once that version is imported,
	// routing the same hash again opens what the link points at.
	const missing = h.v && !state.versions.some((x) => x.version === h.v) ? h.v : null;
	renderWanted(missing);
	if (!state.versions.length) {
		showStart();
		return;
	}
	showBrowser();
	if (missing) {
		await loadVersion(preferredVersion());
		if (seqHere !== routeSeq) return;
		showViewerNote(`This link is for ${missing}, which isn't imported.`, { action: `Import ${missing}`, onAction: openVersions });
		return;
	}
	if (!h.v) {
		history.replaceState(null, "", hashFor({ v: preferredVersion() }));
		return route();
	}
	await loadVersion(h.v);
	if (seqHere !== routeSeq) return;
	if (!state.listing) return;
	loadTabs(h.v);
	if (!h.t || !h.a) {
		// No type in the link: go back to the active tab, or the last one; the landing page only when none are open.
		const tab = tabs.list.find((x) => tabKey(x) === tabs.active) ?? tabs.list.at(-1);
		if (tab) {
			tabSwitchHash = tab.hash;
			history.replaceState(null, "", tab.hash);
			return route();
		}
		renderTabs();
		editorKey = null;
		state.shown = null;
		markCurrent(null);
		showLanding();
		return;
	}
	openTab(h.a, h.t, location.hash);
	await showType(h.v, h.a, h.t, h.m, h.l, seqHere);
}

addEventListener("hashchange", route);

// ---- Version listing ------------------------------------------------------------------------

function loadVersion(v: string): Promise<void> {
	if (state.version === v && state.listingPromise)
		return state.listingPromise;
	state.version = v;
	state.listing = null;
	state.listingError = "";
	store.set("vssrc.version", v);
	$("version-label").textContent = v;
	$("tree").replaceChildren();
	hideResults();
	renderVersions();
	renderPartial();
	renderSideNote();
	const started = performance.now();
	const tick = setInterval(() => renderSideNote(performance.now() - started), 250);
	const loading = call("open", { version: v })
		.then((tsv) => {
			if (state.version !== v) return;
			state.listing = parseListing(v, tsv);
			renderTree();
			runSearch();
		})
		.catch((err: unknown) => {
			if (state.version !== v) return;
			state.listingError = errorText(err);
			state.listingPromise = null;
		})
		.finally(() => {
			clearInterval(tick);
			if (state.version === v) renderSideNote();
		});
	state.listingPromise = loading;
	return loading;
}

function renderSideNote(elapsed?: number) {
	const note = $("side-note");
	note.className = "side-note";
	if (runtimeState === "error") {
		note.classList.add("error-text");
		note.textContent = "The decompiler failed to start: " + runtimeError;
	} else if (state.listingError) {
		note.classList.add("error-text");
		note.textContent = state.listingError;
	} else if (!state.listing && state.version) {
		const seconds = elapsed ? ` · ${(elapsed / 1000).toFixed(0)} s` : "";
		note.replaceChildren(dot("warn"), text(runtimeState === "starting" ? `Starting decompiler${seconds}` : `Loading ${state.version}${seconds}`));
	} else {
		note.hidden = true;
		return;
	}
	note.hidden = false;
}

function dot(cls: string) {
	const d = document.createElement("span");
	d.className = "dot " + cls;
	return d;
}
function text(s: string) {
	return document.createTextNode(s);
}

/** Splits "Ns.Sub.Outer+Inner`1" into namespace, display name (Outer.Inner) and simple name. */
function splitTypeName(reflectionName: string) {
	const plus = reflectionName.indexOf("+");
	const outer = plus < 0 ? reflectionName : reflectionName.slice(0, plus);
	const dotAt = outer.lastIndexOf(".");
	const ns = dotAt < 0 ? "" : outer.slice(0, dotAt);
	const display = reflectionName.slice(dotAt + 1).replace(/`\d+/g, "").replace(/\+/g, ".");
	return { ns, display, simple: display.slice(display.lastIndexOf(".") + 1) };
}

const KIND_LETTER: Record<string, string> = { class: "C", static: "C", abstract: "C", interface: "I", struct: "S", enum: "E", delegate: "D", method: "M", field: "F", property: "P", event: "E" };

function parseListing(v: string, tsv: string): Listing {
	const types: TypeEntry[] = [];
	const members: MemberEntry[] = [];
	const assemblies: string[] = [];
	const byName = new Map<string, TypeEntry>();
	for (const line of tsv.split("\n")) {
		if (!line) continue;
		const f = line.split("\t");
		if (f[0] === "T") {
			const [, a = "", name = "", kind = "", top = "", token = ""] = f;
			const { ns, display, simple } = splitTypeName(name);
			const full = (ns ? ns + "." : "") + display;
			const t: TypeEntry = {
				a, name, kind, top, token, ns, display, full,
				lower: simple.toLowerCase(),
				fullLower: full.toLowerCase(),
				href: hashFor({ v, a, t: top, m: top === name ? null : token }),
			};
			types.push(t);
			byName.set(a + "|" + name, t);
			if (!assemblies.includes(a)) assemblies.push(a);
		} else if (f[0] === "M") {
			const [, a = "", display = "", kind = "", top = "", token = "", declaring = ""] = f;
			const owner = splitTypeName(declaring);
			const simple = display.replace(/\(.*$/, "");
			members.push({
				a, display, kind, token, owner: owner.display,
				lower: simple.toLowerCase(),
				fullLower: (owner.display + "." + simple).toLowerCase(),
				href: hashFor({ v, a, t: top, m: token }),
			});
		}
	}
	return { v, types, members, assemblies, byName };
}

function renderTree() {
	const { types, assemblies } = state.listing!;
	const frag = document.createDocumentFragment();
	for (const a of assemblies) {
		const head = document.createElement("div");
		head.className = "tree-assembly";
		head.textContent = a;
		frag.append(head);
		const groups = new Map<string, TypeEntry[]>();
		for (const t of types)
			if (t.a === a && t.top === t.name) {
				if (!groups.has(t.ns)) groups.set(t.ns, []);
				groups.get(t.ns)!.push(t);
			}
		for (const ns of [...groups.keys()].sort()) {
			const list = groups.get(ns)!.sort((x, y) => x.display.localeCompare(y.display));
			const details = document.createElement("details");
			details.dataset.key = a + "|" + ns;
			const summary = document.createElement("summary");
			const label = document.createElement("span");
			label.className = "ns";
			label.textContent = ns || "(global)";
			const count = document.createElement("span");
			count.className = "count";
			count.textContent = String(list.length);
			summary.append(label, count);
			details.append(summary);
			// Items are built on first open: thousands of rows nobody expanded are not worth the DOM.
			details.addEventListener("toggle", () => {
				if (details.open && details.childElementCount === 1)
					details.append(...list.map((t) => typeItem(t, false)));
			});
			frag.append(details);
		}
	}
	$("tree").replaceChildren(frag);
	if (state.shown) markCurrent(state.shown);
}

function typeItem(t: TypeEntry, withWhere: boolean) {
	const a = document.createElement("a");
	a.className = "item";
	a.href = t.href;
	a.dataset.key = t.a + "|" + t.name;
	const kind = document.createElement("span");
	kind.className = "kind";
	kind.textContent = KIND_LETTER[t.kind] ?? "";
	kind.title = t.kind;
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = t.display;
	a.append(kind, name);
	if (withWhere) {
		const where = document.createElement("span");
		where.className = "where";
		where.textContent = t.ns;
		a.append(where);
	}
	return a;
}

function memberItem(m: MemberEntry) {
	const a = document.createElement("a");
	a.className = "item";
	a.href = m.href;
	const kind = document.createElement("span");
	kind.className = "kind " + (m.kind === "method" ? "m" : "f");
	kind.textContent = KIND_LETTER[m.kind] ?? "";
	kind.title = m.kind;
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = m.display;
	const where = document.createElement("span");
	where.className = "where";
	where.textContent = m.owner;
	a.append(kind, name, where);
	return a;
}

function markCurrent(shown: Shown | null) {
	for (const el of document.querySelectorAll('#tree [aria-current="page"]'))
		el.removeAttribute("aria-current");
	if (!shown || !state.listing) return;
	const t = state.listing.byName.get(shown.a + "|" + shown.t);
	if (!t) return;
	const details = document.querySelector<HTMLDetailsElement>(`#tree details[data-key="${CSS.escape(t.a + "|" + t.ns)}"]`);
	if (!details) return;
	if (!details.open) details.open = true;
	if (details.childElementCount === 1) details.dispatchEvent(new Event("toggle"));
	const item = details.querySelector(`[data-key="${CSS.escape(t.a + "|" + t.name)}"]`);
	if (item) {
		item.setAttribute("aria-current", "page");
		if ($("results").hidden) item.scrollIntoView({ block: "center" });
	}
}

// ---- Search ---------------------------------------------------------------------------------

const MAX_RESULTS = 100;
/** [score, display length, entry, is a type] */
type Result = [number, number, TypeEntry | MemberEntry, boolean];
let results: Result[] = [];
let active = -1;

function score(item: { lower: string; fullLower: string }, q: string, dotted: boolean) {
	const s = dotted ? item.fullLower : item.lower;
	if (s === q) return 0;
	if (s.startsWith(q)) return 1;
	if (dotted && s.endsWith(q)) return 1;
	return s.includes(q) ? 2 : -1;
}

function runSearch() {
	const search = $<HTMLInputElement>("search");
	const q = search.value.trim().toLowerCase();
	if (!q || !state.listing) {
		hideResults();
		return;
	}
	const dotted = q.includes(".");
	const scored: Result[] = [];
	for (const t of state.listing.types) {
		const s = score(t, q, dotted);
		if (s >= 0) scored.push([s, t.display.length, t, true]);
	}
	for (const m of state.listing.members) {
		const s = score(m, q, dotted);
		if (s >= 0) scored.push([s + 0.5, m.display.length, m, false]);
	}
	scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	results = scored.slice(0, MAX_RESULTS);
	const box = $("results");
	const frag = document.createDocumentFragment();
	results.forEach(([, , item, isType], i) => {
		const el = isType ? typeItem(item as TypeEntry, true) : memberItem(item as MemberEntry);
		el.id = "result-" + i;
		el.setAttribute("role", "option");
		frag.append(el);
	});
	if (!results.length) {
		const none = document.createElement("div");
		none.className = "side-note";
		none.textContent = `Nothing matches “${search.value.trim()}”.`;
		frag.append(none);
	} else if (scored.length > MAX_RESULTS) {
		const more = document.createElement("div");
		more.className = "results-more";
		more.textContent = `${MAX_RESULTS} of ${scored.length.toLocaleString()}`;
		frag.append(more);
	}
	box.replaceChildren(frag);
	box.hidden = false;
	$("tree").hidden = true;
	search.setAttribute("aria-expanded", "true");
	setActive(results.length ? 0 : -1);
	$("side-scroll").scrollTop = 0;
}

function hideResults() {
	results = [];
	active = -1;
	$("results").hidden = true;
	$("results").replaceChildren();
	$("tree").hidden = false;
	$("search").setAttribute("aria-expanded", "false");
	$("search").removeAttribute("aria-activedescendant");
}

function setActive(i: number) {
	$("results").querySelector(".active")?.classList.remove("active");
	active = i;
	if (i < 0) {
		$("search").removeAttribute("aria-activedescendant");
		return;
	}
	const el = $("result-" + i);
	el.classList.add("active");
	el.scrollIntoView({ block: "nearest" });
	$("search").setAttribute("aria-activedescendant", el.id);
}

let searchFrame = 0;
$("search").addEventListener("input", () => {
	cancelAnimationFrame(searchFrame);
	searchFrame = requestAnimationFrame(runSearch);
});
$<HTMLInputElement>("search").addEventListener("keydown", (e) => {
	const search = e.currentTarget as HTMLInputElement;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		if (!results.length) return;
		e.preventDefault();
		const step = e.key === "ArrowDown" ? 1 : -1;
		setActive((active + step + results.length) % results.length);
	} else if (e.key === "Enter") {
		if (active < 0) return;
		e.preventDefault();
		$("result-" + active).click();
	} else if (e.key === "Escape") {
		e.preventDefault();
		if (search.value) {
			search.value = "";
			hideResults();
		} else if (phone.matches) {
			closeSheet();
		} else {
			search.blur();
		}
	}
});
$("sidebar").addEventListener("click", (e) => {
	if (e.target instanceof Element && e.target.closest("a.item") && phone.matches)
		closeSheet();
});

// ---- Tabs -----------------------------------------------------------------------------------

/** An open tab: a type, and the hash it was last shown at (with its m= or l=). */
interface Tab {
	a: string;
	t: string;
	hash: string;
}

// Open tabs belong to a version and persist as "vssrc.tabs.<version>": { tabs: Tab[], active: "a|t" }.
// The URL hash itself always names the active tab.
const tabs = { version: null as string | null, list: [] as Tab[], active: null as string | null };
/** Editor snapshots ("v|a|t") of open tabs, so switching back restores scroll and folds. */
const tabStates = new Map<string, EditorSnapshot>();
/** Hash set by switching tabs; routing to it restores the tab without scrolling to its lines. */
let tabSwitchHash: string | null = null;
const tabKey = (tab: { a: string; t: string }) => tab.a + "|" + tab.t;

function loadTabs(v: string) {
	if (tabs.version !== v) {
		tabs.version = v;
		tabStates.clear();
	}
	readTabs();
}

/**
 * Storage is the source of truth: every change re-reads it first, so a page restored from the
 * back/forward cache or a second window never writes back a stale list.
 */
function readTabs() {
	let saved: { tabs?: unknown; active?: unknown } | null = null;
	try { saved = JSON.parse(store.get("vssrc.tabs." + tabs.version) ?? "null"); } catch {}
	tabs.list = Array.isArray(saved?.tabs) ? (saved.tabs as Partial<Tab>[]).filter((x): x is Tab => !!(x?.a && x?.t && x?.hash)) : [];
	tabs.active = typeof saved?.active === "string" && tabs.list.some((x) => tabKey(x) === saved.active) ? saved.active : null;
}

/** Re-reads storage, keeping the tab on screen in this window as its active one. */
function readTabsKeepingShown() {
	const shown = state.shown && state.shown.v === tabs.version ? state.shown.a + "|" + state.shown.t : null;
	readTabs();
	if (shown && tabs.list.some((x) => tabKey(x) === shown))
		tabs.active = shown;
}

function refreshTabs() {
	if (!tabs.version)
		return;
	readTabsKeepingShown();
	renderTabs();
}
addEventListener("storage", (e) => {
	if (e.key === "vssrc.tabs." + tabs.version)
		refreshTabs();
});
addEventListener("pageshow", (e) => {
	if (e.persisted)
		refreshTabs();
});

function saveTabs() {
	store.set("vssrc.tabs." + tabs.version, JSON.stringify({ tabs: tabs.list, active: tabs.active }));
}

/** Makes a|t the active tab, adding it right after the current one if it isn't open. */
function openTab(a: string, t: string, hash: string) {
	// Inserted next to the tab this window was showing, not whichever another window made active.
	readTabsKeepingShown();
	let tab = tabs.list.find((x) => x.a === a && x.t === t);
	if (!tab) {
		tab = { a, t, hash };
		const at = tabs.list.findIndex((x) => tabKey(x) === tabs.active);
		tabs.list.splice(at < 0 ? tabs.list.length : at + 1, 0, tab);
	}
	tab.hash = hash;
	tabs.active = tabKey(tab);
	saveTabs();
	renderTabs();
}

function switchTab(key: string) {
	const tab = tabs.list.find((x) => tabKey(x) === key);
	if (!tab || key === tabs.active)
		return;
	tabSwitchHash = tab.hash;
	location.hash = tab.hash;
}

function closeTab(key: string) {
	readTabsKeepingShown();
	const i = tabs.list.findIndex((x) => tabKey(x) === key);
	if (i < 0 || !tabs.version)
		return;
	tabs.list.splice(i, 1);
	tabStates.delete(tabs.version + "|" + key);
	if (key !== tabs.active) {
		saveTabs();
		renderTabs();
		return;
	}
	// The neighbour to the right takes over, like closing a tab in an editor; none left shows the landing page.
	const next = tabs.list[i] ?? tabs.list[i - 1];
	tabs.active = next ? tabKey(next) : null;
	saveTabs();
	renderTabs();
	if (next) {
		tabSwitchHash = next.hash;
		location.hash = next.hash;
	} else {
		location.hash = hashFor({ v: tabs.version });
	}
}

/** Switches to the tab step places after the active one, wrapping around. */
function stepTab(step: number) {
	readTabsKeepingShown();
	const i = tabs.list.findIndex((x) => tabKey(x) === tabs.active);
	if (i >= 0)
		switchTab(tabKey(tabs.list[(i + step + tabs.list.length) % tabs.list.length]!));
}

const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

function renderTabs() {
	const list = $("tab-list");
	const names = tabs.list.map((x) => splitTypeName(x.t));
	const counts = new Map<string, number>();
	for (const n of names)
		counts.set(n.display, (counts.get(n.display) ?? 0) + 1);
	list.replaceChildren(...tabs.list.map((tab, i) => {
		const { ns, display } = names[i]!;
		const active = tabKey(tab) === tabs.active;
		const el = document.createElement("div");
		el.className = "tab";
		el.setAttribute("role", "tab");
		el.setAttribute("aria-selected", String(active));
		el.tabIndex = active ? 0 : -1;
		el.dataset.key = tabKey(tab);
		el.title = (ns ? ns + "." : "") + display;
		el.innerHTML = FILE_ICON + '<span class="tab-name"></span>';
		el.querySelector(".tab-name")!.textContent = display + ".cs";
		// Two open types with the same name get the last part of their namespace as a hint.
		if (counts.get(display)! > 1) {
			const hint = document.createElement("span");
			hint.className = "tab-hint";
			hint.textContent = ns.split(".").pop() || "(global)";
			el.append(hint);
		}
		const close = document.createElement("button");
		close.className = "tab-close";
		close.tabIndex = -1;
		close.setAttribute("aria-label", `Close ${display}.cs`);
		close.innerHTML = CLOSE_ICON;
		el.append(close);
		return el;
	}));
	$("viewer-head").hidden = tabs.list.length === 0;
	list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The tab element an event happened in, if any. */
const tabOf = (e: Event) => e.target instanceof Element ? e.target.closest<HTMLElement>(".tab") : null;

$("tab-list").addEventListener("click", (e) => {
	const tab = tabOf(e);
	if (!tab)
		return;
	if (e.target instanceof Element && e.target.closest(".tab-close"))
		closeTab(tab.dataset.key!);
	else
		switchTab(tab.dataset.key!);
});
// Middle click closes; the mousedown is stopped so it doesn't start autoscroll.
$("tab-list").addEventListener("mousedown", (e) => {
	if (e.button === 1 && tabOf(e))
		e.preventDefault();
});
$("tab-list").addEventListener("auxclick", (e) => {
	const tab = tabOf(e);
	if (tab && e.button === 1)
		closeTab(tab.dataset.key!);
});
// Tablist keys: arrows/Home/End move focus, Enter/Space opens, Delete/Backspace closes.
$("tab-list").addEventListener("keydown", (e) => {
	const tab = tabOf(e);
	if (!tab)
		return;
	const all = [...$("tab-list").querySelectorAll<HTMLElement>(".tab")];
	const i = all.indexOf(tab);
	const focusAt = (j: number) => {
		const target = all[(j + all.length) % all.length]!;
		for (const el of all)
			el.tabIndex = el === target ? 0 : -1;
		target.focus();
	};
	if (e.key === "ArrowRight") focusAt(i + 1);
	else if (e.key === "ArrowLeft") focusAt(i - 1);
	else if (e.key === "Home") focusAt(0);
	else if (e.key === "End") focusAt(all.length - 1);
	else if (e.key === "Enter" || e.key === " ") switchTab(tab.dataset.key!);
	else if (e.key === "Delete" || e.key === "Backspace") {
		closeTab(tab.dataset.key!);
		const left = [...$("tab-list").querySelectorAll<HTMLElement>(".tab")];
		(left[Math.min(i, left.length - 1)] ?? $("search")).focus();
	} else return;
	e.preventDefault();
});

// ---- Viewer ---------------------------------------------------------------------------------

/** The code view loads as its own chunk, fetched while the decompiler starts. */
let editorModule: Promise<typeof import("./editor.ts")> | undefined;
function loadEditor() {
	editorModule ??= import("./editor.ts").catch((err: unknown) => {
		// Let the next attempt fetch it again, e.g. after a network hiccup.
		editorModule = undefined;
		throw new Error("The code editor failed to load: " + errorText(err));
	});
	return editorModule;
}

let editor: CodeEditor | null = null;
/** "v|a|t" of the document in the editor. */
let editorKey: string | null = null;
/** Hash set by a line-number click; routing to it highlights without scrolling. */
let lineClickHash: string | null = null;

async function getEditor() {
	const { create } = await loadEditor();
	editor ??= create($("editor"), {
		onLineClick(line, extend) {
			const h = parseHash();
			if (!h.v)
				return;
			// Shift extends from the first line of the current range, like a text selection.
			const anchor = extend && h.l ? h.l[0] : line;
			lineClickHash = hashFor({ ...h, v: h.v, m: null, l: [Math.min(anchor, line), Math.max(anchor, line)] });
			location.hash = lineClickHash;
		},
		onLink(href) {
			location.hash = href;
		},
		onGoToLine(line) {
			const h = parseHash();
			if (!h.v)
				return;
			const target = hashFor({ ...h, v: h.v, m: null, l: [line, line] });
			// Routing scrolls to the line, but an unchanged hash doesn't route.
			if (location.hash === target) editor?.link([line, line], true);
			else location.hash = target;
		},
	});
	return editor;
}

/** The page shown while no tabs are open. */
function showLanding() {
	$("viewer-head").hidden = true;
	$("crumbs").hidden = true;
	$("editor").hidden = true;
	$("viewer-note").hidden = true;
	$("landing").hidden = false;
	document.title = PAGE_TITLE;
	const top = state.listing!.types.filter((t) => t.top === t.name).length;
	$("landing-stats").textContent = `${state.version} · ${top.toLocaleString()} types`;
}

$("landing-search").addEventListener("click", () => {
	revealSidebar();
	$("search").focus();
});
$("landing-random").addEventListener("click", () => {
	const top = state.listing?.types.filter((t) => t.top === t.name) ?? [];
	if (top.length)
		location.hash = top[Math.floor(Math.random() * top.length)]!.href;
});
// Shortcut keys as this platform writes them: on Apple platforms Ctrl is ⌘ in .mod keys and ⌃ elsewhere, Alt is ⌥.
if (mac)
	for (const kbd of document.querySelectorAll("kbd"))
		kbd.textContent = kbd.textContent!.replace(/^Ctrl /, kbd.classList.contains("mod") ? "⌘ " : "⌃ ").replace(/^Alt /, "⌥ ");

function showViewerNote(message: string, { error = false, action, onAction }: { error?: boolean; action?: string; onAction?: () => void } = {}) {
	$("landing").hidden = true;
	$("viewer-head").hidden = true;
	$("crumbs").hidden = true;
	$("editor").hidden = true;
	const note = $("viewer-note");
	note.hidden = false;
	const inner = document.createElement("div");
	const p = document.createElement("p");
	p.textContent = message;
	if (error) p.className = "error";
	inner.append(p);
	if (action && onAction) {
		const b = document.createElement("button");
		b.className = "button small";
		b.style.marginTop = "1rem";
		b.textContent = action;
		b.addEventListener("click", onAction);
		inner.append(b);
	}
	note.replaceChildren(inner);
}

function showHead(a: string, ns: string, display: string) {
	$("type-name").textContent = display + ".cs";
	const parts = [a, ...(ns ? [ns] : []), display].map((s) => {
		const span = document.createElement("span");
		span.textContent = s;
		return span;
	});
	const crumbs: HTMLElement[] = [];
	parts.forEach((p, i) => {
		if (i) {
			const sep = document.createElement("i");
			sep.textContent = "›";
			crumbs.push(sep);
		}
		crumbs.push(p);
	});
	$("crumbs").replaceChildren(...crumbs);
	$("landing").hidden = true;
	$("viewer-head").hidden = tabs.list.length === 0;
	$("crumbs").hidden = false;
}

async function showType(v: string, a: string, t: string, m: string | null, l: LineRange | null, seqHere: number) {
	const key = `${v}|${a}|${t}`;
	const info = state.listing!.byName.get(a + "|" + t);
	const { ns, display } = splitTypeName(t);
	state.shown = { v, a, t };
	markCurrent(state.shown);
	document.title = `${display} · ${v} · vssrc`;
	if (!info) {
		// The tab stays in the bar so it can be closed.
		showViewerNote(`${t} is not in ${a} ${v}.`, { error: true });
		showHead(a, ns, display);
		return;
	}
	showHead(a, ns, display);

	// A tab with a saved snapshot needs no decompile, even if its HTML has left the cache.
	let html = state.cache.get(key);
	if (html === undefined && !tabStates.has(key)) {
		$("editor").hidden = true;
		const started = performance.now();
		const status = $("view-status");
		const renderTick = () => status.replaceChildren(dot("warn"), text(`Decompiling · ${((performance.now() - started) / 1000).toFixed(1)} s`));
		renderTick();
		const tick = setInterval(renderTick, 100);
		showViewerNoteKeepHead();
		try {
			html = await call("decompile", { version: v, assembly: a, type: t });
		} catch (err) {
			clearInterval(tick);
			if (seqHere !== routeSeq) return;
			status.replaceChildren();
			showViewerNote(`Decompiling ${t} failed: ${errorText(err)}`, { error: true });
			showHead(a, ns, display);
			return;
		}
		clearInterval(tick);
		state.cache.set(key, html);
		// Keep a few dozen types; decompiled text of the large ones runs to megabytes.
		if (state.cache.size > 40)
			state.cache.delete(state.cache.keys().next().value!);
		if (seqHere !== routeSeq) return;
		status.replaceChildren(text(`${((performance.now() - started) / 1000).toFixed(1)} s`));
	} else {
		$("view-status").replaceChildren();
	}
	if (seqHere !== routeSeq) return;
	let ed: CodeEditor;
	try {
		ed = await getEditor();
	} catch (err) {
		showViewerNote(errorText(err), { error: true });
		return;
	}
	if (seqHere !== routeSeq) return;

	// Shown before the document goes in, so CodeMirror can measure for scrolling.
	$("viewer-note").hidden = true;
	$("editor").hidden = false;
	const changed = editorKey !== key;
	let restored = false;
	if (changed) {
		// Keep the outgoing tab's place while it stays open.
		if (editorKey && tabs.list.some((x) => tabs.version + "|" + tabKey(x) === editorKey))
			tabStates.set(editorKey, ed.save());
		const saved = tabStates.get(key);
		if (saved) {
			ed.restore(saved);
			restored = true;
		} else {
			ed.show(html!);
		}
		editorKey = key;
	}
	// A member link (m=) highlights its definition's line; a line permalink (l=) wins over it.
	let range = l;
	if (!range && m) {
		const line = ed.lineOf(m);
		if (line) range = [line, line];
	}
	// Line clicks and tab switches keep the view where it is; links and permalinks scroll to their lines.
	const fromLineClick = location.hash === lineClickHash;
	const fromTabSwitch = location.hash === tabSwitchHash && restored;
	lineClickHash = null;
	tabSwitchHash = null;
	ed.link(range, !fromLineClick && !fromTabSwitch);
	if (!range && changed && !restored)
		ed.scrollTop();
}

function showViewerNoteKeepHead() {
	const note = $("viewer-note");
	note.hidden = false;
	note.replaceChildren();
}

// ---- Phone sheet ----------------------------------------------------------------------------

const SHEET_IN: Keyframe[] = [{ transform: "translateX(-100%)" }, { transform: "none" }];

function openSheet(animate = true) {
	const s = $("sidebar");
	if (s.classList.contains("open")) return;
	s.classList.add("open");
	$("types-button").setAttribute("aria-expanded", "true");
	if (animate && !reducedMotion.matches)
		s.animate(SHEET_IN, { duration: 180, easing: "ease-out" });
}

async function closeSheet() {
	const s = $("sidebar");
	if (!s.classList.contains("open") || s.dataset.closing) return;
	s.dataset.closing = "1";
	$("types-button").setAttribute("aria-expanded", "false");
	if (!reducedMotion.matches)
		await s.animate([...SHEET_IN].reverse(), { duration: 160, easing: "ease-in" }).finished.catch(() => {});
	s.classList.remove("open");
	delete s.dataset.closing;
}

// ---- Sidebar --------------------------------------------------------------------------------

// Wide screens can collapse the sidebar (Ctrl+B), remembered as "vssrc.sidebar"; phones show it as a sheet.
const sidebarCollapsed = () => document.body.classList.contains("side-hidden");

function setSidebarCollapsed(collapsed: boolean) {
	document.body.classList.toggle("side-hidden", collapsed);
	store.set("vssrc.sidebar", collapsed ? "hidden" : "shown");
	if (!phone.matches)
		$("types-button").setAttribute("aria-expanded", String(!collapsed));
}

function toggleSidebar() {
	if (!phone.matches) setSidebarCollapsed(!sidebarCollapsed());
	else if ($("sidebar").classList.contains("open")) closeSheet();
	else openSheet();
}

/** Shows the sidebar, as a sheet on phones. */
function revealSidebar() {
	if (phone.matches) openSheet();
	else if (sidebarCollapsed()) setSidebarCollapsed(false);
}

if (store.get("vssrc.sidebar") === "hidden")
	document.body.classList.add("side-hidden");
$("types-button").setAttribute("aria-expanded", String(!phone.matches && !sidebarCollapsed()));
$("types-button").addEventListener("click", toggleSidebar);
phone.addEventListener("change", () => {
	if (!phone.matches) $("sidebar").classList.remove("open");
	$("types-button").setAttribute("aria-expanded", String(!phone.matches && !sidebarCollapsed()));
});

// ---- Screens --------------------------------------------------------------------------------

function showStart() {
	$("browser").hidden = true;
	$("version-button").hidden = true;
	$("types-button").hidden = true;
	$("start").hidden = false;
	$("import-home").append($("import"));
	document.title = PAGE_TITLE;
}

function showBrowser() {
	$("start").hidden = true;
	$("browser").hidden = false;
	$("version-button").hidden = false;
	$("types-button").hidden = false;
}

// ---- Versions dialog ------------------------------------------------------------------------

const dialog = $<HTMLDialogElement>("versions-dialog");
let pendingDelete: string | null = null;

function renderVersions() {
	const list = $("version-list");
	list.replaceChildren();
	if (!state.versions.length) {
		const li = document.createElement("li");
		li.className = "muted";
		li.textContent = "No versions imported yet.";
		list.append(li);
		return;
	}
	for (const r of [...state.versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))) {
		const li = document.createElement("li");
		li.className = "version-row" + (r.version === state.version ? " current" : "");
		const v = document.createElement("span");
		v.className = "v";
		v.textContent = r.version;
		const meta = document.createElement("span");
		meta.className = "meta";
		meta.textContent = `${mb(r.size)} MB · ${new Date(r.imported).toLocaleDateString()}`;
		if (r.archive === "server") {
			const partial = document.createElement("span");
			partial.className = "partial";
			partial.textContent = " · server-only";
			partial.title = partialText(r);
			meta.append(partial);
		}
		const actions = document.createElement("span");
		actions.className = "actions";
		if (pendingDelete === r.version) {
			const label = document.createElement("span");
			label.className = "confirm";
			label.textContent = "Delete?";
			const yes = button("Delete", "button small danger", () => deleteVersion(r.version));
			const no = button("Cancel", "button small", () => {
				pendingDelete = null;
				renderVersions();
				list.querySelector<HTMLElement>(`[data-v="${CSS.escape(r.version)}"]`)?.focus();
			});
			actions.append(label, yes, no);
			queueMicrotask(() => no.focus());
		} else {
			if (r.version !== state.version)
				actions.append(button("Open", "button small", () => {
					closeDialog();
					location.hash = hashFor({ v: r.version });
				}));
			const del = button("Delete", "button small danger", () => {
				pendingDelete = r.version;
				renderVersions();
			});
			del.dataset.v = r.version;
			actions.append(del);
		}
		li.append(v, meta, actions);
		list.append(li);
	}
}

function button(label: string, cls: string, onClick: () => void) {
	const b = document.createElement("button");
	b.className = cls;
	b.textContent = label;
	b.addEventListener("click", onClick);
	return b;
}

async function deleteVersion(v: string) {
	pendingDelete = null;
	try {
		await call("delete", { version: v });
	} catch (err) {
		showImportError("Deleting failed: " + errorText(err));
	}
	for (const key of state.cache.keys())
		if (key.startsWith(v + "|")) state.cache.delete(key);
	store.remove("vssrc.tabs." + v);
	if (tabs.version === v) {
		tabs.version = null;
		tabs.list = [];
		tabs.active = null;
		tabStates.clear();
		renderTabs();
	}
	if (state.version === v) {
		state.version = null;
		state.listing = null;
		state.listingPromise = null;
		state.shown = null;
		editorKey = null;
	}
	await refreshVersions();
	renderStorage();
	if (!state.versions.length) {
		await closeDialog();
		history.replaceState(null, "", location.pathname + location.search);
		route();
	} else if (parseHash().v === v) {
		history.replaceState(null, "", hashFor({ v: preferredVersion() }));
		route();
	}
}

async function renderStorage() {
	const el = $("storage-status");
	if (!navigator.storage?.estimate) {
		el.hidden = true;
		return;
	}
	const [persisted, estimate] = await Promise.all([navigator.storage.persisted?.() ?? false, navigator.storage.estimate()]);
	el.replaceChildren(dot(persisted ? "ok" : "hollow"), text(`${persisted ? "Persistent" : "Not persistent"} · ${mb(estimate.usage ?? 0)} MB used`));
	el.title = persisted ? "" : "The browser may evict imported versions under storage pressure";
}

const DIALOG_IN: Keyframe[] = [{ opacity: 0, transform: "translateY(0.5rem) scale(0.98)" }, { opacity: 1, transform: "none" }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

/** Opens a modal dialog, animating it and its backdrop in. */
function showModal(d: HTMLDialogElement) {
	d.showModal();
	if (!reducedMotion.matches) {
		d.animate(DIALOG_IN, { duration: 180, easing: "ease-out" });
		d.animate(FADE_IN, { duration: 180, easing: "ease-out", pseudoElement: "::backdrop" });
	}
}

/** Animates a modal dialog and its backdrop out, then closes it. */
async function hideModal(d: HTMLDialogElement) {
	if (!d.open || d.dataset.closing) return;
	d.dataset.closing = "1";
	if (!reducedMotion.matches) {
		const options: KeyframeAnimationOptions = { duration: 140, easing: "ease-in", fill: "forwards" };
		const out = d.animate([...DIALOG_IN].reverse(), options);
		const backdrop = d.animate([...FADE_IN].reverse(), { ...options, pseudoElement: "::backdrop" });
		await out.finished.catch(() => {});
		d.close();
		out.cancel();
		backdrop.cancel();
	} else {
		d.close();
	}
	delete d.dataset.closing;
}

function openVersions() {
	if (dialog.open) return;
	$("import-dialog").append($("import"));
	pendingDelete = null;
	renderVersions();
	renderStorage();
	showModal(dialog);
}

async function closeDialog() {
	if (!dialog.open || dialog.dataset.closing || importing) return;
	await hideModal(dialog);
	$("version-button").focus();
}

$("version-button").addEventListener("click", openVersions);
$("versions-close").addEventListener("click", closeDialog);
dialog.addEventListener("cancel", (e) => {
	e.preventDefault();
	closeDialog();
});
dialog.addEventListener("click", (e) => {
	if (e.target === dialog) closeDialog();
});

// ---- Shortcuts dialog -----------------------------------------------------------------------

const shortcutsDialog = $<HTMLDialogElement>("shortcuts-dialog");
/** Where focus goes back to on close: the button, or wherever ? was pressed. */
let shortcutsOpener: HTMLElement | null = null;

function openShortcuts() {
	if (shortcutsDialog.open) return;
	shortcutsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	showModal(shortcutsDialog);
}

async function closeShortcuts() {
	if (!shortcutsDialog.open || shortcutsDialog.dataset.closing) return;
	await hideModal(shortcutsDialog);
	shortcutsOpener?.focus();
}

$("shortcuts-button").addEventListener("click", openShortcuts);
$("shortcuts-close").addEventListener("click", closeShortcuts);
shortcutsDialog.addEventListener("cancel", (e) => {
	e.preventDefault();
	closeShortcuts();
});
shortcutsDialog.addEventListener("click", (e) => {
	if (e.target === shortcutsDialog) closeShortcuts();
});

// ---- Import ---------------------------------------------------------------------------------

$("import-home").append($<HTMLTemplateElement>("import-template").content.cloneNode(true));

/** A listed download, or a guessed one for a version newer than the list (a permalink can ask for one). */
function downloadFor(version: string): Download {
	return versions.find((d) => d.version === version) ?? {
		version,
		branch: version.includes("-") ? "unstable" : "stable",
		file: `vs_client_linux-x64_${version}.tar.gz`,
		size: "",
		// Pre-releases (1.22.0-rc.3) live under unstable/ on the CDN.
		url: `https://cdn.vintagestory.at/gamefiles/${version.includes("-") ? "unstable" : "stable"}/vs_client_linux-x64_${version}.tar.gz`,
	};
}

function renderDownload(version: string) {
	const d = downloadFor(version);
	const select = $<HTMLSelectElement>("version-select");
	select.querySelector("option[data-unlisted]")?.remove();
	if (!versions.includes(d)) {
		const option = new Option(d.version, d.version);
		option.dataset.unlisted = "";
		select.prepend(option);
	}
	select.value = d.version;
	$<HTMLAnchorElement>("download-link").href = d.url;
	$("download-file").textContent = d.file;
	$("download-size").textContent = d.size;
}

function renderVersionSelect() {
	// A group with no versions (no pre-releases embedded) is left out rather than shown empty.
	const groups = ([["stable", "Stable"], ["unstable", "Pre-release"]] as const).flatMap(([branch, label]) => {
		const group = document.createElement("optgroup");
		group.label = label;
		for (const d of versions)
			if (d.branch === branch)
				group.append(new Option(d.version, d.version));
		return group.childElementCount ? [group] : [];
	});
	$<HTMLSelectElement>("version-select").replaceChildren(...groups);
	$("newest-version").textContent = newest().version;
}

/** The version a permalink asks for (null for none). */
let wanted: string | null | undefined;
/** A version chosen in the picker, which wins until the link's version changes. */
let picked: string | null = null;
const downloadShown = () => picked ?? wanted ?? newest().version;

$<HTMLSelectElement>("version-select").addEventListener("change", (e) => {
	picked = (e.currentTarget as HTMLSelectElement).value;
	renderDownload(picked);
});

/** Points the download step at the version a permalink asks for, or the newest when null. */
function renderWanted(version: string | null) {
	// Only on a change, so routing doesn't undo a version picked by hand.
	if (version === wanted)
		return;
	wanted = version;
	picked = null;
	renderDownload(downloadShown());
	const link = $("start-link");
	link.hidden = !version;
	if (version) {
		const mono = document.createElement("span");
		mono.className = "mono";
		mono.textContent = version;
		link.replaceChildren(text("Import "), mono, text(" to open this link."));
	}
}
renderVersionSelect();
renderWanted(null);

/**
 * Swaps in the live version list, in builds made for a server that proxies api.vintagestory.at's
 * manifests next to the page (versions/stable.json and versions/unstable.json; the API itself sends
 * no CORS headers). If the requests fail anyway, the embedded versions stay.
 */
async function fetchLiveVersions() {
	const manifest = async (branch: Branch) => {
		const response = await fetch(asset(`versions/${branch}.json`));
		if (!response.ok)
			throw new Error(`HTTP ${response.status}`);
		return await response.json() as Manifest;
	};
	try {
		const [stable, unstable] = await Promise.all([manifest("stable"), manifest("unstable")]);
		const live = linuxDownloads({ stable, unstable });
		if (!live.some((d) => d.branch === "stable"))
			return;
		versions = live;
		renderVersionSelect();
		renderDownload(downloadShown());
	} catch {
		// Not proxied after all (a local file, offline, a misconfigured server), or not JSON.
	}
}

let importing = false;

function showImportError(message: string) {
	const el = $("import-error");
	el.textContent = message;
	el.hidden = !message;
}

async function startImport(file: File | undefined) {
	if (importing || !file) return;
	if (unsupported) return;
	// Inside the file pick (a user gesture), where browsers that prompt for it allow the prompt.
	navigator.storage?.persist?.().catch(() => {});
	importing = true;
	showImportError("");
	$("choose-button").setAttribute("aria-disabled", "true");
	$("import-progress").hidden = false;
	const fill = $("import-fill");
	const label = $("import-text");
	fill.classList.remove("indeterminate");
	fill.style.width = "0";
	label.textContent = "Reading";
	onProgress = (p) => {
		if (p.phase === "read") {
			fill.style.width = (100 * p.read / p.total).toFixed(1) + "%";
			label.textContent = `Reading ${mb(p.read)} / ${mb(p.total)} MB`;
		} else {
			fill.classList.add("indeterminate");
			label.textContent = p.phase === "resolve"
				? runtimeState === "ready" ? "Resolving references" : "Waiting for the decompiler"
				: "Saving";
		}
	};
	try {
		const { version, archive, kept }: ImportResult = await call("import", { file });
		importing = false;
		await refreshVersions();
		// A fresh server-only import shows its warning again, even if an earlier one was dismissed.
		if (archive === "server")
			store.set("vssrc.dismissed." + version, "");
		if (state.version === version && !kept) {
			// Re-imported the open version: drop what was built from the old files.
			state.version = null;
			state.listingPromise = null;
			for (const key of state.cache.keys())
				if (key.startsWith(version + "|")) state.cache.delete(key);
			tabStates.clear();
			editorKey = null;
		}
		await closeDialog();
		// The hash still holds a permalink into the version just imported: open it as is.
		const target = parseHash().v === version ? location.hash : hashFor({ v: version });
		if (location.hash === target) route();
		else location.hash = target;
	} catch (err) {
		showImportError(errorText(err));
	} finally {
		importing = false;
		onProgress = null;
		$("choose-button").removeAttribute("aria-disabled");
		$("import-progress").hidden = true;
		$<HTMLInputElement>("file-input").value = "";
	}
}

$<HTMLInputElement>("file-input").addEventListener("change", (e) => startImport((e.currentTarget as HTMLInputElement).files?.[0]));
$("choose-button").addEventListener("keydown", (e) => {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		$("file-input").click();
	}
});
for (const type of ["dragenter", "dragover"] as const)
	document.addEventListener(type, (e) => {
		if (!e.dataTransfer?.types?.includes("Files")) return;
		e.preventDefault();
		$("import").classList.add("dragging");
	});
document.addEventListener("dragleave", (e) => {
	if (!e.relatedTarget) $("import").classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
	if (!e.dataTransfer?.files?.length) return;
	e.preventDefault();
	$("import").classList.remove("dragging");
	if (!$("browser").hidden && !dialog.open) openVersions();
	startImport(e.dataTransfer.files[0]);
});

// ---- Keyboard -------------------------------------------------------------------------------

// The list is in the shortcuts dialog (index.html). Tab keys use Alt because browsers keep Ctrl+W,
// Ctrl+Tab and Ctrl+PageUp/PageDown, and Alt+Left/Right are Back and Forward. Keys go by e.code where
// Alt is held, since Option on Apple platforms turns e.key into another character.
document.addEventListener("keydown", (e) => {
	if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
	// The code view is contenteditable only for its caret and selection; it takes no text.
	const typing = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]:not(.cm-content)");
	const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
	// Ctrl, or ⌘ on Apple platforms.
	const mod = (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
	// Alt alone; AltGr arrives as Ctrl+Alt and types characters.
	const alt = e.altKey && !e.ctrlKey && !e.metaKey;
	const key = e.key.toLowerCase();
	const browsing = !$("browser").hidden;
	let handled = true;
	if (browsing && ((e.key === "/" && plain && !typing) || (key === "k" && mod))) {
		revealSidebar();
		const search = $<HTMLInputElement>("search");
		search.focus();
		search.select();
	} else if (browsing && key === "b" && mod) {
		toggleSidebar();
	} else if (key === "g" && e.ctrlKey && !e.metaKey && !e.altKey && editor && !$("editor").hidden) {
		editor.goToLine();
	} else if (browsing && alt && (e.code === "BracketLeft" || e.code === "BracketRight")) {
		stepTab(e.code === "BracketLeft" ? -1 : 1);
	} else if (browsing && alt && e.code === "KeyW") {
		readTabsKeepingShown();
		if (tabs.active) closeTab(tabs.active);
	} else if (e.key === "?" && !e.ctrlKey && !e.metaKey && !typing) {
		openShortcuts();
	} else if (e.key === "Escape" && phone.matches && $("sidebar").classList.contains("open") && state.shown) {
		closeSheet();
		handled = false;
	} else {
		handled = false;
	}
	if (handled)
		e.preventDefault();
});

// ---- Start ----------------------------------------------------------------------------------

(async () => {
	// In the background: the picker shows the embedded versions until (and unless) the live list arrives.
	if (BUILD_USE_PROXY)
		fetchLiveVersions();
	if (unsupported) {
		$("runtime-status").hidden = true;
		showStart();
		showImportError("This browser lacks DecompressionStream, WebAssembly or IndexedDB. Use Safari 16.4+, Chrome 80+ or Firefox 113+.");
		$("choose-button").setAttribute("aria-disabled", "true");
		return;
	}
	startWorker().then(
		() => setRuntime("ready"),
		(err: unknown) => setRuntime("error", errorText(err)),
	);
	// Fetched now, while the runtime starts, so the first type opens without waiting on it.
	loadEditor().catch(() => {});
	try {
		await refreshVersions();
	} catch (err) {
		showStart();
		showImportError("Storage is unavailable: " + errorText(err));
		return;
	}
	route();
})();
