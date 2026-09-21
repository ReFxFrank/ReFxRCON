import { describe, expect, test } from 'bun:test';
import { validateDiscordInvite } from './discord-invite';

describe('validateDiscordInvite', () => {
	test('short and long forms normalise to discord.gg', () => {
		expect(validateDiscordInvite('https://discord.gg/abc123')).toBe('https://discord.gg/abc123');
		expect(validateDiscordInvite('discord.gg/abc123')).toBe('https://discord.gg/abc123');
		expect(validateDiscordInvite('https://discord.com/invite/Esprit-DC')).toBe(
			'https://discord.gg/Esprit-DC'
		);
		expect(validateDiscordInvite('https://discordapp.com/invite/xyz?event=1')).toBe(
			'https://discord.gg/xyz'
		);
	});
	test('blank clears', () => {
		expect(validateDiscordInvite('')).toBe('');
		expect(validateDiscordInvite(null)).toBe('');
	});
	test('anything else is refused', () => {
		for (const bad of [
			'https://example.com/invite/abc',
			'https://discord.com/channels/1/2',
			'https://discord.gg/',
			'http://discord.gg/abc',
			'not a url at all !!',
			'https://discord.gg/a/b'
		])
			expect(() => validateDiscordInvite(bad)).toThrow();
	});
});
