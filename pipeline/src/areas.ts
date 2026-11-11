import { CAMERA, activeRegion, llhToPixel, useRegion } from "./camera.ts";
import { REGIONS } from "./places.ts";

/** A rendered patch of a region (see places.ts); all pipeline steps work per area. */
export interface Area {
  title: string;
  region: string;
  /** south, west, north, east (WGS84) */
  bbox: [number, number, number, number];
}

export const AREAS: Record<string, Area> = {
  /** Jaffa → Yarkon Park → Ramat Gan, including the sea off the coast. */
  "tlv-core": {
    title: "Tel Aviv-Yafo · Ramat Gan",
    region: "israel-center",
    bbox: [32.035, 34.735, 32.108, 34.835],
  },
  /** Small test patch around Rothschild Blvd. */
  rothschild: {
    title: "Rothschild Blvd",
    region: "israel-center",
    bbox: [32.0605, 34.7705, 32.0675, 34.7795],
  },
  /** The Bund → Lujiazui pilot patch: People's Square, Yu Garden, the Huangpu and the towers. */
  "shanghai-bund": {
    title: "Shanghai · The Bund & Lujiazui",
    region: "shanghai",
    bbox: [31.224, 121.480, 31.252, 121.512],
  },
  /** Chengdu Economic & Technological Development Zone: 大面 → 经开区 → 东安湖 → 龙泉驿城区. */
  "longquanyi": {
    title: "Chengdu · Longquanyi",
    region: "chengdu",
    bbox: [30.548, 104.215, 30.580, 104.290],
  },
  /** A 3 × 4 km test patch around the 经开区 core, before the whole area. */
  "longquanyi-test": {
    title: "Longquanyi · 经开区",
    region: "chengdu",
    bbox: [30.548, 104.215, 30.578, 104.255],
  },
  /** Central Shanghai: Jing'an → the Bund → Lujiazui → North Bund (the city's opening view). */
  "shanghai-core": {
    title: "Shanghai · Central",
    region: "shanghai",
    bbox: [31.194, 121.438, 31.270, 121.536],
  },
};

/** Look up an area and switch the camera to its region: call before any projection. */
export function openArea(name: string): Area {
  const area = AREAS[name];
  if (!area) throw new Error(`unknown area ${name}`);
  useRegion(area.region);
  return area;
}

/** Ellipsoid height of the active region's ground: area outlines and projections start here. */
export function groundH() { return REGIONS[activeRegion()].groundH ?? 25; }

type Pt = [number, number];

/** Area outline in global art pixels (the bbox projected at ground level: a slanted quad). */
export function areaPolygon(bbox: [number, number, number, number]): Pt[] {
  const [s, w, n, e] = bbox;
  return [[s, w], [s, e], [n, e], [n, w]].map(([lat, lon]) => llhToPixel(lat, lon, groundH()));
}

export function inside([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Render tiles whose centre lies inside the area outline. */
export function areaTiles(bbox: [number, number, number, number]) {
  const poly = areaPolygon(bbox);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const out: Array<[number, number]> = [];
  for (let ty = Math.floor(Math.min(...ys) / CAMERA.tile); ty <= Math.floor(Math.max(...ys) / CAMERA.tile); ty++)
    for (let tx = Math.floor(Math.min(...xs) / CAMERA.tile); tx <= Math.floor(Math.max(...xs) / CAMERA.tile); tx++)
      if (inside([(tx + 0.5) * CAMERA.tile, (ty + 0.5) * CAMERA.tile], poly)) out.push([tx, ty]);
  return out;
}

/** Distance (art px) from a point inside a convex outline to its nearest edge; ≤ 0 outside. */
export function insideDistance([x, y]: Pt, poly: Pt[]) {
  if (!inside([x, y], poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}
