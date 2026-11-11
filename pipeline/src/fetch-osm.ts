/**
 * Fallback data source: the OSM API 0.6 map call instead of Overpass.
 *
 *   npm -w pipeline exec tsx src/fetch-osm.ts shanghai-core
 *
 * Overpass throttles large city bboxes (429/502/504); the OSM API returns the same open data as XML for
 * one small bbox (≤ 50k elements). Cells of 1.3 km are fetched one by one, resolved into the Overpass
 * `out body geom` shape and merged into the files the pipeline already reads:
 *
 *   data/raw/<area>/ground.json   roads, rail, landuse, water, parks, amenities (see fetch.ts)
 *   data/raw/<area>/osm.json      buildings + natural=tree nodes
 *   data/raw/<area>/roads.json    drivable roads for the traffic animation
 *
 * Existing files are left alone unless --force is passed. Every cell is cached in
 * data/raw/<area>/osm-cells/<x>_<y>.json so a retry continues where it stopped.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { RAW } from "./paths.ts";

const UA = "isometric-world/0.3 (+https://github.com/krasun/isometricworld) open-data isometric map";
const API = "https://api.openstreetmap.org/api/0.6/map";
const STEP = 0.012; // ≈ 1.3 km N-S; a central cell stays far below the 50k-element cap
/** Fetch every cell with a margin: the API returns a way only with its nodes, and a polygon whose
 *  vertices fall just outside a cell would otherwise come back as an open, unusable ring. */
const MARGIN = 0.004; // ≈ 440 m
const FORCE = process.argv.includes("--force"); // rewrite output files
const REFETCH = process.argv.includes("--refetch"); // ignore the cached cells

type Tag = Record<string, string>;
type P = { lat: number; lon: number };
interface El {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Tag;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: P[];
  members?: Array<{ type: string; ref: number; role: string; geometry?: P[] }>;
}

const un = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = un(m[2]);
  return out;
}
function tagsOf(body: string): Tag {
  const tags: Tag = {};
  for (const m of body.matchAll(/<tag\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.k) tags[a.k] = a.v ?? "";
  }
  return tags;
}

/** Parse an OSM API XML response into elements with resolved geometry. */
function parse(xml: string) {
  const nodes = new Map<number, P>();
  const ways = new Map<number, El>();
  const out: El[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const a = attrs(m[1]);
    const id = Number(a.id), lat = Number(a.lat), lon = Number(a.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.set(id, { lat, lon });
    const tags = tagsOf(m[3] ?? "");
    if (tags.natural === "tree" || tags.amenity === "tree" || Object.keys(tags).length) out.push({ type: "node", id, lat, lon, tags });
  }
  for (const m of xml.matchAll(/<way\b([^>]*?)(\/>|>([\s\S]*?)<\/way>)/g)) {
    const a = attrs(m[1]), body = m[3] ?? "";
    const id = Number(a.id), refs = [...body.matchAll(/<nd\b[^>]*ref="(\d+)"/g)].map((x) => Number(x[1]));
    const tags = tagsOf(body);
    if (!refs.length) continue;
    const geometry = refs.map((r) => nodes.get(r)).filter((p): p is P => !!p);
    if (!geometry.length) continue;
    const el: El = { type: "way", id, tags, nodes: refs, geometry };
    ways.set(id, el); // untagged ways are multipolygon members: keep them for relations, not for output
    if (Object.keys(tags).length) out.push(el);
  }
  for (const m of xml.matchAll(/<relation\b([^>]*?)(\/>|>([\s\S]*?)<\/relation>)/g)) {
    const a = attrs(m[1]), body = m[3] ?? "";
    const tags = tagsOf(body);
    const members = [...body.matchAll(/<member\b([^>]*?)\/?>/g)]
      .map((x) => attrs(x[1]))
      .map((x) => {
        const type = x.type, ref = Number(x.ref), role = x.role ?? "";
        const w = type === "way" ? ways.get(ref) : undefined;
        return { type, ref, role, ...(w ? { geometry: w.geometry } : {}) };
      })
      .filter((x) => x.geometry);
    if (!members.length || !Object.keys(tags).length) continue;
    out.push({ type: "relation", id: Number(a.id), tags, members });
  }
  return out;
}

const GROUND_TAGS = /^(highway|area:highway|railway|landuse|leisure|natural|water|waterway|amenity|man_made|place)$/;

async function getCell(w: number, s: number, e: number, n: number, depth = 0): Promise<El[]> {
  const url = `${API}?bbox=${w.toFixed(6)},${s.toFixed(6)},${e.toFixed(6)},${n.toFixed(6)}`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180_000) });
      if (r.status === 509) {
        // too many elements: split into four quarters
        if (depth >= 3) throw new Error(`cell still too big: ${url}`);
        const mx = (w + e) / 2, my = (s + n) / 2;
        const cells = [
          [w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n],
        ];
        const parts: El[] = [];
        for (const c of cells) parts.push(...(await getCell(c[0], c[1], c[2], c[3], depth + 1)));
        return parts;
      }
      if (r.status === 429 || r.status === 503 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      return parse(await r.text());
    } catch (err) {
      if (attempt === 6) throw err;
      console.warn(`  ${url.split("?")[1]}: ${(err as Error).message}, retrying…`);
      await new Promise((res) => setTimeout(res, 4000 * attempt));
    }
  }
  return [];
}

