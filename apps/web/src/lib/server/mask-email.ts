// B04: the confirmation page shows which account a magic link signs in to, without showing the
// full address (readable over someone's shoulder, in a screenshot, in a screen share) and without
// this helper itself ever needing to know or reveal whether an account exists for it -- that's a
// separate question the caller (auth/verify/preview) deliberately never answers either.
// "j•••@g•••.com": first character of the local part, first character of the domain name, TLD
// intact.
export const maskEmail = (email: string): string => {
	const atIndex = email.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === email.length - 1) return "•••@•••"; // never throw on odd input

	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex + 1);
	const maskedLocal = `${local[0]}•••`;

	const dotIndex = domain.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === domain.length - 1) return `${maskedLocal}@${domain[0]}•••`;

	const domainName = domain.slice(0, dotIndex);
	const tld = domain.slice(dotIndex + 1);
	return `${maskedLocal}@${domainName[0]}•••.${tld}`;
};
