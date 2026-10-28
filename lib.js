// Pure text helpers shared by the app and the Node test. No browser APIs in here.

const STOP = new Set(
	(
		"the and for are what when how does with that this from have can should which about into than then there their will any not was were " +
		"is it in of to a an on at be do if or as by my me i we our us you your has had did done get got need needs " +
		"one also please tell show find here would could may use used want know give what's whats " +
		"work works working fly flying happen happens happening mean means meaning"
	).split(" "),
);

/** Symbol-font characters (bullets, arrows, tick boxes) arrive as private-use code points that show as empty boxes. Bullets become "•", the rest go. */
export const clean = (s) =>
	s
		.replace(/\uF0B7/g, "•")
		.replace(/[\uE000-\uF8FF]/g, "")
		.replace(/ {2,}/g, " ");

/** Crude word stem so "evacuation" also finds "evacuate", "calls" finds "call", "landing" finds "land". */
export function stem(w) {
	const r = w.replace(/(ations?|itions?|ings?|ions?|ed|es|s)$/, "");
	return r.length >= 4 ? r : w;
}

/** Turn pdf.js text items into lines of text. */
export function itemsToLines(items) {
	const lines = [];
	let cur = "",
		prevEnd = null,
		prevY = null;
	const flush = () => {
		if (cur.trim()) lines.push(cur.trim().replace(/\s+/g, " "));
		cur = "";
		prevEnd = null;
		prevY = null;
	};
	for (const it of items) {
		if (typeof it.str !== "string") continue;
		const x = it.transform[4],
			y = it.transform[5];
		const h = Math.abs(it.transform[3]) || it.height || 10;
		if (prevY !== null && Math.abs(y - prevY) > h * 0.6) flush();
		const str = clean(it.str);
		if (str) {
			if (
				cur &&
				prevEnd !== null &&
				x - prevEnd > h * 0.15 &&
				!/\s$/.test(cur) &&
				!/^\s/.test(str)
			)
				cur += " ";
			cur += str;
			prevEnd = x + it.width;
			prevY = y;
		}
		if (it.hasEOL) flush();
	}
	flush();
	return lines;
}

/**
 * Finds the printed page identifier. Two styles are understood:
 *  "01 Nov 2025 EQUIPMENT/FURNISHINGS 25 Page 14 of 44"   (may come first or last in the extracted text)
 *  a header with "Page: 10-187" and "Section 10:" followed by the section name on the next line
 * Returns { label, lines } with those header/footer lines taken out of the text.
 */
