#!/usr/bin/env node
// Renders the app icon PNGs and the web favicons from the SVG sources in apps/mobile/assets/icon/.
//
// The sources sit on Android's 108 dp adaptive-icon grid: the launcher shows the middle 72 dp and the art stays
// inside the 66 dp safe circle, so every mask shape (circle, squircle, rounded square) keeps the whole of Capi.
//
// Needs Playwright with its Chromium (not a workspace dependency): npm i -g playwright && npx playwright install chromium
// Usage: node apps/mobile/scripts/render-icons.mjs   # from anywhere; paths are resolved from this file
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(MOBILE, '..', '..');
const ASSETS = join(MOBILE, 'assets');

const source = (name) => readFileSync(join(ASSETS, 'icon', `${name}.svg`), 'utf8');
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const background = inner(source('background'));
const foreground = inner(source('foreground'));
const monochrome = inner(source('monochrome'));

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
// What a launcher shows: the middle 72 dp of the grid.
const VISIBLE = '18 18 72 72';
// The same, cut to a rounded square for places that do not mask the icon themselves (favicons).
const roundedTile = svg(
  VISIBLE,
  `<clipPath id="tile"><rect x="18" y="18" width="72" height="72" rx="16"/></clipPath><g clip-path="url(#tile)">${background}${foreground}</g>`,
);
// Android 12+ masks the splash icon to a circle two thirds of its canvas wide, so the splash is that disc already.
const splashDisc = svg(
  '0 0 108 108',
  `<clipPath id="disc"><circle cx="54" cy="54" r="36"/></clipPath><g clip-path="url(#disc)">${background}</g>${foreground}`,
);

const outputs = [
  // iOS and the store listing mask the square themselves; it must stay opaque.
  { file: join(ASSETS, 'icon.png'), size: 1024, svg: svg(VISIBLE, background + foreground), opaque: true },
  { file: join(ASSETS, 'android-icon-foreground.png'), size: 1024, svg: svg('0 0 108 108', foreground) },
  { file: join(ASSETS, 'android-icon-background.png'), size: 1024, svg: svg('0 0 108 108', background), opaque: true },
  { file: join(ASSETS, 'android-icon-monochrome.png'), size: 1024, svg: svg('0 0 108 108', monochrome) },
  { file: join(ASSETS, 'splash-icon.png'), size: 1024, svg: splashDisc },
  { file: join(ASSETS, 'favicon.png'), size: 48, svg: roundedTile },
];

const browser = await chromium.launch();
try {
  for (const { file, size, svg: markup, opaque = false } of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const sized = markup.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(`<body style="margin:0;background:transparent">${sized}</body>`);
    await page.screenshot({ path: file, omitBackground: !opaque });
    await page.close();
    console.log(`${file.slice(ROOT.length + 1)} (${size}×${size})`);
  }
} finally {
  await browser.close();
}

for (const app of ['site', 'dashboard']) {
  const file = join(ROOT, 'apps', app, 'public', 'favicon.svg');
  writeFileSync(file, `${roundedTile.replace(/>\s+</g, '><').replace(/<!--[\s\S]*?-->/g, '')}\n`);
  console.log(file.slice(ROOT.length + 1));
}
