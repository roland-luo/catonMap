/**
 * Headless renderer page: open-data 3D scene through one orthographic camera.
 * Terrain + ground surface (OSM, drawn per tile onto a canvas texture) + extruded buildings + trees.
 * Driven by src/render.ts via Playwright: window.renderTile(tx, ty) -> PNG data.
 */
import * as THREE from "three";
import { CAMERA, activeRegion, axes, ecefToEnu, llhToEcef, tileCamera, useRegion } from "../src/camera.ts";
import { drawGround, type Feature } from "./ground.ts";
import { LANDMARKS, type Landmark } from "../src/landmarks.ts";

const params = new URLSearchParams(location.search);
useRegion(params.get("region") ?? "israel-center"); // before any projection below
/** "cartoon": cel-shaded colours, ink outlines from the depth pass and paper grain (see postMaterial). */
const STYLE = params.get("style") ?? "plain";
const CARTOON = STYLE === "cartoon";
const SS = Number(params.get("ss") ?? 2); // supersampling
const SIZE = CAMERA.tile * SS;
/** Overscan in render px: the scene is rendered bigger than the tile and cropped in the post pass, so
 *  ink lines, AO and the sun march keep working across a tile border (they need neighbours). */
const PAD = 128;
const FULL = SIZE + 2 * PAD;
const HEIGHT_SIZE = 256;
/** Ground texture resolution (m per texel); the render samples ~0.125 m across, 0.18 m in depth. */
const GROUND_MPT = 0.15;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ---- cartoon post-process ---------------------------------------------------------------------
// The scene is rendered into a target with a depth texture; a fullscreen pass posterises the shading,
// inks the silhouettes (Sobel on the orthographic depth) and lays a little paper grain. All noise is
// keyed on global pixel coordinates so neighbouring tiles continue the same paper.
const depthTexture = new THREE.DepthTexture(FULL, FULL, THREE.UnsignedIntType);
const colorTarget = new THREE.WebGLRenderTarget(FULL, FULL, {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, depthTexture,
});
colorTarget.texture.generateMipmaps = false;
depthTexture.format = THREE.DepthFormat;
const postScene = new THREE.Scene();
const postCamera = new THREE.Camera();
const DEBUG = params.get("debug") ?? "";
const postMaterial = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  defines: DEBUG === "edge" ? { DEBUG_EDGE: 1 } : DEBUG === "shadow" ? { DEBUG_SHADOW: 1 } : DEBUG === "ao" ? { DEBUG_AO: 1 } : {},
  uniforms: {
    tColor: { value: colorTarget.texture }, tDepth: { value: depthTexture },
    texel: { value: new THREE.Vector2(1 / FULL, 1 / FULL) },
    offset: { value: new THREE.Vector2(0, 0) },
    near: { value: 1 }, far: { value: 6000 },
    crop: { value: SIZE },          // the tile edge in px, inside the padded image
    pad: { value: PAD },            // overscan on each side, px
    halfSize: { value: 128 },       // padded camera half size, metres (set per tile)
    sunView: { value: new THREE.Vector3(-0.55, -0.35, 0.76).normalize() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tDepth;
    uniform vec2 texel, offset; uniform float near, far;
    uniform float crop, pad, halfSize;
    uniform vec3 sunView;
    varying vec2 vUv;
    const vec3 INK = vec3(0.10, 0.11, 0.15);
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    /** Render targets hold linear-sRGB (three's working space); the canvas expects sRGB. */
    vec3 toSrgb(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    /** Orthographic depth is linear in view distance. */
    float dist(vec2 uv) { return near + texture2D(tDepth, uv).x * (far - near); }
    vec3 viewPos(vec2 uv, float d) {
      return vec3((uv.x * 2.0 - 1.0) * halfSize, (uv.y * 2.0 - 1.0) * halfSize, -d);
    }
    vec2 uvOf(vec3 p) { return vec2(p.x, p.y) / halfSize * 0.5 + 0.5; }

    void main() {
      // the tile sits in the middle of the padded image: everything below works in padded uv
      vec2 uv = (vUv * crop + pad) / (crop + 2.0 * pad);
      float d0 = dist(uv);

      // ---- ambient occlusion: eight taps in a ~9 m disc, against the linear depth -------------
      float occ = 0.0;
      float rad = 9.0 / (2.0 * halfSize);
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.4;
        vec2 t = uv + vec2(cos(a), sin(a)) * rad * (mod(float(i), 2.0) < 0.5 ? 1.0 : 0.55);
        occ += step(0.9, d0 - dist(t));
      }
      float ao = 1.0 - 0.22 * (occ / 8.0);

      // ---- sun marching: walk toward the sun in view space, 1.5 m a step ----------------------
      float lit = 1.0;
      vec3 p = viewPos(uv, d0);
      for (int i = 1; i <= 24; i++) {
        vec3 q = p + sunView * (1.6 * float(i));
        vec2 t = uvOf(q);
        if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) break;
        if (dist(t) < -q.z - 0.7) { lit = 0.0; break; }
      }

      vec3 c = toSrgb(texture2D(tColor, uv).rgb);
      c *= ao;
      // a hard cel shadow with a soft contact fringe: one step, quantised like everything else
      c *= mix(0.74, 1.0, lit);

      // ink: depth steps between neighbours are silhouettes / occlusions; curvature (a second
      // difference of the linear orthographic depth) catches the crease where a wall meets its roof.
      float dl = dist(uv - vec2(texel.x, 0.0)), dr = dist(uv + vec2(texel.x, 0.0));
      float du = dist(uv + vec2(0.0, texel.y)), dd = dist(uv - vec2(0.0, texel.y));
      float jump = max(max(abs(dl - d0), abs(dr - d0)), max(abs(du - d0), abs(dd - d0)));
      float crease = max(abs(dl + dr - 2.0 * d0), abs(du + dd - 2.0 * d0));
      // the 8-neighbourhood and a wider ring thicken the line (2-3 px before the 2× downscale)
      float wide = 0.0;
      for (int i = 0; i < 24; i++) {
        float a = float(i % 8) * 0.785398;
        float r = i < 8 ? 1.6 : i < 16 ? 3.2 : 4.6;
        wide = max(wide, abs(dist(uv + vec2(cos(a), sin(a)) * r * texel) - d0));
      }
      float edge = max(smoothstep(0.35, 0.9, jump), smoothstep(0.8, 2.0, wide) * 0.95);
      edge = max(edge, smoothstep(0.18, 0.6, crease) * 0.95);

      // cel shading: six luminance bands, gentler than flat colouring so the facade tones survive
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      float band = floor(l * 6.0 + 0.35) / 6.0 + 0.035;
      c = mix(c, c * (band / max(l, 0.04)), 0.34);
      // contrast (an S-curve on luminance, so hue stays), then a warmer, more saturated illustration
      float l2 = l * l * (3.0 - 2.0 * l);
      c *= mix(1.0, l2 / max(l, 0.02), 0.30);
      c = mix(vec3(l), c, 1.20);
      c *= vec3(1.05, 1.0, 0.93);
      // paper: fine grain and a soft fibre, both fixed in global pixel space
      vec2 g = floor(gl_FragCoord.xy + offset);
      float grain = hash(g) * 0.07 + hash(floor(g / 3.0)) * 0.035;
      c *= 0.955 + grain;
      c = mix(c, INK, edge);
      #if defined(DEBUG_EDGE)
        gl_FragColor = vec4(vec3(edge), 1.0);
      #elif defined(DEBUG_SHADOW)
        gl_FragColor = vec4(vec3(lit), 1.0);
      #elif defined(DEBUG_AO)
        gl_FragColor = vec4(vec3(ao), 1.0);
      #else
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      #endif
    }`,
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

// ?markers=lat,lon,h;lat,lon,h  -> red 6 m spheres (alignment debugging)
for (const m of (params.get("markers") ?? "").split(";").filter(Boolean)) {
  const [lat, lon, h] = m.split(",").map(Number);
  const s = new THREE.Mesh(new THREE.SphereGeometry(6), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  s.position.set(...ecefToEnu(llhToEcef(lat, lon, h)));
  scene.add(s);
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10);

// ---- terrain ---------------------------------------------------------------------------------
const meta: { x0: number; y0: number; nx: number; ny: number; step: number } = await (await fetch("/ground/meta.json")).json();
const terrain = new Float32Array(await (await fetch("/ground/height.bin")).arrayBuffer());
const features: Feature[] = await (await fetch("/ground/features.json")).json();
const fbox = features.map((f) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  if (f.j) return [-Infinity, -Infinity, Infinity, Infinity]; // point sets (junctions, zebras): always passed
  for (const ring of f.r ?? [f.l!]) for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
});

/** Ground ENU "up" at (x, y), bilinear on the terrain grid. */
function ground(x: number, y: number): number {
  const fx = Math.min(meta.nx - 1.001, Math.max(0, (x - meta.x0) / meta.step));
  const fy = Math.min(meta.ny - 1.001, Math.max(0, (y - meta.y0) / meta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * meta.nx + ix;
  return (terrain[i] * (1 - ax) + terrain[i + 1] * ax) * (1 - ay) + (terrain[i + meta.nx] * (1 - ax) + terrain[i + meta.nx + 1] * ax) * ay;
}

const groundTexture = new THREE.CanvasTexture(document.createElement("canvas"));
groundTexture.colorSpace = THREE.SRGBColorSpace;
groundTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const groundMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: groundTexture }));
scene.add(groundMesh);

// ---- landmarks ---------------------------------------------------------------------------------
// Eight hand-modelled buildings (see src/landmarks.ts). They replace their OSM extrusion and are
// drawn with Lambert materials: the cartoon post pass posterises and inks them like the rest.
scene.add(new THREE.AmbientLight(0xffffff, 0.82));
const sunLight = new THREE.DirectionalLight(0xffffff, 1.25);
sunLight.position.set(-550, -350, 760);
scene.add(sunLight);
// a soft fill from the camera side so the shaded faces stay readable (the cartoon passes posterise it)
const fillLight = new THREE.DirectionalLight(0xfff4e2, 0.6);
fillLight.position.set(600, -700, 500);
scene.add(fillLight);

const LMAT = new Map<number, THREE.MeshLambertMaterial>();
const lmat = (color: number) => {
  let m = LMAT.get(color);
  if (!m) { m = new THREE.MeshLambertMaterial({ color }); LMAT.set(color, m); }
  return m;
};
const UP = new THREE.Vector3(0, 1, 0);
function tube(g: THREE.Group, a: [number, number, number], b: [number, number, number], r: number, color: number, seg = 10) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, seg), lmat(color));
  m.position.copy(A).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  g.add(m);
}
function box(g: THREE.Group, w: number, d: number, h: number, x: number, y: number, z: number, color: number, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), lmat(color));
  m.position.set(x, y, z + h / 2); m.rotation.z = rz; g.add(m); return m;
}
function cyl(g: THREE.Group, r0: number, r1: number, z0: number, z1: number, x: number, y: number, color: number, seg = 20, rz = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, z1 - z0, seg), lmat(color));
  m.rotation.order = "ZXY"; m.rotation.z = rz; m.rotation.x = Math.PI / 2;
  m.position.set(x, y, (z0 + z1) / 2); g.add(m); return m;
}
function sphere(g: THREE.Group, x: number, y: number, z: number, r: number, color: number, sz = 1, seg = 24) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2 | 0)), lmat(color));
  m.position.set(x, y, z); m.scale.z = sz; g.add(m); return m;
}
function cone(g: THREE.Group, r: number, h: number, x: number, y: number, z: number, color: number, seg = 8) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), lmat(color));
  m.rotation.x = Math.PI / 2; m.position.set(x, y, z + h / 2); g.add(m); return m;
}
function disc(g: THREE.Group, r: number, t: number, x: number, y: number, z: number, color: number, axis: "x" | "y" = "x") {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t, 24), lmat(color));
  if (axis === "x") m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z); g.add(m); return m;
}

const STONE = 0xdfd3bd, CREAM = 0xf0e6d2, GLASS = 0x86a3b4, GLASS_DARK = 0x647f8f;
const MAUVE = 0xc08fa2, WHITE = 0xf4efe5, RED = 0xb5403c, ROOF = 0x4f6b5d, ROOF_RED = 0x8a4f3f;

/** 东方明珠: 468 m, the three spheres are 50 m, 45 m and 14 m. */
function buildPearl(g: THREE.Group) {
  cyl(g, 46, 46, 0, 2, 0, 0, 0xd8d1c0, 32); // base plinth
  cyl(g, 38, 34, 2, 8, 0, 0, STONE, 32);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(44, 1.2, 8, 40), lmat(0xb9b0a0));
  ring.rotation.x = Math.PI / 2; ring.position.set(0, 0, 2.2); g.add(ring);
  for (let i = 0; i < 3; i++) {
    const a = (i * 120 + 30) * Math.PI / 180;
    tube(g, [Math.cos(a) * 38, Math.sin(a) * 38, 2], [Math.cos(a) * 15, Math.sin(a) * 15, 92], 5.5, WHITE, 12);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i * 120 + 90) * Math.PI / 180;
    tube(g, [Math.cos(a) * 11, Math.sin(a) * 11, 2], [Math.cos(a) * 23, Math.sin(a) * 23, 350], 3.2, WHITE, 10);
  }
  cyl(g, 4.5, 3.2, 0, 350, 0, 0, WHITE, 16);
  sphere(g, 0, 0, 96, 25, MAUVE, 1, 32);       // lower sphere, 50 m
  sphere(g, 0, 0, 272, 22.5, MAUVE, 1, 32);     // upper sphere, 45 m
  // the glass sphere's latitude rings read as the tower's panel bands at close zoom
  for (const [zc, r] of [[96, 25], [272, 22.5]] as const) {
    for (const dz of [-0.55, 0, 0.55]) {
      const rr = Math.sqrt(Math.max(0.1, r * r - (dz * r) ** 2));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.35, 6, 40), lmat(0x9c6b7e));
      ring.rotation.x = Math.PI / 2; ring.position.set(0, 0, zc + dz * r); g.add(ring);
    }
  }
  for (let i = 0; i < 3; i++) {                  // the three small spheres on the columns
    const a = (i * 120 + 30) * Math.PI / 180;
    sphere(g, Math.cos(a) * 23, Math.sin(a) * 23, 210, 6.5, MAUVE, 1, 16);
  }
  sphere(g, 0, 0, 350, 7, GLASS_DARK, 1, 20);   // space module
  cyl(g, 1.7, 1.2, 350, 430, 0, 0, WHITE, 10);
  cyl(g, 1.2, 0.5, 430, 462, 0, 0, RED, 10);
  cone(g, 0.9, 6, 0, 0, 462, RED, 8);
}
/** 上海中心: 632 m, a triangular glass shaft twisting 120° from base to crown. */
function buildShanghaiTower(g: THREE.Group) {
  const H = 600, N = 18, SIDES = 3, TURNS = (120 * Math.PI) / 180;
  const pos: number[] = [], nor: number[] = [];
  const ring = (k: number) => {
    const z = (H * k) / N, r = 44 - (18 * k) / N, a = (TURNS * k) / N;
    return Array.from({ length: SIDES }, (_, j) => {
      const t = a + (j * 2 * Math.PI) / SIDES;
      return new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, z);
    });
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.x * a.x + n.y * a.y < 0) n.negate(); // keep the face normal pointing away from the axis
    for (const p of [a, b, c, a, c, d]) { pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); }
  };
  for (let k = 0; k < N; k++) {
    const A = ring(k), B = ring(k + 1);
    for (let j = 0; j < SIDES; j++) quad(A[j], A[(j + 1) % SIDES], B[(j + 1) % SIDES], B[j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.add(new THREE.Mesh(geo, lmat(GLASS)));
  // floor bands: thin ledges built from the same twisted ring, so they cannot spike out at the corners
  const bp: number[] = [], bn: number[] = [];
  const bquad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.x * a.x + n.y * a.y < 0) n.negate();
    for (const p of [a, b, c, a, c, d]) { bp.push(p.x, p.y, p.z); bn.push(n.x, n.y, n.z); }
  };
  for (let k = 1; k < 24; k++) {
    const A = ring(k).map((p) => p.clone().multiply(new THREE.Vector3(1.015, 1.015, 1)));
    const B = A.map((p) => p.clone().setZ(p.z + 0.45));
    for (let j = 0; j < SIDES; j++) bquad(A[j], A[(j + 1) % SIDES], B[(j + 1) % SIDES], B[j]);
  }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute("position", new THREE.Float32BufferAttribute(bp, 3));
  bgeo.setAttribute("normal", new THREE.Float32BufferAttribute(bn, 3));
  g.add(new THREE.Mesh(bgeo, lmat(0xc6d4dc)));
  cyl(g, 2.2, 0.5, 600, 632, 0, 0, WHITE, 10);
  tube(g, [38, 0, 4], [12, 0, 596], 1.1, WHITE, 6); // the sunshade spine on one edge
}
/** 环球金融中心: 492 m, a rectangular shaft with the trapezoid opening at the top. */
function buildSwfc(g: THREE.Group) {
  box(g, 58, 50, 432, 0, 0, 0, GLASS);
  box(g, 16, 50, 60, -21, 0, 432, GLASS_DARK);
  box(g, 16, 50, 60, 21, 0, 432, GLASS_DARK);
  box(g, 58, 50, 14, 0, 0, 478, GLASS);
  box(g, 30, 2, 46, 0, 23, 432, 0x4d5e66);       // the dark back wall of the aperture
  cyl(g, 1.8, 0.6, 492, 500, 0, 0, WHITE, 8);
}
/** 金茂大厦: 420.5 m, fourteen setback tiers and a spire. */
function buildJinmao(g: THREE.Group) {
  let w = 54, d = 54, z = 0;
  for (let i = 0; i < 18; i++) {
    const h = 21;
    box(g, w, d, h, 0, 0, z, i % 2 ? 0xd7d3c7 : 0xc4c0b4);
    z += h; w -= 1.75; d -= 1.75;
  }
  cyl(g, 3.4, 0.5, z, z + 42, 0, 0, 0xbdb5a4, 10);
}
/** 外滩海关大楼: a stone block and the clock tower. */
function buildCustoms(g: THREE.Group) {
  box(g, 39, 27, 30, 0, 0, 0, STONE);
  for (let i = 0; i < 7; i++) {                     // the river-facing colonnade
    const y = -10 + i * 3.3;
    cyl(g, 0.55, 0.55, 4, 26, 17.5, y, 0xe9dfca, 8);
  }
  for (let i = 0; i < 4; i++) box(g, 37, 0.4, 1.2, 0, 0, 8 + i * 6, 0xb7a88e); // floor bands
  box(g, 13, 13, 38, 0, 0, 30, STONE);
  box(g, 45, 31, 2, 0, 0, 30, 0xcdbfa6);          // cornice
  disc(g, 5.2, 1.2, 7, 0, 56, CREAM, "x");         // clock face (east)
  disc(g, 5.2, 1.2, 0, -7, 56, CREAM, "y");        // clock face (south)
  cone(g, 9.5, 8, 0, 0, 68, ROOF, 4);              // green pyramid roof
  box(g, 4.5, 4.5, 2, 0, 0, 76, 0x3e554a);
}
/** 汇丰银行大楼 (陆家嘴): a 250 m glass tower with a set-back crown. */
function buildHsbc(g: THREE.Group) {
  box(g, 56, 50, 18, 0, 0, 0, CREAM);
  box(g, 44, 40, 200, 0, 0, 18, GLASS);
  box(g, 38, 34, 24, 0, 0, 218, GLASS_DARK);
  box(g, 30, 28, 8, 0, 0, 242, WHITE);
  cyl(g, 2.2, 0.5, 250, 256, 0, 0, WHITE, 8);
}
/** 豫园·湖心亭: the pavilion in the pond, dark curved roofs and red columns. */
function buildPavilion(g: THREE.Group) {
  cyl(g, 11, 11, 0, 2, 0, 0, 0xc9bda7, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i * 45) * Math.PI / 180;
    tube(g, [Math.cos(a) * 8.4, Math.sin(a) * 8.4, 2], [Math.cos(a) * 8.4, Math.sin(a) * 8.4, 7], 0.35, ROOF_RED, 6);
  }
  cyl(g, 10, 10, 7, 7.6, 0, 0, ROOF_RED, 8);
  cone(g, 13.5, 5.2, 0, 0, 7.6, ROOF, 8);
  cone(g, 10.5, 4.2, 0, 0, 11.2, ROOF, 8);
  sphere(g, 0, 0, 16, 0.8, 0xd9b45a, 1, 8);
}
/** 上海博物馆: the round "ding" with its shallow dome. */
function buildMuseum(g: THREE.Group) {
  box(g, 92, 92, 7, 0, 0, 0, STONE);                   // the square plinth
  cyl(g, 44, 44, 7, 30, 0, 0, CREAM, 44);              // the round drum
  for (let i = 0; i < 24; i++) {                        // the colonnade
    const a = (i * 360 / 24) * Math.PI / 180;
    tube(g, [Math.cos(a) * 45, Math.sin(a) * 45, 7], [Math.cos(a) * 45, Math.sin(a) * 45, 29], 0.8, 0xd6c8ad, 6);
  }
  cyl(g, 46, 46, 30, 32, 0, 0, 0xcdbfa4, 44);          // the flat cornice
  box(g, 22, 22, 5, 0, 0, 32, CREAM);                   // the square "ding" pavilion
  const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), lmat(0xded1b8));
  dome.scale.z = 0.42; dome.position.set(0, 0, 37); g.add(dome);
}

const BUILDERS: Record<Landmark["kind"], (g: THREE.Group) => void> = {
  pearl: buildPearl, "shanghai-tower": buildShanghaiTower, swfc: buildSwfc, jinmao: buildJinmao,
  customs: buildCustoms, hsbc: buildHsbc, pavilion: buildPavilion, museum: buildMuseum,
};

const landmarkGroup = new THREE.Group();
landmarkGroup.name = "landmarks";
for (const l of LANDMARKS) {
  const [x, y] = ecefToEnu(llhToEcef(l.lat, l.lon, 0));
  const g = new THREE.Group();
  g.name = l.id;
  g.position.set(x, y, ground(x, y) - 0.6);
  g.rotation.z = THREE.MathUtils.degToRad(90 - l.bearing);
  BUILDERS[l.kind](g);
  landmarkGroup.add(g);
}
scene.add(landmarkGroup);

/** ENU rectangle of ground the tile camera can see (screen rect swept over the terrain's height range). */
function footprint(tx: number, ty: number) {
  const { right: r, up: v, dir: d } = axes();
  const T = CAMERA.tile * CAMERA.mpp;
  /** ground height on the ray through the tile centre (a couple of fixed-point iterations) */
  const centreGround = () => {
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const sx = (tx + 0.5) * T, sy = (ty + 0.5) * T;
      const t = (u + v[2] * sy) / d[2];
      u = ground(r[0] * sx - v[0] * sy + d[0] * t, r[1] * sx - v[1] * sy + d[1] * t);
    }
    return u;
  };
  const box = (lo: number, hi: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (const sx of [tx * T, (tx + 1) * T]) for (const sy of [ty * T, (ty + 1) * T]) for (const u of [lo, hi]) {
      const t = (u + v[2] * sy) / d[2];
      xs.push(r[0] * sx - v[0] * sy + d[0] * t);
      ys.push(r[1] * sx - v[1] * sy + d[1] * t);
    }
    const m = 15;
    return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m] as const;
  };
  // first the rough band around the local ground, then the actual terrain range under that band
  const u0 = centreGround();
  let b = box(u0 - 10, u0 + 10);
  let lo = Infinity, hi = -Infinity;
  for (let y = b[1]; y <= b[3]; y += 20) for (let x = b[0]; x <= b[2]; x += 20) {
    const g = ground(x, y);
    if (Number.isFinite(g)) { lo = Math.min(lo, g); hi = Math.max(hi, g); }
  }
  if (Number.isFinite(lo)) b = box(lo - 8, hi + 8);
  return [b[0], b[1], b[2], b[3]] as [number, number, number, number];
}

function buildGround(tx: number, ty: number, data?: TileObjects) {
  const [x0, y0, x1, y1] = footprint(tx, ty);
  // texture
  const cv = groundTexture.image as HTMLCanvasElement;
  cv.width = Math.ceil((x1 - x0) / GROUND_MPT);
  cv.height = Math.ceil((y1 - y0) / GROUND_MPT);
  const visible = features.filter((_, i) => fbox[i][0] < x1 && fbox[i][2] > x0 && fbox[i][1] < y1 && fbox[i][3] > y0);
  drawGround(cv.getContext("2d")!, visible, [x0, y0, x1, y1], GROUND_MPT, data ?? { b: [], t: [] }, ground, CARTOON);
  groundTexture.needsUpdate = true;
  // terrain mesh: 5 m grid draped on the terrain, UVs into the canvas
  const step = 5, nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(x1, x0 + i * step), y = Math.min(y1, y0 + j * step), k = j * nx + i;
    pos.set([x, y, ground(x, y)], k * 3);
    uv.set([(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)], k * 2);
    if (i && j) idx.push(k - nx - 1, k - nx, k, k - nx - 1, k, k - 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  groundMesh.geometry.dispose();
  groundMesh.geometry = geo;
}

/** Ellipsoid height (cm + 10000, 16 bit in RG) of whatever surface is visible. */
const heightMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vEnu;
    void main() {
      #ifdef USE_INSTANCING
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
      #else
        vec4 w = modelMatrix * vec4(position, 1.0);
      #endif
      vEnu = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  depthTest: true,
  depthWrite: true,
  side: THREE.DoubleSide,
  fragmentShader: /* glsl */ `
    varying vec3 vEnu;
    void main() {
      float h = vEnu.z + dot(vEnu.xy, vEnu.xy) / (2.0 * 6371000.0);
      float v = clamp(floor((h + 100.0) * 100.0 + 0.5), 0.0, 65535.0);
      gl_FragColor = vec4(floor(v / 256.0) / 255.0, mod(v, 256.0) / 255.0, 0.0, 1.0);
    }`,
});
const heightTarget = new THREE.WebGLRenderTarget(HEIGHT_SIZE, HEIGHT_SIZE, {
  colorSpace: THREE.NoColorSpace, depthBuffer: true,
  depthTexture: new THREE.DepthTexture(HEIGHT_SIZE, HEIGHT_SIZE, THREE.UnsignedIntType),
});
heightTarget.texture.generateMipmaps = false;

// ---------------------------------------------------------------------------------------------
// Open-data 3D objects.

type P2 = [number, number];
export interface TileObjects {
  b: Array<[P2[], number, number, number | null]>; // ring, height, style, ground hint (ellipsoid)
  t: Array<[number, number, number, number]>;      // x, y, radius, crown height
}

/** wall, roof colours per style (see scene.ts): bauhaus, residential, public, tower, shed, modern */
const PALETTE: Array<[number[], number[]]> = [
  [[0.98, 0.96, 0.91], [0.86, 0.83, 0.78]], // bauhaus
  [[0.96, 0.89, 0.75], [0.80, 0.77, 0.71]], // 60s-80s residential
  [[0.91, 0.84, 0.70], [0.73, 0.71, 0.66]], // public stone
  [[0.70, 0.79, 0.86], [0.65, 0.69, 0.73]], // glass tower
  [[0.80, 0.78, 0.73], [0.57, 0.57, 0.57]], // shed
  [[0.89, 0.89, 0.86], [0.77, 0.77, 0.77]], // modern
];
const SUN = new THREE.Vector3(-0.55, -0.35, 0.76).normalize();

/** Facade textures, one per style index (see style() in src/scene.ts), generated offline with the
 *  local Qwen-Image 2.1 (pipeline/tools/qwen-texture.mjs), plus three roofs. Each image is exactly one
 *  module in metres and is mirror-tiled, so a wall has no visible repeat seam. */
const FACADE_FILES = ["bauhaus-white", "residential-cream", "public-stone", "tower-curtain", "factory-blue", "office-glass"];
const FACADE_MODULE: Array<[number, number]> = [[16, 16], [14, 14], [14, 14], [12, 12], [20, 20], [16, 16]];
const ROOF_FILES = ["roof-metal", "roof-blue", "roof-concrete"];
/** GLSL if-chain for moduleOf(), so the shader cannot drift from FACADE_MODULE */
const MODULE_CASES = FACADE_MODULE.slice(0, -1)
  .map(([w, h], i) => `      if (k == ${i}) return vec2(${w.toFixed(1)}, ${h.toFixed(1)});`)
  .join("\n");
const ROOF_MODULE = 8;
const textureLoader = new THREE.TextureLoader();
async function loadTexture(file: string) {
  let texture: THREE.Texture;
  try {
    texture = await textureLoader.loadAsync(`/style/facades/${file}.png`);
  } catch {
    // a texture that has not been generated yet must not stop the whole render: paint flat instead
    console.warn(`[textures] ${file}.png missing — flat fallback`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ded6c5";
    ctx.fillRect(0, 0, 2, 2);
    texture = new THREE.CanvasTexture(canvas);
  }
  texture.wrapS = THREE.MirroredRepeatWrapping;
  texture.wrapT = THREE.MirroredRepeatWrapping;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace; // sampled by hand: toLinear() in the shaders
  return texture;
}
const FACADE_TEX = await Promise.all(FACADE_FILES.map(loadTexture));
const ROOF_TEX = await Promise.all(ROOF_FILES.map(loadTexture));

const buildingMaterial = new THREE.ShaderMaterial({
  defines: CARTOON ? { CARTOON: 1 } : {},
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute vec2 facade;   // (meters along wall, meters above ground); y = -1000: roof / rooftop object
    attribute vec2 roofUv;   // world x,y in metres, for the roof textures
    attribute float kind;    // style index
    attribute float tint;    // 0..1 per building: a pastel wash so neighbours differ
    attribute float hgt;     // building height, for the parapet band
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying vec2 vRoofUv;
    varying float vKind; varying float vTint; varying float vHgt;
    void main() {
      vColor = color; vNormal = normal; vFacade = facade; vRoofUv = roofUv;
      vKind = kind; vTint = tint; vHgt = hgt;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun;
    uniform sampler2D uFacade0, uFacade1, uFacade2, uFacade3, uFacade4, uFacade5;
    uniform sampler2D uRoof0, uRoof1, uRoof2;
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying vec2 vRoofUv;
    varying float vKind; varying float vTint; varying float vHgt;
    const vec3 GLASS = vec3(0.30, 0.40, 0.50);
    /** Authored colours are sRGB; cartoon renders go through a linear target (undone in postMaterial). */
    vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
    // a small pastel set; each building picks one, so a row of blocks is not one flat colour
    const vec3 TINTS[8] = vec3[8](
      vec3(0.99, 0.95, 0.86), vec3(0.96, 0.86, 0.79), vec3(0.91, 0.89, 0.74),
      vec3(0.84, 0.90, 0.82), vec3(0.85, 0.90, 0.96), vec3(0.99, 0.91, 0.72),
      vec3(0.93, 0.80, 0.74), vec3(0.88, 0.86, 0.84));
    /** the module a facade texture repeats over, in metres (generated from FACADE_MODULE) */
    vec2 moduleOf(int k) {
${MODULE_CASES}
      return vec2(${FACADE_MODULE[5][0].toFixed(1)}, ${FACADE_MODULE[5][1].toFixed(1)});
    }
    vec3 facadeTex(int k, vec2 uv) {
      if (k == 0) return texture2D(uFacade0, uv).rgb;
      if (k == 1) return texture2D(uFacade1, uv).rgb;
      if (k == 2) return texture2D(uFacade2, uv).rgb;
      if (k == 3) return texture2D(uFacade3, uv).rgb;
      if (k == 4) return texture2D(uFacade4, uv).rgb;
      return texture2D(uFacade5, uv).rgb;
    }
    /** three flat tones (sun side / side / shadow side) with cool shadows: the volume of the block */
    float celTone(float ndl) {
      if (ndl > 0.62) return 1.0;
      if (ndl > 0.12) return 0.85;
      if (ndl > -0.30) return 0.70;
      return 0.58;
    }
    void main() {
      vec3 n = normalize(vNormal);
      bool roof = vFacade.y < -100.0;
      vec3 albedo;
      if (roof) {
      #ifdef CARTOON
        int k = int(vKind + 0.5);
        // sheds alternate silver standing seam and blue profiled steel; everything else concrete
        int rk = k == 4 ? (vTint > 0.5 ? 1 : 0) : 2;
        // every roof is turned a little, so the panel ribs of one block never line up with its neighbour
        float ang = vTint * 3.1416;
        mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        vec2 uv = (rot * vRoofUv) / ${ROOF_MODULE.toFixed(1)};
        vec3 t = rk == 0 ? texture2D(uRoof0, uv).rgb : rk == 1 ? texture2D(uRoof1, uv).rgb : texture2D(uRoof2, uv).rgb;
        albedo = mix(toLinear(t), vColor, 0.30);
      #else
        albedo = vColor; // the original flat render has no textures at all
      #endif
      } else {
        int k = int(vKind + 0.5);
        #ifdef CARTOON
          vec2 uv = vFacade / moduleOf(k);
          vec3 t = toLinear(facadeTex(k, uv));
          albedo = t * (0.94 + 0.10 * vTint);
          // parapet: a lit coping and the shadow under it; walls darken into the ground
          float rel = vFacade.y / max(vHgt, 0.001);
          if (rel > 0.955) albedo *= 1.06;
          else if (rel > 0.915) albedo *= 0.84;
          albedo *= 0.82 + 0.18 * smoothstep(0.0, 3.5, vFacade.y);
          albedo = mix(albedo, albedo * mix(vec3(1.0), TINTS[int(mod(vTint * 8.0, 8.0))], 1.6), 0.16);
        #else
          // the original flat render: procedurally drawn windows, no textures
          albedo = vColor;
          if (vFacade.y > -100.0) {
            int kk = int(vKind + 0.5);
            float fl = fract(vFacade.y / 3.2), x = vFacade.x;
            bool ground = vFacade.y < 3.2;
            if (kk == 0) {
              bool ribbon = fl > 0.45 && fl < 0.78 && fract(x / 7.0) > 0.08;
              if (ribbon) albedo = mix(albedo, GLASS, 0.75);
              else if (fl < 0.12) albedo *= 0.93;
            } else if (kk == 1) {
              float col = fract(x / 3.0);
              if (fl > 0.30 && fl < 0.80 && col > 0.20 && col < 0.80) albedo = mix(albedo, GLASS, 0.70);
              if (fl < 0.22) albedo *= 0.86;
            } else if (kk == 3) {
              albedo = mix(albedo, GLASS * 1.1, 0.55);
              if (fl < 0.10 || fract(x / 1.6) < 0.06) albedo = vec3(0.80, 0.83, 0.86);
            } else if (kk == 5) {
              float col = fract(x / 4.0);
              if (fl > 0.18 && fl < 0.88 && col > 0.08 && col < 0.92) albedo = mix(albedo, GLASS, 0.65);
            } else if (kk == 2) {
              float col = fract(x / 4.5);
              if (fl > 0.25 && fl < 0.85 && col > 0.35 && col < 0.65) albedo = mix(albedo, GLASS, 0.6);
            }
            if (ground && kk != 3 && kk != 4) albedo *= 0.84;
          }
        #endif
      }
      #ifdef CARTOON
        float ndl = dot(n, sun);
        float tone = roof ? 1.0 : celTone(ndl);
        vec3 c = albedo * tone;
        c = mix(c, c * vec3(0.90, 0.93, 1.05), (1.0 - tone) * 1.05); // shadow sides go cool, gently
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      #else
        float light = min(1.10, 0.74 + 0.40 * max(dot(n, sun), 0.0));
        gl_FragColor = vec4(albedo * light, 1.0);
      #endif
    }`,
  uniforms: {
    sun: { value: SUN },
    uFacade0: { value: FACADE_TEX[0] }, uFacade1: { value: FACADE_TEX[1] }, uFacade2: { value: FACADE_TEX[2] },
    uFacade3: { value: FACADE_TEX[3] }, uFacade4: { value: FACADE_TEX[4] }, uFacade5: { value: FACADE_TEX[5] },
    uRoof0: { value: ROOF_TEX[0] }, uRoof1: { value: ROOF_TEX[1] }, uRoof2: { value: ROOF_TEX[2] },
  },
});

