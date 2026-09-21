<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { InviteView, OrgMemberView, StatusBoardView, WebhookView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ROLES = ['viewer', 'operator', 'admin'];

	type Dialog =
		| {
				kind: 'invite';
				label: string;
				orgRole: 'owner' | 'member';
				serverRole: string;
				expiresDays: string;
				maxUses: string;
		  }
		| { kind: 'created'; invite: InviteView }
		| { kind: 'grants'; member: OrgMemberView; grants: Record<string, string> }
		| {
				kind: 'webhook';
				id: string | null;
				label: string;
				url: string;
				events: Record<string, boolean>;
				allServers: boolean;
				servers: Record<string, boolean>;
		  }
		| {
				kind: 'board';
				id: string | null;
				serverId: string;
				url: string;
				intervalSeconds: number;
				topPlayers: number;
		  };
	let dialog = $state<Dialog | null>(null);
	let busy = $state(false);

	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);

	async function run(fn: () => Promise<void>, done: string, close = true) {
		busy = true;
		try {
			await fn();
			if (done) toast(done, 'ok');
			if (close) dialog = null;
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('Invite link copied.', 'ok');
		} catch {
			window.prompt('Copy the invite link:', text);
		}
	}

	const openInvite = () => {
		dialog = {
			kind: 'invite',
			label: '',
			orgRole: 'member',
			serverRole: 'viewer',
			expiresDays: '7',
			maxUses: ''
		};
	};
	function createInvite() {
		const d = dialog;
		if (!d || d.kind !== 'invite') return;
		void run(
			async () => {
				const res = await api<{ invite: InviteView }>('POST', `${orgPath}/invites`, {
					label: d.label,
					orgRole: d.orgRole,
					serverRole: d.serverRole || null,
					expiresDays: d.expiresDays ? Number(d.expiresDays) : null,
					maxUses: d.maxUses ? Number(d.maxUses) : null
				});
				dialog = { kind: 'created', invite: res.invite };
			},
			'',
			false
		);
	}
	async function revoke(inv: InviteView) {
		if (
			!(await confirmDialog(
				'Revoke this invite link? Anyone who already joined keeps their access.',
				{
					okLabel: 'Revoke',
					danger: true
				}
			))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/invites/${inv.id}`), 'Invite link revoked.');
	}

	function setRole(m: OrgMemberView, role: string) {
		void run(
			() => api('PATCH', `${orgPath}/members/${m.userId}`, { role }),
			`@${m.username} is now ${role}.`
		);
	}
	const openGrants = (m: OrgMemberView) => {
		const grants: Record<string, string> = {};
		for (const s of data.orgServers)
			grants[s.id] = m.grants.find((g) => g.serverId === s.id)?.role ?? '';
		dialog = { kind: 'grants', member: m, grants };
	};
	function saveGrants() {
		const d = dialog;
		if (!d || d.kind !== 'grants') return;
		const grants = Object.entries(d.grants)
			.filter(([, role]) => role)
			.map(([serverId, role]) => ({ serverId, role }));
		void run(
			() => api('PUT', `${orgPath}/members/${d.member.userId}/grants`, { grants }),
			'Access updated.'
		);
	}
	async function remove(m: OrgMemberView) {
		if (
			!(await confirmDialog(
				`Remove @${m.username} from ${data.org.name}? Their access to its servers is removed; their account stays.`,
				{ okLabel: 'Remove', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/members/${m.userId}`), 'Member removed.');
	}

	const STATUS_BADGE: Record<InviteView['status'], { tone: 'ok' | 'warn' | 'err'; text: string }> =
		{
			live: { tone: 'ok', text: 'live' },
			revoked: { tone: 'err', text: 'revoked' },
			expired: { tone: 'warn', text: 'expired' },
			used: { tone: 'warn', text: 'used up' }
		};
	const usesLabel = (inv: InviteView) =>
		inv.maxUses === null ? `${inv.uses}` : `${inv.uses} / ${inv.maxUses}`;

	// --- Discord webhooks ---
	const openWebhook = (w: WebhookView | null) => {
		const events: Record<string, boolean> = {};
		for (const e of data.webhookEvents)
			events[e.key] = w
				? w.events.includes(e.key)
				: e.key === 'bans' || e.key === 'commands' || e.key === 'triggers';
		const servers: Record<string, boolean> = {};
		for (const s of data.orgServers) servers[s.id] = !!w?.serverIds?.includes(s.id);
		dialog = {
			kind: 'webhook',
			id: w?.id ?? null,
			label: w?.label ?? '',
			url: '',
			events,
			allServers: !w?.serverIds,
			servers
		};
	};
	function saveWebhook() {
		const d = dialog;
		if (!d || d.kind !== 'webhook') return;
		const body: Record<string, unknown> = {
			label: d.label.trim(),
			events: Object.entries(d.events)
				.filter(([, on]) => on)
				.map(([k]) => k),
			serverIds: d.allServers
				? null
				: Object.entries(d.servers)
						.filter(([, on]) => on)
						.map(([k]) => k)
		};
		if (d.url.trim()) body.url = d.url.trim();
		void run(
			() =>
				d.id
					? api('PATCH', `${orgPath}/webhooks/${d.id}`, body)
					: api('POST', `${orgPath}/webhooks`, body),
			d.id ? 'Webhook updated.' : 'Webhook added.'
		);
	}
	function toggleWebhook(w: WebhookView) {
		void run(
			() => api('PATCH', `${orgPath}/webhooks/${w.id}`, { enabled: !w.enabled }),
			w.enabled ? 'Webhook paused.' : 'Webhook enabled.',
			false
		);
	}
	function testWebhook(w: WebhookView) {
		void run(() => api('POST', `${orgPath}/webhooks/${w.id}/test`), 'Test message sent.', false);
	}
	async function deleteWebhook(w: WebhookView) {
		if (
			!(await confirmDialog(`Remove the ${w.label} webhook?`, { okLabel: 'Remove', danger: true }))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/webhooks/${w.id}`), 'Webhook removed.', false);
	}
	const eventLabel = (key: string) =>
		data.webhookEvents.find((e) => e.key === key)?.label.split(' (')[0] ?? key;

	// --- Discord invite (public pages button) ---
	let discordInput = $state('');
	$effect(() => {
		discordInput = data.org.discordUrl;
	});
	function saveDiscord() {
		void run(
			() => api('PATCH', orgPath, { discordUrl: discordInput.trim() }),
			discordInput.trim() ? 'Discord invite saved.' : 'Discord invite removed.',
			false
		);
	}

	// --- Discord status boards ---
	const INTERVALS = [30, 60, 120, 300, 900].filter((s) => s >= data.boardMinInterval);
	const intervalLabel = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`);
	const openBoard = (b: StatusBoardView | null) => {
		dialog = {
			kind: 'board',
			id: b?.id ?? null,
			serverId: b?.serverId ?? data.orgServers[0]?.id ?? '',
			url: '',
			intervalSeconds: b?.intervalSeconds ?? (INTERVALS.includes(60) ? 60 : INTERVALS[0]),
			topPlayers: b?.topPlayers ?? 10
		};
	};
	function saveBoard() {
		const d = dialog;
		if (!d || d.kind !== 'board') return;
		const body: Record<string, unknown> = {
			serverId: d.serverId,
			intervalSeconds: d.intervalSeconds,
			topPlayers: d.topPlayers
		};
		if (d.url.trim()) body.url = d.url.trim();
		void run(
			async () => {
				if (d.id) await api('PATCH', `${orgPath}/boards/${d.id}`, body);
				else {
					const r = await api<{ board: StatusBoardView }>('POST', `${orgPath}/boards`, body);
					// Post the first card right away so the channel shows something.
					await api('POST', `${orgPath}/boards/${r.board.id}/refresh`).catch((err) =>
						toast(errorMessage(err), 'err', 8000)
					);
				}
			},
			d.id ? 'Status board updated.' : 'Status board added.'
		);
	}
	function toggleBoard(b: StatusBoardView) {
		void run(
			() => api('PATCH', `${orgPath}/boards/${b.id}`, { enabled: !b.enabled }),
			b.enabled ? 'Status board paused.' : 'Status board enabled.',
			false
		);
	}
	function refreshBoard(b: StatusBoardView) {
		void run(() => api('POST', `${orgPath}/boards/${b.id}/refresh`), 'Card updated.', false);
	}
	async function deleteBoard(b: StatusBoardView) {
		if (
			!(await confirmDialog(
				`Remove the status board for ${b.serverName}? The card is deleted from the channel.`,
				{ okLabel: 'Remove', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/boards/${b.id}`), 'Status board removed.', false);
	}

	// --- site owner controls ---
	// A number input binds a number, or null when blank (blank = the instance default).
	let limitInput = $state<number | null>(null);
	let suspendReason = $state('');
	$effect(() => {
		limitInput = data.org.customServerLimit;
	});
	function saveLimit() {
		void run(
			() => api('PATCH', orgPath, { serverLimit: limitInput }),
			'Server limit updated.',
			false
		);
	}
	const ALLOWANCES = [
		{
			key: 'allowStats',
			name: 'Match statistics',
			blurb: 'per-match rows: leaderboards, careers, Discord board tables'
		},
		{
			key: 'allowPublicStatus',
			name: 'Public status pages',
			blurb: 'a live page per server without sign-in'
		},
		{
			key: 'allowPublicStats',
			name: 'Public leaderboards and careers',
			blurb: 'public stats pages; needs match statistics'
		}
	] as const;
	function setAllowance(key: (typeof ALLOWANCES)[number]['key'], on: boolean) {
		void run(
			() => api('PATCH', orgPath, { [key]: on }),
			on ? 'Allowed.' : 'Not allowed any more.',
			false
		);
	}
	async function suspend() {
		if (
			!(await confirmDialog(
				`Suspend ${data.org.name}? Members lose access to its servers and its invite links stop working until you restore it.`,
				{ okLabel: 'Suspend', danger: true }
			))
		)
			return;
		await run(
			() => api('PATCH', orgPath, { suspended: true, reason: suspendReason.trim() }),
			'Organisation suspended.',
			false
		);
	}
	function restore() {
		void run(() => api('PATCH', orgPath, { suspended: false }), 'Organisation restored.', false);
	}
</script>

<div class="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
	<div class="space-y-4">
		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!">Invite links</span>
				<button class="ml-auto btn btn-sm btn-primary" onclick={openInvite}>New invite link</button>
			</div>
			<p class="mb-3 text-[13px] text-mist-400">
				Paste a link into your Discord. Whoever opens it signs in with Discord (or an existing
				username) and joins with the roles below.
				{#if !data.discord}<span class="text-warn"
						>Discord sign-in is not configured, so only people who already have an account can use a
						link.</span
					>{/if}
			</p>
			<div class="table-wrap">
				<table>
					<thead
						><tr
							><th>Label</th><th>Joins as</th><th class="num">Uses</th><th>Expires</th><th
								>Status</th
							><th></th></tr
						></thead
					>
					<tbody>
						{#each data.invites as inv (inv.id)}
							{@const status = inv.status}
							<tr class={status === 'live' ? '' : 'text-mist-600'}>
								<td>
									<div>{inv.label || '—'}</div>
									<div class="font-mono text-[11px] text-mist-600">
										{fmtTime(inv.createdAt)}
									</div>
								</td>
								<td>
									<span class="inline-flex flex-wrap items-center gap-1">
										<RoleBadge role={inv.orgRole} />
										{#if inv.serverRole}<RoleBadge role={inv.serverRole} />{:else}<Badge
												>no servers</Badge
											>{/if}
									</span>
								</td>
								<td class="num">{usesLabel(inv)}</td>
								<td class="whitespace-nowrap">{inv.expiresAt ? fmtTime(inv.expiresAt) : 'never'}</td
								>
								<td>
									<Badge tone={STATUS_BADGE[status].tone}>{STATUS_BADGE[status].text}</Badge>
								</td>
								<td class="text-right whitespace-nowrap">
									<span class="inline-flex gap-1.5">
										{#if status === 'live'}
											<button class="btn btn-sm" onclick={() => copy(inv.url)}>Copy link</button>
											<button class="btn btn-sm btn-danger" onclick={() => revoke(inv)}
												>Revoke</button
											>
										{/if}
									</span>
								</td>
							</tr>
						{:else}
							<tr
								><td colspan="6" class="py-6 text-center text-mist-600">No invite links yet.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<div class="panel">
			<span class="label-sm">Members</span>
			<div class="table-wrap">
				<table>
					<thead
						><tr><th>Member</th><th>Org role</th><th>Server access</th><th>Joined</th><th></th></tr
						></thead
					>
					<tbody>
						{#each data.members as m (m.userId)}
							<tr>
								<td>
									<div>
										{m.name || m.username}
										{#if m.siteOwner}<Badge tone="accent" class="ml-1">site owner</Badge>{/if}
										{#if m.disabled}<Badge tone="err" class="ml-1">disabled</Badge>{/if}
									</div>
									<div class="font-mono text-[12px] text-mist-600">@{m.username}</div>
								</td>
								<td>
									<select
										class="input w-32"
										value={m.role}
										disabled={busy}
										onchange={(e) => setRole(m, (e.currentTarget as HTMLSelectElement).value)}
									>
										<option value="member">member</option>
										<option value="owner">owner</option>
									</select>
								</td>
								<td>
									{#if m.role === 'owner'}
										<span class="text-mist-400">all servers (owner)</span>
									{:else if m.grants.length}
										<div class="flex flex-wrap gap-1.5 max-md:max-w-[240px]">
											{#each m.grants as g (g.serverId)}
												<span
													class="inline-flex items-center gap-1.5 rounded-[2px] border border-black bg-ink-950 py-0.5 pr-1 pl-2 text-[12px]"
													>{g.serverName} <RoleBadge role={g.role} /></span
												>
											{/each}
										</div>
									{:else}
										<span class="text-mist-600">none</span>
									{/if}
								</td>
								<td class="whitespace-nowrap text-mist-400">{fmtTime(m.joinedAt)}</td>
								<td class="text-right whitespace-nowrap">
									<span class="inline-flex gap-1.5">
										{#if m.role !== 'owner'}
											<button class="btn btn-sm" onclick={() => openGrants(m)}>Access</button>
										{/if}
										{#if m.userId !== data.user.id}
											<button class="btn btn-sm btn-danger" onclick={() => remove(m)}>Remove</button
											>
										{/if}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>

	<div class="space-y-4 self-start">
		{#if data.user.role === 'owner'}
			<div class="panel border-accent/40">
				<span class="label-sm">Site owner controls</span>
				<div class="kv">
					<span class="text-mist-400">Created</span>
					<span
						>{fmtTime(data.org.createdAt)}{#if data.org.createdBy}&nbsp;by @{data.org.createdBy
								.username}{/if}</span
					>
				</div>
				<div class="kv items-center">
					<span class="text-mist-400">Server limit</span>
					<span class="join">
						<input
							class="input w-24 text-right"
							type="number"
							min="0"
							max="1000"
							bind:value={limitInput}
							placeholder="default"
							aria-label="Server limit"
						/>
						<button type="button" class="btn btn-sm h-auto" onclick={saveLimit} disabled={busy}
							>Save</button
						>
					</span>
				</div>
				<p class="note">
					Blank uses the instance default. Currently {data.org.serverCount} of {data.org
						.serverLimit}.
				</p>
				<div class="mt-3 border-t border-white/8 pt-3">
					<span class="field-label">Features this organisation may switch on</span>
					<div class="space-y-1.5">
						{#each ALLOWANCES as a (a.key)}
							<label class="flex items-start gap-2 text-[13px]">
								<input
									type="checkbox"
									class="mt-0.5"
									checked={data.org.allowed[a.key]}
									disabled={busy}
									onchange={(e) => setAllowance(a.key, e.currentTarget.checked)}
								/>
								<span>{a.name} <span class="text-[12px] text-mist-400">· {a.blurb}</span></span>
							</label>
						{/each}
					</div>
					<p class="note">
						Each server still has its own switch under Servers; a feature runs only when both agree.
						Turning match statistics off stops new rows; old ones age out after a year.
					</p>
				</div>
				<div class="mt-3 border-t border-white/8 pt-3">
					{#if data.org.suspended}
						<button type="button" class="btn btn-sm" onclick={restore} disabled={busy}
							>Restore organisation</button
						>
					{:else}
						<div class="join w-full">
							<input
								class="input"
								type="text"
								bind:value={suspendReason}
								placeholder="Reason (shown to its owners)"
								maxlength="300"
							/>
							<button
								type="button"
								class="btn btn-sm h-auto btn-danger"
								onclick={suspend}
								disabled={busy}>Suspend</button
							>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="panel">
			<span class="label-sm">Discord invite</span>
			<form
				class="join w-full"
				onsubmit={(e) => {
					e.preventDefault();
					saveDiscord();
				}}
			>
				<input
					class="input font-mono text-[12.5px]"
					type="text"
					bind:value={discordInput}
					placeholder="https://discord.gg/…"
					maxlength="200"
				/>
				<button type="submit" class="btn btn-sm h-auto" disabled={busy}>Save</button>
			</form>
			<p class="note">
				Shown as a "Join the Discord" button on this organisation's public pages and linked from its
				status boards. Use a link that never expires. Leave blank for no button.
			</p>
		</div>

		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!">Discord webhooks</span>
				<button class="ml-auto btn btn-sm btn-primary" onclick={() => openWebhook(null)}
					>New webhook</button
				>
			</div>
			<p class="mb-3 text-[13px] text-mist-400">
				Mirror the audit trail into a channel: bans, kicks, trigger actions, sign-ins. In Discord,
				open the channel's settings → Integrations → Webhooks, copy the URL and paste it here.
			</p>
			{#each data.webhooks as w (w.id)}
				<div class="kv items-start">
					<div class="min-w-0">
						<div>
							{w.label}
							{#if !w.enabled}<Badge class="ml-1">paused</Badge>{/if}
							{#if w.lastError}<Badge tone="err" class="ml-1">failing</Badge
								>{:else if w.lastSentAt}<Badge tone="ok" class="ml-1">ok</Badge>{/if}
						</div>
						<div class="truncate font-mono text-[11px] text-mist-600">{w.urlHint}</div>
						<div class="text-[12px] text-mist-400">
							{w.events.map(eventLabel).join(' · ')}
							{#if w.serverIds}· {w.serverIds.length} server{w.serverIds.length === 1
									? ''
									: 's'}{/if}
							{#if w.lastError}<div class="text-danger">{w.lastError}</div>{:else if w.lastSentAt}·
								last sent {fmtTime(w.lastSentAt)}{/if}
						</div>
					</div>
					<span class="inline-flex shrink-0 flex-wrap justify-end gap-1.5">
						<button class="btn btn-sm" onclick={() => testWebhook(w)} disabled={busy}>Test</button>
						<button class="btn btn-sm" onclick={() => openWebhook(w)}>Edit</button>
						<button class="btn btn-sm" onclick={() => toggleWebhook(w)} disabled={busy}
							>{w.enabled ? 'Pause' : 'Enable'}</button
						>
						<button class="btn btn-sm btn-danger" onclick={() => deleteWebhook(w)} disabled={busy}
							>Remove</button
						>
					</span>
				</div>
			{:else}
				<p class="text-[13px] text-mist-600">No webhooks yet.</p>
			{/each}
		</div>

		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!">Discord status boards</span>
				<button
					class="ml-auto btn btn-sm btn-primary"
					onclick={() => openBoard(null)}
					disabled={!data.orgServers.length}>New board</button
				>
			</div>
			<p class="mb-3 text-[13px] text-mist-400">
				A live card per server in a channel: map, clock, players, scores and cash in one embed, the
				current match's top players in another. Each board has its own channel webhook (Discord:
				channel settings → Integrations → Webhooks → copy URL); the card is posted once and edited
				in place as the poller samples, so the channel never fills up.
				{#if !data.pollerOn}<span class="text-warn"
						>The poller is off (POLL_SECONDS=0), so boards only update on "Refresh".</span
					>{/if}
			</p>
			{#each data.boards as b (b.id)}
				<div class="kv items-start">
					<div class="min-w-0">
						<div>
							{b.serverName}
							{#if !b.enabled}<Badge class="ml-1">paused</Badge>{/if}
							{#if b.lastError}<Badge tone="err" class="ml-1">failing</Badge
								>{:else if b.posted}<Badge tone="ok" class="ml-1">live</Badge>{:else}<Badge
									tone="info"
									class="ml-1">not posted yet</Badge
								>{/if}
						</div>
						<div class="truncate font-mono text-[11px] text-mist-600">{b.urlHint}</div>
						<div class="text-[12px] text-mist-400">
							every {intervalLabel(b.intervalSeconds)} · top {b.topPlayers}
							{#if b.lastError}<div class="text-danger">
									{b.lastError}
								</div>{:else if b.lastUpdatedAt}· updated {fmtTime(b.lastUpdatedAt)}{/if}
						</div>
					</div>
					<span class="inline-flex shrink-0 flex-wrap justify-end gap-1.5">
						<button class="btn btn-sm" onclick={() => refreshBoard(b)} disabled={busy}
							>Refresh</button
						>
						<button class="btn btn-sm" onclick={() => openBoard(b)}>Edit</button>
						<button class="btn btn-sm" onclick={() => toggleBoard(b)} disabled={busy}
							>{b.enabled ? 'Pause' : 'Enable'}</button
						>
						<button class="btn btn-sm btn-danger" onclick={() => deleteBoard(b)} disabled={busy}
							>Remove</button
						>
					</span>
				</div>
			{:else}
				<p class="text-[13px] text-mist-600">No status boards yet.</p>
			{/each}
		</div>

		<div class="panel">
			<span class="label-sm">Ban list and reserved slots</span>
			<div class="space-y-1.5">
				{#each data.lists.lists as l (l.id)}
					<div class="kv items-center">
						<a
							href="/orgs/{encodeURIComponent(data.org.id)}/{l.kind === 'ban'
								? 'bans'
								: 'reserved'}"
							class="text-accent hover:underline"
							>{l.kind === 'ban' ? 'Ban list' : 'Reserved slots'}</a
						>
						<span class="text-mist-400"
							>{l.entryCount} entr{l.entryCount === 1
								? 'y'
								: 'ies'}{#if l.kind === 'reserve' && data.lists.membersReserved}
								· members get a slot{/if}</span
						>
					</div>
				{/each}
			</div>
			<p class="note">
				Pushed to every server in {data.org.name}. Server admins can add and remove entries too.
			</p>
		</div>

		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!"
					>Servers <span class="text-mist-600"
						>{data.orgServers.length} / {data.org.serverLimit}</span
					></span
				>
				<a class="ml-auto btn btn-sm" href="/servers">Manage servers</a>
			</div>
			{#each data.orgServers as s (s.id)}
				<div class="kv items-center">
					<a href="/server/{encodeURIComponent(s.id)}" class="text-accent hover:underline"
						>{s.name}</a
					>
					<span class="font-mono text-[12px] text-mist-600">{s.host}:{s.port}</span>
				</div>
			{:else}
				<p class="text-[13px] text-mist-400">
					No servers yet. <a href="/servers" class="text-accent underline">Add one</a>; members with
					a default server role on their invite link only get access to servers that exist when they
					join.
				</p>
			{/each}
		</div>
	</div>
</div>

{#if dialog?.kind === 'invite'}
	{@const d = dialog}
	<Modal title="New invite link" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				createInvite();
			}}
		>
			<label class="block"
				><span class="field-label">Label (for you)</span><input
					class="input"
					type="text"
					bind:value={d.label}
					placeholder="e.g. #recruitment channel"
					maxlength="60"
				/></label
			>
			<div class="grid grid-cols-2 gap-2">
				<label class="block"
					><span class="field-label">Joins as</span>
					<select class="input" bind:value={d.orgRole}
						><option value="member">member</option><option value="owner">owner</option></select
					>
				</label>
				<label class="block"
					><span class="field-label">Access to current servers</span>
					<select class="input" bind:value={d.serverRole}>
						<option value="">none (grant later)</option>
						{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
					</select>
				</label>
				<label class="block"
					><span class="field-label">Expires</span>
					<select class="input" bind:value={d.expiresDays}>
						<option value="1">in 1 day</option>
						<option value="7">in 7 days</option>
						<option value="30">in 30 days</option>
						<option value="">never</option>
					</select>
				</label>
				<label class="block"
					><span class="field-label">Max uses</span><input
						class="input"
						type="number"
						bind:value={d.maxUses}
						placeholder="unlimited"
						min="1"
					/></label
				>
			</div>
			<p class="note">
				An <b>owner</b> link makes joiners admin on every server and lets them manage the org. Keep those
				short-lived and single-use.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Create link</button>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'created'}
	{@const d = dialog}
	<Modal title="Invite link ready" onclose={() => (dialog = null)}>
		<p class="mb-3 text-[13.5px]">Paste this into your Discord:</p>
		<div class="join w-full">
			<input class="input font-mono text-[12.5px]" type="text" readonly value={d.invite.url} />
			<button type="button" class="btn btn-primary" onclick={() => copy(d.invite.url)}>Copy</button>
		</div>
		<p class="note">
			Joins as <b>{d.invite.orgRole}</b>{#if d.invite.serverRole}, <b>{d.invite.serverRole}</b> on every
				current server{/if}. {d.invite.expiresAt
				? `Expires ${fmtTime(d.invite.expiresAt)}.`
				: 'Never expires.'}
			{d.invite.maxUses ? `${d.invite.maxUses} use${d.invite.maxUses === 1 ? '' : 's'}.` : ''}
		</p>
		{#snippet actions()}<button type="button" class="btn" onclick={() => (dialog = null)}
				>Done</button
			>{/snippet}
	</Modal>
{:else if dialog?.kind === 'webhook'}
	{@const d = dialog}
	<Modal title={d.id ? 'Edit webhook' : 'New Discord webhook'} onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				saveWebhook();
			}}
		>
			<label class="block"
				><span class="field-label">Label</span><input
					class="input"
					type="text"
					bind:value={d.label}
					placeholder="e.g. #admin-log"
					maxlength="60"
				/></label
			>
			<label class="block"
				><span class="field-label">Webhook URL{d.id ? ' (leave blank to keep)' : ''}</span><input
					class="input font-mono text-[12.5px]"
					type="url"
					bind:value={d.url}
					placeholder="https://discord.com/api/webhooks/…"
					required={!d.id}
					autocomplete="off"
				/></label
			>
			<div>
				<span class="field-label">Mirror</span>
				<div class="space-y-1">
					{#each data.webhookEvents as e (e.key)}
						<label class="flex items-center gap-2 text-[13px]"
							><input type="checkbox" bind:checked={d.events[e.key]} /> {e.label}</label
						>
					{/each}
				</div>
			</div>
			{#if data.orgServers.length > 1}
				<div>
					<span class="field-label">Servers</span>
					<label class="flex items-center gap-2 text-[13px]"
						><input type="checkbox" bind:checked={d.allServers} /> Every server in the organisation</label
					>
					{#if !d.allServers}
						<div class="mt-1 space-y-1 pl-5">
							{#each data.orgServers as s (s.id)}
								<label class="flex items-center gap-2 text-[13px]"
									><input type="checkbox" bind:checked={d.servers[s.id]} /> {s.name}</label
								>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<p class="note">
				The URL lets anyone post to that channel, so it is stored encrypted and never shown again.
				IP addresses are never sent to Discord.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{d.id ? 'Save' : 'Add webhook'}</button
				>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'board'}
	{@const d = dialog}
	<Modal
		title={d.id ? 'Edit status board' : 'New Discord status board'}
		onclose={() => (dialog = null)}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				saveBoard();
			}}
		>
			{#if !d.id}
				<label class="block"
					><span class="field-label">Server</span><select class="input" bind:value={d.serverId}>
						{#each data.orgServers as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
					</select></label
				>
			{/if}
			<label class="block"
				><span class="field-label">Channel webhook URL{d.id ? ' (leave blank to keep)' : ''}</span
				><input
					class="input font-mono text-[12.5px]"
					type="url"
					bind:value={d.url}
					placeholder="https://discord.com/api/webhooks/…"
					required={!d.id}
					autocomplete="off"
				/></label
			>
			<div class="grid grid-cols-2 gap-3">
				<label class="block"
					><span class="field-label">Update every</span><select
						class="input"
						bind:value={d.intervalSeconds}
					>
						{#each INTERVALS as s (s)}<option value={s}>{intervalLabel(s)}</option>{/each}
					</select></label
				>
				<label class="block"
					><span class="field-label">Players on the board</span><input
						class="input"
						type="number"
						min="1"
						max={data.boardMaxTop}
						bind:value={d.topPlayers}
					/></label
				>
			</div>
			<p class="note">
				The card is posted once and then edited, so it stays where it was put. Delete it in Discord
				and the next update posts a fresh one. Changing the channel deletes the old card.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button
					type="submit"
					class="btn btn-primary"
					disabled={busy || !d.serverId || (!d.id && !d.url.trim())}
					>{d.id ? 'Save' : 'Add and post'}</button
				>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'grants'}
	{@const d = dialog}
	<Modal title="Server access for @{d.member.username}" onclose={() => (dialog = null)}>
		{#each data.orgServers as s (s.id)}
			<div class="kv items-center">
				<span
					>{s.name} <span class="font-mono text-[12px] text-mist-600">{s.host}:{s.port}</span></span
				>
				<select class="input w-40" bind:value={d.grants[s.id]}>
					<option value="">no access</option>
					{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
				</select>
			</div>
		{:else}
			<p class="text-mist-400">This organisation has no servers yet.</p>
		{/each}
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
			<button type="button" class="btn btn-primary" onclick={saveGrants} disabled={busy}
				>Save access</button
			>
		{/snippet}
	</Modal>
{/if}
