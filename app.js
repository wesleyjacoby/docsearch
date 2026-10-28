import {
	itemsToLines,
	extractLabel,
	findHeadings,
	findSubheads,
	findAipHeadings,
	isBlank,
	isContents,
	clean,
	stripBoilerplate,
	chunkPage,
	buildPlan,
	memberRegex,
	snippet,
	wordRe,
} from "./lib.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const TF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
const MODEL = "Xenova/bge-small-en-v1.5";
const QPREFIX = "Represent this sentence for searching relevant passages: ";
const DIM = 384;
const KEYWORD_WEIGHT = 0.3;
const PHRASE_WEIGHT = 0.25;
const ALL_BONUS = 0.08; // every search word present in the passage
const PER_DOC_SHOWN = 5;
const PER_DOC_MAX = 15;
const OVERALL_SHOWN = 15;
const OVERALL_MAX = 40;

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- storage (IndexedDB: PDFs as blobs, index as arrays) ----------
let dbPromise;
function openDb() {
	return (
		dbPromise ||
		(dbPromise = new Promise((res, rej) => {
			const r = indexedDB.open("docsearch", 1);
			r.onupgradeneeded = () => {
				r.result.createObjectStore("pdfs");
				r.result.createObjectStore("index");
			};
			r.onsuccess = () => res(r.result);
			r.onerror = () => rej(r.error);
		}))
	);
}
async function run(store, mode, fn) {
	const d = await openDb();
	return new Promise((res, rej) => {
		const t = d.transaction(store, mode);
		const req = fn(t.objectStore(store));
		t.oncomplete = () => res(req && req.result);
		t.onerror = t.onabort = () => rej(t.error);
	});
}
const dbGet = (s, k) => run(s, "readonly", (o) => o.get(k));
const dbPut = (s, k, v) => run(s, "readwrite", (o) => o.put(v, k));
const dbDel = (s, k) => run(s, "readwrite", (o) => o.delete(k));
const dbKeys = (s) => run(s, "readonly", (o) => o.getAllKeys());

// ---------- state ----------
const docs = new Map(); // name -> { name, size, pages, chunks, vecs, tl } (indexed documents)
const pdfInfo = new Map(); // name -> { size, added, pages }
let active = new Set(
	JSON.parse(localStorage.getItem("active") || "null") || [],
);
let busy = false;
let lastSearch = null;

// ---------- libraries, loaded on demand ----------
let pdfjs;
async function getPdfjs() {
	if (pdfjs) return pdfjs;
	pdfjs = await import(PDFJS + "pdf.min.mjs");
	const src = await (await fetch(PDFJS + "pdf.worker.min.mjs")).text();
	pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
		new Blob([src], { type: "text/javascript" }),
	);
	return pdfjs;
}

// The search model runs in worker.js so the page stays responsive.
let worker = null,
	ready = null,
	nextId = 1;
const pending = new Map();
const THREADS =
	parseInt(new URLSearchParams(location.search).get("threads"), 10) || 1; // PC only: serve.py + ?threads=4

function call(msg) {
	return new Promise((res, rej) => {
		const id = nextId++;
		pending.set(id, { res, rej });
		worker.postMessage({ ...msg, id });
	});
}
function getWorker() {
	if (ready) return ready;
	setStatus("Loading the search model (first time only, about 35 MB)…");
	worker = new Worker("worker.js", { type: "module" });
	worker.onmessage = (e) => {
		const m = e.data;
		if (m.type === "progress") {
			setStatus(`Downloading search model… ${Math.round(m.progress)}%`);
			return;
		}
		const p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		if (m.type === "error") p.rej(new Error(m.message));
		else p.res(m);
	};
	worker.onerror = (e) => {
		const err = new Error(e.message || "the search worker failed to start");
		for (const p of pending.values()) p.rej(err);
		pending.clear();
		ready = null;
	};
	ready = call({ type: "init", threads: THREADS }).then((m) => {
		if (THREADS > 1)
			console.log(
				m.threaded
					? `search model running with ${THREADS} threads`
					: "?threads ignored: page is not cross-origin isolated (use serve.py)",
			);
		return worker;
	});
	ready.catch(() => {
		ready = null;
	});
	return ready;
}
async function embed(texts) {
	await getWorker();
	return (await call({ type: "embed", texts })).data; // Float32Array, texts.length * DIM
}

// ---------- status ----------
function setStatus(text, fraction) {
	$("status").textContent = text || "";
	const bar = $("bar");
	if (fraction == null) bar.hidden = true;
	else {
		bar.hidden = false;
		bar.value = fraction;
	}
}

// ---------- indexing ----------
async function readPages(name, rec) {
	const lib = await getPdfjs();
	const pdf = await lib.getDocument({ data: await rec.blob.arrayBuffer() })
		.promise;
	const pages = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const tc = await page.getTextContent();
		const r = extractLabel(itemsToLines(tc.items));
		pages.push({ p: i, lines: r.lines, label: r.label });
		page.cleanup();
		if (i % 25 === 0) {
			setStatus(
				`${name}: reading page ${i} of ${pdf.numPages}`,
				i / pdf.numPages,
			);
			await tick();
		}
	}
	await pdf.destroy();
	stripBoilerplate(pages);
	return pages;
}

