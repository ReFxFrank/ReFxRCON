<script lang="ts">
	import { toast } from '$lib/toast.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let copied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(data.code);
			copied = true;
			toast('Join code copied.', 'ok');
		} catch {
			window.prompt('Copy the join code:', data.code);
		}
	}
</script>

<svelte:head><title>Join · {data.publicServer.name} · {data.appName}</title></svelte:head>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
	<div class="panel">
		<span class="label-sm">Join code</span>
		<div class="flex flex-wrap items-center gap-3">
			<code class="chip px-3 py-2 text-[16px] tracking-wide select-all">{data.code}</code>
			<button class="btn btn-primary" onclick={copy}>{copied ? 'Copied' : 'Copy the code'}</button>
		</div>
		<ol class="mt-4 list-decimal space-y-1.5 pl-5 text-[13.5px]">
			<li>
				Launch WARDOGS: <a href={data.launch} class="text-accent hover:underline"
					>open it through Steam</a
				>.
			</li>
			<li>Open the <b>server browser</b> from the main menu.</li>
			<li>Choose <b>Join by code</b> at the bottom and paste the code exactly.</li>
			<li>Pick a faction and squad up. The code stays the same across maps and restarts.</li>
		</ol>
		<p class="note">
			WARDOGS joins through its own browser only: it publishes no server address, so there is no
			connect-by-IP and no link that drops you straight in. Once a friend is on the server, Steam's
			"Join Game" on their name takes you to the same server, faction and squad if there is room.
		</p>
	</div>
	<div class="self-start panel">
		<span class="label-sm">{data.publicServer.name}</span>
		<p class="text-[13px] text-mist-400">
			Search the browser for the server by name if you would rather not paste the code.
		</p>
		<a href={data.launch} class="mt-3 btn">Launch WARDOGS</a>
	</div>
</div>
