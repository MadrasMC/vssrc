// Read-only CodeMirror view for decompiled code. app.ts imports it with import(), so the build
// splits it into its own chunk that loads while the decompiler starts.
import { EditorState, RangeSet, RangeValue, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
	Decoration, EditorView, GutterMarker, drawSelection, getDialog, gutterLineClass, highlightActiveLine,
	highlightActiveLineGutter, keymap, lineNumbers, showDialog, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";

/** A first and last line number, 1-based and inclusive. */
export type LineRange = [number, number];

/** A span or link of the decompiler's HTML, as a text range. */
interface Mark {
	from: number;
	to: number;
	cls: string | null;
	href: string | null;
	title: string | null;
	def: boolean;
}

/**
 * Splits the decompiler's HTML into plain text and the ranges its spans and links covered.
 * Definitions (id="d<token>") come back as token -> offset, the anchors for member links.
 */
function parse(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	let text = "";
	const marks: Mark[] = [];
	const defs = new Map<string, number>();
	const walk = (node: Node) => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child instanceof Text) {
				text += child.data;
				continue;
			}
			if (!(child instanceof Element))
				continue;
			const from = text.length;
			walk(child);
			const cls = child.getAttribute("class");
			const href = child.getAttribute("href");
			const title = child.getAttribute("title");
			const id = child.getAttribute("id");
			if (id)
				defs.set(id.slice(1), from);
			if (cls || href)
				marks.push({ from, to: text.length, cls, href, title, def: !!id });
		}
	};
	walk(template.content);
	return { text, marks, defs };
}

function decorations(marks: Mark[]): DecorationSet {
	const ranges = [];
	for (const m of marks) {
		if (m.from === m.to)
			continue;
		const spec: { class: string; tagName?: string; attributes?: Record<string, string> } = { class: "tok-" + m.cls + (m.def ? " tok-def" : "") };
		if (m.href) {
			spec.tagName = "a";
			spec.attributes = { href: m.href };
		} else if (m.title) {
			spec.attributes = { title: m.title };
		}
		ranges.push(Decoration.mark(spec).range(m.from, m.to));
	}
	return Decoration.set(ranges, true);
}

// ---- Linked lines (the permalink's l= range) ----

const setLinked = StateEffect.define<LineRange | null>();

class LinkedGutter extends GutterMarker {
	override elementClass = "cm-linked-gutter";
}
const linkedGutter = new LinkedGutter();

/** Holds the linked line range, or null. */
const linkedField = StateField.define<LineRange | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects)
			if (e.is(setLinked))
				value = e.value;
		return value;
	},
	provide: (field) => [
		EditorView.decorations.compute([field], (state) => lineRanges(state, state.field(field), Decoration.line({ class: "cm-linked" }))),
		gutterLineClass.compute([field], (state) => lineRanges(state, state.field(field), linkedGutter)),
	],
});

function lineRanges<T extends RangeValue>(state: EditorState, linked: LineRange | null, value: T): RangeSet<T> {
	if (!linked)
		return RangeSet.empty;
	const ranges = [];
	const last = Math.min(linked[1], state.doc.lines);
	for (let n = Math.max(1, linked[0]); n <= last; n++)
		ranges.push(value.range(state.doc.line(n).from));
	return RangeSet.of(ranges);
}

// ---- Folding ----

const indentOf = (text: string) => /^\s*/.exec(text)![0].length;

/**
 * The decompiler writes braces on their own lines (Allman style) with consistent tabs, so a
 * block is: a header line, a "{" at the same indent, and the next "}" at that indent.
 */
const braceFolding = foldService.of((state, lineStart) => {
	const line = state.doc.lineAt(lineStart);
	if (line.number >= state.doc.lines)
		return null;
	const open = state.doc.line(line.number + 1);
	const indent = indentOf(line.text);
	if (open.text.trim() !== "{" || indentOf(open.text) !== indent || !line.text.trim())
		return null;
	for (let n = open.number + 1; n <= state.doc.lines; n++) {
		const close = state.doc.line(n);
		if (indentOf(close.text) === indent && close.text.trim().startsWith("}"))
			return { from: line.to, to: close.to };
		if (close.text.trim() && indentOf(close.text) < indent)
			return null;
	}
	return null;
});

