// Generates a Hindi + English PDF via headless Chromium. Run: node audit/repro/make_hindi_pdf.cjs
const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(`<html><body style="font-size:16px">
    <p>पूर्व-मौजूदा बीमारी के उपचार से संबंधित खर्च 48 महीने तक बाहर रहेंगे।</p>
    <p>Pre-existing disease expenses are excluded for 48 months.</p></body></html>`);
  await p.pdf({ path: path.join(__dirname, "fixtures", "hindi.pdf") });
  await b.close();
})();
