#!/usr/bin/env node
/**
 * slides-to-pdf.js
 * Usage: node slides-to-pdf.js <google-slides-url> [max-slides]
 *
 * Deps: npm install puppeteer pdf-lib sharp
 */

const puppeteer = require("puppeteer");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const RAW_URL = process.argv[2];
const MAX_SLIDES = parseInt(process.argv[3] || "0", 10); // 0 = no limit

if (!RAW_URL) {
  console.error("Usage: node slides-to-pdf.js <google-slides-url> [max-slides]");
  process.exit(1);
}

// Normalise to the HTML slideshow view (strip output=pdf, anchor, etc.)
function normaliseUrl(raw) {
  const u = new URL(raw);
  // Remove output=pdf and any conflicting params
  u.searchParams.delete("output");
  u.searchParams.set("start", "false");
  u.searchParams.set("loop", "false");
  u.searchParams.set("delayms", "60000");
  u.hash = "";
  return u.toString();
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Compute a fast perceptual fingerprint: resize to tiny thumbnail, get raw bytes
async function fingerprint(pngPath) {
  const buf = await sharp(pngPath)
    .resize(16, 9, { fit: "fill" })
    .raw()
    .toBuffer();
  return buf.toString("base64");
}

async function run() {
  const SLIDES_URL = normaliseUrl(RAW_URL);
  console.log("Normalised URL:", SLIDES_URL);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

  console.log("Loading slides…");
  await page.goto(SLIDES_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Extra render time
  await new Promise((r) => setTimeout(r, 3000));

  const pageTitle = await page.title();
  const folderName = slugify(pageTitle) || "slides-" + Date.now();
  const outDir = path.join(process.cwd(), folderName);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Output folder: ${outDir}`);
  console.log(`Page title: "${pageTitle}"`);

  // Click on the slide area first so keyboard events are captured
  await page.mouse.click(800, 450);
  await new Promise((r) => setTimeout(r, 500));

  // Go to first slide
  await page.keyboard.press("Home");
  await new Promise((r) => setTimeout(r, 10000));

  const screenshots = [];
  let slideIndex = 0;
  let prevFingerprint = null;

  const limit = MAX_SLIDES > 0 ? MAX_SLIDES : Infinity;

  while (slideIndex < limit) {
    const screenshotPath = path.join(
      outDir,
      `slide-${String(slideIndex + 1).padStart(3, "0")}.png`
    );

    await page.screenshot({ path: screenshotPath, fullPage: false });

    const fp = await fingerprint(screenshotPath);

    if (slideIndex > 0 && fp === prevFingerprint) {
      console.log(`Slide ${slideIndex + 1} identical to previous — end of deck.`);
      fs.unlinkSync(screenshotPath);
      break;
    }

    console.log(`  Captured slide ${slideIndex + 1} → ${path.basename(screenshotPath)}`);
    screenshots.push(screenshotPath);
    prevFingerprint = fp;
    slideIndex++;

    if (slideIndex >= limit) break;

    // Advance slide and wait for it to fully render
    await page.keyboard.press("ArrowRight");
    await new Promise((r) => setTimeout(r, 10000));
  }

  await browser.close();

  if (screenshots.length === 0) {
    console.error("No screenshots captured. The URL may require sign-in.");
    process.exit(1);
  }

  // Build PDF
  console.log(`\nBuilding PDF from ${screenshots.length} slide(s)…`);
  const pdfDoc = await PDFDocument.create();

  for (const imgPath of screenshots) {
    const imgBytes = fs.readFileSync(imgPath);
    const jpegBytes = await sharp(imgBytes).jpeg({ quality: 92 }).toBuffer();
    const jpegImage = await pdfDoc.embedJpg(jpegBytes);
    const { width, height } = jpegImage.scale(1);
    const pdfPage = pdfDoc.addPage([width, height]);
    pdfPage.drawImage(jpegImage, { x: 0, y: 0, width, height });
  }

  const pdfPath = path.join(outDir, `${folderName}.pdf`);
  fs.writeFileSync(pdfPath, await pdfDoc.save());

  console.log(`\nDone!`);
  console.log(`  PDF  → ${pdfPath}`);
  console.log(`  PNGs → ${outDir}`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