export function extractLabel(lines) {
	// AIP style: "Civil Aviation Authority", the page id ("ENR 2.1-25"), "AIP South Africa", the body, then the effective date ("15 JAN 25") and "AMDT 1/25"
	const ai = lines
		.slice(0, 8)
		.findIndex((l) =>
			/^(GEN|ENR|AD)\s+[0-9][A-Za-z0-9.\-]*$|^AD\s+\d+-[A-Z0-9]{3,5}-\d+$/.test(
				l,
			),
		);
	if (ai >= 0) {
		const drop = new Set([ai]);
		lines.slice(0, 8).forEach((l, j) => {
			if (/^Civil Aviation Authority$|^AIP South Africa$|^AMDT\s/i.test(l))
				drop.add(j);
		});
		let date = "";
		for (let j = Math.max(0, lines.length - 3); j < lines.length; j++) {
			if (/^\d{1,2} [A-Z]{3} \d{2}$/.test(lines[j])) {
				date = lines[j];
				drop.add(j);
			} else if (/^AMDT\s/i.test(lines[j])) drop.add(j);
		}
		return {
			label: `Page ${lines[ai]}` + (date ? ` · Effective ${date}` : ""),
			lines: lines.filter((_, j) => !drop.has(j)),
		};
	}
	// Boeing manual style: header block, a "Boeing Proprietary" line, then "14.20.4 D6-27370-844-SFZ" (or the reverse, with the date first)
	const bi = lines
		.slice(0, 14)
		.findIndex((l) => /^Boeing Proprietary\./i.test(l));
	if (bi > 0) {
		let id = "",
			idAt = -1;
		for (let i = bi + 1; i < Math.min(lines.length, bi + 3); i++) {
			const a = /^([A-Za-z0-9./]+)\s+(?:D6-\d+-\S+|FCT 737 NG \(TM\))/.exec(
				lines[i],
			);
			const b =
				/(?:D6-\d+-\S+|FCT 737 NG \(TM\))\s+([A-Za-z0-9./]*\.[A-Za-z0-9./]*)\s*$/.exec(
					lines[i],
				);
			const m = a || b;
			if (m && /\d/.test(m[1])) {
				id = m[1];
				idAt = i;
				break;
			}
		}
		if (id) {
			const head = [];
			for (const l of lines.slice(0, bi)) {
				if (
					/Flight Crew (Operations|Training) Manual\s*$/i.test(l) &&
					l.length < 60
				)
					continue;
				if (/^(737-\d|FAA|EU-OPS|Category\b)|CFM56/.test(l)) break;
				head.push(
					l
						.replace(/\s+(Chapter|Section)\s+[A-Za-z0-9]+(?=\s*-?\s*$)/i, "")
						.trim(),
				);
			}
			const sec =
				head.length > 1 && /-\s*$/.test(head[0])
					? head[0] + " " + head.slice(1).join(" ")
					: head.join(" - "); // "Chapter -" then the section, which may wrap
			const drop = new Set(lines.slice(0, idAt + 1).map((_, j) => j));
			let rest = lines.filter((_, j) => !drop.has(j));
			if (
				rest.length &&
				/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(rest[rest.length - 1])
			)
				rest = rest.slice(0, -1); // the page's revision date
			return {
				label:
					`Page ${id}` +
					(sec ? ` · ${sec.replace(/\s+/g, " ").slice(0, 100)}` : ""),
				lines: rest,
			};
		}
	}
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].length < 100 && /Page\s+\d+\s+of\s+\d+/i.test(lines[i])) {
			const label = lines[i]
				.replace(/\b\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\b/g, "")
				.replace(/\s+/g, " ")
				.trim();
			return { label, lines: lines.filter((_, j) => j !== i) };
		}
	}
	const top = Math.min(lines.length, 10);
	let pg = "",
		sec = "";
	const drop = new Set();
	for (let i = 0; i < top; i++) {
		if (
			/^\s*(Issue:\s*\d+\s*\|\s*Amendment:\s*\d+|Effective Date:)/.test(
				lines[i],
			)
		)
			drop.add(i);
		const m =
			!pg && /\bPage:\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/.exec(lines[i]);
		if (m) {
			pg = m[1];
			drop.add(i);
		}
		const s =
			!sec &&
			/\b(Section|Annexure|Annex|Chapter|Part)\s+([A-Za-z0-9]+):\s*(.*)$/.exec(
				lines[i],
			);
		if (s) {
			let name = s[3].trim();
			drop.add(i);
			if (
				!name &&
				lines[i + 1] &&
				lines[i + 1].length < 70 &&
				!/OPERATIONS MANUAL/i.test(lines[i + 1])
			) {
				name = lines[i + 1].trim();
				drop.add(i + 1);
			}
			sec = `${s[1]} ${s[2]}` + (name ? `: ${name}` : "");
		}
	}
	if (!pg) return { label: "", lines };
	return {
		label: `Page ${pg}` + (sec ? ` · ${sec}` : ""),
		lines: lines.filter((_, j) => !drop.has(j)),
	};
}

/** Numbered headings on a page ("10.4.5.2 The Procedure for a Monitored Approach is as follows:"), shortened to 110 characters. */
export function findHeadings(lines) {
	const out = [];
	for (const l of lines) {
		if (l.length > 160 || /\s\d{1,3}$/.test(l)) continue; // long paragraphs, and table-of-contents lines that end in a page number
		const m = /^(\d{1,2}(?:\.\d{1,2}){1,5})\.?\s+([A-Z][A-Za-z]{2}.*)$/.exec(l);
		if (!m) continue;
		let t = l;
		if (t.length > 110) t = t.slice(0, 110).replace(/\s+\S*$/, "") + "…";
		out.push(t);
	}
	return out;
}

