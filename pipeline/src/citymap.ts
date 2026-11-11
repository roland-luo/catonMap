/**
 * A whole-municipality overview card: the 16 districts, the Yangtze estuary, the Huangpu and the
 * detailed central rectangle, drawn from OSM boundaries/water into one paper-coloured PNG.
 *
 *   npm -w pipeline exec tsx src/citymap.ts
 *
 * Output: web/public/city/shanghai-overview.png (served by the site; shown by the 全市域 button).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ROOT } from "./paths.ts";

type P = { lat: number; lon: number };
const districts = JSON.parse(readFileSync(join(ROOT, "data/raw/boundaries/shanghai-municipality.json"), "utf8")).elements;
const water = JSON.parse(readFileSync(join(ROOT, "data/raw/boundaries/shanghai-water.json"), "utf8")).elements;

const eq = (a: P, b: P) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
/** join ways (outer members) into closed rings */
function stitch(ways: P[][]): P[][] {
  const left = ways.map((w) => [...w]), rings: P[][] = [];
  while (left.length) {
    const ring = left.shift()!;
    let grown = true;
    while (!eq(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i], end = ring[ring.length - 1];
        if (eq(w[0], end)) ring.push(...w.slice(1));
        else if (eq(w[w.length - 1], end)) ring.push(...w.reverse().slice(1));
        else continue;
        left.splice(i, 1); grown = true; break;
      }
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
/** The land bbox of the municipality; maritime boundary members run far into the sea and are dropped. */
const IN = (p: P) => p.lat > 30.6 && p.lat < 31.95 && p.lon > 120.75 && p.lon < 122.15;
const clean = (m: any) => m.type === "way" && m.geometry && m.geometry.filter(IN).length >= m.geometry.length * 0.9;
function ringsOf(el: any): P[][] {
  if (el.type === "way") return el.geometry && el.geometry.filter(IN).length >= el.geometry.length * 0.9 ? [el.geometry.filter(IN)] : [];
  const ways = (el.members ?? []).filter((m: any) => m.role !== "inner" && clean(m)).map((m: any) => m.geometry.filter(IN));
  const inner = (el.members ?? []).filter((m: any) => m.role === "inner" && clean(m)).map((m: any) => m.geometry.filter(IN));
  return [...stitch(ways), ...stitch(inner)];
}

const districtShapes = districts.map((d: any) => ({ name: d.tags?.name ?? d.tags?.["name:en"] ?? "", rings: ringsOf(d) })).filter((d: any) => d.rings.length);
const riverShapes = water.filter((w: any) => w.tags?.waterway === "riverbank" || w.tags?.natural === "water").flatMap((w: any) => ringsOf(w));
const coastLines = water.filter((w: any) => w.tags?.natural === "coastline").map((w: any) => w.geometry as P[]).filter(Boolean);

// the municipality's land frame (the sea fills the rest of the paper)
const lat0 = 30.67, lat1 = 31.90, lon0 = 120.85, lon1 = 122.05;
const pad = 0, W = 1400, H = Math.round((W * ((lat1 - lat0) + 2 * pad) * 110900) / (((lon1 - lon0) + 2 * pad) * 95200));
const kx = W / ((lon1 - lon0) + 2 * pad), ky = H / ((lat1 - lat0) + 2 * pad);
const X = (lon: number) => (lon - lon0 + pad) * kx, Y = (lat: number) => (lat1 + pad - lat) * ky;
const path = (ring: P[], close = true) => `M${ring.map((p) => `${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}`).join("L")}${close ? "Z" : ""}`;

/** a point comfortably inside a ring: the grid point farthest from its edges (coarse) */
function labelPoint(ring: P[]): [number, number] {
  const xs = ring.map((p) => X(p.lon)), ys = ring.map((p) => Y(p.lat));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = [X(ring[i].lon), Y(ring[i].lat)], [xj, yj] = [X(ring[j].lon), Y(ring[j].lat)];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const edge = (x: number, y: number) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = X(ring[j].lon), ay = Y(ring[j].lat), bx = X(ring[i].lon), by = Y(ring[i].lat);
      const L = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }
    return d;
  };
  let best: [number, number] = [x0, y0], bd = -1;
  for (let i = 0; i <= 30; i++) for (let j = 0; j <= 30; j++) {
    const x = x0 + ((x1 - x0) * i) / 30, y = y0 + ((y1 - y0) * j) / 30;
    if (!inside(x, y)) continue;
    const d = edge(x, y);
    if (d > bd) { bd = d; best = [x, y]; }
  }
  return best;
}