/** A caret pointing down when the block is open, right when folded. */
function foldMarker(open: boolean) {
	const span = document.createElement("span");
	span.className = "cm-fold-marker" + (open ? "" : " cm-fold-closed");
	span.title = open ? "Fold" : "Unfold";
	span.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
	return span;
}

const theme = EditorView.theme({
	"&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)", fontSize: "var(--code-size)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.75", fontVariantLigatures: "none" },
	".cm-content": { padding: "0.75rem 0 4rem", caretColor: "transparent" },
	".cm-line": { padding: "0 1.5rem 0 0.75rem" },
	".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", border: "none" },
	".cm-lineNumbers .cm-gutterElement": { padding: "0 0.75rem 0 var(--gutter-pad)", minWidth: "var(--gutter-min)", cursor: "pointer", fontVariantNumeric: "tabular-nums" },
	".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--text)" },
	".cm-foldGutter .cm-gutterElement": { width: "1rem", color: "var(--faint)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
	".cm-fold-marker": { display: "flex", width: "1rem", height: "1rem", transition: "opacity 120ms ease-out" },
	".cm-fold-marker svg": { width: "100%", height: "100%" },
	".cm-fold-marker:hover": { color: "var(--text)" },
	".cm-fold-closed svg": { transform: "rotate(-90deg)" },
	// Like most editors, open-block markers appear while the pointer is over the gutter; folded ones always show.
	".cm-gutters:not(:hover) .cm-fold-marker:not(.cm-fold-closed)": { opacity: "0" },
	"@media (hover: none)": { ".cm-gutters:not(:hover) .cm-fold-marker:not(.cm-fold-closed)": { opacity: "1" } },
	".cm-activeLine": { backgroundColor: "var(--active-line)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
	".cm-linked": { backgroundColor: "var(--target)" },
	".cm-linked-gutter": { color: "var(--text)", backgroundColor: "var(--target)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
	".cm-selectionMatch": { backgroundColor: "var(--match)" },
	".cm-searchMatch": { backgroundColor: "var(--match)", outline: "1px solid var(--faint)" },
	".cm-searchMatch-selected": { backgroundColor: "var(--target)" },
	".cm-foldPlaceholder": { backgroundColor: "var(--sunken)", border: "1px solid var(--line)", color: "var(--muted)", padding: "0 0.375rem", margin: "0 0.25rem" },
	".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
	".cm-panels-top": { borderBottom: "1px solid var(--line)" },
	// The find and go to line panels: one row of fields, buttons and options, with the close button at the end.
	".cm-panel.cm-search, .cm-panel.cm-goto-line, .cm-panel.cm-goto-line form": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem" },
	".cm-panel.cm-search, .cm-panel.cm-goto-line": { padding: "0.5rem 3rem 0.5rem 0.75rem", fontFamily: "var(--font)", fontSize: "0.8125rem" },
	".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-goto-line input, .cm-panel.cm-goto-line button": { font: "inherit", margin: "0" },
	".cm-panel.cm-search label, .cm-panel.cm-goto-line label": { display: "inline-flex", alignItems: "center", gap: "0.375rem", fontSize: "inherit", margin: "0" },
	".cm-panel.cm-search label": { color: "var(--muted)", marginLeft: "0.5rem", cursor: "pointer" },
	".cm-panel.cm-search label:hover": { color: "var(--text)" },
	".cm-panel.cm-search input[type=checkbox]": { width: "1rem", height: "1rem", accentColor: "var(--accent)", cursor: "pointer" },
	".cm-panel.cm-goto-line input": { width: "6rem" },
	".cm-panel.cm-search [name=close], .cm-panel.cm-goto-line .cm-dialog-close": {
		position: "absolute", top: "0.5rem", right: "0.5rem", width: "2rem", height: "2rem", padding: "0",
		display: "flex", alignItems: "center", justifyContent: "center",
		border: "none", borderRadius: "0.375rem", background: "none", color: "var(--muted)", fontSize: "0", cursor: "pointer",
	},
	// The close icon of the app's dialogs, in place of CodeMirror's × character.
	".cm-panel.cm-search [name=close]::before, .cm-panel.cm-goto-line .cm-dialog-close::before": {
		content: '""', width: "1rem", height: "1rem", backgroundColor: "currentColor",
		mask: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'><path d='M6 6l12 12M18 6 6 18'/></svg>") center / contain no-repeat`,
	},
	".cm-panel.cm-search [name=close]:hover, .cm-panel.cm-goto-line .cm-dialog-close:hover": { backgroundColor: "var(--sunken)", color: "var(--text)" },
	".cm-textfield": { boxSizing: "border-box", height: "2rem", border: "1px solid var(--line)", borderRadius: "0.375rem", backgroundColor: "var(--bg)", padding: "0 0.5rem", fontSize: "1rem" },
	".cm-textfield:focus-visible": { borderColor: "var(--accent)" },
	".cm-button": {
		boxSizing: "border-box", height: "2rem", padding: "0 0.75rem", fontWeight: "500", cursor: "pointer",
		backgroundImage: "none", backgroundColor: "var(--panel)", border: "1px solid var(--line)", borderRadius: "0.375rem",
	},
	".cm-button:hover": { backgroundColor: "var(--sunken)" },
	".cm-button:active": { backgroundImage: "none" },
	".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)" },
	"a.tok-t, a.tok-m, a.tok-f": { textDecoration: "none", cursor: "pointer" },
	"a.tok-t:hover, a.tok-m:hover, a.tok-f:hover": { textDecoration: "underline", textUnderlineOffset: "0.2em" },
	".tok-k": { color: "var(--sx-k)" },
	".tok-t": { color: "var(--sx-t)" },
	".tok-m": { color: "var(--sx-m)" },
	".tok-f": { color: "var(--sx-f)" },
	".tok-s": { color: "var(--sx-s)" },
	".tok-n": { color: "var(--sx-n)" },
	".tok-c": { color: "var(--sx-c)", fontStyle: "italic" },
	".tok-v": { color: "var(--sx-v)" },
	".tok-def": { fontWeight: "600" },
});