// Per page: printed page label (l), headings on the page (h), and the heading in force when the page starts (c, carried over from earlier pages).
function makeMeta(pages) {
	let cur = "";
	const aip = pages.some((pg) => /^Page (GEN|ENR|AD)\s/.test(pg.label)); // the AIP numbers its paragraphs like headings, so only its own headings count
	return pages.map((pg) => {
		let h = aip ? findAipHeadings(pg.lines) : findHeadings(pg.lines);
		if (!h.length && !aip) h = [...new Set(findSubheads(pg.lines))];
		const o = { l: pg.label, c: cur, h };
		if (o.h.length) cur = o.h[o.h.length - 1];
		return o;
	});
}

// Adds labels and headings to an index that was built without them. Cheap: reads the PDF text, no search model needed.
async function addMeta(name) {
	const rec = await dbGet("pdfs", name),
		idx = await dbGet("index", name);
	if (!rec || !idx || idx.meta || idx.pdfSize !== rec.size) return;
	const meta = makeMeta(await readPages(name, rec));
	await dbPut("index", name, { ...idx, meta });
	const d = docs.get(name);
	if (d) d.meta = meta;
}

async function backfillMeta() {
	if (busy) return;
	busy = true;
	try {
		for (const name of [...docs.keys()]) {
			if (docs.get(name).meta || !pdfInfo.get(name)?.size) continue;
			try {
				await addMeta(name);
			} catch (e) {
				console.error(e);
			}
		}
	} finally {
		busy = false;
		setStatus("");
	}
}

// exclude.json: { "FCOM": ["PI.", "PD."] } leaves pages whose printed page number starts with those letters out of the search.
let excludeCfg = null;
async function excludedPrefixes(name) {
	if (!excludeCfg) {
		try {
			excludeCfg = await (
				await fetch("exclude.json", { cache: "no-store" })
			).json();
		} catch {
			excludeCfg = {};
		}
	}
	return Object.entries(excludeCfg)
		.filter(([k]) => name.toLowerCase().includes(k.toLowerCase()))
		.flatMap(([, v]) => v);
}

async function indexDoc(name) {
	const rec = await dbGet("pdfs", name);
	if (!rec) throw new Error("the PDF has not been added to this app yet");
	const pages = await readPages(name, rec);
	const meta = makeMeta(pages);
	const chunks = [];
	const skipPrefixes = await excludedPrefixes(name);
	let skipped = 0;
	for (const pg of pages) {
		// contents pages and any chapters listed in exclude.json are left out of the search (they stay readable in the viewer)
		if (
			isBlank(pg.lines) ||
			isContents(pg.lines) ||
			skipPrefixes.some((x) => pg.label.startsWith("Page " + x))
		) {
			skipped++;
			continue;
		}
		for (const t of chunkPage(pg.lines))
			chunks.push({ p: pg.p, l: pg.label, t });
	}
	if (!chunks.length)
		throw new Error("No readable text found. Is this a scanned PDF?");

	const order = chunks
		.map((_, i) => i)
		.sort((a, b) => chunks[a].t.length - chunks[b].t.length);
	const vecs = new Float32Array(chunks.length * DIM);
	const B = 8,
		t0 = performance.now();
	await getWorker();
	for (let s = 0; s < order.length; s += B) {
		const idx = order.slice(s, s + B);
		const out = await embed(idx.map((i) => chunks[i].t));
		idx.forEach((ci, k) =>
			vecs.set(out.subarray(k * DIM, (k + 1) * DIM), ci * DIM),
		);
		const done = Math.min(s + B, order.length);
		if ((s / B) % 4 === 0 || done === order.length) {
			const per = (performance.now() - t0) / done;
			const left = Math.round((per * (order.length - done)) / 60000);
			setStatus(
				`${name}: indexing ${done} of ${order.length} passages (about ${left} min left)`,
				done / order.length,
			);
			await tick();
		}
	}
	await dbPut("index", name, {
		chunks,
		vecs: vecs.buffer,
		built: Date.now(),
		model: MODEL,
		pdfSize: rec.size,
		pages: pages.length,
		meta,
		skipped,
	});
	pdfInfo.get(name).pages = pages.length;
	await dbPut("pdfs", name, { ...rec, pages: pages.length });
	await loadIndex(name);
	active.add(name);
	saveActive();
}

async function loadIndex(name) {
	const rec = await dbGet("index", name);
	if (!rec) return;
	const info = pdfInfo.get(name) || {};
	docs.set(name, {
		name,
		size: info.size,
		pages: info.pages,
		chunks: rec.chunks,
		vecs: new Float32Array(rec.vecs),
		tl: rec.chunks.map((c) => c.t.toLowerCase()),
		pdfSize: rec.pdfSize,
		built: rec.built,
		meta: rec.meta || null,
		skipped: rec.skipped || 0,
	});
}

async function loadAll() {
	pdfInfo.clear();
	docs.clear();
	for (const name of await dbKeys("pdfs")) {
		const rec = await dbGet("pdfs", name);
		pdfInfo.set(name, { size: rec.size, added: rec.added, pages: rec.pages });
	}
	// an index can exist without its PDF (after importing an index file); keep those listed too
	for (const name of await dbKeys("index"))
		if (!pdfInfo.has(name))
			pdfInfo.set(name, { size: 0, added: 0, pages: 0, noPdf: true });
	for (const name of pdfInfo.keys()) await loadIndex(name);
	if (localStorage.getItem("active") === null) active = new Set(docs.keys());
	for (const name of [...active]) if (!docs.has(name)) active.delete(name);
	saveActive();
	renderChips();
	renderDocList();
	backfillMeta();
}
function saveActive() {
	localStorage.setItem("active", JSON.stringify([...active]));
}

