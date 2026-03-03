#!/usr/bin/env node
/**
 * test-links.js
 * Integration test: runs slides-to-pdf against a known presentation
 * and verifies that clickable links are embedded in the output PDF.
 *
 * Usage: node test-links.js
 */

const { execSync } = require("child_process");
const { PDFDocument, PDFName, PDFArray, PDFDict } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

const TEST_URL =
  "https://docs.google.com/presentation/d/e/2PACX-1vQc3zo7Z0b6HK7YeC56p_n2RbHNjUHh1HI66DH0cHbFk0db1HlbF7gILE__NCvhUiYMjIGSOHwHPv2_/pub?start=false&loop=false&delayms=3000&slide=id.g393fb86ef49_0_41";

// Capture slides 1-5; slide 3 is known to contain a link
const MAX_SLIDES = 5;

const OUT_DIR = path.join(__dirname, "test-output-" + Date.now());

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log("Running slides-to-pdf…");
  execSync(
    `node slides-to-pdf.js "${TEST_URL}" ${MAX_SLIDES}`,
    { cwd: __dirname, stdio: "inherit", env: { ...process.env, HOME: process.env.HOME } }
  );

  // Find the output folder (slugified title)
  const dirs = fs.readdirSync(__dirname).filter((d) => {
    const full = path.join(__dirname, d);
    return fs.statSync(full).isDirectory() && d.startsWith("htgaa-");
  });
  assert(dirs.length > 0, "Output directory was created");
  const outDir = path.join(__dirname, dirs[dirs.length - 1]);

  // Find the PDF
  const pdfFiles = fs.readdirSync(outDir).filter((f) => f.endsWith(".pdf"));
  assert(pdfFiles.length === 1, "Exactly one PDF was generated");
  const pdfPath = path.join(outDir, pdfFiles[0]);

  // Parse the PDF and extract link annotations
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  // +1 for the final "source" page
  assert(pages.length === MAX_SLIDES + 1, `PDF has ${MAX_SLIDES} slide pages + 1 source page`);

  // Collect all links across all pages
  const allLinks = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const annotsRef = page.node.lookup(PDFName.of("Annots"));
    if (!annotsRef || !(annotsRef instanceof PDFArray)) continue;

    for (let j = 0; j < annotsRef.size(); j++) {
      const annot = annotsRef.lookup(j);
      if (!(annot instanceof PDFDict)) continue;

      const subtype = annot.lookup(PDFName.of("Subtype"));
      if (subtype?.toString() !== "/Link") continue;

      const action = annot.lookup(PDFName.of("A"));
      if (!(action instanceof PDFDict)) continue;

      const uri = action.lookup(PDFName.of("URI"));
      const rect = annot.lookup(PDFName.of("Rect"));

      allLinks.push({
        page: i + 1,
        url: uri?.toString() || "",
        rect: rect?.toString() || "",
      });
    }
  }

  console.log(`\nFound ${allLinks.length} link annotation(s) in PDF:`);
  for (const l of allLinks) {
    console.log(`  Page ${l.page}: ${l.url}`);
  }

  // Slide 3 should have a link to the referenced Google Slides presentation
  assert(allLinks.length >= 1, "At least one link annotation exists in the PDF");

  const slide3Links = allLinks.filter((l) => l.page === 3);
  assert(slide3Links.length >= 1, "Slide 3 (known to have a link) has at least one annotation");

  // The link should point to the actual destination, not Google's redirect wrapper
  const hasUnwrappedUrl = slide3Links.some(
    (l) => l.url.includes("docs.google.com/presentation") && !l.url.includes("google.com/url?q=")
  );
  assert(hasUnwrappedUrl, "Google redirect URL was unwrapped to actual destination");

  // Verify link rect is within page bounds
  const pageWidth = pages[2].getWidth();
  const pageHeight = pages[2].getHeight();
  for (const l of slide3Links) {
    // rect format: "[ x1 y1 x2 y2 ]"
    const nums = l.rect.match(/[\d.]+/g)?.map(Number) || [];
    if (nums.length === 4) {
      const [x1, y1, x2, y2] = nums;
      const inBounds = x1 >= 0 && y1 >= 0 && x2 <= pageWidth && y2 <= pageHeight && x2 > x1 && y2 > y1;
      assert(inBounds, `Link rect [${nums.join(", ")}] is within page bounds (${pageWidth}x${pageHeight})`);
    }
  }

  // Pages without links should have no annotations
  const page1Links = allLinks.filter((l) => l.page === 1);
  assert(page1Links.length === 0, "Slide 1 (no links in source) has no annotations");

  // Final page should link back to the original presentation URL
  const finalPageNum = MAX_SLIDES + 1;
  const finalPageLinks = allLinks.filter((l) => l.page === finalPageNum);
  assert(finalPageLinks.length === 1, "Final source page has exactly one link annotation");
  const hasOrigUrl = finalPageLinks.some((l) => l.url.includes("2PACX-1vQc3zo7Z0b6HK7YeC56p_n2RbHNjUHh1HI66DH0cHbFk0db1HlbF7gILE"));
  assert(hasOrigUrl, "Final page links back to the original presentation URL");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
