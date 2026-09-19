// Minimal RequestEvent stand-in for calling +server.ts handlers directly in tests, without
// spinning up a dev server. Callers cast the result to the handler's own parameter type
// (`Parameters<typeof POST>[0]`); this file only needs to be structurally close enough for
// the handful of RequestEvent members our routes actually read.
import { isHttpError, isRedirect, type Cookies } from "@sveltejs/kit";

export const createFakeCookies = (initial: Record<string, string> = {}): Cookies => {
	const store = new Map<string, string>(Object.entries(initial));
	return {
		get: (name: string) => store.get(name),
		getAll: () => Array.from(store, ([name, value]) => ({ name, value })),
		set: (name: string, value: string) => {
			store.set(name, value);
		},
		delete: (name: string) => {
			store.delete(name);
		},
		serialize: (name: string, value: string) => `${name}=${value}`,
	} as Cookies;
};

export type FakeEventOptions = {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	jsonBody?: unknown;
	platform?: unknown;
	locals?: unknown;
	params?: Record<string, string>;
	cookies?: Cookies;
};

export const createFakeEvent = (options: FakeEventOptions): Record<string, unknown> => {
	const headers = new Headers(options.headers ?? {});
	const hasBody = options.jsonBody !== undefined;
	if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");

	const request = new Request(options.url, {
		method: options.method ?? "GET",
		headers,
		body: hasBody ? JSON.stringify(options.jsonBody) : undefined,
	});

	return {
		request,
		url: new URL(options.url),
		params: options.params ?? {},
		platform: options.platform,
		locals: options.locals ?? {},
		cookies: options.cookies ?? createFakeCookies(),
		route: { id: null },
		fetch,
		getClientAddress: () => "127.0.0.1",
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
	};
};

// `error()`/`redirect()` from '@sveltejs/kit' throw; SvelteKit's own request pipeline is what
// turns those into Responses. Calling a +server.ts export directly (bypassing that pipeline,
// as these tests do) needs the same conversion done here instead.
export const invokeHandler = async (
	handler: (event: never) => Response | Promise<Response>,
	event: unknown,
): Promise<Response> => {
	try {
		return await (handler as (event: unknown) => Response | Promise<Response>)(event);
	} catch (err) {
		if (isHttpError(err)) return Response.json(err.body, { status: err.status });
		if (isRedirect(err)) return new Response(null, { status: err.status, headers: { location: err.location } });
		throw err;
	}
};