// ---- land/sea from Copernicus DEM (the district polygons' maritime boundaries make straight cuts) ----
const DEM_DIR = join(ROOT, "data/raw/dem");
const demTiles = new Map<string, Float32Array>();
for (const f of readdirSync(DEM_DIR).filter((f) => f.endsWith(".tif"))) {
  const m = f.match(/N(\d+)_00_E(\d+)_00/);
  if (!m) continue;
  const { data } = await sharp(join(DEM_DIR, f)).extractChannel(0).raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
  demTiles.set(`${Number(m[1])}_${Number(m[2])}`, new Float32Array(data.buffer, data.byteOffset, data.length / 4));
}
const demAt = (lat: number, lon: number) => {
  const t = demTiles.get(`${Math.floor(lat)}_${Math.floor(lon)}`);
  if (!t) return -1;
  const fx = (lon - Math.floor(lon)) * 3600, fy = (Math.floor(lat) + 1 - lat) * 3600;
  const ix = Math.min(3598, Math.max(0, Math.floor(fx))), iy = Math.min(3598, Math.max(0, Math.floor(fy)));
  return t[iy * 3600 + ix];
};
let land = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const lon = lon0 - pad + x / kx, lat = lat1 + pad - y / ky;
  land[y * W + x] = demAt(lat, lon) > 0.8 ? 1 : 0;
}
/** square morphology (the DEM has thousands of 1-px canals and ponds that read as noise at card scale) */
function morph(src: Uint8Array, r: number, dilate: boolean) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let hit = 0;
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const v = src[ny * W + nx];
      if (dilate ? v === 1 : v === 0) hit = 1;
    }
    out[y * W + x] = dilate ? (hit ? 1 : 0) : (hit ? 0 : 1);
  }
  return out;
}
// majority filter removes the speckle, then close (dilate → erode) the thin canals
for (let pass = 0; pass < 2; pass++) {
  const next = new Uint8Array(land.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) n += land[ny * W + nx];
    }
    next[y * W + x] = n >= 5 ? 1 : 0;
  }
  land = next;
}
land = morph(morph(land, 2, true), 2, false);
const mask = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, isLand = land[i];
  const edge = (x > 0 && land[i - 1] !== isLand) || (x + 1 < W && land[i + 1] !== isLand) ||
    (y > 0 && land[i - W] !== isLand) || (y + 1 < H && land[i + W] !== isLand);
  const c = edge ? [124, 172, 186] : isLand ? [239, 232, 216] : [188, 216, 222];
  mask[i * 3] = c[0]; mask[i * 3 + 1] = c[1]; mask[i * 3 + 2] = c[2];
}
const maskPng = await sharp(mask, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();

const PAPER = "#efe8d8", SEA = "#bcd8de", WATER = "#2f7f99", INK = "#4a4438", BORDER = "#8a7d63";
const FILLS = ["#e7dcc6", "#e2d6bf", "#eadfc9", "#dfd4bd", "#e5d9c1", "#e9ddc7"];

// the detailed 3D region, from places.ts
const core: [number, number, number, number] = [31.194, 121.438, 31.270, 121.536];
const [cs, cw, cn, ce] = core;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${districtShapes.map((d: any) =>
    `<path d="${d.rings.map((r: P[]) => path(r)).join(" ")}" fill="none" stroke="${BORDER}" stroke-width="1.1" stroke-dasharray="5 4" stroke-opacity="0.35"/>`).join("")}
  ${riverShapes.map((r: P[]) => `<path d="${path(r)}" fill="${WATER}" fill-rule="evenodd" stroke="#2a6d84" stroke-width="0.8" stroke-opacity="0.5"/>`).join("")}
  ${coastLines.map((l: P[]) => `<path d="${path(l, false)}" fill="none" stroke="#3f93ab" stroke-width="2.4" stroke-opacity="0.55"/>`).join("")}
  <rect x="${X(cw)}" y="${Y(cn)}" width="${X(ce) - X(cw)}" height="${Y(cs) - Y(cn)}" fill="none" stroke="#a2543f" stroke-width="2.4" stroke-dasharray="8 5"/>
  <text x="${X(cw) + 8}" y="${Y(cn) - 10}" font-family="'Noto Serif CJK SC', serif" font-size="17" fill="#a2543f">中心城区 · 3D 详图</text>
  ${(() => {
    const placed: Array<[number, number]> = [];
    return districtShapes.map((d: any) => {
      const ring = d.rings.reduce((a: P[], b: P[]) => (b.length > a.length ? b : a), d.rings[0]);
      const [ax, ay] = labelPoint(ring);
      let x = ax, y = ay, step = 0;
      while (placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 74) && step < 8) {
        step++;
        const dir = step % 2 ? 1 : -1, mag = Math.ceil(step / 2) * 34;
        y = ay + dir * mag;
      }
      placed.push([x, y]);
      const leader = Math.abs(y - ay) > 2 ? `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y - 5).toFixed(1)}" stroke="#7c7059" stroke-width="0.8" stroke-opacity="0.6"/>` : "";
      return leader + `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="'Noto Serif CJK SC', serif" font-size="21" fill="${INK}" stroke="${PAPER}" stroke-width="4.5" paint-order="stroke" letter-spacing="1">${d.name.replace(/区$/, "")}</text>`;
    }).join("");
  })()}
  <rect x="28" y="26" width="360" height="90" rx="6" fill="${PAPER}" fill-opacity="0.86"/>
  <text x="42" y="68" font-family="'Noto Serif CJK SC', serif" font-size="40" fill="${INK}" letter-spacing="3">上海 · 全市域</text>
  <text x="44" y="98" font-family="Georgia, serif" font-size="16" fill="#6d6453" letter-spacing="1.5">SHANGHAI · THE WHOLE MUNICIPALITY</text>
  <text x="44" y="${H - 26}" font-family="'Noto Serif CJK SC', serif" font-size="14" fill="#6d6453">Map data © OpenStreetMap contributors · Copernicus DEM · 中心城区瓦片由本地渲染</text>
</svg>`;

mkdirSync(join(ROOT, "web/public/city"), { recursive: true });
const out = join(ROOT, "web/public/city/shanghai-overview.png");
const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
await sharp(maskPng).composite([{ input: overlay }]).png({ compressionLevel: 9 }).toFile(out);
writeFileSync(join(ROOT, "web/public/city/shanghai-overview.svg"), svg);
console.log(`  ${out} ${W}×${H}, ${districtShapes.length} districts, ${riverShapes.length} water rings`);
