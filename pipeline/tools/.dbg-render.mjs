import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";

const ROOT = "/home/roland/桌面/code/isometricworld-main";
const PIPELINE = join(ROOT, "pipeline");
const dist = join(PIPELINE, "page", "dist");
mkdirSync(dist, { recursive: true });
await esbuild.build({
  entryPoints: [join(PIPELINE, "page", "renderer.ts")],
  bundle: true, format: "esm", target: "es2022", outfile: join(dist, "renderer.js"), logLevel: "warning",
});
writeFileSync(join(dist, "index.html"),
  `<!doctype html><html><body style="margin:0;background:#000"><script type="module" src="/renderer.js"></script></body></html>`);

const groundDir = join(ROOT, "data/derived/longquanyi-test/ground");
const browser = await chromium.launch({
  executablePath: "/usr/bin/microsoft-edge", headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
page.on("console", (m) => console.log(`  [console:${m.type()}]`, m.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 600)));
page.on("requestfailed", (r) => console.log("  [failed]", r.url().slice(0, 120), r.failure()?.errorText));
await page.route("http://iso.local/**", (route) => {
  const p = new URL(route.request().url()).pathname;
  const file = p.startsWith("/ground/") ? join(groundDir, p.slice(8))
    : p.startsWith("/style/") ? join(PIPELINE, "style", p.slice(7))
    : join(dist, p === "/" ? "index.html" : p.slice(1));
  const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json"
    : file.endsWith(".png") ? "image/png" : file.endsWith(".bin") ? "application/octet-stream" : "text/html";
  if (!existsSync(file)) { console.log("  [404]", p); return route.fulfill({ status: 404 }); }
  return route.fulfill({ body: readFileSync(file), contentType: type });
});
await page.goto("http://iso.local/?region=chengdu&style=cartoon&ss=2&debug=&markers=");
await page.waitForTimeout(12000);
console.log("ready =", await page.evaluate(() => window.ready ?? null));
const r = await page.evaluate(() => window.renderTile ? window.renderTile(-1, -3).then((x) => x.color.length).catch((e) => "ERR " + e.message) : "no renderTile");
console.log("renderTile:", typeof r === "string" ? r : "ok " + r);
await ctx.close();
await browser.close();
