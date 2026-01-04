import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";

function jsonResponse(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
  };
}

function safeParsePositions(rawText) {
  let t = String(rawText ?? "").trim();
  t = t.replace(/^\uFEFF/, "").trim();
  t = t.replace(/;+\s*$/, "").trim();

  try {
    return JSON.parse(t);
  } catch {}

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const objText = t.slice(first, last + 1);
    try {
      return JSON.parse(objText);
    } catch {}
  }

  throw new Error("layout-positions.json parse failed (invalid JSON/JS)");
}

function percentToRatio(str, def = 0) {
  if (!str) return def;
  const n = parseFloat(String(str).replace("%", "").trim());
  if (Number.isNaN(n)) return def;
  return n / 100;
}

function cleanText(v) {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCyrillic(s) {
  return /[А-ЯЁа-яё]/.test(String(s || ""));
}

function pickFirstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function wrapByWidth(text, font, size, maxWidth) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width <= maxWidth) line = test;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: "",
    };
  }

  const qs = event.queryStringParameters || {};
  const isDiag = String(qs.diag || "") === "1";
  const isFields = String(qs.fields || "") === "1";

  // разрешаем GET только для diag/fields
  if ((isDiag || isFields) && event.httpMethod === "GET") {
    // ok
  } else if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  let payload = {};
  if (event.httpMethod === "POST") {
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "bad_json" });
    }
  }

  const fields =
    payload.fields && typeof payload.fields === "object" ? payload.fields : {};

  const ROOT = "/var/task";

  // layout — берём ТОЛЬКО корень (чтобы не путаться с дубликатами)
  const LAYOUT_PATH = path.join(ROOT, "layout-positions.json");

  // template PDF (должен быть включен в bundle через netlify.toml included_files)
  const TEMPLATE_PATH = path.join(ROOT, "assets_rf2019", "template_rf2019.pdf");

  // font
  const CYR_TTF_PATH = pickFirstExisting([
    path.join(ROOT, "fonts", "DejaVuSerif.ttf"),
    path.join(ROOT, "fonts", "DejaVuSerif-Bold.ttf"),
  ]);

  // diag
  if (isDiag) {
    const stat = (p) => {
      try {
        const s = fs.statSync(p);
        return { path: p, bytes: s.size };
      } catch (e) {
        return { path: p, error: String(e?.message || e) };
      }
    };
    return jsonResponse(200, {
      cwd: process.cwd(),
      root_list: fs.readdirSync(ROOT),
      picked: {
        layout: stat(LAYOUT_PATH),
        template: stat(TEMPLATE_PATH),
        font: CYR_TTF_PATH ? stat(CYR_TTF_PATH) : null,
      },
      note:
        "Если template показывает error ENOENT — значит не попал в bundle. Проверь netlify.toml included_files.",
    });
  }

  // load layout
  let FIELD_POS = {};
  try {
    const raw = fs.readFileSync(LAYOUT_PATH, "utf8");
    const parsed = safeParsePositions(raw);
    FIELD_POS =
      parsed && parsed.pos && typeof parsed.pos === "object"
        ? parsed.pos
        : parsed && typeof parsed === "object"
        ? parsed
        : {};
  } catch (e) {
    return jsonResponse(500, {
      error: "layout_load_failed",
      message: String(e?.message || e),
      expected: "/var/task/layout-positions.json",
    });
  }

  // fields list
  if (isFields) {
    const layoutKeys = Object.keys(FIELD_POS).filter((k) =>
      String(k).startsWith("en_")
    );
    return jsonResponse(200, {
      layout_en_keys_count: layoutKeys.length,
      layout_en_keys: layoutKeys,
    });
  }

  // PDF
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      return jsonResponse(500, {
        error: "template_missing",
        message:
          "template_rf2019.pdf not found in /var/task/assets_rf2019/. Add it to repo and include via netlify.toml included_files.",
        expected_path: TEMPLATE_PATH,
      });
    }

    const templateBytes = fs.readFileSync(TEMPLATE_PATH);
    const pdfDoc = await PDFDocument.load(templateBytes);
    pdfDoc.registerFontkit(fontkit);

    const pages = pdfDoc.getPages();
    if (!pages.length) throw new Error("template has no pages");
    const page = pages[0]; // ✅ печатаем на первой странице шаблона

    const width = page.getWidth();
    const height = page.getHeight();

    // fonts
    const fontEN = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    let fontCYR = null;
    if (CYR_TTF_PATH) {
      try {
        fontCYR = await pdfDoc.embedFont(fs.readFileSync(CYR_TTF_PATH));
      } catch {
        fontCYR = null;
      }
    }

    const X_OFFSET = Number(process.env.PDF_X_OFFSET || 0.0);
    const Y_OFFSET = Number(process.env.PDF_Y_OFFSET || 0.014);
    const FONT_SCALE = Number(process.env.PDF_FONT_SCALE || 1.2);
    const BASE_SIZE = 12;

    function drawTextInBox(key, value) {
      const cfg = FIELD_POS[key];
      if (!cfg) return;

      const t = cleanText(value);
      if (!t) return;

      const leftRatio = percentToRatio(cfg.left, 0);
      const topRatio = percentToRatio(cfg.top, 0);
      const widthRatio = percentToRatio(cfg.width, 0.5);

      const xLeft = (leftRatio + X_OFFSET) * width;
      const boxW = widthRatio * width;
      const yBase = height - (topRatio + Y_OFFSET) * height;

      const hasCyr = hasCyrillic(t);
      const allowCyr = key === "en_series";
      if (hasCyr && !allowCyr) return;

      const usedFont = hasCyr ? (fontCYR || fontEN) : fontEN;

      let size = BASE_SIZE * FONT_SCALE;
      if (key === "en_series") size *= 0.85;

      // перенос по ширине
      const lines = wrapByWidth(t, usedFont, size, boxW);

      // максимум 3 строки, чтобы “весь текст появился”, но без разъезда
      const out = lines.length ? lines.slice(0, 3) : [t];
      const lineH = size * 1.15;

      for (let i = 0; i < out.length; i++) {
        const line = out[i];
        const tw = usedFont.widthOfTextAtSize(line, size);
        const x = xLeft + Math.max(0, (boxW - tw) / 2);
        page.drawText(line, { x, y: yBase - i * lineH, size, font: usedFont });
      }
    }

    // ✅ рисуем только те поля, которые реально есть в layout
    const layoutKeys = Object.keys(FIELD_POS).filter((k) =>
      String(k).startsWith("en_")
    );

    for (const key of layoutKeys) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        drawTextInBox(key, fields[key]);
      }
    }

    const pdfBytes = await pdfDoc.save();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="rf2019_translation.pdf"',
        "Access-Control-Allow-Origin": "*",
      },
      body: Buffer.from(pdfBytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return jsonResponse(500, {
      error: "pdf_failed",
      message: String(e?.message || e),
    });
  }
};