// ---------- importing ----------
async function importFiles(files) {
	if (busy) return;
	busy = true;
	let lock;
	try {
		lock = await navigator.wakeLock?.request("screen");
	} catch {}
	const kept = new Set();
	try {
		for (const file of files) {
			if (!/\.pdf$/i.test(file.name)) continue;
			setStatus(`Saving ${file.name}…`);
			// An index that was imported for this exact file (same size) is kept, so there is no need to index again.
			const old = await dbGet("index", file.name);
			const keep = !!old && old.pdfSize === file.size;
			if (keep) kept.add(file.name);
			else {
				await dbDel("index", file.name);
				docs.delete(file.name);
			}
			await dbPut("pdfs", file.name, {
				blob: file,
				size: file.size,
				added: Date.now(),
				pages: keep ? old.pages || 0 : 0,
			});
			pdfInfo.set(file.name, {
				size: file.size,
				added: Date.now(),
				pages: keep ? old.pages || 0 : 0,
			});
		}
		for (const file of files) {
			if (!/\.pdf$/i.test(file.name) || kept.has(file.name)) continue;
			try {
				await indexDoc(file.name);
			} catch (e) {
				console.error(e);
				setStatus(`Could not index ${file.name}: ${e.message}`);
				await new Promise((r) => setTimeout(r, 2500));
			}
			renderChips();
			renderDocList();
		}
		if (kept.size) await loadAll();
		setStatus("Done. Documents are saved on this device and work offline.");
		navigator.storage?.persist?.();
	} finally {
		busy = false;
		try {
			await lock?.release();
		} catch {}
		renderChips();
		renderDocList();
		setTimeout(() => setStatus(""), 4000);
	}
}

// In-app confirmation (the browser's own confirm() pop-up looks foreign and is blocked in some home-screen apps).
function askConfirm(title, text, okLabel) {
	return new Promise((resolve) => {
		const dlg = $("confirm");
		$("confirmtitle").textContent = title;
		$("confirmtext").textContent = text;
		$("confirmok").textContent = okLabel;
		const done = (v) => {
			dlg.close();
			resolve(v);
		};
		$("confirmok").onclick = () => done(true);
		$("confirmcancel").onclick = () => done(false);
		dlg.oncancel = () => resolve(false);
		dlg.showModal();
	});
}

async function removeDoc(name) {
	if (
		!(await askConfirm(
			`Delete ${name}?`,
			"It is removed from this app only. Your original file elsewhere is not touched.",
			"Delete",
		))
	)
		return;
	await dbDel("pdfs", name);
	await dbDel("index", name);
	docs.delete(name);
	pdfInfo.delete(name);
	active.delete(name);
	saveActive();
	renderChips();
	renderDocList();
	$("results").innerHTML = "";
}

async function reindex(name) {
	if (busy) return;
	busy = true;
	try {
		await indexDoc(name);
	} catch (e) {
		setStatus(`Could not index ${name}: ${e.message}`);
	}
	busy = false;
	renderChips();
	renderDocList();
	setTimeout(() => setStatus(""), 4000);
}

// ---------- moving the index between devices ----------
// File layout: 4 bytes (length of the JSON header), the JSON header, then each document's vectors (float32) in header order.
async function exportIndex() {
	if (!docs.size) {
		setStatus("Nothing to export yet.");
		return;
	}
	const header = { version: 1, model: MODEL, dim: DIM, docs: [] };
	const parts = [];
	for (const name of docs.keys()) {
		const rec = await dbGet("index", name);
		const info = pdfInfo.get(name) || {};
		header.docs.push({
			name,
			pdfSize: rec.pdfSize || info.size || 0,
			pages: rec.pages || info.pages || 0,
			built: rec.built,
			n: rec.chunks.length,
			chunks: rec.chunks,
			meta: rec.meta || null,
			skipped: rec.skipped || 0,
		});
		parts.push(rec.vecs);
	}
	const hb = new TextEncoder().encode(JSON.stringify(header));
	const len = new Uint8Array(4);
	new DataView(len.buffer).setUint32(0, hb.length, true);
	const blob = new Blob([len, hb, ...parts], {
		type: "application/octet-stream",
	});
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "docsearch-index.bin";
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 120000);
	setStatus(
		`Exported ${header.docs.length} document(s), ${(blob.size / 1e6).toFixed(0)} MB.`,
	);
	setTimeout(() => setStatus(""), 5000);
}

async function importIndex(file) {
	if (busy) return;
	busy = true;
	try {
		setStatus("Reading index file…");
		const buf = await file.arrayBuffer();
		const hl = new DataView(buf).getUint32(0, true);
		const header = JSON.parse(
			new TextDecoder().decode(new Uint8Array(buf, 4, hl)),
		);
		if (header.model !== MODEL || header.dim !== DIM)
			throw new Error("this index was built with a different search model");
		let off = 4 + hl;
		const warn = [];
		for (const d of header.docs) {
			const bytes = d.n * DIM * 4;
			if (off + bytes > buf.byteLength)
				throw new Error("the index file is incomplete");
			const vecs = buf.slice(off, off + bytes);
			off += bytes;
			await dbPut("index", d.name, {
				chunks: d.chunks,
				vecs,
				built: d.built,
				model: header.model,
				pdfSize: d.pdfSize,
				pages: d.pages,
				meta: d.meta || null,
				skipped: d.skipped || 0,
			});
			const rec = await dbGet("pdfs", d.name);
			if (!rec) warn.push(`${d.name}: add the PDF too`);
			else if (rec.size !== d.pdfSize)
				warn.push(`${d.name}: the PDF here is a different version`);
			active.add(d.name);
		}
		saveActive();
		await loadAll();
		setStatus(
			`Imported ${header.docs.length} document index(es).` +
				(warn.length ? " Check: " + warn.join("; ") : ""),
		);
		setTimeout(() => setStatus(""), warn.length ? 15000 : 5000);
	} catch (e) {
		console.error(e);
		setStatus("Could not import the index: " + e.message);
	} finally {
		busy = false;
		renderChips();
		renderDocList();
	}
}

