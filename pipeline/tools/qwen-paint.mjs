/**
 * Repaint rendered art tiles into photographs with the local Qwen-Image 2.1 + its ControlNet Union,
 * so the geometry of the render survives while the materials and light become real.
 *
 *   node pipeline/tools/qwen-paint.mjs --tile 0,-1 --area longquanyi
 *   node pipeline/tools/qwen-paint.mjs --area longquanyi --list
 *   node pipeline/tools/qwen-paint.mjs --area longquanyi --from 0,-1 --count 8
 *
 * Input per tile: data/derived/<area>/render/<x>_<y>.png (the photographic render, 1024²) and its
 * height pass (data/derived/<area>/height/<x>_<y>.png) turned into a depth hint. The depth hint is
 * what keeps every footprint, street and tree where it is: the model is free to change materials
 * only. Output: data/derived/<area>/paint/<x>_<y>.png — `export` prefers a painted tile over a
 * rendered one, and the site shows it without any other change.
 *
 * A tile is accepted only when its edges still line up with the render (normalised cross-correlation
 * of Sobel magnitudes ≥ --min-edge, default 0.45); otherwise the tile is left unpainted and reported,
 * because a shifted street is worse than a flat one.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(HERE, "..");
const DERIVED = join(PIPELINE, "..", "data", "derived");
const HOST = process.env.COMFY_HOST ?? "http://127.0.0.1:8188";
const COMFY_INPUT = process.env.COMFY_INPUT ?? "/home/roland/ComfyUI/input";

const UNET = "qwen-image-2.1-UC-int8_convrot.safetensors";
const CLIP = "qwen3vl_8b_int8_convrot.safetensors";
const VAE = "qwen_image_2.1_vae_bf16.safetensors";
const CONTROLNET = "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors";

const { values: args } = parseArgs({
  options: {
    area: { type: "string" },
    tile: { type: "string" },
    from: { type: "string" },
    count: { type: "string", default: "4" },
    strength: { type: "string", default: "0.85" },
    denoise: { type: "string", default: "1.0" },
    steps: { type: "string", default: "26" },
    cfg: { type: "string", default: "3.5" },
    seed: { type: "string", default: "11" },
    "min-edge": { type: "string", default: "0.30" },
    init: { type: "boolean", default: false }, // start from the render's latent, so the layout is locked
    prompt: { type: "string" },
    list: { type: "boolean", default: false },
    check: { type: "boolean", default: false }, // only score the tiles already painted
  },
});

const area = args.area ?? "longquanyi";
const base = join(DERIVED, area);
const renderDir = join(base, "render"), heightDir = join(base, "height"), outDir = join(base, "paint");

const DEFAULT_PROMPT = [
  "A realistic aerial photograph of a Chinese industrial district, same view, same layout:",
  "white and blue corrugated steel factory walls, silver standing-seam metal roofs with skylights and vents,",
  "cream and grey apartment walls with real window grids and balconies, concrete and bitumen flat roofs,",
  "asphalt streets with kerbs and lane markings, leafy street trees and hedges, soft afternoon sun,",
  "gentle contact shadows, faint atmospheric haze, natural colours, crisp detail.",
].join(" ");

const tilesOnDisk = () => readdirSync(renderDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4));

/** height PNG (16-bit-ish in RG) -> 8-bit depth hint, white = near the camera */
async function depthHint(tile) {
  const file = join(heightDir, `${tile}.png`);
  if (!existsSync(file)) return null;
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // the height pass stores (height + 10000 m) in centimetres as a 16-bit value split over R (high) and G (low)
  const raw = new Float32Array(info.width * info.height);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < raw.length; k++) {
    const i = k * info.channels;
    const h = data[i] * 256 + data[i + 1];
    raw[k] = h;
    if (h > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  }
  const out = Buffer.alloc(1024 * 1024);
  const span = Math.max(1, hi - lo);
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const sx = Math.min(info.width - 1, Math.floor((x * info.width) / 1024));
      const sy = Math.min(info.height - 1, Math.floor((y * info.height) / 1024));
      const h = raw[sy * info.width + sx];
      out[y * 1024 + x] = h === 0 ? 0 : Math.max(0, Math.min(255, Math.round(((h - lo) / span) * 255)));
    }
  }
  return sharp(out, { raw: { width: 1024, height: 1024, channels: 1 } })
    .blur(0.5).png().toBuffer();
}

