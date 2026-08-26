// pdf.mjs — renders already-generated text as PDF. Pure formatting only: no
// AI involvement, nothing invented here — it lays out text that colibri (for
// cover letters) or the candidate (for profile.md) already wrote.

import PDFDocument from "pdfkit";
import { stripEmDash } from "./text-filter.mjs";

function renderToBuffer(build) {
  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: { Producer: "jobscrape", Creator: "jobscrape" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

/**
 * Renders one drafted cover letter as a single-page-ish business-letter PDF.
 * @param {{ candidateName: string, contactLine: string, posting: object, letter: string }} params
 * @returns {Promise<Buffer>}
 */
export async function coverLetterToPdf({ candidateName, contactLine, posting, letter }) {
  return renderToBuffer((doc) => {
    doc.font("Helvetica-Bold").fontSize(13).text(stripEmDash(candidateName) || "");
    if (contactLine) {
      doc.font("Helvetica").fontSize(9).fillColor("#666666").text(stripEmDash(contactLine));
    }
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).fillColor("#666666")
      .text(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000")
      .text(stripEmDash(`Re: ${posting.title} — ${posting.company}`));
    doc.moveDown(1.5);

    doc.font("Helvetica").fontSize(11).fillColor("#000000")
      .text(stripEmDash(letter), { align: "left", lineGap: 4 });
  });
}

/**
 * Renders profile.md as a plain, legible resume-shaped PDF. Lightweight
 * line-based markdown handling (# / ## headers, - bullets, **bold** inline)
 * — this is a format conversion of existing content, not a designed resume
 * template. Good enough to read/attach; not meant to replace a real CV
 * layout tool.
 * @param {string} markdown
 * @returns {Promise<Buffer>}
 */
export async function profileToResumePdf(markdown) {
  const lines = stripEmDash(markdown).replace(/\r\n/g, "\n").split("\n");

  return renderToBuffer((doc) => {
    for (const raw of lines) {
      const line = raw.trimEnd();

      if (!line.trim()) {
        doc.moveDown(0.5);
        continue;
      }
      if (line.startsWith("# ")) {
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(18).fillColor("#000000").text(line.slice(2));
        continue;
      }
      if (line.startsWith("## ")) {
        doc.moveDown(0.6);
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#000000").text(line.slice(3));
        doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .strokeColor("#cccccc").lineWidth(0.5).stroke();
        doc.moveDown(0.3);
        continue;
      }
      if (line.startsWith("- ")) {
        renderInline(doc, `•  ${line.slice(2)}`, { indent: 14 });
        continue;
      }
      renderInline(doc, line, {});
    }
  });
}

// Minimal **bold** inline handling — splits on ** markers and toggles the
// bold font for alternating segments. No other markdown inline syntax is
// interpreted (deliberately simple — this isn't a general markdown renderer).
function renderInline(doc, text, { indent = 0 } = {}) {
  const segments = text.split("**");
  const startX = doc.page.margins.left + indent;
  doc.fontSize(10.5).fillColor("#000000");
  for (let i = 0; i < segments.length; i++) {
    const isBold = i % 2 === 1;
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica");
    const continued = i < segments.length - 1;
    if (i === 0) doc.text(segments[i], startX, doc.y, { continued });
    else doc.text(segments[i], { continued });
  }
}
