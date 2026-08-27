import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const legalText = (dateStr) =>
  `This report reflects inspection results entered by the technician on ${dateStr}. Flarelo does not perform inspections and is not responsible for their accuracy.`;

export async function generateInspectionPdf({
  companyName,
  siteName,
  assetLabel,
  assetType,
  technicianEmail,
  submittedAt,
  checklist,
  answers,
  signaturePngBytes,
}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const left = 50;

  const drawLine = (text, { bold = false, size = 11, gap = 18 } = {}) => {
    page.drawText(text, { x: left, y, size, font: bold ? boldFont : font, color: rgb(0, 0, 0) });
    y -= gap;
  };

  const dateStr = new Date(submittedAt).toISOString().slice(0, 10);

  drawLine('Inspection Report', { bold: true, size: 20, gap: 30 });
  drawLine(`Company: ${companyName}`);
  drawLine(`Site: ${siteName}`);
  drawLine(`Asset: ${assetLabel} (${assetType})`);
  drawLine(`Technician: ${technicianEmail}`);
  drawLine(`Date: ${dateStr}`, { gap: 30 });

  drawLine('Checklist', { bold: true, size: 14, gap: 22 });
  for (const item of checklist) {
    const answer = answers.find((a) => a.item_id === item.id);
    const status = answer ? answer.status.toUpperCase() : 'N/A';
    drawLine(`[${status}] ${item.label}`);
    if (answer?.notes) drawLine(`    Notes: ${answer.notes}`, { size: 10 });
  }

  y -= 20;
  if (signaturePngBytes) {
    const sigImage = await doc.embedPng(signaturePngBytes);
    const sigDims = sigImage.scale(0.5);
    page.drawImage(sigImage, { x: left, y: y - sigDims.height, width: sigDims.width, height: sigDims.height });
    y -= sigDims.height + 10;
    drawLine('Technician signature', { size: 9 });
  }

  y -= 20;
  page.drawText(legalText(dateStr), { x: left, y, size: 8, font, maxWidth: 500, lineHeight: 10 });

  return doc.save();
}
