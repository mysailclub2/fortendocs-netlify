import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "method_not_allowed" }),
    };
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "bad_json" }),
    };
  }

  const fields = payload.fields || {};

  // --- загрузка layout ---
  const layoutPath = path.join(process.cwd(), "layout-positions.json");
  const layoutRaw = fs.readFileSync(layoutPath, "utf8");
  const layoutJson = JSON.parse(layoutRaw);
  const POS = layoutJson.pos || layoutJson;

  // --- PDF ---
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const width = page.getWidth();
  const height = page.getHeight();

  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const BASE_SIZE = 12;

  const percent = (v) => parseFloat(String(v).replace("%", "")) / 100;

  for (const key of Object.keys(fields)) {
    if (!POS[key]) continue;

    const text = String(fields[key] || "").trim();
    if (!text) continue;

    const cfg = POS[key];
    const x = percent(cfg.left) * width;
    const y = height - percent(cfg.top) * height;
    const boxW = percent(cfg.width || "50%") * width;

    let size = BASE_SIZE;
    if (key === "en_series") size = 10;

    page.drawText(text, {
      x,
      y,
      size,
      font,
      maxWidth: boxW,
    });
  }

  const pdfBytes = await pdfDoc.save();

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Access-Control-Allow-Origin": "*",
    },
    body: Buffer.from(pdfBytes).toString("base64"),
    isBase64Encoded: true,
  };
};
