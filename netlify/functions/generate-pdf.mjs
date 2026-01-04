import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========================================
// HELPERS
// ========================================

function jsonResponse(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
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

  throw new Error("layout-positions.json parse failed");
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

// ✅ Умная загрузка файлов для Netlify
function findFile(filename, possibleDirs) {
  for (const dir of possibleDirs) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath)) {
      console.log(`✅ Found ${filename} at:`, fullPath);
      return fullPath;
    }
  }
  console.warn(`⚠️ ${filename} NOT FOUND in:`, possibleDirs);
  return null;
}

// ========================================
// MAIN HANDLER
// ========================================

export const handler = async (event) => {
  // CORS preflight
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
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "bad_json" });
  }

  const fields =
    payload.fields && typeof payload.fields === "object" ? payload.fields : {};
  const template = payload.template || "rf";

  console.log("📦 Received fields count:", Object.keys(fields).length);
  console.log("📦 Template:", template);

  // ✅ ПОИСК ФАЙЛОВ (Netlify меняет структуру при деплое)
  const possibleRoots = [
    "/var/task",
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../.."),
    process.cwd(),
  ];

  const possiblePublicDirs = possibleRoots.flatMap((root) => [
    path.join(root, "public"),
    path.join(root, "dist"),
    path.join(root, "assets"),
  ]);

  const possibleFontDirs = possibleRoots.map((root) =>
    path.join(root, "fonts")
  );

  console.log("🔍 Searching files in roots:", possibleRoots.slice(0, 3));

  // --- LAYOUT POSITIONS ---
  let LAYOUT_PATH = null;
  for (const root of possibleRoots) {
    const candidate = path.join(root, "layout-positions.json");
    if (fs.existsSync(candidate)) {
      LAYOUT_PATH = candidate;
      break;
    }
  }

  if (!LAYOUT_PATH) {
    return jsonResponse(500, {
      error: "layout_not_found",
      searched: possibleRoots.map((r) => path.join(r, "layout-positions.json")),
      cwd: process.cwd(),
      __dirname,
    });
  }

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

    console.log("✅ Loaded positions:", Object.keys(FIELD_POS).length, "fields");
  } catch (e) {
    return jsonResponse(500, {
      error: "layout_parse_failed",
      message: String(e?.message || e),
    });
  }

  // --- FIND FILES ---
  const BG_PATH =
    findFile("bg_en_rf.jpg", possiblePublicDirs) ||
    findFile("bg_en_rf.png", possiblePublicDirs);

  const SEAL_PATH = findFile("seal.png", possiblePublicDirs);
  const CYR_TTF_PATH = findFile("DejaVuSerif.ttf", possibleFontDirs);

  if (!BG_PATH) {
    console.warn("⚠️ Background image not found!");
  }

  // ========================================
  // PDF GENERATION
  // ========================================

  try {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const A4_W = 595.28;
    const A4_H = 841.89;
    const page = pdfDoc.addPage([A4_W, A4_H]);

    const width = page.getWidth();
    const height = page.getHeight();

    // ===== 1) BACKGROUND =====
    if (BG_PATH && fs.existsSync(BG_PATH)) {
      const bgBytes = fs.readFileSync(BG_PATH);

      let bgImg;
      try {
        bgImg = await pdfDoc.embedJpg(bgBytes);
      } catch {
        try {
          bgImg = await pdfDoc.embedPng(bgBytes);
        } catch (e) {
          console.warn("⚠️ Failed to embed background:", e.message);
          bgImg = null;
        }
      }

      if (bgImg) {
        // ✅ КРИТИЧНО: stretch на весь A4 (иначе координаты поедут)
        page.drawImage(bgImg, {
          x: 0,
          y: 0,
          width: A4_W,
          height: A4_H,
        });
        console.log("✅ Background drawn (stretched to A4)");
      }
    } else {
      console.warn("⚠️ Background not found or invalid path");
    }

    // ===== 2) SEAL =====
    if (SEAL_PATH && fs.existsSync(SEAL_PATH)) {
      const sealBytes = fs.readFileSync(SEAL_PATH);
      let sealImg;
      try {
        sealImg = await pdfDoc.embedPng(sealBytes);
      } catch {
        try {
          sealImg = await pdfDoc.embedJpg(sealBytes);
        } catch {
          sealImg = null;
        }
      }

      if (sealImg) {
        const sealW_base = 200;
        const sealH_base = 140;
        const scale = 0.95;
        const sealW = sealW_base * scale;
        const sealH = sealH_base * scale;
        const dyUp = 20;

        page.drawImage(sealImg, {
          x: width - sealW - 40,
          y: height - sealH - 40 + dyUp,
          width: sealW,
          height: sealH,
        });
        console.log("✅ Seal drawn");
      }
    }

    // ===== 3) FONTS =====
    const fontEN = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    let fontCYR = null;
    if (CYR_TTF_PATH && fs.existsSync(CYR_TTF_PATH)) {
      try {
        fontCYR = await pdfDoc.embedFont(fs.readFileSync(CYR_TTF_PATH));
        console.log("✅ Cyrillic font loaded");
      } catch (e) {
        console.warn("⚠️ Cyrillic font failed:", e.message);
      }
    }

    // ===== DRAWING HELPERS =====
    const X_OFFSET = 0.0;
    const Y_OFFSET = 0.014;
    const FONT_SCALE = 1.2;
    const BASE_SIZE = 12;

    function fitSize(
      text,
      size,
      minSize = 8,
      maxWidth = Infinity,
      usedFont = fontEN
    ) {
      let s = size;
      while (s > minSize) {
        const w = usedFont.widthOfTextAtSize(text, s);
        if (w <= maxWidth) break;
        s -= 0.5;
      }
      return s;
    }

    function drawInBox({
      text,
      xLeft,
      y,
      boxW,
      align = "center",
      size,
      allowCyrillic = false,
    }) {
      const t = cleanText(text);
      if (!t) return;

      const hasCyr = hasCyrillic(t);
      if (hasCyr && !allowCyrillic) return;

      const usedFont = hasCyr ? fontCYR || fontEN : fontEN;
      const s = fitSize(t, size, 8, boxW, usedFont);
      const tw = usedFont.widthOfTextAtSize(t, s);

      let x = xLeft;
      if (align === "center") x = xLeft + (boxW - tw) / 2;
      if (align === "right") x = xLeft + (boxW - tw);
      if (x < 0) x = 0;

      page.drawText(t, { x, y, size: s, font: usedFont });
    }

    function splitWords_5_8_9(text) {
      const w = cleanText(text).split(/\s+/).filter(Boolean);
      const l1 = w.slice(0, 5).join(" ");
      const l2 = w.slice(5, 13).join(" ");
      const l3 = w.slice(13, 22).join(" ");
      return { l1, l2, l3 };
    }

    function drawRegplace_5_8_9(key, value) {
      const cfg = FIELD_POS[key];
      if (!cfg) return;

      const leftRatio = percentToRatio(cfg.left, 0);
      const topRatio = percentToRatio(cfg.top, 0);
      const widthRatio = percentToRatio(cfg.width, 0.5);

      const xLeft = (leftRatio + X_OFFSET) * width;
      const boxW = widthRatio * width;
      const yTop = height - (topRatio + Y_OFFSET) * height;

      const size = BASE_SIZE * FONT_SCALE;
      const { l1, l2, l3 } = splitWords_5_8_9(value);

      const lineH = size * 1.22;
      const gap23 = 2;

      drawInBox({ text: l1, xLeft, y: yTop, boxW, align: "right", size });
      drawInBox({
        text: l2,
        xLeft,
        y: yTop - lineH,
        boxW,
        align: "right",
        size,
      });
      drawInBox({
        text: l3,
        xLeft,
        y: yTop - lineH * 2 - gap23,
        boxW,
        align: "center",
        size,
      });
    }

    function splitAfterWords(text, firstLineWords = 10) {
      const words = String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);

      if (words.length <= firstLineWords) return [words.join(" ")];

      const line1 = words.slice(0, firstLineWords).join(" ");
      const line2 = words.slice(firstLineWords).join(" ");
      return [line1, line2];
    }

    function drawStamp2Lines(key, value) {
      const cfg = FIELD_POS[key];
      if (!cfg) return;

      const leftRatio = percentToRatio(cfg.left, 0);
      const topRatio = percentToRatio(cfg.top, 0);
      const widthRatio = percentToRatio(cfg.width, 0.5);

      const xLeft = (leftRatio + X_OFFSET) * width;
      const boxW = widthRatio * width;
      const yTop = height - (topRatio + Y_OFFSET) * height;

      const normalSize = BASE_SIZE * FONT_SCALE;
      const stampSize = Math.max(7, normalSize * 0.65);

      const lines = splitAfterWords(value, 10);
      const lineH = stampSize * 1.2;

      drawInBox({
        text: lines[0] || "",
        xLeft,
        y: yTop,
        boxW,
        align: "center",
        size: stampSize,
      });

      if (lines[1]) {
        drawInBox({
          text: lines[1],
          xLeft,
          y: yTop - lineH,
          boxW,
          align: "center",
          size: stampSize,
        });
      }
    }

    function drawField(key) {
      const cfg = FIELD_POS[key];
      if (!cfg) return;

      if (key === "en_dob_words") return;

      const value = cleanText(fields[key]);
      if (!value) return;

      const leftRatio = percentToRatio(cfg.left, 0);
      const topRatio = percentToRatio(cfg.top, 0);
      const widthRatio = percentToRatio(cfg.width, 0.5);

      const xLeft = (leftRatio + X_OFFSET) * width;
      const boxW = widthRatio * width;
      const y = height - (topRatio + Y_OFFSET) * height;

      let fontSize = BASE_SIZE * FONT_SCALE;

      // ✅ серия меньше
      if (key === "en_series") {
        fontSize = fontSize * 0.85;
      }

      if (key === "en_regplace" || key === "en_regplace2") {
        drawRegplace_5_8_9(key, value);
        return;
      }

      if (key === "en_stamp_text") {
        drawStamp2Lines(key, fields[key]);
        return;
      }

      drawInBox({
        text: value,
        xLeft,
        y,
        boxW,
        align: "center",
        size: fontSize,
        allowCyrillic: key === "en_series",
      });
    }

    // Рисуем только en_*
    const keys = Object.keys(fields).filter((k) =>
      String(k).startsWith("en_")
    );
    console.log("📝 Drawing", keys.length, "fields");

    for (const key of keys) {
      if (FIELD_POS[key]) drawField(key);
    }

    const pdfBytes = await pdfDoc.save();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          'attachment; filename="birth_certificate_translation.pdf"',
        "Access-Control-Allow-Origin": "*",
      },
      body: Buffer.from(pdfBytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error("PDF generation failed:", e);
    return jsonResponse(500, {
      error: "pdf_failed",
      message: String(e?.message || e),
      stack: e?.stack,
    });
  }
};