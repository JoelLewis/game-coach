// CSRF defence. F04: the previous check only ran for requests whose Content-Type began with
// `application/json`, so a cross-site "simple request" (no Content-Type header, or one outside
// the CORS-preflight-triggering set) sailed through untouched -- SvelteKit's own CSRF guard only
// covers its recognized *form* content types, not a bare, content-type-less POST. Origin is now
// checked for every state-changing request regardless of Content-Type; JSON-only endpoints
// additionally check the media type themselves (see requireJsonContentType), since only the
// route handler knows whether it is one.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isStateChangingRequest = (request: Request): boolean => STATE_CHANGING_METHODS.has(request.method);

// Missing Origin is treated the same as a mismatched one: browsers send Origin on every
// state-changing fetch (same-origin or not), so its absence means either a non-browser client we
// don't need to accommodate, or a spoofing attempt. An explicit `Origin: null` (e.g. a sandboxed
// iframe or a redirected request) is likewise rejected -- it is never equal to `appOrigin`.
export const isSameOriginRequest = (request: Request, appOrigin: string): boolean => {
	if (!isStateChangingRequest(request)) return true;
	return request.headers.get("origin") === appOrigin;
};

export const isJsonContentType = (request: Request): boolean =>
	(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
