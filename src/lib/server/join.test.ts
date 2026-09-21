import { describe, expect, test } from 'bun:test';
import { steamLaunchLink, validateJoinCode } from './join';

describe('validateJoinCode', () => {
	test('a community server UUID, cleaned up', () => {
		expect(validateJoinCode(' 0E0D5726-FD99-44CA-BF62-AD2D43F79204 ')).toBe(
			'0e0d5726-fd99-44ca-bf62-ad2d43f79204'
		);
	});
	test('an official server number keeps its leading zeros', () => {
		expect(validateJoinCode('004512')).toBe('004512');
	});
	test('blank clears', () => {
		expect(validateJoinCode('')).toBe('');
		expect(validateJoinCode(undefined)).toBe('');
	});
	test('anything else is refused', () => {
		for (const bad of ['165.217.128.166:9025', 'abc', '0e0d5726-fd99-44ca-bf62', 'x'.repeat(36)])
			expect(() => validateJoinCode(bad)).toThrow('join code');
	});
});

describe('steamLaunchLink', () => {
	test('launches WARDOGS', () => {
		expect(steamLaunchLink()).toBe('steam://rungameid/1867240');
	});
});