const SMALL = new Set(
	"of and the in for to on or with a an at by from vs".split(" "),
);
/** Plain-text sub-headings (no numbering), such as "Autobrake System" or "Rejected Takeoff (RTO)": a short title-case line after the end of a sentence. */
export function findSubheads(lines) {
	const out = [];
	for (let i = 0; i < lines.length - 1; i++) {
		const l = lines[i];
		if (
			l.length < 4 ||
			l.length > 60 ||
			!/^[A-Z]/.test(l) ||
			/[.,;:!?]$/.test(l) ||
			/^ZS-/.test(l)
		)
			continue;
		const words = l.split(/\s+/);
		if (words.length > 7) continue;
		if (
			!words.every(
				(w) =>
					SMALL.has(w) || /^[A-Z(\d]/.test(w) || /^[A-Z0-9/()&–-]+$/.test(w),
			)
		)
			continue;
		const prev = lines[i - 1];
		if (
			prev &&
			!/[.:]$/.test(prev) &&
			!(out.length && out[out.length - 1].at === i - 1)
		)
			continue; // a wrapped line, not a heading
		const next = lines[i + 1];
		if (!next || next.length < 20) continue;
		out.push({ at: i, t: l });
	}
	return out.map((o) => o.t);
}

/** Pages that only say they are blank. */
export const isBlank = (lines) =>
	lines.join(" ").length < 100 &&
	/left blank|intentionally blank|blank intentionally/i.test(lines.join(" "));

/** AIP headings such as "ENR 1.1 GENERAL RULES" (its numbered paragraphs, "3.2 ...", are not headings). */
export function findAipHeadings(lines) {
	const out = [];
	for (const l of lines) {
		if (l.length > 160 || /\s\d{1,3}$/.test(l)) continue;
		if (!/^(GEN|ENR|AD)\s+\d+(?:\.\d+)*\s+[A-Z]/.test(l)) continue;
		out.push(l.length > 110 ? l.slice(0, 110).replace(/\s+\S*$/, "") + "…" : l);
	}
	return out;
}

/** Contents pages are full of dotted leader lines and only repeat the headings. */
export const isContents = (lines) => {
	const dotted = lines.filter((l) => /(?:\.\s?){6,}/.test(l)).length;
	if (dotted >= 8 || (dotted >= 4 && dotted * 2 >= lines.length)) return true;
	// numbered contents lines that end in a page reference, e.g. "2.3 AUTHORITY AND DUTIES 27" or "0.1 TITLE PAGE 0-3"
	const numbered = lines.filter(
		(l) =>
			/^[0-9A-Z]{1,4}(\.\d+)*\.?\s+\S/.test(l) &&
			/\s\d{1,3}(-\d{1,3})?$/.test(l),
	).length;
	return numbered >= 10 && numbered * 10 >= lines.length * 6;
};

/** Remove headers/footers that repeat on many pages (mutates pages[i].lines). Returns how many distinct lines were removed. */
export function stripBoilerplate(pages) {
	if (pages.length < 20) return 0;
	const key = (l) => l.replace(/\d+/g, "#").toLowerCase();
	const count = new Map();
	for (const pg of pages)
		for (const k of new Set(pg.lines.map(key)))
			count.set(k, (count.get(k) || 0) + 1);
	const limit = Math.max(20, pages.length * 0.25);
	const drop = new Set(
		[...count].filter(([, n]) => n >= limit).map(([k]) => k),
	);
	for (const pg of pages)
		pg.lines = pg.lines.filter((l) => l.length > 100 || !drop.has(key(l)));
	return drop.size;
}

/** Split one page into one or more chunks of text. */
export function chunkPage(lines, maxWords = 180, overlap = 40) {
	const text = lines.join("\n");
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length < 6) return [];
	if (words.length <= maxWords + 40) return [text];
	const title = (lines[0] || "").slice(0, 100);
	const out = [];
	const step = maxWords - overlap;
	for (let s = 0; s < words.length; s += step) {
		const part = words.slice(s, s + maxWords).join(" ");
		out.push(s === 0 ? part : title + " … " + part);
		if (s + maxWords >= words.length) break;
	}
	return out;
}

