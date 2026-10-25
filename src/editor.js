// Read-only CodeMirror view for decompiled code. Bundled by build.mjs into a classic script that
// sets globalThis.vssrcEditor; the page's own script stays unbundled.
import { EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration, EditorView, GutterMarker, drawSelection, gutterLineClass, highlightActiveLine,
	highlightActiveLineGutter, keymap, lineNumbers,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";

/**
 * Splits the decompiler's HTML into plain text and the ranges its spans and links covered.
 * Definitions (id="d<token>") come back as token -> offset, the anchors for member links.
 */
function parse(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	let text = "";
	const marks = [];
	const defs = new Map();
	const walk = (node) => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3) {
				text += child.data;
				continue;
			}
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

function decorations(marks) {
	const ranges = [];
	for (const m of marks) {
		if (m.from === m.to)
			continue;
		const spec = { class: "tok-" + m.cls + (m.def ? " tok-def" : "") };
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

// ---- Linked lines (the permalink's ?l= range) ----

const setLinked = StateEffect.define();

class LinkedGutter extends GutterMarker {
	elementClass = "cm-linked-gutter";
}
const linkedGutter = new LinkedGutter();

/** Holds the linked line range as [first, last] line numbers, or null. */
const linkedField = StateField.define({
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

function lineRanges(state, linked, value) {
	if (!linked)
		return RangeSet.empty;
	const ranges = [];
	const last = Math.min(linked[1], state.doc.lines);
	for (let n = Math.max(1, linked[0]); n <= last; n++)
		ranges.push(value.range(state.doc.line(n).from));
	return RangeSet.of(ranges);
}

// ---- Folding ----

const indentOf = (text) => /^\s*/.exec(text)[0].length;

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

const theme = EditorView.theme({
	"&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)", fontSize: "var(--code-size)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.75", fontVariantLigatures: "none" },
	".cm-content": { padding: "0.75rem 0 4rem", caretColor: "transparent" },
	".cm-line": { padding: "0 1.5rem 0 0.75rem" },
	".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", border: "none" },
	".cm-lineNumbers .cm-gutterElement": { padding: "0 0.75rem 0 var(--gutter-pad)", minWidth: "var(--gutter-min)", cursor: "pointer", fontVariantNumeric: "tabular-nums" },
	".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--text)" },
	".cm-foldGutter .cm-gutterElement": { width: "1rem", color: "var(--faint)", cursor: "pointer" },
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
	".cm-panel.cm-search": { padding: "0.5rem 0.75rem", fontFamily: "var(--font)", fontSize: "0.8125rem" },
	".cm-panel.cm-search input, .cm-panel.cm-search button": { font: "inherit", borderRadius: "0.375rem" },
	".cm-textfield": { border: "1px solid var(--line)", backgroundColor: "var(--bg)", padding: "0.25rem 0.5rem", fontSize: "1rem" },
	".cm-button": { backgroundImage: "none", backgroundColor: "var(--panel)", border: "1px solid var(--line)", padding: "0.25rem 0.625rem" },
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

/**
 * @param parent element the editor fills
 * @param onLineClick (line, extend) for a click on a line number; extend is true with Shift
 * @param onLink (href) for a plain click on a reference
 */
function create(parent, { onLineClick, onLink }) {
	const base = [
		EditorState.readOnly.of(true),
		EditorState.tabSize.of(4),
		// Editable so the caret, selection keys and Ctrl+F work, but never opens a soft keyboard.
		EditorView.contentAttributes.of({ inputmode: "none", "aria-label": "Decompiled source", spellcheck: "false" }),
		lineNumbers({
			domEventHandlers: {
				mousedown(view, block, event) {
					if (event.button !== 0)
						return false;
					onLineClick(view.state.doc.lineAt(block.from).number, event.shiftKey);
					return true;
				},
			},
		}),
		foldGutter({ openText: "⌄", closedText: "›" }),
		codeFolding(),
		braceFolding,
		highlightActiveLine(),
		highlightActiveLineGutter(),
		drawSelection(),
		highlightSelectionMatches(),
		search({ top: true }),
		keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
		linkedField,
		theme,
		EditorView.domEventHandlers({
			click(event) {
				const a = event.target.closest?.("a[href]");
				if (!a || event.button !== 0)
					return false;
				event.preventDefault();
				// Links inside an editable region don't navigate natively, so both cases are handled here.
				if (event.ctrlKey || event.metaKey || event.shiftKey)
					window.open(a.getAttribute("href"), "_blank", "noopener");
				else
					onLink(a.getAttribute("href"));
				return true;
			},
		}),
	];
	const view = new EditorView({ parent, state: EditorState.create({ extensions: base }) });
	let defs = new Map();

	return {
		/** Replaces the document; returns the definition offsets so callers can resolve m= anchors. */
		show(html) {
			const parsed = parse(html);
			defs = parsed.defs;
			view.setState(EditorState.create({
				doc: parsed.text,
				extensions: [base, EditorView.decorations.of(decorations(parsed.marks))],
			}));
			return defs;
		},
		/** Highlights [first, last] (1-based) or clears with null; scrolls to it when asked. */
		link(range, scroll) {
			view.dispatch({ effects: setLinked.of(range) });
			if (range && scroll) {
				const line = view.state.doc.line(Math.min(range[0], view.state.doc.lines));
				view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
			}
		},
		lineOf(token) {
			return defs.has(token) ? view.state.doc.lineAt(defs.get(token)).number : null;
		},
		scrollTop() {
			view.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) });
		},
		focus() {
			view.focus();
		},
	};
}

globalThis.vssrcEditor = { create };
