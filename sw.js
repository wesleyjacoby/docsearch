// Offline support. App files: network first, cache as fallback. Library files from the CDN: cache first.
// (The search model files are cached separately by the model library itself.)
const CACHE = "docsearch-v8";
const SHELL = [
	"./",
	"index.html",
	"styles.css",
	"app.js",
	"lib.js",
	"worker.js",
	"glossary.json",
	"abbreviations.json",
	"exclude.json",
	"manifest.json",
	"icon-180.png",
	"icon-192.png",
];

self.addEventListener("install", (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});
self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((ks) =>
				Promise.all(
					ks
						.filter((k) => k !== CACHE && k.startsWith("docsearch-"))
						.map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});
self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin === location.origin) {
		e.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE).then((c) => c.put(req, copy));
					return res;
				})
				.catch(() =>
					caches
						.match(req, { ignoreSearch: true })
						.then((r) => r || caches.match("index.html")),
				),
		);
	} else if (url.hostname === "cdn.jsdelivr.net") {
		e.respondWith(
			caches.match(req).then(
				(hit) =>
					hit ||
					fetch(req).then((res) => {
						if (res.ok) {
							const copy = res.clone();
							caches.open(CACHE).then((c) => c.put(req, copy));
						}
						return res;
					}),
			),
		);
	}
});
