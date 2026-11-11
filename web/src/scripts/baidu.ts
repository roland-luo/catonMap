/**
 * Baidu Maps basemap for the city page (`?basemap=baidu`).
 *
 * The isometric map streams its tiles from R2 (`TILES_ORIGIN`). When that origin is unreachable
 * (an unset origin, a network that cannot reach Cloudflare) the page would open on an empty
 * rectangle, so this module draws a normal Baidu map in the same `#map` container: the city centre,
 * the hand-modelled landmarks and a search box that asks Baidu's LocalSearch.
 *
 * Coordinates: `places.ts` and `landmarks.ts` are WGS84, Baidu wants BD09 — converted here.
 * The AK comes from `PUBLIC_BAIDU_AK` (baked in as `__BAIDU_AK__` by astro.config.mjs); `?ak=`
 * overrides it and is remembered, so a link can carry the key once.
 */
import { CITIES } from "../../../pipeline/src/places.ts";
import { LANDMARKS } from "../../../pipeline/src/landmarks.ts";

declare const __BAIDU_AK__: string;

/* ---- WGS84 <-> GCJ-02 <-> BD-09 (the offsets the Chinese map datum adds) ---------------------- */

const X_PI = (Math.PI * 3000) / 180;
const A = 6378245;
const EE = 0.00669342162296594323;

const outsideChina = (lon: number, lat: number) => lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;

const transformLat = (x: number, y: number) => {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
};
const transformLon = (x: number, y: number) => {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
};

/** WGS84 → GCJ-02 (outside China the datum is untouched) */
export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (outsideChina(lon, lat)) return [lon, lat];
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const rad = (lat / 180) * Math.PI;
  let magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(rad) * Math.PI);
  return [lon + dLon, lat + dLat];
}

/** GCJ-02 → BD-09 */
export function gcj02ToBd09(lon: number, lat: number): [number, number] {
  const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

/** WGS84 → BD-09: every coordinate from the pipeline goes through this before it reaches Baidu */
export const wgs84ToBd09 = (lon: number, lat: number): [number, number] => gcj02ToBd09(...wgs84ToGcj02(lon, lat));

/* ---- the SDK ---------------------------------------------------------------------------------- */

/* No official typings: this is the slice of BMapGL the page uses. */
type BdPoint = { lng: number; lat: number };
type BdMap = {
  centerAndZoom(point: BdPoint, zoom: number): void;
  enableScrollWheelZoom(on: boolean): void;
  addControl(control: unknown): void;
  addOverlay(overlay: unknown): void;
  openInfoWindow(window: unknown, point: BdPoint): void;
  addEventListener(name: string, handler: () => void): void;
  pointToPixel(point: BdPoint): { x: number; y: number };
};
type BdSdk = {
  Map: new (element: HTMLElement, options?: { enableMapClick?: boolean }) => BdMap;
  Point: new (lng: number, lat: number) => BdPoint;
  Marker: new (point: BdPoint) => { addEventListener(name: string, handler: () => void): void; setTitle(title: string): void };
  InfoWindow: new (html: string, options?: { width?: number; height?: number }) => unknown;
  ScaleControl?: new () => unknown;
  LocalSearch: new (
    map: BdMap,
    options: { pageCapacity?: number; onSearchComplete?: (result: BdLocalResult) => void },
  ) => { search(keyword: string): void; clearResults?(): void };
};
type BdLocalResult = {
  getCurrentNumPois?: () => number;
  getPoi?: (i: number) => { title: string; address?: string; point: BdPoint } | undefined;
};

const AK_STORAGE = "iw.baidu.ak";

/**
 * A browser AK is public by design (Baidu binds it to referer domains, not to a secret), so the
 * build-time value falls back to this one — a dev server started before `PUBLIC_BAIDU_AK` was added
 * to .env, or a build without .env, still opens the map.
 */
const AK_FALLBACK = "7ILVztKEU8XNneVW5JoJpQ7S140L5OKo";

/** `?ak=` (remembered) → the AK baked in at build time → this file's fallback → a previous visit */
function resolveAk(): string {
  const fromUrl = new URLSearchParams(location.search).get("ak")?.trim();
  if (fromUrl) {
    try { localStorage.setItem(AK_STORAGE, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  const baked = typeof __BAIDU_AK__ === "string" ? __BAIDU_AK__ : "";
  if (baked) return baked;
  if (AK_FALLBACK) return AK_FALLBACK;
  try { return localStorage.getItem(AK_STORAGE) ?? ""; } catch { return ""; }
}

let loading: Promise<BdSdk> | null = null;

/** Load the WebGL JS API once; every later call reuses the same promise. */
export function loadBaiduSdk(ak: string): Promise<BdSdk> {
  const win = window as unknown as { BMapGL?: BdSdk };
  if (win.BMapGL?.Map) return Promise.resolve(win.BMapGL);
  if (loading) return loading;
  loading = new Promise<BdSdk>((resolve, reject) => {
    if (!ak) {
      reject(new Error("缺少百度 AK：在 .env 里设 PUBLIC_BAIDU_AK，或用 ?ak= 带上"));
      return;
    }
    // `api.map.baidu.com/api?type=webgl` document.writes a second <script>, which never runs in a
    // module page; getscript is the bundle itself. It calls back with no event, so poll for BMapGL.
    const script = document.createElement("script");
    script.src = `https://api.map.baidu.com/getscript?type=webgl&v=1.0&ak=${encodeURIComponent(ak)}`;
    script.async = true;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (win.BMapGL?.Map) {
        window.clearInterval(timer);
        resolve(win.BMapGL);
        return;
      }
      if (Date.now() - started > 25000) {
        window.clearInterval(timer);
        reject(new Error("百度 JS API 25 秒内没就绪（AK 无效 / 白名单未配 / 网络不通）"));
      }
    }, 120);
    script.onerror = () => {
      window.clearInterval(timer);
      reject(new Error("百度 JS API 脚本请求失败（检查 AK 与白名单域名）"));
    };
    document.head.append(script);
  });
  return loading;
}

/** metres across the screen → Baidu zoom level (z15 is about 5 km wide, each level halves it) */
const zoomFor = (widthM: number) => Math.max(4, Math.min(19, Math.round(15 - Math.log2(widthM / 5000))));

/* ---- the map ---------------------------------------------------------------------------------- */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Search box → Baidu LocalSearch, rendered into the page's own results list. */
function wireSearch(sdk: BdSdk, map: BdMap): void {
  const input = el<HTMLInputElement>("search-input");
  const list = el<HTMLUListElement>("search-results");
  if (!input || !list) return;

  let hits: Array<{ name: string; sub: string; point: BdPoint }> = [];
  let timer = 0;

  const show = (items: typeof hits, note: string) => {
    hits = items;
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "n";
      name.textContent = item.name;
      li.append(name);
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "e";
        sub.textContent = item.sub;
        li.append(sub);
      }
      li.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        map.centerAndZoom(item.point, 16);
        list.hidden = true;
        input.blur();
      });
      return li;
    }));
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = note;
      list.append(li);
    }
    list.hidden = false;
  };

  const local = new sdk.LocalSearch(map, {
    pageCapacity: 8,
    onSearchComplete: (result) => {
      const count = result?.getCurrentNumPois?.() ?? 0;
      const items: typeof hits = [];
      for (let i = 0; i < count; i += 1) {
        const poi = result.getPoi?.(i);
        if (poi?.point) items.push({ name: poi.title, sub: poi.address ?? "", point: poi.point });
      }
      show(items, "百度没有搜到，换个词试试");
    },
  });

  input.addEventListener("input", () => {
    const keyword = input.value.trim();
    window.clearTimeout(timer);
    if (!keyword) return;
    timer = window.setTimeout(() => local.search(keyword), 350);
  });
  input.addEventListener("focus", () => { if (hits.length) list.hidden = false; });
  input.addEventListener("blur", () => window.setTimeout(() => { list.hidden = true; }, 120));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { list.hidden = true; input.blur(); }
    if (event.key === "Enter") {
      event.preventDefault();
      local.search(input.value.trim());
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      input.focus();
    }
  });
}