// ---------- search ----------
let glossary = [];
// glossary.json is written by hand; abbreviations.json was collected from the abbreviation lists in the manuals.
const loadGroups = (f) =>
	fetch(f)
		.then((r) => r.json())
		.then((g) => g.filter(Array.isArray))
		.catch(() => []);
const glossaryReady = Promise.all([
	loadGroups("glossary.json"),
	loadGroups("abbreviations.json"),
]).then(([a, b]) => {
	glossary = [...a, ...b];
});

async function doSearch() {
	const q = $("q").value.trim();
	if (!q || busy) return;
	if (!docs.size) {
		setStatus("Add your PDFs first (Documents button).");
		return;
	}
	setStatus("Searching…");
	await tick();
	await glossaryReady;
	const plan = buildPlan(q, glossary);
	const qv = (await embed([QPREFIX + plan.embedText])).slice(0, DIM);
	const { concepts, phrases } = plan;
	const groups = [];
	for (const d of docs.values()) {
		if (!active.has(d.name)) continue;
		const n = d.chunks.length;
		const bestByPage = new Map();
		for (let i = 0; i < n; i++) {
			let dot = 0;
			const o = i * DIM;
			for (let k = 0; k < DIM; k++) dot += d.vecs[o + k] * qv[k];
			let score = dot;
			const tl = d.tl[i];
			if (concepts.length) {
				let hit = 0;
				for (const c of concepts) {
					for (const r of c.regs)
						if (r.test(tl)) {
							hit++;
							break;
						}
				}
				score +=
					KEYWORD_WEIGHT * (hit / concepts.length) +
					(hit === concepts.length ? ALL_BONUS : 0);
			}
			if (phrases.length) {
				let hit = 0;
				for (const r of phrases) if (r.test(tl)) hit++;
				score += PHRASE_WEIGHT * (hit / phrases.length);
			}
			const p = d.chunks[i].p,
				prev = bestByPage.get(p);
			if (!prev || score > prev.score) bestByPage.set(p, { i, score });
		}
		const top = [...bestByPage.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, PER_DOC_MAX);
		for (const h of top) {
			h.doc = d;
			const tl = d.tl[h.i];
			h.matched = concepts.map((c) => c.regs.some((r) => r.test(tl)));
		}
		if (top.length) groups.push({ doc: d, hits: top });
	}
	groups.sort((a, b) => b.hits[0].score - a.hits[0].score);
	const overall = groups
		.flatMap((g) => g.hits)
		.sort((a, b) => b.score - a.score)
		.slice(0, OVERALL_MAX);
	lastSearch = {
		q,
		plan,
		groups,
		overall,
		open: new Set(),
		mode: lastSearch?.mode || "docs",
		seen: new Set(),
		moreOverall: false,
	};
	renderResults();
	setStatus("");
	window.scrollTo(0, 0);
}

const escHtml = (t) =>
	t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Where the passage sits in the manual: the heading closest above the first match, else the heading carried in from earlier pages.
function headingFor(doc, c, hlWords) {
	const m = doc.meta && doc.meta[c.p - 1];
	if (!m) return "";
	const flat = c.t.replace(/\s+/g, " ");
	const re = hlWords.length
		? new RegExp("(?<![a-z0-9])(" + hlWords.map(wordRe).join("|") + ")", "i")
		: null;
	const first = re ? flat.search(re) : -1;
	let best = m.c || "",
		bestPos = -1;
	for (const h of m.h || []) {
		const key = h.replace(/…$/, "").replace(/\s+/g, " ");
		const pos = flat.indexOf(key.slice(0, 40));
		if (pos < 0) continue;
		if (first < 0 ? bestPos < 0 : pos <= first) {
			best = h;
			bestPos = pos;
		}
	}
	return best;
}

// "Page 10-187 · Section 10: Operating Procedures" -> plate "10-187", section text. "EQUIPMENT 25 Page 14 of 44" -> plate "14".
function splitLabel(label) {
	const m = /Page:?\s+((?:GEN|ENR|AD)\s+\S+|\S+)(?:\s+of\s+\d+)?/i.exec(
		label || "",
	);
	if (!m) return { token: "", rest: label || "" };
	const rest = label.replace(m[0], "").replace(/^[\s·]+|[\s·]+$/g, "");
	return { token: m[1], rest };
}

