/**
 * Rasterises the generated SVGs into branding/png/ and the app icons in static/.
 *
 * The SVG generator (scripts/branding.ts) emits vectors only, so the PNG set used to be a manual
 * step done in a graphics editor — which meant it drifted from the SVGs every time the brand
 * changed. This closes that gap: run it after scripts/branding.ts and the rasters are exact.
 *
 *   bun run scripts/branding.ts && bun run scripts/branding-png.ts
 *
 * Chromium comes from Playwright. It is a devDependency-free tool here, resolved from
 * PLAYWRIGHT_BROWSERS_PATH or a global install, so CI does not need it to build the app —
 * regenerating brand assets is a deliberate, occasional act.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const OUT = 'branding/png';

interface Job {
	/** Source SVG, relative to the repo root. */
	src: string;
	/** Destination PNG, relative to the repo root. */
	dest: string;
	/** Target width in px; height follows the SVG's aspect ratio. */
	width: number;
	/** Painted behind the art. `null` keeps transparency. */
	background?: string | null;
}

const MARK = 'branding/refxrcon-mark.svg';
const jobs: Job[] = [
	// The mark, at every size an icon slot asks for.
	...[16, 32, 64, 192, 256, 512, 1024].map((n) => ({
		src: MARK,
		dest: `${OUT}/refxrcon-mark-${n}.png`,
		width: n
	})),
	{
		src: 'branding/refxrcon-mark-mono-black.svg',
		dest: `${OUT}/refxrcon-mark-mono-black-512.png`,
		width: 512
	},
	{
		src: 'branding/refxrcon-mark-mono-white.svg',
		dest: `${OUT}/refxrcon-mark-mono-white-512.png`,
		width: 512
	},
	// Lockups at 2x for slide decks and READMEs.
	{
		src: 'branding/refxrcon-logo-on-dark.svg',
		dest: `${OUT}/refxrcon-logo-on-dark@2x.png`,
		width: 1024
	},
	{
		src: 'branding/refxrcon-logo-on-light.svg',
		dest: `${OUT}/refxrcon-logo-on-light@2x.png`,
		width: 1024
	},
	{
		src: 'branding/refxrcon-logo-mono-white.svg',
		dest: `${OUT}/refxrcon-logo-mono-white@2x.png`,
		width: 1024
	},
	{
		src: 'branding/refxrcon-logo-mono-black.svg',
		dest: `${OUT}/refxrcon-logo-mono-black@2x.png`,
		width: 1024
	},
	{
		src: 'branding/refxrcon-stacked-on-dark.svg',
		dest: `${OUT}/refxrcon-stacked-on-dark.png`,
		width: 1024
	},
	{
		src: 'branding/refxrcon-stacked-on-light.svg',
		dest: `${OUT}/refxrcon-stacked-on-light.png`,
		width: 1024
	},
	// App icons. These are referenced by src/app.html and must stay in step with the mark.
	{ src: MARK, dest: 'static/icon-192.png', width: 192 },
	{ src: MARK, dest: 'static/icon-512.png', width: 512 },
	// Apple composites the icon onto a white sheet if it is transparent; paint the page colour
	// ourselves so the cut corners read as intentional rather than as a rendering artefact.
	{ src: MARK, dest: 'static/apple-touch-icon.png', width: 180, background: '#070B12' }
];

/** 1280x640 is GitHub's social preview slot; the stacked lockup is centred on the page colour. */
const SOCIAL = {
	src: 'branding/refxrcon-stacked-on-dark.svg',
	dest: `${OUT}/refxrcon-social-preview.png`
};

function svgSize(svg: string): { w: number; h: number } {
	const vb = svg.match(/viewBox="([\d.\s-]+)"/);
	if (!vb) throw new Error('no viewBox');
	const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
	return { w, h };
}

/** The SVG centred on a fixed canvas, as a data: URL Chromium can screenshot. */
function page(svg: string, width: number, height: number, art: number, background: string | null) {
	const bg = background ?? 'transparent';
	return `data:text/html;charset=utf-8,${encodeURIComponent(
		`<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;background:${bg};display:flex;align-items:center;justify-content:center">` +
			// [\d.]+ and not \d+: the stacked lockups carry a fractional height (202.4), and an
			// integer-only pattern left them at their intrinsic 260px inside a 1024px canvas.
			`<div style="width:${art}px;line-height:0">${svg.replace(/width="[\d.]+"\s+height="[\d.]+"/, 'width="100%" height="auto"')}</div>` +
			`</body></html>`
	)}`;
}

const require = createRequire(import.meta.url);
let chromium;
try {
	({ chromium } = require('playwright'));
} catch {
	console.error(
		'playwright is not resolvable. Install it once (npm i -g playwright) and re-run;\n' +
			'the browser itself is expected at PLAYWRIGHT_BROWSERS_PATH.'
	);
	process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let written = 0;

for (const job of [
	...jobs,
	{ ...SOCIAL, width: 1280, height: 640, background: '#070B12' }
] as (Job & {
	height?: number;
})[]) {
	const svg = readFileSync(job.src, 'utf8');
	const { w, h } = svgSize(svg);
	const width = job.width;
	const height = job.height ?? Math.round((width * h) / w);
	// For the fixed-canvas social slot, inset the art so it does not touch the edges.
	const art = job.height ? Math.round(Math.min(width * 0.62, ((height * 0.72) / h) * w)) : width;

	const ctx = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1
	});
	const p = await ctx.newPage();
	await p.goto(page(svg, width, height, art, job.background ?? null));
	const png = await p.screenshot({ omitBackground: !job.background, type: 'png' });
	writeFileSync(job.dest, png);
	await ctx.close();
	written++;
	console.log(`  ${job.dest}  ${width}x${height}`);
}

await browser.close();
console.log(`wrote ${written} PNGs`);