/**
 * Tree species of Tel Aviv streets and parks, as placeholder colours and shapes the paint step turns
 * into real trees (style/trees.png). Weights are rough shares; palms only replace small crowns.
 * Shanghai gets its own mix: plane trees, camphor, willow and ginkgo, no palms.
 * [name, weight, crown colour, crown scale xy, crown scale z, palm?]
 */
const TLV_SPECIES: Array<[string, number, number[], number, number, boolean]> = [
  ["ficus", 22, [0.16, 0.36, 0.14], 1, 0.85, false],
  ["tipuana", 13, [0.42, 0.62, 0.22], 1.05, 0.7, false],
  ["jacaranda", 9, [0.62, 0.5, 0.85], 1, 0.7, false],
  ["poinciana", 7, [0.88, 0.32, 0.16], 1.15, 0.45, false],
  ["olive", 10, [0.6, 0.66, 0.55], 0.8, 0.75, false],
  ["pine", 8, [0.12, 0.3, 0.26], 0.95, 1.1, false],
  ["eucalyptus", 6, [0.38, 0.52, 0.46], 0.85, 1.25, false],
  ["date palm", 14, [0.55, 0.62, 0.2], 0, 0, true],
  ["fan palm", 11, [0.32, 0.5, 0.2], 0, 0, true],
];
const SH_SPECIES: Array<[string, number, number[], number, number, boolean]> = [
  ["plane", 40, [0.34, 0.55, 0.22], 1, 0.85, false],       // 法国梧桐: the street tree of the former French Concession
  ["camphor", 26, [0.16, 0.38, 0.18], 1.1, 1.0, false],    // 香樟
  ["willow", 14, [0.48, 0.64, 0.26], 0.9, 0.7, false],     // 柳
  ["ginkgo", 12, [0.72, 0.72, 0.2], 0.85, 0.9, false],     // 银杏, yellow in autumn
  ["metasequoia", 8, [0.24, 0.42, 0.2], 0.7, 1.35, false], // 水杉, a tall narrow crown
];
const SPECIES = activeRegion() === "shanghai" ? SH_SPECIES : TLV_SPECIES;
const SPECIES_TOTAL = SPECIES.reduce((t, s) => t + s[1], 0);
const rand = (x: number, y: number) => Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
/** Mostly one species per ~40 m patch (streets are planted in runs), every 4th tree a random one. */
function species(x: number, y: number, r: number) {
  const own = rand(x, y) < 0.25;
  let h = (own ? rand(y, x) : rand(Math.floor(x / 40), Math.floor(y / 40))) * SPECIES_TOTAL;
  for (const s of SPECIES) if ((h -= s[1]) < 0) return s[5] && r > 4.5 ? SPECIES[0] : s; // no palm for a big canopy
  return SPECIES[0];
}

