// Applied to every response from hooks.server.ts. COOP + COEP cross-origin-isolate the page,
// which Stockfish needs for SharedArrayBuffer / multi-threaded WASM (see docs/build-plan.md,
// "Key architecture calls"). static/_headers sets the same COOP/COEP for static assets, which
// never run through hooks.
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	// 'wasm-unsafe-eval' allows WebAssembly.instantiate without allowing JS eval.
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	["Cross-Origin-Opener-Policy", "same-origin"],
	["Cross-Origin-Embedder-Policy", "require-corp"],
	["X-Content-Type-Options", "nosniff"],
	["Referrer-Policy", "strict-origin-when-cross-origin"],
	["Content-Security-Policy", CONTENT_SECURITY_POLICY],
];

export const applySecurityHeaders = (response: Response): Response => {
	for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
	return response;
};
