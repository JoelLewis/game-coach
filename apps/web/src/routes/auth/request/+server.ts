// POST { email } -> always 202. Never reveals whether the email has an account: the same
// response is returned for a known email, an unknown email, and a rate-limited email.
import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { buildMagicLinkEmail } from "../../../lib/server/magic-link-email.ts";
import { createMagicLinkToken } from "../../../lib/server/players.ts";
import type { RequestHandler } from "./$types";

const RequestBodySchema = v.object({
	email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(320)),
});

const ACCEPTED_BODY = { accepted: true } as const;

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!platform) error(500, "platform unavailable");

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, "invalid JSON body");
	}

	const parsed = v.safeParse(RequestBodySchema, body);
	if (!parsed.success) error(400, "invalid email");
	const { email } = parsed.output;

	const now = Date.now();
	const result = await createMagicLinkToken(platform.env.DB, email, locals.playerId, now);

	if (result.ok) {
		const verifyUrl = `${platform.env.APP_ORIGIN}/auth/verify?token=${encodeURIComponent(result.token)}`;
		const { subject, text, html } = buildMagicLinkEmail(verifyUrl);
		// Never log the token or the verify URL: it's a bearer credential.
		await platform.env.EMAIL.send({ to: email, from: platform.env.EMAIL_FROM, subject, text, html });
	}

	// Same response whether the token was created, the email is unknown, or the request was
	// rate-limited: none of those must be distinguishable from the outside.
	return json(ACCEPTED_BODY, { status: 202 });
};
