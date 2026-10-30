// Renders bench/fixtures/apostila-bio.html (7 A4 pages of PT-BR biology) to a PDF with Playwright's Chromium.
// Playwright is not a project dependency: use a machine that has it (npx playwright, or a global install).
//   node bench/make-pdf.cjs <out.pdf>
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || 'apostila-bio.pdf';
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, 'fixtures', 'apostila-bio.html')}`);
  await page.pdf({ path: out, format: 'A4' });
  await browser.close();
  console.log(out);
})();
