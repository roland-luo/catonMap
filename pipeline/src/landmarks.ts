/**
 * The eight hand-modelled landmarks of the Shanghai map.
 *
 * Shared by the scene builder (to drop the OSM footprint the model replaces), the renderer (procedural
 * models) and the web search (names, coordinates). Positions are the OSM footprint centroids; heights
 * are the surveyed/OSM heights, the Oriental Pearl is modelled at its real 468 m / 50 m spheres.
 */
export type LandmarkKind =
  | "pearl" | "shanghai-tower" | "swfc" | "jinmao"
  | "customs" | "hsbc" | "pavilion" | "museum";

export interface Landmark {
  id: string;
  name: string;
  nameEn: string;
  kind: LandmarkKind;
  /** footprint centroid (WGS84) */
  lat: number;
  lon: number;
  /** metres above ground */
  height: number;
  /** compass bearing of the longest footprint edge */
  bearing: number;
  /** footprint size in metres, for the model and for clearing the generic extrusion */
  width: number;
  depth: number;
  /** OSM way this model replaces */
  osmWay: number;
  /** shown in the search list and the card */
  blurb: string;
}

export const LANDMARKS: Landmark[] = [
  {
    id: "oriental-pearl",
    name: "东方明珠",
    nameEn: "Oriental Pearl Tower",
    kind: "pearl",
    lat: 31.241897, lon: 121.495265,
    height: 468, bearing: 159, width: 98, depth: 98,
    osmWay: 40778038,
    blurb: "三颗球体停在江风里，像一封写给天空的标点。",
  },
  {
    id: "shanghai-tower",
    name: "上海中心",
    nameEn: "Shanghai Tower",
    kind: "shanghai-tower",
    lat: 31.235539, lon: 121.501308,
    height: 632, bearing: -139, width: 95, depth: 102,
    osmWay: 165792123,
    blurb: "玻璃顺着风拧了一下，632 米，城市把目光举到云上。",
  },
  {
    id: "swfc",
    name: "环球金融中心",
    nameEn: "Shanghai World Financial Center",
    kind: "swfc",
    lat: 31.236591, lon: 121.502993,
    height: 492, bearing: -95, width: 65, depth: 65,
    osmWay: 10691100,
    blurb: "顶端的开口像一扇窗，让天空从楼里穿过去。",
  },
  {
    id: "jinmao",
    name: "金茂大厦",
    nameEn: "Jin Mao Tower",
    kind: "jinmao",
    lat: 31.237264, lon: 121.501393,
    height: 420.5, bearing: 0, width: 95, depth: 89,
    osmWay: 376075961,
    blurb: "一层层收拢的塔身，是旧时笔尖落在浦东的墨。",
  },
  {
    id: "customs-house",
    name: "外滩海关大楼",
    nameEn: "Customs House",
    kind: "customs",
    lat: 31.238630, lon: 121.485423,
    height: 79, bearing: -7, width: 39, depth: 27,
    osmWay: 178407318,
    blurb: "钟声从 1927 年走来，替整条外滩数着黄昏。",
  },
  {
    id: "hsbc-tower",
    name: "汇丰银行大楼",
    nameEn: "HSBC Tower",
    kind: "hsbc",
    lat: 31.238562, lon: 121.496848,
    height: 249.9, bearing: 178, width: 50, depth: 46,
    osmWay: 164968674,
    blurb: "铜狮子守着旧账本，玻璃里换了一代人的灯火。",
  },
  {
    id: "huxinting",
    name: "豫园·湖心亭",
    nameEn: "Huxinting Teahouse",
    kind: "pavilion",
    lat: 31.228670, lon: 121.487410,
    height: 12, bearing: 0, width: 22, depth: 22,
    osmWay: 228035340,
    blurb: "九曲桥把一杯茶送到水中央，豫园的下午就慢下来。",
  },
  {
    id: "shanghai-museum",
    name: "上海博物馆",
    nameEn: "Shanghai Museum",
    kind: "museum",
    lat: 31.230141, lon: 121.470970,
    height: 30, bearing: 53, width: 132, depth: 136,
    osmWay: 161090899,
    blurb: "天圆地方的屋顶下，青铜器替这座城市收着时间。",
  },
];

export const LANDMARK_WAYS = new Set(LANDMARKS.map((l) => l.osmWay));
