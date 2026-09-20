// B06: every JSON endpoint used to call `request.json()` directly, which buffers and parses the
// whole body before any application-level size check ran (the 2,048-character token cap in
// auth/verify, for example, bounds a *field*, not the request). A client can still send an
// arbitrarily large body (within whatever the platform itself allows) containing a small valid
// payload plus one huge unused field, or just repeated oversized garbage, and pay for the
// parse/allocation before rejection.
//
// This reads the body as a stream and aborts as soon as the byte total exceeds `maxBytes`,
// independent of (and not trusting) any Content-Length header -- a client can lie about that, or
// omit it and stream forever. JSON.parse only ever runs over a buffer we already know is small.
export const MAX_JSON_BODY_BYTES = 8 * 1024;

export type ReadJsonBodyResult = { ok: true; body: unknown } | { ok: false; reason: "too_large" | "invalid_json" };

export const readJsonBody = async (request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<ReadJsonBodyResult> => {
	const reader = request.body?.getReader();
	if (!reader) return { ok: false, reason: "invalid_json" };

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("body exceeds maximum size").catch(() => {});
			return { ok: false, reason: "too_large" };
		}
		chunks.push(value);
	}

	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		const text = new TextDecoder().decode(buffer);
		return { ok: true, body: text.length === 0 ? undefined : JSON.parse(text) };
	} catch {
		return { ok: false, reason: "invalid_json" };
	}
};
