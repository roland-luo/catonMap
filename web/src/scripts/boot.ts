/**
 * Which basemap the city page opens.
 *
 *   (default)            Baidu Maps (`baidu.ts`): the AK is baked in, tiles come from Baidu's own CDN
 *   ?basemap=iso         the painted isometric map (`map.ts`), streamed from the tile origin
 *   ?basemap=baidu       Baidu Maps, explicitly
 *
 * The choice is remembered in localStorage and the toggle in the top-right corner swaps it. If the
 * chosen basemap cannot be created at all (an invalid AK, a referer whitelist that rejects the
 * domain, an unreachable tile origin) the page falls back to the other one and says why, instead of
 * sitting on an empty rectangle.
 */
type Basemap = "iso" | "baidu";

const REGION = document.body.dataset.region ?? "";
const KEY = `iw.basemap.${REGION}`; // per region: Baidu suits China, the painted map everywhere else
// Baidu is the default where it has the data: the Chinese regions. Elsewhere (Tel Aviv) the painted
// isometric map stays the opening view — Baidu's coverage of Israel is thin and the AK is China-bound.
const BAIDU_REGIONS = new Set(["shanghai", "chengdu"]);
const DEFAULT: Basemap = BAIDU_REGIONS.has(REGION) ? "baidu" : "iso";
const params = new URLSearchParams(location.search);
const asked = params.get("basemap") ?? (location.hash === "#baidu" ? "baidu" : location.hash === "#iso" ? "iso" : null);

function remembered(): Basemap | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "baidu" || value === "iso" ? value : null;
  } catch { return null; }
}

function remember(basemap: Basemap): void {
  try { localStorage.setItem(KEY, basemap); } catch { /* private mode */ }
}

/** The URL of the other basemap: same page, same deep link, one different parameter. */
function urlFor(basemap: Basemap): string {
  const next = new URL(location.href);
  next.searchParams.set("basemap", basemap);
  next.hash = location.hash;
  return next.href;
}

function paintToggle(basemap: Basemap): void {
  const button = document.getElementById("basemap-toggle") as HTMLButtonElement | null;
  if (!button) return;
  const other: Basemap = basemap === "baidu" ? "iso" : "baidu";
  button.textContent = other === "baidu" ? "百度地图" : "等距地图";
  button.title = other === "baidu" ? "改用百度地图底图" : "回到等距手绘地图";
  button.dataset.target = other;
  button.hidden = false;
  button.onclick = () => {
    remember(other);
    location.href = urlFor(other);
  };
}

/** A quiet line above the credits when one basemap failed and the other took over. */
function note(text: string, retry: Basemap): void {
  let box = document.getElementById("basemap-note");
  if (!box) {
    box = document.createElement("div");
    box.id = "basemap-note";
    box.setAttribute("role", "status");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭提示");
    close.addEventListener("click", () => box?.remove());
    box.append(document.createElement("span"), document.createElement("a"), close);
    document.body.append(box);
  }
  const span = box.querySelector("span");
  if (span) span.textContent = text;
  const link = box.querySelector("a");
  if (link) {
    link.textContent = "重试";
    link.href = urlFor(retry);
    link.onclick = () => remember(retry);
  }
}

const start = (basemap: Basemap): Promise<unknown> =>
  basemap === "baidu" ? import("./baidu.ts").then((m) => m.startBaidu()) : import("./map.ts");

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Boot one basemap; on failure boot the other and explain. */
async function boot(basemap: Basemap): Promise<void> {
  const other: Basemap = basemap === "baidu" ? "iso" : "baidu";
  try {
    await start(basemap);
    document.getElementById("basemap-note")?.remove();
    paintToggle(basemap);
  } catch (error) {
    console.warn(`[basemap] ${basemap} failed`, error);
    // the console keeps the stack; the page only says what a visitor can act on
    const why = basemap === "baidu"
      ? `百度地图没起来（${message(error)}），已切到等距地图。`
      : "等距地图的数据取不到（瓦片服务未连上），已切到百度地图。";
    try {
      await start(other);
      document.body.classList.toggle("baidu", other === "baidu");
      remember(other);
      paintToggle(other);
      note(why, basemap);
    } catch (alsoFailed) {
      document.body.classList.add("basemap-failed");
      note(`${why} 另一种底图也失败了：${message(alsoFailed)}`, other);
    }
  }
}

const explicit = asked === "iso" || asked === "baidu" ? (asked as Basemap) : null;
if (explicit) remember(explicit);
void boot(explicit ?? remembered() ?? DEFAULT);
