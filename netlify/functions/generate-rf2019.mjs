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
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// перенос текста по ширине бокса
function wrapByWidth(text, font, size, maxWidth) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let line = "";

  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width <= maxWidth) {
      line = test;
    } else {
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
  const isDiag = String(qs.diag || "") === "1";      // файловая диагностика
  const isFields = String(qs.fields || "") === "1";  // показать список полей из layout

  // ✅ для diag/fields разрешаем GET
  if ((isDiag || isFields) && event.httpMethod === "GET") {
    // просто упадём ниже в общий код, payload будет пустой — и вернём диагностику/поля
  } else {
    // для генерации PDF оставляем только POST
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }
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

  // ✅ Netlify runtime root
  const ROOT = "/var/task";
  const PUBLIC_DIR = path.join(ROOT, "public");
  const LAYOUT_PATH = path.join(ROOT, "layout-positions.json");
  const SEAL_PATH = path.join(PUBLIC_DIR, "seal.png");
  const CYR_TTF_PATH = path.join(ROOT, "fonts", "DejaVuSerif.ttf");

  const BG_PICKED = pickFirstExisting([
    path.join(PUBLIC_DIR, "bg_en_rf.jpg"),
    path.join(PUBLIC_DIR, "bg_en_rf.jpeg"),
    path.join(PUBLIC_DIR, "bg_en_rf.png"),
  ]);

  // --- load layout positions ---
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
      expected_path: "/var/task/layout-positions.json",
    });
  }

  // ✅ показать список полей, которые есть в layout (чтобы ты знал что отправлять)
  if (isFields) {
    const layoutKeys = Object.keys(FIELD_POS).filter((k) => String(k).startsWith("en_"));
    const sentKeys = Object.keys(fields || {});
    const missingInRequest = layoutKeys.filter((k) => !sentKeys.includes(k));
    const unknownInRequest = sentKeys.filter((k) => !layoutKeys.includes(k));

    return jsonResponse(200, {
      layout_en_keys_count: layoutKeys.length,
      layout_en_keys: layoutKeys,
      sent_keys_count: sentKeys.length,
      missing_in_request_count: missingInRequest.length,
      missing_in_request_sample: missingInRequest.slice(0, 40),
      unknown_in_request_count: unknownInRequest.length,
      unknown_in_request_sample: unknownInRequest.slice(0, 40),
    });
  }

  // ✅ диагностика файлов (фон/печать/шрифт/лейаут)
  if (isDiag) {
    const listDir = (p) => {
      try {
        return { exists: fs.existsSync(p), items: fs.readdirSync(p) };
      } catch (e) {
        return { exists: false, error: String(e?.message || e) };
      }
    };

    const stat = (p) => {
      try {
        if (!p) return null;
        const s = fs.statSync(p);
        return { path: p, bytes: s.size };
      } catch (e) {
        return { path: p, error: String(e?.message || e) };
      }
    };

    return jsonResponse(200, {
      cwd: process.cwd(),
      ROOT,
      PUBLIC_DIR,
      root_list: listDir(ROOT),
      public_list: listDir(PUBLIC_DIR),
      files: {
        layout: stat(LAYOUT_PATH),
        bg: stat(BG_PICKED),
        seal: stat(SEAL_PATH),
        font: stat(CYR_TTF_PATH),
      },
      bg_picked: BG_PICKED,
    });
  }

  // ---------- PDF ----------
  try {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const A4_W = 595.28;
    const A4_H = 841.89;
    const page = pdfDoc.addPage([A4_W, A4_H]);

    const width = page.getWidth();
    const height = page.getHeight();

    // ===== 1) BACKGROUND: строго на всю A4 (0,0,width,height) =====
    if (!BG_PICKED || !fs.existsSync(BG_PICKED)) {
      return jsonResponse(500, {
        error: "bg_not_found",
        message: "No background found in /public. Put bg_en_rf.jpg there and redeploy.",
      });
    }

    const bgBytes = fs.readFileSync(BG_PICKED);
    const bgImg = BG_PICKED.toLowerCase().endsWith(".png")
      ? await pdfDoc.embedPng(bgBytes)
      : await pdfDoc.embedJpg(bgBytes);

    page.drawImage(bgImg, { x: 0, y: 0, width, height });

    // ===== 2) SEAL =====
    if (fs.existsSync(SEAL_PATH)) {
      const sealBytes = fs.readFileSync(SEAL_PATH);
      const sealImg = await pdfDoc.embedPng(sealBytes);

      const sealW = 190;
      const sealH = 133;
      const dyUp = 20;

      page.drawImage(sealImg, {
        x: width - sealW - 40,
        y: height - sealH - 40 + dyUp,
        width: sealW,
        height: sealH,
      });
    }

    // ===== 3) FONTS =====
    const fontEN = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    let fontCYR = null;
    if (fs.existsSync(CYR_TTF_PATH)) {
      try {
        fontCYR = await pdfDoc.embedFont(fs.readFileSync(CYR_TTF_PATH));
      } catch {
        fontCYR = null;
      }
    }

    // ===== offsets/scale =====
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

      // шрифт
      const hasCyr = hasCyrillic(t);
      const allowCyr = key === "en_series";
      if (hasCyr && !allowCyr) return;

      const usedFont = hasCyr ? (fontCYR || fontEN) : fontEN;

      // размер
      let size = BASE_SIZE * FONT_SCALE;
      if (key === "en_series") size *= 0.85; // как просил

      // перенос в 2 строки (универсально) если не влезло
      const lines = wrapByWidth(t, usedFont, size, boxW);
      const maxLines = 2;

      // если одна строка — рисуем по центру
      if (lines.length <= 1) {
        const tw = usedFont.widthOfTextAtSize(t, size);
        const x = xLeft + Math.max(0, (boxW - tw) / 2);
        page.drawText(t, { x, y: yBase, size, font: usedFont });
        return;
      }

      // две строки
      const out = lines.slice(0, maxLines);
      const lineH = size * 1.15;

      for (let i = 0; i < out.length; i++) {
        const line = out[i];
        const tw = usedFont.widthOfTextAtSize(line, size);
        const x = xLeft + Math.max(0, (boxW - tw) / 2);
        page.drawText(line, { x, y: yBase - i * lineH, size, font: usedFont });
      }
    }

    // ✅ главное изменение: рисуем по layout-positions, а не по присланным ключам
    const layoutKeys = Object.keys(FIELD_POS).filter((k) => String(k).startsWith("en_"));

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
    return jsonResponse(500, { error: "pdf_failed", message: String(e?.message || e) });
  }
};
