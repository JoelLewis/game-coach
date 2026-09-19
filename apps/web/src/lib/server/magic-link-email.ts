// Plain, short copy for the magic-link email. Kept separate from the route handler so the
// wording (and its one link) is easy to review on its own.
export type MagicLinkEmail = { subject: string; text: string; html: string };

const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// F05/F09: the token now travels in the URL fragment, not the query string. A fragment is never
// sent to the server (so it never reaches Workers logs, Referer headers, or link-scanning
// prefetchers) and is only visible to script running on the page the browser actually navigates
// to -- see src/routes/auth/verify/+page.svelte, which reads it client-side and POSTs it.
export const buildMagicLinkEmail = (verifyUrl: string): MagicLinkEmail => {
	const subject = "Your GameCoach sign-in link";
	const text = [
		"Here's your GameCoach sign-in link:",
		"",
		verifyUrl,
		"",
		"This link works once and expires in 15 minutes.",
		"If you didn't request this, you can ignore this email.",
	].join("\n");
	const safeUrl = escapeHtml(verifyUrl);
	const html = `<p>Here's your GameCoach sign-in link:</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>This link works once and expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`;
	return { subject, text, html };
};