function resultCard(hit, rank, showDoc) {
	const { plan, seen } = lastSearch;
	const doc = hit.doc,
		c = doc.chunks[hit.i];
	const m = doc.meta && doc.meta[c.p - 1];
	const { token, rest } = splitLabel((m && m.l) || c.l || "");
	const head = headingFor(doc, c, plan.hl);
	const firstLine = (
		c.t
			.split("\n")
			.find(
				(l) =>
					l.trim() &&
					!/^\s*(Effective Date:|Issue:|SFR \d+|QRH Insert\s*$)/i.test(l),
			) || ""
	)
		.replace(/\s+/g, " ")
		.trim();
	const rawTitle = clean(
		head || (/^Effective /.test(rest) ? "" : rest) || firstLine,
	)
		.replace(/\s+/g, " ")
		.trim();
	const title =
		rawTitle.length > 110 ? rawTitle.slice(0, 110).trim() + "…" : rawTitle;
	const key = doc.name + "#" + c.p;
	const card = document.createElement("button");
	card.className =
		"card" + (rank === 1 ? " first" : "") + (seen.has(key) ? " seen" : "");
	const missing = plan.concepts
		.filter((_, k) => !hit.matched[k])
		.map((cn) => cn.label);
	const total = hit.matched.length;
	const status = !total
		? ""
		: missing.length
			? `<span class="tag no">Not on this page: ${missing.map(escHtml).join(", ")}</span>`
			: `<span class="tag ok">All ${total} search words found</span>`;
	const docName = escHtml(doc.name.replace(/\.pdf$/i, ""));
	card.innerHTML =
		`<div class="plate"><b>${escHtml(token || String(c.p))}</b><small>${token ? "PDF p." + c.p : "PDF page"}</small></div>` +
		`<div class="body">` +
		`<div class="head"><div class="title">${escHtml(title)}</div><span class="rank">#${rank}</span></div>` +
		(showDoc || (rest && rest !== title) || seen.has(key)
			? `<div class="sec">${showDoc ? `<span class="doc">${docName}</span>` : ""}${rest && rest !== title ? `<span>${escHtml(rest)}</span>` : ""}${seen.has(key) ? `<span class="viewed">viewed</span>` : ""}</div>`
			: "") +
		`<div class="snip">${snippet(c.t, plan.hl, 420)}</div>` +
		(status ? `<div class="tags">${status}</div>` : "") +
		`</div>`;
	card.onclick = () => {
		seen.add(key);
		card.classList.add("seen");
		openViewer(doc.name, c.p, plan.hl);
	};
	return card;
}

function renderResults() {
	const ls = lastSearch;
	const out = $("results");
	out.innerHTML = "";
	if (!ls.groups.length) {
		out.innerHTML =
			'<div class="empty"><b>No documents selected</b>Tap at least one document above to search it.</div>';
		return;
	}
	const bar = document.createElement("div");
	bar.className = "resbar";
	const note = document.createElement("span");
	note.textContent =
		ls.mode === "docs"
			? "Grouped by document"
			: "Best matches across all documents";
	const tog = document.createElement("button");
	tog.textContent =
		ls.mode === "docs" ? "Show best overall" : "Group by document";
	tog.onclick = () => {
		ls.mode = ls.mode === "docs" ? "overall" : "docs";
		renderResults();
		window.scrollTo(0, 0);
	};
	bar.append(note, tog);
	out.appendChild(bar);

	if (ls.mode === "overall") {
		const shown = ls.moreOverall
			? ls.overall
			: ls.overall.slice(0, OVERALL_SHOWN);
		shown.forEach((hit, i) => out.appendChild(resultCard(hit, i + 1, true)));
		if (!ls.moreOverall && ls.overall.length > OVERALL_SHOWN) {
			const more = document.createElement("button");
			more.className = "more";
			more.textContent = `Show ${ls.overall.length - OVERALL_SHOWN} more`;
			more.onclick = () => {
				ls.moreOverall = true;
				renderResults();
			};
			out.appendChild(more);
		}
		return;
	}
	for (const g of ls.groups) {
		const sec = document.createElement("section");
		const shown = ls.open.has(g.doc.name)
			? g.hits
			: g.hits.slice(0, PER_DOC_SHOWN);
		const h = document.createElement("h2");
		h.textContent = g.doc.name.replace(/\.pdf$/i, "");
		sec.appendChild(h);
		shown.forEach((hit, i) => sec.appendChild(resultCard(hit, i + 1, false)));
		if (g.hits.length > PER_DOC_SHOWN && !ls.open.has(g.doc.name)) {
			const more = document.createElement("button");
			more.className = "more";
			more.textContent = `Show ${g.hits.length - PER_DOC_SHOWN} more from ${g.doc.name.replace(/\.pdf$/i, "")}`;
			more.onclick = () => {
				ls.open.add(g.doc.name);
				renderResults();
			};
			sec.appendChild(more);
		}
		out.appendChild(sec);
	}
}

// Order of the document pills, chosen by dragging (mouse: drag; touch: press and hold, then drag). Saved on this device.
let chipOrder = [];
try {
	chipOrder = JSON.parse(localStorage.getItem("chipOrder") || "[]");
} catch {}
const orderedNames = () => {
	const names = [...docs.keys()];
	return names.sort((x, y) => {
		const i = chipOrder.indexOf(x),
			j = chipOrder.indexOf(y);
		return (i < 0 ? 1e6 : i) - (j < 0 ? 1e6 : j);
	});
};
let justDragged = false;

let scopeOpen = false;

