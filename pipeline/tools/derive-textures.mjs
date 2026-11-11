/**
 * Derive the secondary textures from the generated ones, so the ten façades/roofs share one look
 * without ten separate generations (each one is ~2 min of the local GPU).
 *
 *   node pipeline/tools/derive-textures.mjs
 *
 * Reads/writes pipeline/style/facades/*.png; every output also gets a 2×2 <name>.tile.png review sheet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "style", "facades");
const S = (name) => join(OUT, `${name}.png`);
const SIZE = 1024;

/** a flat colour wash over the texture, to push one look toward another */
const wash = (color, opacity, blend = "overlay") => {
  const svg = `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${color}" fill-opacity="${opacity}"/></svg>`;
  return { input: Buffer.from(svg), blend };
};

/** vertical or horizontal rules, for mullions and sheet seams */
const rules = (step, width, color, vertical = true, opacity = 0.5) => {
  const lines = [];
  for (let p = 0; p < SIZE; p += step) {
    lines.push(vertical
      ? `<rect x="${p}" y="0" width="${width}" height="${SIZE}" fill="${color}" fill-opacity="${opacity}"/>`
      : `<rect x="0" y="${p}" width="${SIZE}" height="${width}" fill="${color}" fill-opacity="${opacity}"/>`);
  }
  return { input: Buffer.from(`<svg width="${SIZE}" height="${SIZE}">${lines.join("")}</svg>`), blend: "over" };
};

async function build(name, from, ops, overlays, blur = 0) {
  let image = sharp(S(from)).resize(SIZE, SIZE, { fit: "cover" });
  if (blur) image = image.blur(blur);
  if (ops) image = image.modulate(ops);
  const buffer = await image.png().toBuffer();
  await sharp(buffer).composite(overlays).png({ compressionLevel: 9 }).toFile(S(name));
  const small = await sharp(S(name)).resize(512, 512).toBuffer();
  await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: "#ffffff" } })
    .composite([0, 1, 2, 3].map((i) => ({ input: small, left: (i % 2) * 512, top: Math.floor(i / 2) * 512 })))
    .png({ compressionLevel: 9 }).toFile(join(OUT, `${name}.tile.png`));
  console.log(`  ${name}  ← ${from}`);
}

// bauhaus: the same window grid, but a plain white institutional wall
await build("bauhaus-white", "residential-cream", { saturation: 0.18, brightness: 1.08 }, [wash("#f7f5ef", 0.45, "overlay")]);

// public stone: the office pier grid, warmed to beige stone
await build("public-stone", "office-glass", { saturation: 0.75, brightness: 0.98 }, [wash("#d8c9a8", 0.55, "overlay")]);

// tower: the office glazing, bluer, with a tall mullion rhythm
await build("tower-curtain", "office-glass", { saturation: 0.85, brightness: 1.02 }, [
  wash("#8fb4c4", 0.45, "overlay"),
  rules(96, 6, "#eef2f0", true, 0.5),
]);


// concrete roof: the metal roof's panel rhythm, desaturated to bitumen sheets
// a flat bitumen roof: the metal seams blurred away, darkened, with a faint sheet grid
await build("roof-concrete", "roof-metal", { saturation: 0.10, brightness: 0.92 }, [
  wash("#b8b2a4", 0.62, "overlay"),
  rules(320, 2, "#8e887b", true, 0.12),
  rules(320, 2, "#8e887b", false, 0.12),
], 40);
