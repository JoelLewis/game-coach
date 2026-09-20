<script lang="ts">
	// F05: the token lives in the URL fragment (#token=...), which browsers never send to a
	// server -- so this GET never carries it, and neither does SvelteKit's auto-generated HEAD.
	// It's read here, client-side, then the fragment is stripped from the visible URL/history
	// immediately so it doesn't linger anywhere the user might copy/share it. Confirming is an
	// explicit, same-origin POST, protected by the browser's own Origin header (enforced in
	// hooks.server.ts) -- not a silent GET-triggered identity change.
	//
	// B04: before offering that Confirm button, a non-consuming preview (POST
	// /auth/verify/preview) resolves and shows which account the link actually signs in to, and
	// warns if it differs from whoever this browser is currently signed in as. A generic
	// "Confirm sign-in" with no destination shown made an attacker's own magic link, sent to
	// someone else and described as an app sign-in, indistinguishable from a legitimate one.
	let token: string | null = $state(null);
	let status: 'idle' | 'checking' | 'previewing' | 'ready' | 'submitting' | 'done' | 'error' | 'missing' = $state('checking');
	let maskedEmail: string | null = $state(null);
	let differentAccount = $state(false);

	const readTokenFromFragment = (): string | null => {
		const hash = window.location.hash;
		if (!hash.startsWith('#')) return null;
		const params = new URLSearchParams(hash.slice(1));
		return params.get('token');
	};

	const preview = async (currentToken: string) => {
		status = 'previewing';
		try {
			const response = await fetch('/auth/verify/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: currentToken })
			});
			if (!response.ok) {
				status = 'error';
				return;
			}
			const body = (await response.json()) as { maskedEmail: string; differentAccount: boolean };
			maskedEmail = body.maskedEmail;
			differentAccount = body.differentAccount;
			status = 'ready';
		} catch {
			status = 'error';
		}
	};

	$effect(() => {
		token = readTokenFromFragment();
		if (!token) {
			status = 'missing';
			return;
		}
		// Clear the fragment from the address bar/history right away; we've already captured it.
		history.replaceState(null, '', window.location.pathname + window.location.search);
		void preview(token);
	});

	const confirm = async () => {
		if (!token) return;
		status = 'submitting';
		try {
			const response = await fetch('/auth/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token })
			});
			if (!response.ok) {
				status = 'error';
				return;
			}
			status = 'done';
			window.location.href = '/';
		} catch {
			status = 'error';
		}
	};
</script>

<main>
	{#if status === 'missing'}
		<h1>That link is incomplete</h1>
		<p>Request a new sign-in link from the app.</p>
	{:else if status === 'error'}
		<h1>That link has expired</h1>
		<p>Magic sign-in links work once and expire after 15 minutes. Request a new one from the app.</p>
	{:else}
		<h1>Confirm sign-in</h1>
		{#if status === 'ready' && maskedEmail}
			<p>This will sign you in as <strong>{maskedEmail}</strong>.</p>
			{#if differentAccount}
				<p role="alert">You're currently signed in as a different account. Confirming will switch you to this one.</p>
			{/if}
		{/if}
		<button onclick={confirm} disabled={status !== 'ready'}>
			{status === 'submitting' ? 'Signing in…' : 'Confirm sign-in'}
		</button>
	{/if}
</main>
