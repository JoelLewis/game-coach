// CSRF defence for JSON APIs. SvelteKit's built-in Origin check (`kit.csrf.checkOrigin`,
// default on) only covers form-style content types (`application/x-www-form-urlencoded`,
// `multipart/form-data`, `text/plain`) on state-changing requests; our auth and games
// endpoints take JSON, so we check it ourselves in hooks.server.ts before those requests
// reach a route handler.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isStateChangingRequest = (request: Request): boolean => STATE_CHANGING_METHODS.has(request.method);

const isJsonRequest = (request: Request): boolean => (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

// Missing Origin is treated the same as a mismatched one: browsers send Origin on every
// state-changing fetch (same-origin or not), so its absence means either a non-browser
// client we don't need to accommodate, or a spoofing attempt.
export const isAllowedJsonOrigin = (request: Request, appOrigin: string): boolean => {
	if (!isStateChangingRequest(request) || !isJsonRequest(request)) return true;
	return request.headers.get("origin") === appOrigin;
};