function renderChips() {
	const box = $("chips");
	box.innerHTML = "";
	const names = orderedNames();
	if (!names.length) return;
	const short = (n) => n.replace(/\.pdf$/i, "");
	const on = names.filter((n) => active.has(n));
	const summary = !on.length
		? "No documents selected"
		: on.length === names.length
			? `All ${names.length} documents`
			: on.length <= 3
				? on.map(short).join(", ")
				: `${on.length} of ${names.length} documents`;

	const row = document.createElement("div");
	row.className = "scope";
	const toggle = document.createElement("button");
	toggle.className = "scopebtn" + (scopeOpen ? " open" : "");
	toggle.setAttribute("aria-expanded", String(scopeOpen));
	toggle.innerHTML = `<span class="lbl">Searching</span><b></b><i aria-hidden="true"></i>`;
	toggle.querySelector("b").textContent = summary;
	toggle.onclick = () => {
		scopeOpen = !scopeOpen;
		renderChips();
	};
	row.appendChild(toggle);
	if (names.length > 1) {
		const all = document.createElement("button");
		all.className = "chip all";
		all.textContent = on.length === names.length ? "Clear" : "Select all";
		all.onclick = () => {
			active = on.length === names.length ? new Set() : new Set(names);
			saveActive();
			renderChips();
			if (lastSearch) doSearch();
		};
		row.appendChild(all);
	}
	box.appendChild(row);

	if (!scopeOpen) return;
	const grid = document.createElement("div");
	grid.className = "chipgrid";
	for (const name of names) {
		const b = document.createElement("button");
		b.className = "chip" + (active.has(name) ? " on" : "");
		b.dataset.name = name;
		b.title = "Tap to include or leave out. Drag to change the order.";
		b.textContent = short(name);
		b.onclick = () => {
			if (justDragged) return;
			active.has(name) ? active.delete(name) : active.add(name);
			saveActive();
			renderChips();
			if (lastSearch) doSearch();
		};
		grid.appendChild(b);
	}
	const hint = document.createElement("p");
	hint.className = "hint";
	hint.textContent =
		"Tap a document to include or leave it out. Drag one (touch: press and hold first) to change the order.";
	grid.appendChild(hint);
	box.appendChild(grid);
}

(function enableChipDrag() {
	const box = $("chips");
	let d = null;
	const begin = () => {
		d.active = true;
		d.chip.classList.add("dragging");
		box.classList.add("sorting");
		try {
			d.chip.setPointerCapture(d.id);
		} catch {}
	};
	const finish = () => {
		if (!d) return;
		clearTimeout(d.timer);
		if (d.active) {
			d.chip.classList.remove("dragging");
			box.classList.remove("sorting");
			chipOrder = [...box.querySelectorAll(".chip[data-name]")].map(
				(c) => c.dataset.name,
			);
			localStorage.setItem("chipOrder", JSON.stringify(chipOrder));
			justDragged = true;
			setTimeout(() => {
				justDragged = false;
			}, 80);
		}
		d = null;
	};
	box.addEventListener("pointerdown", (e) => {
		const chip = e.target.closest(".chip[data-name]");
		if (!chip || e.button > 0) return;
		d = {
			chip,
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			active: false,
			touch: e.pointerType !== "mouse",
		};
		if (d.touch) {
			const me = d;
			d.timer = setTimeout(() => {
				if (d === me) begin();
			}, 350);
		}
	});
	box.addEventListener("pointermove", (e) => {
		if (!d || e.pointerId !== d.id) return;
		if (!d.active) {
			const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
			if (!d.touch && dist > 6) begin();
			else if (d.touch && dist > 10) {
				clearTimeout(d.timer);
				d = null;
			} // the person is scrolling the row, not reordering
			return;
		}
		e.preventDefault();
		for (const c of box.querySelectorAll(".chip[data-name]")) {
			if (c === d.chip) continue;
			const r = c.getBoundingClientRect();
			if (
				e.clientX >= r.left &&
				e.clientX <= r.right &&
				e.clientY >= r.top &&
				e.clientY <= r.bottom
			) {
				const before =
					d.chip.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING; // c comes after the dragged chip
				if (before) c.after(d.chip);
				else c.before(d.chip);
				break;
			}
		}
	});
	box.addEventListener(
		"touchmove",
		(e) => {
			if (d && d.active) e.preventDefault();
		},
		{ passive: false },
	);
	box.addEventListener("pointerup", finish);
	box.addEventListener("pointercancel", finish);
})();

// ---------- documents dialog ----------
async function renderDocList() {
	const list = $("doclist");
	list.innerHTML = "";
	for (const [name, info] of pdfInfo) {
		const d = docs.get(name);
		const row = document.createElement("div");
		row.className = "row";
		const date = info.added ? new Date(info.added).toLocaleDateString() : "";
		let note = "";
		if (info.noPdf) note = " · PDF not added yet (add it to open pages)";
		else if (d && d.pdfSize && d.pdfSize !== info.size)
			note = " · PDF differs from the indexed version: re-index";
		const sizeText = info.size ? `${(info.size / 1e6).toFixed(1)} MB · ` : "";
		const when = info.added
			? `imported ${date}`
			: d && d.built
				? `indexed ${new Date(d.built).toLocaleDateString()}`
				: "";
		row.innerHTML = `<div><b></b><small>${sizeText}${info.pages || d?.pages || "?"} pages · ${d ? d.chunks.length + " passages" + (d.skipped ? ` (${d.skipped} contents and excluded pages left out)` : "") : "not indexed"} · ${when}${note}</small></div>`;
		row.querySelector("b").textContent = name;
		const re = document.createElement("button");
		re.textContent = "Re-index";
		re.onclick = () => reindex(name);
		const rm = document.createElement("button");
		rm.textContent = "Delete";
		rm.onclick = () => removeDoc(name);
		row.append(re, rm);
		list.appendChild(row);
	}
	if (!pdfInfo.size) list.textContent = "No documents yet.";
	try {
		const est = await navigator.storage?.estimate?.();
		const persisted = await navigator.storage?.persisted?.();
		if (est)
			$("storage").textContent =
				`Storage used: ${(est.usage / 1e6).toFixed(0)} MB of about ${(est.quota / 1e6).toFixed(0)} MB available. Persistent: ${persisted ? "yes" : "not guaranteed"}.`;
	} catch {}
}

