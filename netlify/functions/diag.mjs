import fs from "fs";
import path from "path";

export const handler = async () => {
  const ROOT = process.cwd();          // /var/task
  const list = (p) => {
    try {
      return fs.readdirSync(p).map((name) => {
        const full = path.join(p, name);
        const st = fs.statSync(full);
        return st.isDirectory() ? name + "/" : name;
      });
    } catch (e) {
      return ["ERR: " + String(e?.message || e)];
    }
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(
      {
        cwd: ROOT,
        root_files: list(ROOT),
        public_files: list(path.join(ROOT, "public")),
        fonts_files: list(path.join(ROOT, "fonts")),
        has_layout: fs.existsSync(path.join(ROOT, "layout-positions.json")),
        has_bg: fs.existsSync(path.join(ROOT, "public", "bg_en_rf.png")),
        has_seal: fs.existsSync(path.join(ROOT, "public", "seal.png")),
        has_font: fs.existsSync(path.join(ROOT, "fonts", "DejaVuSerif.ttf")),
      },
      null,
      2
    ),
  };
};