const treeMaterial = new THREE.ShaderMaterial({
  defines: CARTOON ? { CARTOON: 1 } : {},
  vertexShader: /* glsl */ `
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    void main() {
      vNormal = normalize(mat3(instanceMatrix) * normal);
      vShade = fract(sin(dot(instanceMatrix[3].xy, vec2(12.9898, 78.233))) * 43758.5453);
      vColor = instanceColor;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun;
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
    void main() {
      float ndl = dot(normalize(vNormal), sun);
      float light = ndl > 0.40 ? 1.06 : ndl > -0.20 ? 0.90 : 0.74;
      vec3 c = vColor * (0.92 + 0.16 * vShade);
      c = mix(c, c * vec3(0.86, 0.95, 0.93), (1.0 - light) * 1.4); // undersides stay green, not grey
      #ifdef CARTOON
        gl_FragColor = vec4(toLinear(clamp(c * light, 0.0, 1.0)), 1.0);
      #else
        gl_FragColor = vec4(c * light, 1.0);
      #endif
    }`,
  uniforms: { sun: { value: SUN } },
});

const objects = new THREE.Group();
scene.add(objects);
function pointInRing(x: number, y: number, ring: P2[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function buildObjects(data: TileObjects) {
  objects.children.forEach((o: any) => o.geometry?.dispose());
  objects.clear();
  const pos: number[] = [], nor: number[] = [], col: number[] = [], fac: number[] = [], ruv: number[] = [];
  const tow: number[] = [], tnt: number[] = [], hgtA: number[] = [];
  /** axis-aligned box on a roof (rooftop clutter), no facade pattern */
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number[]) => {
    const X = [x - sx / 2, x + sx / 2], Y = [y - sy / 2, y + sy / 2], Z = [z, z + sz];
    const faces: Array<[number[][], number[]]> = [
      [[[X[0], Y[0], Z[1]], [X[1], Y[0], Z[1]], [X[1], Y[1], Z[1]], [X[0], Y[1], Z[1]]], [0, 0, 1]],
      [[[X[0], Y[0], Z[0]], [X[1], Y[0], Z[0]], [X[1], Y[0], Z[1]], [X[0], Y[0], Z[1]]], [0, -1, 0]],
      [[[X[1], Y[0], Z[0]], [X[1], Y[1], Z[0]], [X[1], Y[1], Z[1]], [X[1], Y[0], Z[1]]], [1, 0, 0]],
      [[[X[1], Y[1], Z[0]], [X[0], Y[1], Z[0]], [X[0], Y[1], Z[1]], [X[1], Y[1], Z[1]]], [0, 1, 0]],
      [[[X[0], Y[1], Z[0]], [X[0], Y[0], Z[0]], [X[0], Y[0], Z[1]], [X[0], Y[1], Z[1]]], [-1, 0, 0]],
    ];
    for (const [q, nn] of faces) for (const v of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[v]); nor.push(...nn); col.push(...c); fac.push(0, -1000);
      // rooftop clutter keeps the roof texture: its top face carries world x,y, its sides none
      ruv.push(nn[2] === 1 ? q[v][0] : 0, nn[2] === 1 ? q[v][1] : 0);
      tow.push(0); tnt.push(0); hgtA.push(0);
    }
  };
  const hash = (n: number) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; return (Math.imul(x, 0xc2b2ae35) >>> 0) / 2 ** 32; };
  const rnd = (seed: number) => () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 2 ** 32;
  data.b.forEach(([ring, h, style]) => {
    // sit on the highest ground under the footprint; walls reach 1 m below the lowest so slopes never show a gap
    const gs = ring.map(([x, y]) => ground(x, y));
    const top = Math.max(...gs) + h, g = Math.min(...gs) - 1;
    const [wall, roof] = PALETTE[style] ?? PALETTE[0];
    const isTower = style;
    const tint = hash(Math.round(ring[0][0] * 3.1 + ring[0][1] * 7.7));
    let along = 0;
    for (let k = 0; k < ring.length; k++) {
      const [ax, ay] = ring[k], [bx, by] = ring[(k + 1) % ring.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      const nx = (by - ay) / L, ny = -(bx - ax) / L; // outward for CCW
      const quad = [[ax, ay, g, along, -1], [bx, by, g, along + L, -1], [bx, by, top, along + L, top - g - 1], [ax, ay, top, along, top - g - 1]];
      for (const q of [0, 1, 2, 0, 2, 3]) {
        pos.push(quad[q][0], quad[q][1], quad[q][2]); nor.push(nx, ny, 0); col.push(...wall);
        fac.push(quad[q][3], quad[q][4]); ruv.push(0, 0);
        tow.push(isTower); tnt.push(tint); hgtA.push(h);
      }
      along += L;
    }
    const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const t of tris) for (const v of t) {
      pos.push(ring[v][0], ring[v][1], top); nor.push(0, 0, 1); col.push(...roof); fac.push(0, -1000);
      ruv.push(ring[v][0], ring[v][1]); tow.push(0); tnt.push(tint); hgtA.push(h);
    }
    // rooftop clutter on flat residential roofs: solar water heaters (panel + tank), AC units
    if (style !== 3 && style !== 4 && h > 6) {
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const area = Math.abs(THREE.ShapeUtils.area(ring.map(([x, y]) => new THREE.Vector2(x, y))));
      const r = rnd(Math.round(x0 * 31 + y0 * 17));
      const n = Math.min(36, Math.max(1, Math.floor(area / (area > 2000 ? 130 : 70))));
      for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
        const px = x0 + 1.5 + r() * (x1 - x0 - 3), py = y0 + 1.5 + r() * (y1 - y0 - 3);
        if (!pointInRing(px, py, ring)) continue;
        k++;
        const kind = r();
        if (kind < 0.55) {        // solar water heater: dark panel + white tank
          box(px, py, top, 2.0, 1.1, 0.35, [0.16, 0.22, 0.38]);
          box(px, py + 0.9, top, 1.6, 0.6, 0.7, [0.93, 0.93, 0.92]);
        } else if (kind < 0.85) { // AC unit
          box(px, py, top, 0.9, 0.7, 0.6, [0.74, 0.75, 0.76]);
        } else {                  // stair / lift housing
          box(px, py, top, 2.6, 2.6, 2.6, roof.map((v) => v * 0.95));
        }
      }
    }
  });
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("facade", new THREE.Float32BufferAttribute(fac, 2));
    geo.setAttribute("kind", new THREE.Float32BufferAttribute(tow, 1));
    geo.setAttribute("tint", new THREE.Float32BufferAttribute(tnt, 1));
    geo.setAttribute("roofUv", new THREE.Float32BufferAttribute(ruv, 2));
    geo.setAttribute("hgt", new THREE.Float32BufferAttribute(hgtA, 1));
    objects.add(new THREE.Mesh(geo, buildingMaterial));
  }
  if (data.t.length) {
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), treeMaterial, data.t.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5), treeMaterial, data.t.length);
    const m = new THREE.Matrix4(), c = new THREE.Color(), bark = new THREE.Color(0.45, 0.36, 0.28);
    data.t.forEach(([x, y, r, ch], i) => {
      const g = ground(x, y), [name, , col, sxy, sz, palm] = species(x, y, r);
      if (palm) {
        // small star crown high on a thin trunk
        const top = g + Math.max(ch, 8) + (name === "fan palm" ? 6 : 0); // Washingtonias tower over the rest
        m.makeScale(2.6, 2.6, 0.9).setPosition(x, y, top);
        crowns.setMatrixAt(i, m);
        m.makeScale(0.4, 0.4, top - g).setPosition(x, y, g);
        trunks.setMatrixAt(i, m);
      } else {
        m.makeScale(r * sxy, r * sxy, r * sz).setPosition(x, y, g + ch);
        crowns.setMatrixAt(i, m);
        m.makeScale(0, 0, 0);
        trunks.setMatrixAt(i, m);
      }
      crowns.setColorAt(i, c.setRGB(col[0], col[1], col[2]));
      trunks.setColorAt(i, bark);
    });
    objects.add(crowns, trunks);
  }
}

