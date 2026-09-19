// Web Standard crypto helpers shared by the session cookie envelope and D1 hashing / id
// generation. No Node crypto: everything here runs identically in Workers and in Node's
// Web Crypto implementation (used by the vitest suite).

// String.fromCharCode has an implementation-defined argument limit; chunk to stay well under it.
const CHUNK_SIZE = 0x2000;

export const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const base64UrlToBytes = (value: string): Uint8Array => {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const pad = (4 - (base64.length % 4)) % 4;
	const binary = atob(base64 + "=".repeat(pad));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
};

export const bytesToHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (data: Uint8Array): Promise<string> => {
	// TS's lib.dom types `Uint8Array` as generic over its backing buffer and won't narrow
	// `Uint8Array<ArrayBufferLike>` to the `BufferSource` the Web Crypto API expects, even
	// though every array here is backed by a plain (non-shared) ArrayBuffer. Cast at the
	// boundary rather than loosen the public signature.
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return bytesToHex(new Uint8Array(digest));
};

export const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

// Player / account / event ids: not secrets, just unique keys.
export const newId = (): string => crypto.randomUUID();
