/* ==================================================================
   flow-layer.js — 기류(바람)·해류 벡터장 레이어  v1.0
   ------------------------------------------------------------------
   지도 위에 바람/해류를 흐르는 입자(streamline)와 속도 색상으로
   표현하는 독립 모듈입니다. 의존성 없음(순수 JS + Canvas 2D).

   설계 원칙 — 투영(projection)을 주입받습니다.
     이 모듈은 "지도가 무엇인지" 모릅니다. project / invert 두 함수만
     받으면 Leaflet, D3, 자체 캔버스, 정사영 지구본 어디에도 붙습니다.

       project(lon, lat) -> [x, y] | null    // null = 화면에 안 보임
       invert (x, y)     -> [lon, lat] | null

   사용 예 (3줄)
     const field = FlowLayer.windField();
     const layer = new FlowLayer.Layer(canvas, { field, project, invert });
     layer.start();

   ------------------------------------------------------------------
   구성
     1. 유틸
     2. 색상 램프
     3. 벡터장  — windField() / oceanField() / customField()
     4. 렌더러  — Layer (입자 애니메이션)
     5. 속도 래스터 (배경 색칠, 선택)
   ================================================================== */

(function (global) {
"use strict";

/* ==================================================================
   1. 유틸
   ================================================================== */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function wrapLon(d) { let x = d; while (x > 180) x -= 360; while (x < -180) x += 360; return x; }

/* ==================================================================
   2. 색상 램프
   stops: [[0..1, [r,g,b]], ...]
   ================================================================== */
function lerpRamp(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    if (t >= p0 && t <= p1) {
      const f = (t - p0) / (p1 - p0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const PALETTES = {
  // 느린 청록 → 초록 → 폭풍급에서 난색. nullschool 계열의 기본 느낌.
  wind: [
    [0.00, [ 92, 150, 190]], [0.16, [ 96, 196, 186]], [0.34, [124, 226, 150]],
    [0.52, [176, 240, 116]], [0.68, [236, 238, 120]], [0.84, [242, 168,  84]],
    [1.00, [236,  96,  70]],
  ],
  // 밝은 지도 위에 얹을 때. 색이 아니라 농담으로 속도를 표현.
  grey: [
    [0.00, [176, 186, 196]], [0.30, [132, 144, 156]],
    [0.60, [ 86,  98, 110]], [0.85, [ 52,  62,  72]], [1.00, [26, 32, 39]],
  ],
  // 어두운 배경용 속도 래스터(배경 색칠).
  speedRaster: [
    [0.00, [ 22,  32,  88]], [0.18, [ 26,  60, 124]], [0.36, [ 28,  98, 120]],
    [0.54, [ 44, 140,  88]], [0.72, [104, 178,  74]], [0.86, [176, 168,  78]],
    [1.00, [168,  92,  72]],
  ],
};

/* ==================================================================
   3. 벡터장
   공통 인터페이스:
     field.sample(lon, lat) -> { u, v, m }
        u = 동쪽(+) 성분, v = 북쪽(+) 성분 (m/s), m = 속력
     field.range   -> [min, max]  색상 정규화용
     field.stepScale -> 입자 이동 배율(시각적 속도)
     field.label() -> 표시용 문자열
     field.load()  -> Promise (실시간 데이터가 있으면 받아옴)
   ================================================================== */

/* ---- 3-1. 대기 대순환 모델 (오프라인 폴백) ------------------------
   무역풍(0~30°) / 편서풍(30~60°) / 극동풍 + 제트기류 + 로스비파,
   그리고 이동하는 저기압 소용돌이. 실측이 없을 때도 '날씨처럼'
   보이게 하는 용도이며, 실측 데이터와 절대 섞지 않습니다.        */
const DEFAULT_STORMS = [
  // [lon, lat, 반경°, 세기(+저기압 북반구/-고기압), 이동 lon, 이동 lat]
  [ 132,  19, 11,  1.5, -0.020,  0.008],
  [ -62,  24, 12,  1.4, -0.022,  0.007],
  [ -30,  52, 18,  1.2,  0.026, -0.004],
  [  15,  57, 16,  1.1,  0.022, -0.003],
  [ 168, -18, 12, -1.3, -0.018, -0.008],
  [  62, -22, 13, -1.1, -0.015, -0.006],
  [-140,  40, 17,  1.2,  0.020, -0.002],
];

function makeProceduralWind(storms) {
  const S = storms.map(s => s.slice());

  function advance() {
    for (const s of S) {
      s[0] += s[4]; s[1] += s[5];
      if (s[0] >  180) s[0] -= 360;
      if (s[0] < -180) s[0] += 360;
      if (s[1] > 62 || s[1] < -62) s[5] *= -1;
    }
  }

  function sample(lon, lat) {
    const φ = lat * D2R, λ = lon * D2R;

    // 위도별 동서 기본류: sin(3φ) 가 0/60°에서 부호를 바꿔
    // 무역풍 → 편서풍 → 극동풍 순서를 만듭니다.
    let u = 7.5 * Math.sin(3 * φ) * Math.cos(φ);
    u += 8.5 * Math.exp(-Math.pow((Math.abs(lat) - 40) / 13, 2));  // 아열대 제트
    u += 4.0 * Math.exp(-Math.pow((Math.abs(lat) - 62) / 10, 2));  // 한대 제트
    let v = -2.0 * Math.sin(6 * φ);

    // 정상파(로스비파) — 완전한 줄무늬가 되지 않도록 사행시킵니다.
    u += 3.4 * Math.sin(3 * λ + 1.1) * Math.cos(2 * φ);
    u += 2.2 * Math.sin(5 * λ - 2.0) * Math.cos(3 * φ);
    v += 3.8 * Math.cos(2 * λ - 0.6) * Math.cos(φ);
    v += 2.4 * Math.sin(4 * λ + 2.2) * Math.cos(3 * φ);

    // 저기압 소용돌이 (태풍·허리케인 형태)
    for (const s of S) {
      let dl = lon - s[0];
      if (dl >  180) dl -= 360;
      if (dl < -180) dl += 360;
      if (Math.abs(dl) > s[2] * 3) continue;
      const dx = dl * Math.cos(lat * D2R), dy = lat - s[1];
      const r = Math.hypot(dx, dy);
      if (r < 1e-6 || r > s[2] * 2.6) continue;
      // 접선 속도는 눈벽에서 최대, 바깥으로 감쇠
      const vt = s[3] * 26 * (r / s[2]) * Math.exp(-Math.pow(r / s[2], 1.7));
      u += -vt * (dy / r);
      v +=  vt * (dx / r);
    }

    // 적도 무풍대
    const doldrum = 1 - 0.7 * Math.exp(-Math.pow(lat / 6, 2));
    return { u: u * doldrum, v: v * doldrum };
  }

  return { sample, advance, storms: S };
}

/* ---- 3-2. 실시간 바람 (Open-Meteo, 무료·API 키 불필요) ---------- */
const GRID = { lonStep: 5, latStep: 5, latMin: -85, latMax: 85 };
const NX = Math.round(360 / GRID.lonStep);                              // 72
const NY = Math.round((GRID.latMax - GRID.latMin) / GRID.latStep) + 1;  // 35

function gridLon(i) { return -180 + i * GRID.lonStep; }
function gridLat(j) { return GRID.latMin + j * GRID.latStep; }

function bilinear(grid, lon, lat, pick, fallback) {
  if (!grid) return fallback(lon, lat);
  const L = wrapLon(lon);
  const cl = clamp(lat, GRID.latMin, GRID.latMax);
  const fi = (L + 180) / GRID.lonStep, fj = (cl - GRID.latMin) / GRID.latStep;
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const di = fi - i0, dj = fj - j0;
  const ii0 = ((i0 % NX) + NX) % NX, ii1 = (ii0 + 1) % NX;
  const jj0 = clamp(j0, 0, NY - 1), jj1 = Math.min(jj0 + 1, NY - 1);
  const a = grid[jj0][ii0], b = grid[jj0][ii1], c = grid[jj1][ii0], d = grid[jj1][ii1];
  if (!a || !b || !c || !d) return fallback(lon, lat);
  const mix = (p, q, r, s) => (p * (1 - di) + q * di) * (1 - dj) + (r * (1 - di) + s * di) * dj;
  return pick(a, b, c, d, mix);
}

async function fetchOpenMeteoGrid(onProgress, signal) {
  const pts = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++)
    pts.push({ i, j, lat: gridLat(j), lon: gridLon(i) });

  const grid = [];
  for (let j = 0; j < NY; j++) grid.push(new Array(NX).fill(null));

  const BATCH = 120;                 // 좌표를 콤마로 묶어 한 번에 요청
  let ok = 0;
  for (let b = 0; b < pts.length; b += BATCH) {
    const batch = pts.slice(b, b + BATCH);
    const lats = batch.map(p => p.lat.toFixed(2)).join(",");
    const lons = batch.map(p => p.lon.toFixed(2)).join(",");
    const url = "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lats}&longitude=${lons}` +
      "&current=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=ms";
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      let data = await res.json();
      if (!Array.isArray(data)) data = [data];
      data.forEach((d, k) => {
        const p = batch[k];
        if (!p || !d || !d.current) return;
        const spd = d.current.wind_speed_10m, dir = d.current.wind_direction_10m;
        if (spd == null || dir == null) return;
        // 기상학적 풍향은 '불어오는 쪽'이므로 부호를 뒤집습니다.
        const rad = dir * D2R;
        grid[p.j][p.i] = { u: -spd * Math.sin(rad), v: -spd * Math.cos(rad), t: d.current.temperature_2m };
        ok++;
      });
    } catch (e) { /* 구멍은 아래에서 모델값으로 메웁니다 */ }
    if (onProgress) onProgress(Math.min(1, (b + BATCH) / pts.length));
  }
  return { grid, ok, total: pts.length };
}

/**
 * 바람 벡터장.
 * @param {object} opts
 *   live      true 면 Open-Meteo 실측을 받아옵니다 (기본 true)
 *   storms    폴백 모델의 저기압 배열 (기본 DEFAULT_STORMS)
 *   maxSpeed  색상 정규화 상한 m/s (기본 35)
 */
function windField(opts) {
  opts = opts || {};
  const proc = makeProceduralWind(opts.storms || DEFAULT_STORMS);
  let grid = null, live = false, label = "모의 대순환 모델";
  let lastAdvance = 0;

  return {
    kind: "wind",
    range: [0, opts.maxSpeed != null ? opts.maxSpeed : 35],
    stepScale: 0.010,          // 입자 이동 배율(도/프레임/(m/s))
    unit: "m/s",
    isLive() { return live; },
    label() { return `바람 10m · ${label}`; },

    async load(onProgress, signal) {
      if (grid || opts.live === false) return this;
      try {
        const r = await fetchOpenMeteoGrid(onProgress, signal);
        if (r.ok > r.total * 0.5) {
          for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++)
            if (!r.grid[j][i]) r.grid[j][i] = proc.sample(gridLon(i), gridLat(j));
          grid = r.grid; live = true; label = "Open-Meteo 실시간 · 5° 격자";
        }
      } catch (e) { /* 모델 유지 */ }
      return this;
    },

    // 실측이 없을 때만 저기압을 이동시켜 살아있게 만듭니다.
    tick(now) {
      if (live) return false;
      if (now - lastAdvance < 200) return false;
      lastAdvance = now; proc.advance(); return true;
    },

    sample(lon, lat) {
      const f = bilinear(grid, lon, lat,
        (a, b, c, d, mix) => ({ u: mix(a.u, b.u, c.u, d.u), v: mix(a.v, b.v, c.v, d.v) }),
        proc.sample);
      return { u: f.u, v: f.v, m: Math.hypot(f.u, f.v) };
    },

    // 부가: 같은 응답에 들어있는 2m 기온 (없으면 null)
    temperature(lon, lat) {
      if (!grid) return null;
      return bilinear(grid, lon, lat, (a, b, c, d, mix) => mix(a.t, b.t, c.t, d.t), () => null);
    },
  };
}

/* ---- 3-3. 해류 모델 ---------------------------------------------
   아열대 환류(북반구 시계/남반구 반시계), 남극순환류(ACC),
   서안경계류(멕시코만류·쿠로시오·아굴라스·브라질). 관측이 아니라
   교육용 모델입니다.                                              */
const GYRES = [
  // [중심lon, 중심lat, 반경lon, 반경lat, 세기(+시계/-반시계)]
  [ -45,  30, 45, 18,  1.0],   // 북대서양
  [ -25, -25, 35, 20, -1.0],   // 남대서양
  [-165,  32, 60, 18,  1.0],   // 북태평양
  [-120, -28, 60, 22, -1.0],   // 남태평양
  [  75, -28, 35, 18, -1.0],   // 인도양
];
const JETS = [
  // [lon, lat, 폭lon, 폭lat, u, v]
  [ -78,  30,  7, 7,  0.7,  1.5],   // 멕시코만류 시작
  [ -68,  40, 12, 6,  1.7,  0.7],   // 북대서양 해류
  [ 132,  30,  7, 7,  0.8,  1.4],   // 쿠로시오
  [ 150,  37, 14, 6,  1.7,  0.4],   // 쿠로시오 연장
  [  30, -33,  7, 8, -0.5, -1.4],   // 아굴라스
  [ -48, -30,  7, 9, -0.4, -1.3],   // 브라질 해류
];

/**
 * 해류 벡터장(모델).
 * @param {object} opts  maxSpeed (기본 2.2 m/s)
 */
function oceanField(opts) {
  opts = opts || {};
  function sample(lon, lat) {
    let u = 1.9 * Math.exp(-Math.pow((lat + 55) / 9, 2));   // 남극순환류
    u += -0.9 * Math.exp(-Math.pow(lat / 7, 2));            // 적도 해류(서향)
    u +=  0.6 * Math.exp(-Math.pow((lat - 7) / 3, 2));      // 적도 반류(동향)
    let v = 0;

    for (const [cl, cb, rl, rb, s] of GYRES) {
      let dl = lon - cl;
      if (dl >  180) dl -= 360;
      if (dl < -180) dl += 360;
      const x = dl / rl, y = (lat - cb) / rb;
      const r2 = x * x + y * y;
      if (r2 > 4) continue;
      const env = Math.exp(-r2);
      u +=  s * 1.15 * y * env;
      v += -s * 1.15 * x * env * (rl / rb) * 0.35;
    }
    for (const [jl, jb, wl, wb, ju, jv] of JETS) {
      let dl = lon - jl;
      if (dl >  180) dl -= 360;
      if (dl < -180) dl += 360;
      if (Math.abs(dl) > wl * 3) continue;
      const env = Math.exp(-(Math.pow(dl / wl, 2) + Math.pow((lat - jb) / wb, 2)));
      u += ju * env * 1.6;
      v += jv * env * 1.6;
    }
    const polar = 1 - Math.exp(-Math.pow((Math.abs(lat) - 90) / 12, 2));
    u *= polar; v *= polar;
    return { u, v, m: Math.hypot(u, v) };
  }

  return {
    kind: "ocean",
    range: [0, opts.maxSpeed != null ? opts.maxSpeed : 2.2],
    stepScale: 0.085,          // 해류는 느려서 시각 배율을 크게
    unit: "m/s",
    isLive() { return false; },
    label() { return "해류 · 모델 (환류·ACC·서안경계류)"; },
    async load() { return this; },
    tick() { return false; },
    sample,
  };
}

/**
 * 직접 만든 벡터장을 쓰고 싶을 때.
 *   customField({ sample:(lon,lat)=>({u,v}), range:[0,20], stepScale:0.01 })
 */
function customField(cfg) {
  const range = cfg.range || [0, 20];
  return {
    kind: cfg.kind || "custom",
    range,
    stepScale: cfg.stepScale != null ? cfg.stepScale : 0.01,
    unit: cfg.unit || "m/s",
    isLive() { return !!cfg.live; },
    label() { return cfg.label || "사용자 벡터장"; },
    load: cfg.load || (async function () { return this; }),
    tick: cfg.tick || function () { return false; },
    sample(lon, lat) {
      const f = cfg.sample(lon, lat);
      return { u: f.u, v: f.v, m: f.m != null ? f.m : Math.hypot(f.u, f.v) };
    },
  };
}

/* ==================================================================
   4. 렌더러 — 흐르는 입자
   ==================================================================
   원리
     · 입자는 화면좌표가 아니라 위경도로 관리합니다. 그래야 지도를
       회전·확대해도, 어떤 투영이든 궤적이 지리적으로 옳습니다.
     · 매 프레임 캔버스를 지우지 않고 살짝 투명하게 덮어(fade) 이전
       궤적을 서서히 지웁니다. 이것이 꼬리(comet tail)를 만듭니다.
     · 날짜변경선 등 투영 이음매를 지나면 화면좌표가 한 번에 크게
       튑니다. 그 구간을 그리면 화면을 가로지르는 줄이 생기므로
       건너뜁니다.
*/
class Layer {
  /**
   * @param {HTMLCanvasElement} canvas  이 레이어 전용 캔버스(투명 배경)
   * @param {object} o
   *   field          벡터장 (필수)
   *   project(lon,lat)-> [x,y] | null   (필수)
   *   invert(x,y)    -> [lon,lat] | null (선택: 지금은 미사용이나 래스터에 필요)
   *   particleCount  기본 4500
   *   maxAge         입자 수명(프레임) 기본 110
   *   trailFade      0~1, 클수록 꼬리가 김. 기본 0.962
   *   lineWidth      기본 0.85
   *   palette        "wind" | "grey" | stops 배열
   *   opacity        선 알파 기본 0.9
   *   mask(lon,lat)  true 면 입자를 그리지 않음 (예: 해류를 육지에서 제외)
   *   onFrame()      매 프레임 콜백(선택)
   */
  constructor(canvas, o) {
    if (!canvas) throw new Error("FlowLayer: canvas is required");
    if (!o || !o.field) throw new Error("FlowLayer: field is required");
    if (!o.project) throw new Error("FlowLayer: project() is required");

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.field = o.field;
    this.project = o.project;
    this.invert = o.invert || null;
    this.mask = o.mask || null;
    this.onFrame = o.onFrame || null;

    this.particleCount = o.particleCount != null ? o.particleCount : 4500;
    this.maxAge = o.maxAge != null ? o.maxAge : 110;
    this.trailFade = o.trailFade != null ? o.trailFade : 0.962;
    this.lineWidth = o.lineWidth != null ? o.lineWidth : 0.85;
    this.opacity = o.opacity != null ? o.opacity : 0.9;
    this.setPalette(o.palette || "wind");

    this._particles = [];
    this._raf = null;
    this._running = false;
    this.reset();
  }

  setPalette(p) {
    this.palette = (typeof p === "string") ? (PALETTES[p] || PALETTES.wind) : p;
  }

  setField(field, opts) {
    this.field = field;
    if (opts && opts.palette) this.setPalette(opts.palette);
    this.reset();
  }

  /** 캔버스 크기가 바뀌었을 때 호출 */
  resize() {
    this.clear();
    this.reset();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** 입자 재배치. 지도 뷰가 바뀌면 호출하면 깔끔합니다. */
  reset() {
    const n = this.particleCount;
    this._particles = new Array(n);
    for (let i = 0; i < n; i++) this._particles[i] = this._spawn();
    this.clear();
  }

  _spawn() {
    // 구면에서 균등 분포: lat = asin(uniform(-1,1))
    for (let t = 0; t < 14; t++) {
      const lon = Math.random() * 360 - 180;
      const lat = Math.asin(Math.random() * 2 - 1) * R2D;
      if (!this.mask || !this.mask(lon, lat)) {
        return { lon, lat, age: Math.random() * this.maxAge, px: null, py: null };
      }
    }
    return { lon: 0, lat: 0, age: 0, px: null, py: null };
  }

  /** 한 프레임 그리기. 직접 루프를 돌리고 싶으면 이것만 호출하세요. */
  step() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const field = this.field;

    if (field.tick) field.tick(performance.now());

    // 1) 이전 궤적을 서서히 지웁니다(꼬리 효과).
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0," + this.trailFade + ")";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";

    // 2) 입자 전진
    const k = field.stepScale;
    const hi = field.range[1] || 1;
    const jumpLimit = Math.max(W, H) * 0.25;   // 이보다 크게 튀면 이음매
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = "round";

    for (const p of this._particles) {
      if (p.age > this.maxAge) { Object.assign(p, this._spawn()); p.age = 0; }

      const scr = this.project(p.lon, p.lat);
      if (!scr) { Object.assign(p, this._spawn()); p.age = 0; continue; }

      const f = field.sample(p.lon, p.lat);

      if (p.px !== null &&
          Math.abs(scr[0] - p.px) < jumpLimit &&
          Math.abs(scr[1] - p.py) < jumpLimit) {
        const c = lerpRamp(this.palette, f.m / hi);
        ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + this.opacity + ")";
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(scr[0], scr[1]);
        ctx.stroke();
      }
      p.px = scr[0]; p.py = scr[1];

      // 지리 좌표계에서 전진 — 투영이 무엇이든 방향이 옳습니다.
      const nextLat = clamp(p.lat + f.v * k, -89.5, 89.5);
      const nextLon = wrapLon(p.lon + f.u * k / Math.max(Math.cos(p.lat * D2R), 0.18));

      // 마스크(예: 육지)에 닿으면 그 자리에서 소멸시켜 경계를 넘지 않게
      if (this.mask && this.mask(nextLon, nextLat)) {
        Object.assign(p, this._spawn()); p.age = 0; p.px = null; continue;
      }
      p.lat = nextLat; p.lon = nextLon;
      p.age++;
    }

    if (this.onFrame) this.onFrame();
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this.step();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  destroy() { this.stop(); this._particles = []; this.clear(); }
}

/* ==================================================================
   5. 속도 래스터 — 배경을 속도 색상으로 칠하기 (선택)
   ------------------------------------------------------------------
   invert() 가 필요합니다. 블록 단위로 샘플링해 저해상 이미지를 만든 뒤
   확대해 그리므로 비용이 낮습니다. 뷰가 바뀔 때만 호출하세요.
   ================================================================== */
function renderSpeedRaster(ctx, o) {
  const W = o.width, H = o.height;
  const B = o.block || 8;
  const field = o.field, invert = o.invert;
  const palette = (typeof o.palette === "string")
    ? (PALETTES[o.palette] || PALETTES.speedRaster) : (o.palette || PALETTES.speedRaster);
  const [lo, hi] = o.range || field.range;
  const span = (hi - lo) || 1;
  const skip = o.skip || null;              // (lon,lat)=>true 면 투명
  const valueOf = o.value || ((lon, lat) => field.sample(lon, lat).m);

  const rw = Math.max(1, Math.ceil(W / B)), rh = Math.max(1, Math.ceil(H / B));
  const off = o.reuseCanvas || document.createElement("canvas");
  if (off.width !== rw || off.height !== rh) { off.width = rw; off.height = rh; }
  const octx = off.getContext("2d");
  const img = octx.createImageData(rw, rh);
  const d = img.data;

  for (let ry = 0; ry < rh; ry++) {
    const py = ry * B + B / 2;
    for (let rx = 0; rx < rw; rx++) {
      const idx = (ry * rw + rx) * 4;
      const geo = invert(rx * B + B / 2, py);
      if (!geo) { d[idx + 3] = 0; continue; }
      if (skip && skip(geo[0], geo[1])) { d[idx + 3] = 0; continue; }
      const val = valueOf(geo[0], geo[1]);
      if (val == null) { d[idx + 3] = 0; continue; }
      const c = lerpRamp(palette, (val - lo) / span);
      d[idx] = c[0]; d[idx + 1] = c[1]; d[idx + 2] = c[2]; d[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W, H);
  return off;                                 // 재사용하려면 보관하세요
}

/** 범례용 그라디언트를 캔버스에 그립니다. */
function drawLegend(canvas, palette) {
  const ctx = canvas.getContext("2d");
  const p = (typeof palette === "string") ? (PALETTES[palette] || PALETTES.wind) : palette;
  for (let x = 0; x < canvas.width; x++) {
    const c = lerpRamp(p, x / (canvas.width - 1));
    ctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
    ctx.fillRect(x, 0, 1, canvas.height);
  }
}

/* ==================================================================
   6. 흔한 투영 어댑터
   ================================================================== */
const projections = {
  /** 등장방형(plate carrée) — 캔버스에 세계 전체를 펼치는 가장 단순한 형태 */
  equirectangular(width, height, opts) {
    const o = opts || {};
    const centerLon = o.centerLon || 0;
    return {
      project(lon, lat) {
        const dl = wrapLon(lon - centerLon);
        return [(dl + 180) / 360 * width, (90 - lat) / 180 * height];
      },
      invert(x, y) {
        const lat = 90 - y / height * 180;
        if (lat > 90 || lat < -90) return null;
        return [wrapLon(x / width * 360 - 180 + centerLon), lat];
      },
    };
  },

  /** 웹 메르카토르 — Leaflet/타일 지도와 같은 좌표계 */
  webMercator(width, height, opts) {
    const o = opts || {};
    const centerLon = o.centerLon || 0, centerLat = o.centerLat || 0;
    const zoomScale = o.scale || width / 360;   // px per degree of longitude
    const latMax = 85.05112878;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + clamp(lat, -latMax, latMax) * D2R / 2));
    const cy = merc(centerLat);
    return {
      project(lon, lat) {
        const dl = wrapLon(lon - centerLon);
        return [width / 2 + dl * zoomScale,
                height / 2 - (merc(lat) - cy) * zoomScale * R2D];
      },
      invert(x, y) {
        const lon = wrapLon(centerLon + (x - width / 2) / zoomScale);
        const m = cy + (height / 2 - y) / (zoomScale * R2D);
        const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * R2D;
        if (!isFinite(lat) || Math.abs(lat) > 89.9) return null;
        return [lon, lat];
      },
    };
  },

  /** 정사영 — 지구본. 뒷면은 null 을 돌려 자동으로 잘립니다. */
  orthographic(width, height, opts) {
    const o = opts || {};
    const cx = o.cx != null ? o.cx : width / 2;
    const cy = o.cy != null ? o.cy : height / 2;
    const R = o.radius || Math.min(width, height) * 0.45;
    const state = { lon: o.centerLon || 0, lat: o.centerLat || 0 };
    return {
      state,
      project(lon, lat) {
        const λ = wrapLon(lon - state.lon) * D2R, φ = lat * D2R, φ0 = state.lat * D2R;
        const sinφ0 = Math.sin(φ0), cosφ0 = Math.cos(φ0);
        const sinφ = Math.sin(φ), cosφ = Math.cos(φ), cosλ = Math.cos(λ);
        if (sinφ0 * sinφ + cosφ0 * cosφ * cosλ < 0) return null;   // 뒷면
        return [cx + R * cosφ * Math.sin(λ),
                cy - R * (cosφ0 * sinφ - sinφ0 * cosφ * cosλ)];
      },
      invert(x, y) {
        const dx = (x - cx) / R, dy = -(y - cy) / R;
        const ρ = Math.hypot(dx, dy);
        if (ρ > 1) return null;
        if (ρ < 1e-9) return [state.lon, state.lat];
        const φ0 = state.lat * D2R;
        const c = Math.asin(clamp(ρ, -1, 1)), sc = Math.sin(c), cc = Math.cos(c);
        const lat = Math.asin(clamp(cc * Math.sin(φ0) + dy * sc * Math.cos(φ0) / ρ, -1, 1)) * R2D;
        const lon = wrapLon(state.lon +
          Math.atan2(dx * sc, ρ * cc * Math.cos(φ0) - dy * sc * Math.sin(φ0)) * R2D);
        return [lon, lat];
      },
    };
  },

  /** Leaflet 지도용 어댑터 (leaflet 이 페이지에 있을 때) */
  leaflet(map) {
    return {
      project(lon, lat) {
        const p = map.latLngToContainerPoint([lat, lon]);
        return [p.x, p.y];
      },
      invert(x, y) {
        const ll = map.containerPointToLatLng([x, y]);
        return [ll.lng, ll.lat];
      },
    };
  },
};

/* ================================================================== */
const FlowLayer = {
  Layer, windField, oceanField, customField,
  renderSpeedRaster, drawLegend, projections,
  PALETTES, lerpRamp,
  version: "1.0",
};

if (typeof module !== "undefined" && module.exports) module.exports = FlowLayer;
global.FlowLayer = FlowLayer;

})(typeof window !== "undefined" ? window : globalThis);