const name = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!name) throw new Error("usage: fetch-osm.ts <area> [--force]");
const area = openArea(name);
const dir = join(RAW, name);
mkdirSync(dir, { recursive: true });
const cache = join(dir, `osm-cells-${MARGIN}`);
mkdirSync(cache, { recursive: true });

const [S, W, N, E] = area.bbox;
const cols = Math.ceil((E - W) / STEP), rows = Math.ceil((N - S) / STEP);
console.log(`  ${name}: ${rows}×${cols} cells of ${(STEP * 111).toFixed(0)} km`);
const seen = new Map<string, El>();
for (let iy = 0; iy < rows; iy++) {
  for (let ix = 0; ix < cols; ix++) {
    const w = W + ix * STEP, e = Math.min(E, w + STEP), s = S + iy * STEP, n = Math.min(N, s + STEP);
    const file = join(cache, `${iy}_${ix}.json`);
    if (!existsSync(file) || REFETCH) {
      const els = await getCell(w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN);
      writeFileSync(file, JSON.stringify(els));
      await new Promise((res) => setTimeout(res, 400)); // be kind to the API
    }
    for (const el of JSON.parse(readFileSync(file, "utf8")) as El[]) {
      const k = `${el.type}/${el.id}`, prev = seen.get(k);
      // a relation that straddles cells comes back in pieces: union its members instead of overwriting
      if (prev?.type === "relation" && el.type === "relation") {
        const members = new Map((prev.members ?? []).map((m) => [`${m.type}/${m.ref}/${m.role}`, m]));
        for (const m of el.members ?? []) {
          const mk = `${m.type}/${m.ref}/${m.role}`, old = members.get(mk);
          if (!old || (!old.geometry && m.geometry)) members.set(mk, m);
        }
        prev.members = [...members.values()];
      } else if (prev?.type === "way" && el.type === "way" && (el.geometry?.length ?? 0) > (prev.geometry?.length ?? 0)) {
        seen.set(k, el);
      } else if (!prev) seen.set(k, el);
    }
    process.stdout.write(`\r  cell ${iy + 1}/${rows} · ${ix + 1}/${cols}, ${seen.size} elements`);
  }
}
process.stdout.write("\n");

const all = [...seen.values()];
const write = (file: string, els: El[]) => {
  if (!FORCE && existsSync(join(dir, file))) {
    console.log(`  ${file}: exists, left alone (--force to rewrite)`);
    return;
  }
  writeFileSync(join(dir, file), JSON.stringify({ elements: els }));
  console.log(`  ${file}: ${els.length} elements`);
};

/** underground ways are not visible on the surface: the ground step draws every rail and road it gets. */
const underground = (t?: Tag) =>
  !!t && (t.tunnel === "yes" || t.tunnel === "building_passage" || t.covered === "yes" || t.location === "underground");
// ground: every tagged way/relation except buildings (the ground step only reads its kinds)
write("ground.json", all.filter((el) =>
  el.type !== "node" && el.tags && !underground(el.tags) && Object.keys(el.tags).some((k) => GROUND_TAGS.test(k))));
// buildings and trees
write("osm.json", all.filter((el) =>
  (el.type === "node" && el.tags?.natural === "tree") ||
  (el.type !== "node" && (el.tags?.building || el.tags?.["building:part"]))));
// drivable roads for the traffic animation
write("roads.json", all.filter((el) =>
  el.type === "way" && el.tags?.highway && el.tags.area !== "yes" && !underground(el.tags)));
