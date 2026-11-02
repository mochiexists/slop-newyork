#!/usr/bin/env node
// A screenshot of a report page, to look at it before trusting it: node snap-page.mjs <page.html> <out.png> [width] [dark]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = process.env.SWIM_EVAL_PLAYWRIGHT ?? '/Users/timapple/Documents/mcc/fujira/theforest/clawpost/clawpost/web/node_modules/playwright-core';
const CHROME = process.env.SWIM_EVAL_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const [page, out, width = '1400', scheme = 'light'] = process.argv.slice(2);
const { chromium } = require(PLAYWRIGHT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: Number(width), height: 900 }, colorScheme: scheme === 'dark' ? 'dark' : 'light' });
const tab = await context.newPage();
await tab.goto(`file://${resolve(page)}`);
await tab.waitForTimeout(500);
await tab.screenshot({ path: out, fullPage: true });
await browser.close();