/**
 * Boot the Baidu basemap. Resolves once the map object exists; the SDK draws its own tiles, so the
 * page is usable before the first tile lands.
 */
export async function startBaidu(): Promise<BdMap> {
  const host = el<HTMLDivElement>("map");
  if (!host) throw new Error("#map 不在页面上");

  document.body.classList.add("baidu");
  el("preview")?.remove(); // the isometric opening shot would sit on top of the map
  el("city-overview")?.remove();
  // The SDK rewrites the container's inline style (position: relative and friends), which collapses a
  // `position: fixed; inset: 0` host to zero height. Give it a child that carries its own size instead.
  host.replaceChildren(); // a failed isometric boot may have left a canvas behind
  const frame = document.createElement("div");
  frame.id = "baidu-map";
  host.append(frame);

  const sdk = await loadBaiduSdk(resolveAk());

  const city = CITIES[document.body.dataset.city ?? ""] ?? CITIES.shanghai;
  // ?at=lat,lon[,km] wins over the city's own opening view, as on the isometric map
  const at = new URLSearchParams(location.search).get("at")?.split(",").map(Number);
  const placed = at && at.length >= 2 && at.slice(0, 2).every(Number.isFinite);
  const [lon, lat] = placed ? [at![1], at![0]] : [city.center[1], city.center[0]];
  const widthM = placed && Number.isFinite(at![2]) ? at![2] * 1000 : city.widthM;
  const [bLon, bLat] = wgs84ToBd09(lon, lat);

  const map = new sdk.Map(frame, { enableMapClick: false });
  map.centerAndZoom(new sdk.Point(bLon, bLat), zoomFor(widthM));
  map.enableScrollWheelZoom(true);
  if (sdk.ScaleControl) {
    try { map.addControl(new sdk.ScaleControl()); } catch { /* older builds */ }
  }

  // the hand-modelled landmarks of the painted map, as plain Baidu markers (Shanghai only)
  if (document.body.dataset.region === "shanghai") {
    for (const landmark of LANDMARKS) {
      const [x, y] = wgs84ToBd09(landmark.lon, landmark.lat);
      const point = new sdk.Point(x, y);
      const marker = new sdk.Marker(point);
      marker.setTitle(landmark.name);
      const card = new sdk.InfoWindow(
        `<b>${landmark.name}</b><br><span style="color:#6b6455">${landmark.nameEn} · ${landmark.height} m</span>`,
        { width: 230 },
      );
      marker.addEventListener("click", () => map.openInfoWindow(card, point));
      map.addOverlay(marker);
    }
  }

  wireSearch(sdk, map);

  const credits = el("credits");
  if (credits) {
    credits.innerHTML = [
      `<a href="https://map.baidu.com">百度地图</a>`,
      `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>`,
      `<span title="© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA">Copernicus DEM</span>`,
      `<a href="https://github.com/krasun/isometricworld">Source</a>`,
      `Made by <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`,
    ].map((c, i, all) => `<span class="credit">${c}${i < all.length - 1 ? " ·" : ""}</span>`).join(" ");
  }

  return map;
}