/** Everything needed to come back to a document as it was: text, folds, selection, scroll. */
export interface EditorSnapshot {
	state: EditorState;
	scroll: number;
	defs: Map<string, number>;
}

export interface EditorEvents {
	/** A click on a line number; extend is true with Shift. */
	onLineClick(line: number, extend: boolean): void;
	/** A plain click on a reference. */
	onLink(href: string): void;
	/** A line picked with Go to line. */
	onGoToLine(line: number): void;
}

/** Opens a line number field above the code (or selects it if it's open) and reports the line picked. */
function promptLine(view: EditorView, onGoToLine: (line: number) => void) {
	const open = getDialog(view, "cm-goto-line");
	if (open) {
		open.dom.querySelector("input")?.select();
		return true;
	}
	// Opened from outside the code, the caret may be far off screen (line 1 until a click). Move it to the
	// top visible line, or handing focus back to the code on close would scroll to it.
	if (!view.hasFocus) {
		const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
		let block = view.lineBlockAtHeight(top);
		// A partly hidden first line would still be scrolled to; take the next one.
		if (block.top < top && block.to < view.state.doc.length)
			block = view.lineBlockAt(block.to + 1);
		view.dispatch({ selection: { anchor: block.from } });
	}
	const current = view.state.doc.lineAt(view.state.selection.main.head).number;
	const { close, result } = showDialog(view, {
		class: "cm-goto-line",
		label: "Go to line",
		input: { type: "text", name: "line", inputmode: "numeric", autocomplete: "off", value: String(current) },
		submitLabel: "Go",
		focus: true,
		top: true,
	});
	result.then((form) => {
		view.dispatch({ effects: close });
		const line = Number(form?.querySelector("input")?.value.trim());
		if (form && Number.isInteger(line) && line >= 1)
			onGoToLine(Math.min(line, view.state.doc.lines));
	});
	return true;
}

