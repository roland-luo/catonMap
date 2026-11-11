/**
 * Regions and cities of Isometric World. Pure data, shared by the pipeline and the web viewer.
 *
 * A REGION is one flat map: one orthographic camera in a local East-North-Up frame at its origin,
 * one tile pyramid (web/public/regions/<id>/). A flat map is accurate to ~1° of building lean at
 * 100 km from its origin, so a region can hold all cities within ~150 km and you scroll between them.
 * Far-apart cities get their own region (joined later by a world overview).
 *
 * A CITY is a named view into a region: /<city-slug> opens the region centred on it.
 */

export interface Region {
  title: string;
  /** ENU origin. Fixed forever once tiles exist: changing it moves every tile of the region. */
  origin: { lat: number; lon: number; h: number };
  /** EGM2008 geoid undulation at the origin (m): orthometric DEM heights + this = ellipsoid height.
   *  It only shifts terrain and sea together; keep it right so heights stay comparable across regions. */
  geoid: number;
  /** OSM admin_level of `municipalities` (default 8: towns/cities; Shanghai's districts are 6). */
  adminLevel?: number;
  /** Ellipsoid height of the region's ground (metres): projections, previews and area outlines start
   *  here instead of sea level (Chengdu ≈ 482, Shanghai ≈ 16). */
  groundH: number;
  /** Approximate ground height in the ENU frame (defaults to geoid + 8); set when the terrain is far
   *  from the origin's tangent plane (Chengdu ≈ 482). */
  groundU?: number;
  /** Compass bearing the camera looks toward (pick it diagonal to the main street grid). */
  headingDeg: number;
  /** Tilt below the horizon for this region (default CAMERA.pitchDeg = 45°). A steeper camera shows
   *  more roof and hides less of the ground behind each block: dense Chinese blocks need ~60°. */
  pitchDeg?: number;
  /** OSM country (name:en of the admin_level=2 area) and municipality names (admin_level=8) for the border overlay. */
  country: string;
  municipalities: string[];
  /** Airliners on final approach drawn over the map (optional). */
  airport?: { lat: number; lon: number; runwayHeadingDeg: number };
  /** Credit lines (video mode and footer). */
  credits: string[];
  /** A literary description shown at the bottom right of the map page (optional). */
  description?: string;
}

export interface City {
  title: string;
  region: string;
  /** Opening view: centre and on-screen width in metres. */
  center: [number, number];
  widthM: number;
}

export const REGIONS: Record<string, Region> = {
  "israel-center": {
    title: "Israel · Center",
    origin: { lat: 32.0778, lon: 34.774, h: 0 }, // Dizengoff Square
    geoid: 19.1, // EGM2008 off Tel Aviv
    groundH: 19, // flat coastal plain
    headingDeg: 340, // 20° west of north: diagonal to Tel Aviv's grid, sea on the left
    country: "Israel",
    municipalities: [
      "תל־אביב–יפו", // maqaf + en dash, as in OSM relation 1382494
      "רמת גן",
      "גבעתיים",
      "בני ברק",
      "חולון",
      "בת ים",
      "הרצליה",
      "רמת השרון",
      "פתח תקווה",
      "קריית אונו",
      "אור יהודה",
      "גבעת שמואל",
    ],
    airport: { lat: 32.0055, lon: 34.8854, runwayHeadingDeg: 117 }, // Ben Gurion, runway 12
    credits: [
      "Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
  },
  "chengdu": {
    title: "Chengdu · Longquanyi",
    origin: { lat: 30.562, lon: 104.265, h: 0 }, // 龙泉驿区政府
    groundH: 482, // ≈ 524 m DEM + geoid -42
    groundU: 482, // the ENU frame is at the ellipsoid: the terrain is ~482 m above it
    geoid: -42.36, // EGM2008 at 30.56N 104.27E
    headingDeg: 25, // diagonal to the 经开区 grid, 龙泉山 on the right
    pitchDeg: 52,   // 45° hid half the street behind each block, 60° flattened the volumes
    country: "China",
    adminLevel: 8, // subdistricts of 龙泉驿区
    municipalities: [
      "龙泉街道",
      "大面街道",
      "柏合街道",
      "东安街道",
      "同安街道",
      "西河街道",
      "十陵街道",
    ],
    credits: [
      "Map data © OpenStreetMap contributors · Chengdu · Longquanyi",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Cel-shaded cartoon render",
      "Facade textures generated with Qwen-Image 2.1 (Apache-2.0)",
    ],
    description:
      "龙泉山下，汽车城的灯沿着成龙大道一盏盏亮起；东安湖把天空收进水面，" +
      "桃花在春天替这座新城写下第一行诗。",
  },
  "shanghai": {
    title: "Shanghai · 上海",
    origin: { lat: 31.2304, lon: 121.4737, h: 0 }, // People's Square 人民广场
    geoid: 11.76, // EGM2008 at 31.23N 121.47E
    groundH: 16, // ~4 m orthometric + geoid
    headingDeg: 30, // north-north-east: diagonal to the Bund grid, Huangpu river running away from the camera
    country: "China",
    adminLevel: 8, // subdistricts (街道), the scale of the rendered area
    municipalities: [
      "外滩街道",   // the Bund
      "南京东路街道",
      "豫园街道",
      "小东门街道",
      "陆家嘴街道", // Lujiazui
      "潍坊新村街道",
      "北外滩街道",
    ],
    credits: [
      "Map data © OpenStreetMap contributors · Shanghai",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Cel-shaded cartoon render",
    ],
    description:
      "黄浦江把城市折成一封信：外滩是旧邮戳，陆家嘴是未干的落款；" +
      "梧桐在街巷里写细密的注脚，风从江面来，替每一盏灯读最后一行。",
  },
};

export const CITIES: Record<string, City> = {
  "tel-aviv-yafo": { title: "Tel Aviv-Yafo", region: "israel-center", center: [32.0745, 34.7810], widthM: 5200 },
  /** The Bund on the left bank, Lujiazui on the right. */
  "shanghai": { title: "Shanghai", region: "shanghai", center: [31.2385, 121.4900], widthM: 5200 },
  /** 成都经开区（龙泉驿区）: the development zone, 东安湖 and the district town. */
  "longquanyi": { title: "Chengdu · Longquanyi", region: "chengdu", center: [30.5640, 104.2525], widthM: 5000 },
};

export const DEFAULT_CITY = "tel-aviv-yafo";