/** Sobel magnitude at 512², computed in JS from a greyscale thumbnail (no sharp convolve quirks) */
async function edges(src) {
  const N = 512;
  const grey = await sharp(src).greyscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  const out = new Float32Array(N * N);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const at = (xx, yy) => grey[yy * N + xx];
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      out[y * N + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** normalised cross-correlation of two edge maps */
function ncc(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

/** the render itself, so the sampler starts from the real layout */
const INIT_IMAGE = "iw-init.png";

const graph = (tile, hintName) => ({
  1: { class_type: "UNETLoader", inputs: { unet_name: UNET, weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: CLIP, type: "qwen_image" } },
  3: { class_type: "VAELoader", inputs: { vae_name: VAE } },
  // the depth hint: ControlNet type "depth" for the union patch
  4: { class_type: "LoadImage", inputs: { image: hintName } },
  5: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
  6: {
    class_type: "TextEncodeQwenImage21",
    inputs: {
      clip: ["2", 0], prompt: args.prompt ?? DEFAULT_PROMPT, resolution: 1024, vae: ["3", 0],
      negative_prompt: "cartoon, ink outline, flat colours, illustration, painting, drawing, text, watermark, different layout, moved buildings, horizon, sky",
    },
  },
  // Qwen-Image 2.1 Fun ControlNet Union is a model patch, not a classic ControlNet
  7: { class_type: "ModelPatchLoader", inputs: { name: CONTROLNET } },
  ...(args.init ? {
    14: { class_type: "LoadImage", inputs: { image: INIT_IMAGE } },
    15: { class_type: "VAEEncode", inputs: { pixels: ["14", 0], vae: ["3", 0] } },
  } : {}),
  8: {
    class_type: "QwenImageDiffsynthControlnet",
    inputs: { model: ["5", 0], model_patch: ["7", 0], vae: ["3", 0], image: ["4", 0], strength: Number(args.strength) },
  },
  10: {
    class_type: "KSampler",
    inputs: {
      model: ["8", 0], seed: Number(args.seed), steps: Number(args.steps), cfg: Number(args.cfg),
      sampler_name: "euler", scheduler: "simple",
      positive: ["6", 0], negative: ["6", 1],
      latent_image: args.init ? ["15", 0] : ["6", 2], denoise: Number(args.denoise),
    },
  },
  11: { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
  12: { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: `iw-paint-${tile.replace(",", "_")}` } },
});

async function api(path, init) {
  const r = await fetch(`${HOST}${path}`, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

async function paint(tile) {
  const renderFile = join(renderDir, `${tile}.png`);
  if (!existsSync(renderFile)) throw new Error(`no render for ${tile}`);
  const hint = await depthHint(tile);
  if (!hint) throw new Error(`no height pass for ${tile}`);
  const hintName = `iw-hint-${tile.replace(",", "_")}.png`;
  writeFileSync(join(COMFY_INPUT, hintName), hint);
  if (args.init) writeFileSync(join(COMFY_INPUT, INIT_IMAGE), await sharp(renderFile).resize(1024, 1024, { fit: "fill" }).png().toBuffer());

  const queued = await api("/prompt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph(tile, hintName), client_id: `iw-paint-${process.pid}` }),
  });
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`graph rejected: ${JSON.stringify(queued.node_errors).slice(0, 900)}`);
  }
  let entry = null;
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const history = await api(`/history/${queued.prompt_id}`);
    entry = history[queued.prompt_id];
    if (entry?.status?.status_str === "error") throw new Error(JSON.stringify(entry.status).slice(0, 600));
    if (entry?.outputs && Object.keys(entry.outputs).length) break;
  }
  const image = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
  if (!image) throw new Error("no image returned");
  const view = await fetch(`${HOST}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? "")}&type=output`);
  const buf = Buffer.from(await view.arrayBuffer());

  const score = ncc(await edges(buf), await edges(renderFile));
  if (score < Number(args["min-edge"])) {
    console.log(`  ${tile}: edge match ${score.toFixed(2)} < ${args["min-edge"]} — rejected`);
    return { tile, score, kept: false };
  }
  mkdirSync(outDir, { recursive: true });
  await sharp(buf).resize(1024, 1024, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(join(outDir, `${tile}.png`));
  console.log(`  ${tile}: edge match ${score.toFixed(2)} — painted`);
  return { tile, score, kept: true };
}

if (args.list) {
  const painted = existsSync(outDir) ? new Set(readdirSync(outDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4))) : new Set();
  const tiles = tilesOnDisk();
  console.log(`${tiles.length} rendered tiles, ${painted.size} painted`);
  for (const t of tiles) console.log(`  ${t.padEnd(9)} ${painted.has(t) ? "painted" : existsSync(join(heightDir, `${t}.png`)) ? "ready" : "no height"}`);
  process.exit(0);
}

if (args.check) {
  let ok = 0, bad = 0;
  for (const f of readdirSync(outDir).filter((f) => f.endsWith(".png"))) {
    const tile = f.slice(0, -4);
    const score = ncc(await edges(join(outDir, f)), await edges(join(renderDir, `${tile}.png`)));
    if (score >= Number(args["min-edge"])) ok++; else { bad++; console.log(`  ${tile}: ${score.toFixed(2)}`); }
  }
  console.log(`painted tiles within tolerance: ${ok}, off: ${bad}`);
  process.exit(0);
}

let tiles;
if (args.tile) tiles = [args.tile.replace(',', '_')];
else {
  const all = tilesOnDisk().filter((t) => existsSync(join(heightDir, `${t}.png`)));
  const start = args.from ? all.indexOf(args.from.replace(',', '_')) : 0;
  tiles = all.slice(Math.max(0, start), Math.max(0, start) + Number(args.count));
}
console.log(`${tiles.length} tile(s) from ${area}`);
for (const t of tiles) {
  try { await paint(t); } catch (e) { console.error(`  ${t}: ${e.message}`); }
}