// ---------- PDF viewer (continuous scroll, pages drawn only when near the screen) ----------
const v = {
	pdf: null,
	name: null,
	page: 1,
	zoom: 1,
	terms: [],
	regs: [],
	items: [],
	gen: 0,
	scale: 1,
	observer: null,
	queue: Promise.resolve(),
};
const MAX_PAGE_WIDTH = 1000; // CSS pixels at zoom 1, so wide screens don't show a giant page

async function openViewer(name, page, terms) {
	$("viewer").hidden = false;
	document.body.classList.add("noscroll");
	v.terms = terms;
	v.regs = terms.map(memberRegex);
	v.zoom = 1;
	$("vtitle").textContent = "Loading…";
	$("vscroll").innerHTML = "";
	try {
		if (v.name !== name || !v.pdf) {
			if (v.pdf) {
				try {
					await v.pdf.destroy();
				} catch {}
			}
			const rec = await dbGet("pdfs", name);
			if (!rec)
				throw new Error(
					"this PDF has not been added to the app yet (Documents > Add or replace PDFs)",
				);
			const lib = await getPdfjs();
			v.pdf = await lib.getDocument({ data: await rec.blob.arrayBuffer() })
				.promise;
			v.name = name;
		}
		await layoutPages(page);
	} catch (e) {
		$("vtitle").textContent = "Could not open: " + e.message;
	}
}

async function layoutPages(goto) {
	const gen = ++v.gen;
	const sc = $("vscroll");
	if (v.observer) v.observer.disconnect();
	sc.innerHTML = "";
	v.items = [];
	const first = await v.pdf.getPage(1);
	const b = first.getViewport({ scale: 1 });
	first.cleanup();
	const avail = Math.min(sc.clientWidth - 22, MAX_PAGE_WIDTH);
	sc.classList.toggle("zoomed", v.zoom > 1.001);
	v.scale = (avail / b.width) * v.zoom;
	const w = b.width * v.scale,
		h = b.height * v.scale;
	const frag = document.createDocumentFragment();
	for (let i = 1; i <= v.pdf.numPages; i++) {
		const wrap = document.createElement("div");
		wrap.className = "vpg";
		wrap.dataset.p = i;
		wrap.style.width = w + "px";
		wrap.style.height = h + "px";
		frag.appendChild(wrap);
		v.items[i] = { wrap, state: 0, want: false, label: "" };
	}
	const inner = document.createElement("div");
	inner.id = "vinner";
	inner.appendChild(frag);
	sc.appendChild(inner);
	scrollToPage(goto || 1);
	v.observer = new IntersectionObserver(
		(entries) => {
			for (const en of entries) {
				const i = +en.target.dataset.p,
					it = v.items[i];
				if (!it) continue;
				it.want = en.isIntersecting;
				if (en.isIntersecting)
					v.queue = v.queue.then(() => renderPage(i, gen)).catch(() => {});
				else releasePage(i);
			}
		},
		{ root: sc, rootMargin: "120% 0px" },
	);
	for (let i = 1; i <= v.pdf.numPages; i++) v.observer.observe(v.items[i].wrap);
	updateCurrent();
}

function scrollToPage(n) {
	n = Math.max(1, Math.min(v.pdf.numPages, n));
	const sc = $("vscroll");
	sc.scrollTop = v.items[n].wrap.offsetTop - 6;
	v.page = n;
	$("vpage").value = n;
}

async function renderPage(i, gen) {
	const it = v.items[i];
	if (gen !== v.gen || !it || !it.want || it.state) return;
	it.state = 1;
	try {
		const lib = await getPdfjs();
		const page = await v.pdf.getPage(i);
		const vp = page.getViewport({ scale: v.scale });
		// pages in a manual can differ in size; adjust, and keep the reading position steady if the page is above the view
		const sc = $("vscroll");
		const dh = vp.height - it.wrap.offsetHeight;
		if (Math.abs(dh) > 1) {
			if (it.wrap.offsetTop + it.wrap.offsetHeight <= sc.scrollTop)
				sc.scrollTop += dh;
			it.wrap.style.height = vp.height + "px";
		}
		it.wrap.style.width = vp.width + "px";
		let dpr = window.devicePixelRatio || 1;
		while (vp.width * vp.height * dpr * dpr > 14e6 && dpr > 1) dpr -= 0.5;
		const canvas = document.createElement("canvas");
		canvas.width = Math.floor(vp.width * dpr);
		canvas.height = Math.floor(vp.height * dpr);
		canvas.style.width = vp.width + "px";
		canvas.style.height = vp.height + "px";
		await page.render({
			canvasContext: canvas.getContext("2d"),
			viewport: vp,
			transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
		}).promise;
		const tc = await page.getTextContent();
		it.label = extractLabel(itemsToLines(tc.items)).label;
		const hl = document.createElement("div");
		hl.className = "hl";
		if (v.regs.length) {
			for (const t of tc.items) {
				const s = t.str || "";
				if (!s || !v.regs.some((r) => r.test(s))) continue;
				const m = lib.Util.transform(vp.transform, t.transform);
				const h = Math.hypot(m[2], m[3]);
				const d = document.createElement("div");
				d.style.cssText = `left:${m[4]}px;top:${m[5] - h * 0.95}px;width:${t.width * v.scale}px;height:${h * 1.15}px`;
				hl.appendChild(d);
			}
		}
		page.cleanup();
		if (gen !== v.gen || !it.want) {
			it.state = 0;
			return;
		} // scrolled away or re-laid out while drawing
		it.wrap.replaceChildren(canvas, hl);
		it.state = 2;
		if (i === v.page) updateCurrent();
	} catch (e) {
		console.warn("page", i, e);
		it.state = 0;
	}
}

