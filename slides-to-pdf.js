#!/usr/bin/env node
/**
 * slides-to-pdf.js
 * Usage: node slides-to-pdf.js <google-slides-url> [max-slides]
 *
 * Deps: npm install puppeteer pdf-lib sharp
 */

const puppeteer = require("puppeteer");
const { PDFDocument, PDFName, PDFArray, PDFString, StandardFonts, rgb } = require("pdf-lib");
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

    // Extract links from the current slide's DOM
    const slideLinks = await page.evaluate(() => {
      const links = [];
      // Find all <a> elements (SVG anchors use xlink:href, not href attribute)
      const anchors = document.querySelectorAll("a");
      for (const a of anchors) {
        const href = a.getAttribute("href") || a.getAttributeNS("http://www.w3.org/1999/xlink", "href");
        if (!href || href === "#" || href.startsWith("javascript:")) continue;
        const rect = a.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        links.push({
          url: href,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
      return links;
    });

    if (slideLinks.length > 0) {
      console.log(`    Found ${slideLinks.length} link(s) on slide ${slideIndex + 1}`);
    }

    console.log(`  Captured slide ${slideIndex + 1} → ${path.basename(screenshotPath)}`);
    screenshots.push({ path: screenshotPath, links: slideLinks });
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

  // Viewport dimensions used for screenshots
  const vpWidth = 1600;
  const vpHeight = 900;

  for (const slide of screenshots) {
    const imgBytes = fs.readFileSync(slide.path);
    const jpegBytes = await sharp(imgBytes).jpeg({ quality: 92 }).toBuffer();
    const jpegImage = await pdfDoc.embedJpg(jpegBytes);
    const { width, height } = jpegImage.scale(1);
    const pdfPage = pdfDoc.addPage([width, height]);
    pdfPage.drawImage(jpegImage, { x: 0, y: 0, width, height });

    // Add clickable link annotations
    const scaleX = width / vpWidth;
    const scaleY = height / vpHeight;

    for (const link of slide.links) {
      // Convert viewport coords to PDF coords (PDF origin is bottom-left)
      const pdfX = link.x * scaleX;
      const pdfY = height - (link.y + link.height) * scaleY;
      const pdfW = link.width * scaleX;
      const pdfH = link.height * scaleY;

      // Resolve relative URLs and unwrap Google redirect
      let url = link.url;
      if (url.startsWith("/")) {
        url = "https://docs.google.com" + url;
      }
      try {
        const parsed = new URL(url);
        if (parsed.hostname === "www.google.com" && parsed.pathname === "/url" && parsed.searchParams.has("q")) {
          url = parsed.searchParams.get("q");
        }
      } catch (_) {}

      const annotRef = pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [pdfX, pdfY, pdfX + pdfW, pdfY + pdfH],
          Border: [0, 0, 0],
          A: {
            Type: "Action",
            S: "URI",
            URI: PDFString.of(url),
          },
        })
      );

      const existingAnnots = pdfPage.node.lookup(PDFName.of("Annots"));
      if (existingAnnots instanceof PDFArray) {
        existingAnnots.push(annotRef);
      } else {
        pdfPage.node.set(PDFName.of("Annots"), pdfDoc.context.obj([annotRef]));
      }
    }
  }

  // Add a final page linking back to the original presentation
  const lastSlide = screenshots[screenshots.length - 1];
  const lastImgMeta = await sharp(fs.readFileSync(lastSlide.path)).metadata();
  const finalPageWidth = lastImgMeta.width;
  const finalPageHeight = lastImgMeta.height;
  const finalPage = pdfDoc.addPage([finalPageWidth, finalPageHeight]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const labelText = "PDF extracted from original presentation:";
  const linkText = RAW_URL;
  const fontSize = 24;
  const labelWidth = font.widthOfTextAtSize(labelText, fontSize);
  const linkWidth = font.widthOfTextAtSize(linkText, fontSize);

  const centerY = finalPageHeight / 2;
  const labelX = (finalPageWidth - labelWidth) / 2;
  const linkX = (finalPageWidth - linkWidth) / 2;

  finalPage.drawText(labelText, {
    x: labelX,
    y: centerY + 20,
    size: fontSize,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  finalPage.drawText(linkText, {
    x: linkX,
    y: centerY - 20,
    size: fontSize,
    font,
    color: rgb(0.1, 0.4, 0.8),
  });

  // Make the URL text a clickable link
  const linkAnnotRef = pdfDoc.context.register(
    pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [linkX, centerY - 20 - 5, linkX + linkWidth, centerY - 20 + fontSize + 2],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(RAW_URL),
      },
    })
  );
  finalPage.node.set(PDFName.of("Annots"), pdfDoc.context.obj([linkAnnotRef]));

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
