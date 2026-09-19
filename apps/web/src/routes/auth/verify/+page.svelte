<script lang="ts">
	// F05: the token lives in the URL fragment (#token=...), which browsers never send to a
	// server -- so this GET never carries it, and neither does SvelteKit's auto-generated HEAD.
	// It's read here, client-side, then the fragment is stripped from the visible URL/history
	// immediately so it doesn't linger anywhere the user might copy/share it. Confirming is an
	// explicit, same-origin POST, protected by the browser's own Origin header (enforced in
	// hooks.server.ts) -- not a silent GET-triggered identity change.
	let token: string | null = $state(null);
	let status: 'idle' | 'checking' | 'submitting' | 'done' | 'error' | 'missing' = $state('checking');

	const readTokenFromFragment = (): string | null => {
		const hash = window.location.hash;
		if (!hash.startsWith('#')) return null;
		const params = new URLSearchParams(hash.slice(1));
		return params.get('token');
	};

	$effect(() => {
		token = readTokenFromFragment();
		status = token ? 'idle' : 'missing';
		// Clear the fragment from the address bar/history right away; we've already captured it.
		if (token) history.replaceState(null, '', window.location.pathname + window.location.search);
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
		<p>Click below to finish signing in on this browser.</p>
		<button onclick={confirm} disabled={status === 'submitting' || status === 'checking' || !token}>
			{status === 'submitting' ? 'Signing in…' : 'Confirm sign-in'}
		</button>
	{/if}
</main>
