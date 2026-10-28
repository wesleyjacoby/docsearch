// Runs the search model in the background so the page stays responsive while indexing.
const TF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
const MODEL = "Xenova/bge-small-en-v1.5";
let extractor = null;

async function load(threads) {
	const tf = await import(TF);
	tf.env.allowLocalModels = false;
	if (threads > 1 && self.crossOriginIsolated)
		tf.env.backends.onnx.wasm.numThreads = threads;
	extractor = await tf.pipeline("feature-extraction", MODEL, {
		dtype: "q8",
		device: "wasm",
		progress_callback: (p) => {
			if (p.status === "progress" && p.total > 1e6)
				postMessage({ type: "progress", progress: p.progress });
		},
	});
}

self.onmessage = async (e) => {
	const m = e.data;
	try {
		if (m.type === "init") {
			if (!extractor) await load(m.threads);
			postMessage({
				type: "ready",
				id: m.id,
				threaded: self.crossOriginIsolated && m.threads > 1,
			});
		} else if (m.type === "embed") {
			const out = await extractor(m.texts, { pooling: "cls", normalize: true });
			const data = out.data.slice();
			postMessage({ type: "result", id: m.id, data }, [data.buffer]);
		}
	} catch (err) {
		postMessage({
			type: "error",
			id: m.id,
			message: String((err && err.message) || err),
		});
	}
};