/** A read-only code view filling parent. */
export function create(parent: HTMLElement, { onLineClick, onLink, onGoToLine }: EditorEvents) {
	const base: Extension[] = [
		EditorState.readOnly.of(true),
		EditorState.tabSize.of(4),
		// Editable so the caret, selection keys and Ctrl+F work, but never opens a soft keyboard.
		EditorView.contentAttributes.of({ inputmode: "none", "aria-label": "Decompiled source", spellcheck: "false" }),
		lineNumbers({
			domEventHandlers: {
				mousedown(view, block, event) {
					if (!(event instanceof MouseEvent) || event.button !== 0)
						return false;
					onLineClick(view.state.doc.lineAt(block.from).number, event.shiftKey);
					return true;
				},
			},
		}),
		foldGutter({ markerDOM: foldMarker }),
		codeFolding(),
		braceFolding,
		highlightActiveLine(),
		highlightActiveLineGutter(),
		drawSelection(),
		highlightSelectionMatches(),
		search({ top: true }),
		// Sentence case, like the app's other buttons and labels.
		EditorState.phrases.of({ next: "Next", previous: "Previous", all: "All", "match case": "Match case", regexp: "Regex", "by word": "Whole word" }),
		// Ctrl+G is go to line on every platform; find next stays on F3 (and ⌘G on Apple platforms).
		keymap.of([{ key: "Ctrl-g", run: (view) => promptLine(view, onGoToLine) }, ...searchKeymap, ...foldKeymap, ...defaultKeymap]),
		linkedField,
		theme,
		EditorView.domEventHandlers({
			click(event) {
				const a = event.target instanceof Element ? event.target.closest("a[href]") : null;
				const href = a?.getAttribute("href");
				if (!href || event.button !== 0)
					return false;
				event.preventDefault();
				// Links inside an editable region don't navigate natively, so every click is handled here. Ctrl/⌘+click
				// follows the link in place, as in code editors; Shift+click opens it in a new tab.
				if (event.shiftKey)
					window.open(href, "_blank", "noopener");
				else
					onLink(href);
				return true;
			},
		}),
	];
	const view = new EditorView({ parent, state: EditorState.create({ extensions: base }) });
	let defs = new Map<string, number>();

	return {
		/** Replaces the document. */
		show(html: string) {
			const parsed = parse(html);
			defs = parsed.defs;
			view.setState(EditorState.create({
				doc: parsed.text,
				extensions: [base, EditorView.decorations.of(decorations(parsed.marks))],
			}));
		},
		/** Highlights a line range, or clears it with null; scrolls to it when asked. */
		link(range: LineRange | null, scroll: boolean) {
			view.dispatch({ effects: setLinked.of(range) });
			if (range && scroll) {
				const line = view.state.doc.line(Math.min(range[0], view.state.doc.lines));
				view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
			}
		},
		save(): EditorSnapshot {
			return { state: view.state, scroll: view.scrollDOM.scrollTop, defs };
		},
		restore(saved: EditorSnapshot) {
			view.setState(saved.state);
			defs = saved.defs;
			// After the new state's first layout, or the scroll position lands on stale heights.
			requestAnimationFrame(() => { view.scrollDOM.scrollTop = saved.scroll; });
		},
		/** The line a member's definition starts on, by its metadata token. */
		lineOf(token: string) {
			const offset = defs.get(token);
			return offset === undefined ? null : view.state.doc.lineAt(offset).number;
		},
		scrollTop() {
			view.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) });
		},
		goToLine() {
			promptLine(view, onGoToLine);
		},
	};
}

export type CodeEditor = ReturnType<typeof create>;
