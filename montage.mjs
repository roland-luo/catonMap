import sharp from "sharp";
import { readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, out, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg || 200);
const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
const ts = files.map((f) => f.replace(".png", "").split("_").map(Number));
const x0 = Math.min(...ts.map((t) => t[0])), y0 = Math.min(...ts.map((t) => t[1]));
const x1 = Math.max(...ts.map((t) => t[0])), y1 = Math.max(...ts.map((t) => t[1]));
const W = (x1 - x0 + 1) * size, H = (y1 - y0 + 1) * size;
const composite = [];
for (const f of files) {
  const [x, y] = f.replace(".png", "").split("_").map(Number);
  composite.push({ input: await sharp(join(dir, f)).resize(size, size).png().toBuffer(), left: (x - x0) * size, top: (y - y0) * size });
}
await sharp({ create: { width: W, height: H, channels: 3, background: "#efe8d8" } }).composite(composite).jpeg({ quality: 88 }).toFile(out);
console.log(out, W, H);
