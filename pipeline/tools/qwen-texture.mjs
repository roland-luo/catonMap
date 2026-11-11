/**
 * Generate one flat-lit, tileable texture for the cartoon renderer with the local Qwen-Image 2.1
 * (ComfyUI on 127.0.0.1:8188), then trim it to a power-of-two PNG the renderer can mirror-tile.
 *
 *   node pipeline/tools/qwen-texture.mjs --list
 *   node pipeline/tools/qwen-texture.mjs --name factory-blue            # one image, the plan's rule
 *   node pipeline/tools/qwen-texture.mjs --name factory-blue --seed 7 --res 1024
 *   node pipeline/tools/qwen-texture.mjs --name test --prompt "flat grey square" --res 512 --dry
 *
 * Output: pipeline/style/facades/<name>.png        the texture (1024², sRGB, no alpha)
 *         pipeline/style/facades/<name>.tile.png   the same image tiled 2×2, to judge the seam
 *         pipeline/style/facades/raw/<name>.png    the model's own 1024² output, kept for re-trims
 *
 * Why one at a time: the local GPU runs a single generation, and every texture is reviewed before
 * the next one is spent on it (see pipeline/style/facades/README.md for the palette it must match).
 *
 * The graph, verified against this ComfyUI build (0.45.2):
 *   UNETLoader(qwen-image-2.1-UC-int8_convrot) → ModelSamplingAuraFlow(shift) → KSampler
 *   CLIPLoader(qwen3vl_8b_int8_convrot, type=qwen_image) → TextEncodeQwenImage21
 *     (positive, negative and an empty 1024² latent, so no EmptyLatent node is needed)
 *   KSampler → VAEDecode(qwen_image_2.1_vae_bf16) → SaveImage
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(HERE, "..");
const OUT = join(PIPELINE, "style", "facades");
const RAW = join(OUT, "raw");
const SPEC = join(PIPELINE, "style", "textures.json");
const HOST = process.env.COMFY_HOST ?? "http://127.0.0.1:8188";

const UNET = "qwen-image-2.1-UC-int8_convrot.safetensors";
const CLIP = "qwen3vl_8b_int8_convrot.safetensors";
const VAE = "qwen_image_2.1_vae_bf16.safetensors";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    prompt: { type: "string" },
    negative: { type: "string" },
    res: { type: "string" },
    steps: { type: "string" },
    cfg: { type: "string" },
    seed: { type: "string" },
    shift: { type: "string" },
    crop: { type: "string" },
    rotate: { type: "string" },
    "dry": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    reuse: { type: "boolean", default: false },
  },
});

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const defaults = {
  resolution: 1024, steps: 26, cfg: 4.0, shift: 3.1, seed: 20261111,
  negative: "photograph, photo, 3d render, perspective, vanishing point, cast shadow, drop shadow, "
    + "glossy reflection, specular highlight, gradient background, vignette, blurry, depth of field, "
    + "text, letters, numbers, signage, watermark, logo, people, cars, sky, ground plane, frame, border",
  ...spec.defaults,
};

if (args.list) {
  for (const item of spec.images) console.log(`${item.name.padEnd(22)} ${item.module ?? ""}  ${item.prompt.slice(0, 90)}…`);
  process.exit(0);
}

const item = args.name ? spec.images.find((i) => i.name === args.name) : null;
if (args.name && !item && !args.prompt) throw new Error(`no such texture: ${args.name} (--list shows them)`);
const name = args.name ?? "test";
const prompt = args.prompt ?? item?.prompt;
if (!prompt) throw new Error("--name of a spec entry, or --prompt");
const negative = args.negative ?? item?.negative ?? defaults.negative;
const resolution = Number(args.res ?? item?.resolution ?? defaults.resolution);
const steps = Number(args.steps ?? item?.steps ?? defaults.steps);
const cfg = Number(args.cfg ?? item?.cfg ?? defaults.cfg);
const shift = Number(args.shift ?? item?.shift ?? defaults.shift);
const seed = Number(args.seed ?? defaults.seed);

const graph = {
  1: { class_type: "UNETLoader", inputs: { unet_name: UNET, weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: CLIP, type: "qwen_image" } },
  3: { class_type: "VAELoader", inputs: { vae_name: VAE } },
  4: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift } },
  5: {
    class_type: "TextEncodeQwenImage21",
    inputs: { clip: ["2", 0], prompt, negative_prompt: negative, resolution, vae: ["3", 0] },
  },
  6: {
    class_type: "KSampler",
    inputs: {
      model: ["4", 0], seed, steps, cfg, sampler_name: "euler", scheduler: "simple",
      positive: ["5", 0], negative: ["5", 1], latent_image: ["5", 2], denoise: 1.0,
    },
  },
  7: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
  8: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: `iw-${name}` } },
};

if (args.dry) {
  console.log(JSON.stringify(graph, null, 2));
  process.exit(0);
}

async function api(path, init) {
  const response = await fetch(`${HOST}${path}`, init);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 800)}`);
  return response.json();
}

const rawPath = join(RAW, `${name}.png`);
const started = Date.now();
if (args.reuse && existsSync(rawPath)) {
  console.log(`[${name}] reusing ${rawPath}`);
} else {
console.log(`[${name}] ${resolution}² · ${steps} steps · seed ${seed}`);
const queued = await api("/prompt", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: graph, client_id: `iw-texture-${process.pid}` }),
});
if (queued.node_errors && Object.keys(queued.node_errors).length) {
  throw new Error(`graph rejected: ${JSON.stringify(queued.node_errors).slice(0, 1200)}`);
}
const id = queued.prompt_id;
let entry = null;
for (let i = 0; i < 1800; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const history = await api(`/history/${id}`);
  entry = history[id];
  if (entry?.status?.status_str === "error") throw new Error(`generation failed: ${JSON.stringify(entry.status.messages ?? entry.status).slice(0, 1200)}`);
  if (entry?.outputs && Object.keys(entry.outputs).length) break;
  if (i % 15 === 14) console.log(`  … ${Math.round((Date.now() - started) / 1000)}s`);
}
if (!entry?.outputs) throw new Error("timed out waiting for the image");
const image = Object.values(entry.outputs).flatMap((o) => o.images ?? [])[0];
if (!image) throw new Error("no image in the result");

const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
const view = await fetch(`${HOST}/view?${query}`);
if (!view.ok) throw new Error(`/view: ${view.status}`);
const raw = Buffer.from(await view.arrayBuffer());

mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(rawPath, raw);
console.log(`  raw  ${join("pipeline/style/facades/raw", `${name}.png`)}  (${(raw.length / 1024).toFixed(0)} kB, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
}

/* ---- trim to the texture ---- */

