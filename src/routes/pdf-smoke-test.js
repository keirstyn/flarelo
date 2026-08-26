import { PDFDocument, StandardFonts } from 'pdf-lib';

// TEMPORARY — confirm pdf-lib runs cleanly in a REAL DEPLOYED Worker
// before building the real PDF template. Delete this file + its route
// in src/index.js once confirmed.
export async function handlePdfSmokeTest() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Flarelo PDF smoke test — pdf-lib works.', { x: 20, y: 150, size: 16, font });
  page.drawText(new Date().toISOString(), { x: 20, y: 120, size: 10, font });

  const pdfBytes = await doc.save();
  return new Response(pdfBytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
}