function releasePage(i) {
	const it = v.items[i];
	if (!it || it.state !== 2) return;
	const c = it.wrap.querySelector("canvas");
	if (c) {
		c.width = 0;
		c.height = 0;
	}
	it.wrap.replaceChildren();
	it.state = 0;
}

function updateCurrent() {
	if (!v.items.length) return;
	const sc = $("vscroll");
	const mid = sc.scrollTop + sc.clientHeight * 0.4;
	let n = Math.max(
		1,
		Math.min(
			v.pdf.numPages,
			Math.round(mid / (v.items[1].wrap.offsetHeight + 8)) || 1,
		),
	);
	while (n > 1 && v.items[n].wrap.offsetTop > mid) n--;
	while (
		n < v.pdf.numPages &&
		v.items[n].wrap.offsetTop + v.items[n].wrap.offsetHeight < mid
	)
		n++;
	v.page = n;
	$("vpage").value = n;
	const label = v.items[n].label;
	$("vtitle").textContent =
		`${v.name.replace(/\.pdf$/i, "")} · PDF p.${n}/${v.pdf.numPages}` +
		(label ? ` · ${label}` : "");
}

let scrollTick = false;
$("vscroll").addEventListener(
	"scroll",
	() => {
		if (scrollTick) return;
		scrollTick = true;
		requestAnimationFrame(() => {
			scrollTick = false;
			if (!$("viewer").hidden) updateCurrent();
		});
	},
	{ passive: true },
);

function closeViewer() {
	$("viewer").hidden = true;
	document.body.classList.remove("noscroll");
}

// pinch to zoom: scale the pages live with a CSS transform, then redraw them sharp at the new zoom when the fingers lift
(() => {
	const sc = $("vscroll");
	let p = null;
	const dist = (t) =>
		Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
	const centre = (t) => {
		const r = sc.getBoundingClientRect();
		return [
			(t[0].clientX + t[1].clientX) / 2 - r.left,
			(t[0].clientY + t[1].clientY) / 2 - r.top,
		];
	};
	sc.addEventListener(
		"touchstart",
		(e) => {
			if (e.touches.length !== 2 || !v.pdf) return;
			const [cx, cy] = centre(e.touches);
			p = {
				d0: dist(e.touches),
				ratio: 1,
				cx,
				cy,
				fx: (cx + sc.scrollLeft) / sc.scrollWidth,
				fy: (cy + sc.scrollTop) / sc.scrollHeight,
			};
			const inner = $("vinner");
			if (inner)
				inner.style.transformOrigin = `${cx + sc.scrollLeft - inner.offsetLeft}px ${cy + sc.scrollTop - inner.offsetTop}px`;
		},
		{ passive: true },
	);
	sc.addEventListener(
		"touchmove",
		(e) => {
			if (!p || e.touches.length !== 2) return;
			e.preventDefault();
			p.ratio = Math.max(
				0.5 / v.zoom,
				Math.min(3 / v.zoom, dist(e.touches) / p.d0),
			);
			const inner = $("vinner");
			if (inner) inner.style.transform = `scale(${p.ratio})`;
		},
		{ passive: false },
	);
	const end = async (e) => {
		if (!p || e.touches.length >= 2) return;
		const g = p;
		p = null;
		const inner = $("vinner");
		if (inner) {
			inner.style.transform = "";
			inner.style.transformOrigin = "";
		}
		if (Math.abs(g.ratio - 1) < 0.03) return;
		await zoomTo(v.zoom * g.ratio, true);
		sc.scrollLeft = g.fx * sc.scrollWidth - g.cx;
		sc.scrollTop = g.fy * sc.scrollHeight - g.cy;
	};
	sc.addEventListener("touchend", end, { passive: true });
	sc.addEventListener("touchcancel", end, { passive: true });
})();

async function zoomTo(z) {
	v.zoom = Math.max(0.5, Math.min(3, z));
	const cur = v.page;
	await layoutPages(cur);
}

// ---------- wire up ----------
$("go").onclick = doSearch;
$("q").addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		$("q").blur();
		doSearch();
	}
});
$("docbtn").onclick = () => {
	renderDocList();
	$("docs").showModal();
};
$("closedocs").onclick = () => $("docs").close();
$("pick").onchange = (e) => {
	const files = [...e.target.files];
	e.target.value = "";
	$("docs").close();
	importFiles(files);
};
$("exportidx").onclick = exportIndex;
$("pickidx").onchange = (e) => {
	const f = e.target.files[0];
	e.target.value = "";
	$("docs").close();
	if (f) importIndex(f);
};
$("vclose").onclick = closeViewer;
$("vzoomin").onclick = () => zoomTo(v.zoom + 0.25);
$("vzoomout").onclick = () => zoomTo(v.zoom - 0.25);
$("vpage").onchange = () =>
	scrollToPage(parseInt($("vpage").value, 10) || v.page);
$("vhlbtn").onclick = () => {
	const off = $("vscroll").classList.toggle("nohl");
	$("vhlbtn").textContent = off ? "Highlight: off" : "Highlight: on";
	$("vhlbtn").setAttribute("aria-pressed", String(!off));
};

if ("serviceWorker" in navigator)
	navigator.serviceWorker.register("sw.js").catch(() => {});

loadAll()
	.then(() => {
		if (!docs.size)
			setStatus("Tap Documents to add your PDFs. This is a one-time import.");
	})
	.catch((e) => setStatus("Storage error: " + e.message));