/** The frustum is wider than the tile by PAD on every side (overscan); returns the padded half size. */
function placeCamera(tx: number, ty: number) {
  const c = tileCamera(tx, ty);
  const half = c.half * (FULL / SIZE);
  camera.left = -half; camera.right = half;
  camera.top = half; camera.bottom = -half;
  camera.near = c.near; camera.far = c.far;
  camera.position.set(...c.pos);
  camera.up.set(...c.up);
  camera.lookAt(c.pos[0] + c.dir[0], c.pos[1] + c.dir[1], c.pos[2] + c.dir[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return half;
}

async function renderTile(tx: number, ty: number, data?: TileObjects) {
  const half = placeCamera(tx, ty);
  buildObjects(data ?? { b: [], t: [] });
  buildGround(tx, ty, data);
  if (CARTOON) {
    renderer.setRenderTarget(colorTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    // paper grain is fixed in global pixel space; the sun is handed over in view space for the march
    postMaterial.uniforms.offset.value.set(tx * SIZE, ty * SIZE);
    postMaterial.uniforms.near.value = camera.near;
    postMaterial.uniforms.far.value = camera.far;
    postMaterial.uniforms.halfSize.value = half;
    postMaterial.uniforms.sunView.value.copy(SUN).transformDirection(camera.matrixWorldInverse).normalize();
    renderer.render(postScene, postCamera);
  } else {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
  const color = renderer.domElement.toDataURL("image/png");

  scene.overrideMaterial = heightMaterial;
  renderer.setRenderTarget(heightTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  renderer.setClearColor(0x000000, 1);
  const buf = new Uint8Array(HEIGHT_SIZE * HEIGHT_SIZE * 4);
  renderer.readRenderTargetPixels(heightTarget, 0, 0, HEIGHT_SIZE, HEIGHT_SIZE, buf);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  return { color, height: bufToB64(buf) };
}

function bufToB64(buf: Uint8Array) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

declare global {
  interface Window {
    renderTile: typeof renderTile;
    ready: boolean;
  }
}
window.renderTile = renderTile;
window.ready = true;

