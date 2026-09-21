import { describe, expect, test } from 'bun:test';
import {
	effectiveFeatures,
	featureBlocker,
	parseAllowances,
	parseSwitches,
	publicLinks
} from './features';

const allowAll = { allowStats: true, allowPublicStatus: true, allowPublicStats: true };
const allOn = { statsEnabled: true, publicStatus: true, publicStats: true };

describe('effectiveFeatures', () => {
	test('both levels on', () => {
		expect(effectiveFeatures(allowAll, allOn)).toEqual({
			stats: true,
			publicStatus: true,
			publicStats: true
		});
	});
	test('the site owner wins', () => {
		expect(effectiveFeatures({ ...allowAll, allowStats: false }, allOn)).toEqual({
			stats: false,
			publicStatus: true,
			publicStats: false
		});
		expect(effectiveFeatures({ ...allowAll, allowPublicStatus: false }, allOn).publicStatus).toBe(
			false
		);
	});
	test('the server switch wins', () => {
		expect(effectiveFeatures(allowAll, { ...allOn, publicStats: false }).publicStats).toBe(false);
		expect(effectiveFeatures(allowAll, { ...allOn, statsEnabled: false })).toEqual({
			stats: false,
			publicStatus: true,
			publicStats: false
		});
	});
	test('public stats need stats', () => {
		expect(
			effectiveFeatures(allowAll, { statsEnabled: false, publicStatus: false, publicStats: true })
				.publicStats
		).toBe(false);
	});
});

describe('featureBlocker', () => {
	test('nothing to explain when off or fully on', () => {
		expect(featureBlocker('stats', allowAll, allOn)).toBeNull();
		expect(featureBlocker('stats', allowAll, { ...allOn, statsEnabled: false })).toBeNull();
	});
	test('names the site owner', () => {
		expect(featureBlocker('publicStatus', { ...allowAll, allowPublicStatus: false }, allOn)).toBe(
			'not allowed for this organisation by the site owner'
		);
	});
	test('names the missing stats', () => {
		expect(featureBlocker('publicStats', allowAll, { ...allOn, statsEnabled: false })).toBe(
			'needs match statistics, which are off'
		);
	});
});

describe('publicLinks', () => {
	test('only the pages that are on, plus the Discord invite', () => {
		expect(
			publicLinks(
				'https://rcon.example.com/',
				{ ...allowAll, discordUrl: 'https://discord.gg/abc' },
				{ ...allOn, id: 's 1' }
			)
		).toEqual({
			status: 'https://rcon.example.com/public/s%201',
			stats: 'https://rcon.example.com/public/s%201/stats',
			discord: 'https://discord.gg/abc'
		});
		expect(
			publicLinks('http://localhost:5173', allowAll, { ...allOn, publicStats: false, id: 'x' })
		).toEqual({ status: 'http://localhost:5173/public/x' });
		expect(
			publicLinks('http://h', allowAll, {
				...allOn,
				id: 'x',
				joinCode: '0e0d5726-fd99-44ca-bf62-ad2d43f79204'
			}).join
		).toBe('http://h/public/x/join');
		expect(
			publicLinks('http://h', allowAll, {
				...allOn,
				publicStatus: false,
				id: 'x',
				joinCode: '0e0d5726-fd99-44ca-bf62-ad2d43f79204'
			}).join
		).toBeUndefined();
		expect(
			publicLinks('http://h', allowAll, {
				...allOn,
				publicStatus: false,
				publicStats: false,
				id: 'x'
			})
		).toEqual({});
	});
});

describe('parsers', () => {
	test('only the keys present, coerced to booleans', () => {
		expect(parseSwitches({ statsEnabled: 0, publicStats: 'yes' })).toEqual({
			statsEnabled: false,
			publicStats: true
		});
		expect(parseAllowances({})).toEqual({});
		expect(parseAllowances({ allowPublicStatus: null })).toEqual({ allowPublicStatus: false });
	});
});