/** Search words from a question: lowercase, no stop words. */
export function queryTerms(q) {
	const seen = new Set();
	for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9\-\/]*/g) || []) {
		if (STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
		seen.add(w);
	}
	return [...seen];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// A term typed with a hyphen or slash ("take-off") also matches "takeoff" and "take off".
export const termRegex = (t) =>
	new RegExp(
		"(^|[^a-z0-9])" +
			t.split(/[-\/]/).filter(Boolean).map(esc).join("[^a-z0-9]*"),
		"i",
	);

/** Lowercase, letters and digits only, single spaces. */
export const norm = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** Regex source for a word or phrase: words may be separated by any punctuation/space; the last word may continue (plurals), unless it is very short. */
export function wordRe(phrase) {
	const words = norm(phrase).split(" ").filter(Boolean);
	return words
		.map(
			(w, i) => w + (i === words.length - 1 && w.length > 3 ? "[a-z0-9]*" : ""),
		)
		.join("[^a-z0-9]+");
}
export const memberRegex = (phrase) =>
	new RegExp("(^|[^a-z0-9])" + wordRe(phrase), "i");

/**
 * Turns a question into a search plan:
 *  concepts: each must be found in a passage for a full keyword score (a concept can have several alternative spellings/abbreviations)
 *  phrases:  adjacent word pairs from the question, found next to each other in a passage
 *  hl:       words to highlight; embedText: the question with glossary alternatives added for the meaning-based search
 */
export function buildPlan(q, groups = []) {
	const terms = queryTerms(q);
	const nq = " " + norm(q) + " ";
	let concepts = terms.map((t) => ({ label: t, regs: [termRegex(stem(t))] }));
	const extras = [];
	const hl = new Set();
	for (const t of terms) {
		if (/[-\/]/.test(t)) {
			const n = norm(t);
			if (n.replace(/ /g, "").length >= 4) {
				hl.add(n);
				hl.add(n.replace(/ /g, ""));
			}
			continue;
		}
		if (t.length >= 3) hl.add(stem(t));
	}
	for (const g of groups) {
		const hits = g.filter((m) => m && nq.includes(" " + norm(m) + " "));
		if (!hits.length) continue;
		const hitWords = new Set(hits.flatMap((m) => norm(m).split(" ")));
		concepts = concepts.filter(
			(c) =>
				!norm(c.label)
					.split(" ")
					.every((w) => hitWords.has(w)),
		);
		concepts.push({ label: hits[0], regs: g.map(memberRegex) });
		let added = 0;
		for (const m of g) {
			const n = norm(m);
			if (!n) continue;
			if (!hits.includes(m) && extras.length < 10 && added < 4) {
				extras.push(m);
				added++;
			}
			const ws = n.split(" ");
			if (ws.length === 1 && n.length >= 2) hl.add(n);
			else {
				hl.add(n);
				if (ws.length === 2) hl.add(ws.join(""));
			}
		}
	}
	const phrases = [];
	for (let i = 0; i + 1 < terms.length; i++) {
		const a = norm(stem(terms[i])).replace(/ /g, "[^a-z0-9]*"),
			b = norm(stem(terms[i + 1]))
				.split(" ")
				.map(
					(w, k, arr) =>
						w + (k === arr.length - 1 && w.length > 3 ? "[a-z0-9]*" : ""),
				)
				.join("[^a-z0-9]*");
		if (a && b)
			phrases.push(
				new RegExp("(^|[^a-z0-9])" + a + "[a-z0-9]*[^a-z0-9]+" + b, "i"),
			);
	}
	return {
		terms,
		concepts,
		phrases,
		hl: [...hl],
		embedText: extras.length ? `${q}. Also called: ${extras.join(", ")}` : q,
	};
}

/** A short snippet around the first matching word, with matches wrapped in <mark>. */
export function snippet(text, words, length = 340) {
	const flat = clean(text).replace(/\s+/g, " ");
	const html = (x) =>
		x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	if (!words.length)
		return html(flat.slice(0, length)) + (flat.length > length ? " …" : "");
	const re = new RegExp(
		"(?<![a-z0-9])(" +
			[...words]
				.sort((a, b) => b.length - a.length)
				.map(wordRe)
				.join("|") +
			")",
		"gi",
	);
	const first = flat.search(re);
	const start = Math.max(0, first < 0 ? 0 : first - 90);
	const part = flat.slice(start, start + length);
	return (
		(start > 0 ? "… " : "") +
		html(part).replace(re, "<mark>$1</mark>") +
		(start + length < flat.length ? " …" : "")
	);
}
