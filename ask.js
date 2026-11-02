// "Ask Claude": sends the question and the best-matching manual pages to the Claude API and shows a short, cited answer.
// Nothing is sent unless the button is tapped. The API key is kept in this browser only (localStorage).

export const MODELS = [
	{ id: "claude-sonnet-5-5", name: "Sonnet 5.5 (balanced)" },
	{ id: "claude-haiku-5-5", name: "Haiku 5.5 (fastest, cheapest)" },
	{ id: "claude-opus-5-5", name: "Opus 5.5 (most thorough, dearest)" },
];
const STORE = "docsearch-ai";
const DEFAULTS = { key: "", model: MODELS[0].id };

export function loadSettings() {
	try {
		return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || "{}") };
	} catch {
		return { ...DEFAULTS };
	}
}
export function saveSettings(s) {
	try {
		localStorage.setItem(STORE, JSON.stringify(s));
		return true;
	} catch {
		return false;
	}
}

const SYSTEM = `You answer questions for a Boeing 737 pilot using ONLY the numbered passages supplied from company and manufacturer manuals (OM, SOP, FAM, FCOM, FCTM, QRH, MEL, regulations and similar).

Rules:
1. Answer directly: one to four short sentences, or a short list when the question has several parts. Give the exact figures, limits and wording the passage uses.
2. Cite every statement with its passage tag, for example [S1] or [S2][S3]. Never cite a passage that does not say it.
3. If the passages do not contain the answer, say so plainly and suggest what to search for. Never fill gaps from general knowledge.
4. If passages disagree, show both with their sources. Precedence, as stated in the SOP: procedures and limitations in the FCOM, QRH, MEL and CDL take precedence over the SOP; policy and legislation in the OM take precedence over the SOP.
5. Watch for conditions and exceptions (day or night, weights, "unless", "either ... or") and state them, because a pilot may act on your answer.
6. No preamble, no disclaimers. The app already tells the pilot to check the page.`;

/** Join the chunks of one page back into text. Chunks after the first carry a "title … " prefix and overlap the previous chunk. */
export function pageText(chunks) {
	let out = "";
	chunks.forEach((c, k) => {
		let t = c;
		if (k > 0) {
			t = t.replace(/^[^\n]{0,100}? … /, "");
			const head = t.split(/\s+/).slice(0, 8).join(" ");
			const at = head ? out.lastIndexOf(head) : -1;
			out = at >= 0 ? out.slice(0, at) + t : out + "\n" + t;
		} else out = t;
	});
	return out;
}

export function buildPrompt(question, sources) {
	const parts = sources.map(
		(s, i) =>
			`[S${i + 1}] ${s.doc}${s.label ? " | " + s.label : ""} | PDF page ${s.page}\n${s.text.slice(0, 6000)}`,
	);
	return `Question: ${question}\n\nPassages:\n\n${parts.join("\n\n---\n\n")}`;
}

export async function askClaude({ key, model, question, sources, signal }) {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		signal,
		headers: {
			"content-type": "application/json",
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify({
			model,
			max_tokens: 800,
			system: SYSTEM,
			messages: [{ role: "user", content: buildPrompt(question, sources) }],
		}),
	});
	if (!res.ok) {
		let msg = "";
		try {
			msg = (await res.json()).error?.message || "";
		} catch {}
		if (res.status === 401)
			throw new Error(
				"The API key was not accepted. Check it in the Ask Claude settings.",
			);
		if (res.status === 429)
			throw new Error(
				"Too many requests just now. Wait a moment and try again.",
			);
		if (res.status === 400 && /credit|balance/i.test(msg))
			throw new Error(
				"The API account is out of credit. Add funds in the Claude Console.",
			);
		throw new Error(msg || `The request failed (${res.status}).`);
	}
	const data = await res.json();
	const text = (data.content || [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("Claude returned no text.");
	return text;
}
