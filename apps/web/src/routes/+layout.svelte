<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<!-- data-theme lives here (not app.html, which this task doesn't own) so board framing and
     chessground overrides in board-themes.css / study-surfaces.css can target it. -->
<div data-theme="study" class="theme-root">
	{@render children()}
</div>

<style>
	.theme-root {
		display: contents;
	}
</style>