// The model paints a 1024² "elevation". A spec entry may cut a band out of it (crop = fractions of
// the raw image: [left, top, width, height]) to keep whole floors/bays, and rotate a roof drawn
// askew. The result is a square, so the shader can mirror-tile it in both directions.
const cropRaw = args.crop ?? item?.crop ?? "";
const crop = Array.isArray(cropRaw) ? cropRaw : String(cropRaw).split(",").filter(Boolean).map(Number);
const out = join(OUT, `${name}.png`);
if (existsSync(out) && !args.force && !args.prompt) console.log(`  keep ${out} (--force re-trims)`);
else {
  let image = sharp(rawPath);
  const meta = await image.metadata();
  if (crop.length === 4) {
    const [l, t, w, h] = crop;
    image = sharp(rawPath).extract({
      left: Math.round(l * meta.width), top: Math.round(t * meta.height),
      width: Math.round(w * meta.width), height: Math.round(h * meta.height),
    });
  }
  const rotate = args.rotate ?? item?.rotate;
  if (rotate) image = image.rotate(Number(rotate), { background: "#ffffff" });
  await image.resize(1024, 1024, { fit: "cover", kernel: "lanczos3" }).removeAlpha().png({ compressionLevel: 9 }).toFile(out);
  console.log(`  tex  ${join("pipeline/style/facades", `${name}.png`)}`);
}

// 2×2 tiling at 1:2 scale: the seam is what the review looks at, not the middle of the image
const tile = join(OUT, `${name}.tile.png`);
await sharp(out).resize(512, 512).toBuffer()
  .then((small) => sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
    .composite([0, 1, 2, 3].map((i) => ({ input: small, left: (i % 2) * 512, top: Math.floor(i / 2) * 512 })))
    .png({ compressionLevel: 9 }).toFile(tile));
console.log(`  tile ${join("pipeline/style/facades", `${name}.tile.png`)}`);
