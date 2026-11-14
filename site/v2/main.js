// poltertab.rhenon.com: particle ghost in shader fog (Three.js) as fixed layers behind the story + pinned scroll chapters (GSAP ScrollTrigger) + Lenis. Grew out of rhenon.com v2.
import * as THREE from "three";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const phone = matchMedia("(max-width: 767px)").matches;                       // chapter layout breakpoint
const narrow = matchMedia("(max-width: 900px)").matches || matchMedia("(pointer: coarse)").matches; // hero: no docking, tap play
const gl = !document.documentElement.classList.contains("nogl"); // probed by the inline head script (also forced by ?nogl)
if (reduce) document.documentElement.classList.add("still"); // the page opens on the docked end layout
if (gl) {

/* ---------- scene ---------- */
const canvas = document.getElementById("scene"), ghostCanvas = document.getElementById("ghost");
const hero = document.querySelector(".hero"), slot = hero.querySelector(".ghost-slot"), story = document.getElementById("how");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));
const scene = new THREE.Scene(), ghostScene = new THREE.Scene(); // ghost on its own transparent canvas so it can ride over the chapter windows
const ghostR = new THREE.WebGLRenderer({ canvas: ghostCanvas, alpha: true, antialias: false, powerPreference: "high-performance" });
ghostR.setPixelRatio(renderer.getPixelRatio()); ghostR.setClearColor(0, 0);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50); camera.position.z = 6;
const halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z; // world half-height at z=0

// fog: one full-screen quad, 4-octave value noise + grain
const fog = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  depthWrite: false, depthTest: false,
  uniforms: { uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uMouse: { value: new THREE.Vector2(0.5, 0.5) }, uDim: { value: 1 } },
  vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.999, 1.0); }`,
  fragmentShader: `
    precision highp float; uniform float uTime, uDim; uniform vec2 uRes, uMouse;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<4;i++){ v += a*n(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }
    void main(){
      vec2 uv = gl_FragCoord.xy / uRes; vec2 p = uv * vec2(uRes.x/uRes.y, 1.0);
      float t = uTime * 0.05;
      float f = fbm(p*1.6 + vec2(t, -t*0.7) + fbm(p*2.2 - t)*0.6);
      float glow = smoothstep(0.7, 0.0, distance(uv, uMouse) ) * 0.12;
      float v = (smoothstep(0.25, 0.95, f) * 0.55 + glow) * uDim;
      vec3 warm = vec3(0.86, 0.80, 0.70), cool = vec3(0.70, 0.74, 0.74);
      vec3 col = mix(cool, warm, fbm(p*0.8 + t)) * v;
      col *= 1.0 - smoothstep(0.35, 0.9, distance(uv, vec2(0.5))) * 0.8; // vignette
      col += (h(gl_FragCoord.xy + uTime) - 0.5) * 0.045; // grain
      gl_FragColor = vec4(col, 1.0);
    }`
}));
fog.frustumCulled = false; scene.add(fog);

// ghost: points sampled from a procedurally drawn silhouette
function ghostPositions(step) {
  const W = 200, H = 240, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"); x.fillStyle = "#fff";
  x.beginPath(); x.arc(W / 2, 90, 80, Math.PI, 0); x.lineTo(W / 2 + 80, 200);
  for (let i = 0; i < 5; i++) { const sx = W / 2 + 80 - i * 32; x.quadraticCurveTo(sx - 16, i % 2 ? 196 : 226, sx - 32, 200); }
  x.lineTo(W / 2 - 80, 90); x.closePath(); x.fill();
  x.globalCompositeOperation = "destination-out";
  x.beginPath(); x.ellipse(W / 2 - 28, 100, 11, 15, 0, 0, 7); x.ellipse(W / 2 + 28, 100, 11, 15, 0, 0, 7); x.fill();
  const d = x.getImageData(0, 0, W, H).data, out = [];
  for (let j = 0; j < H; j += step) for (let i = 0; i < W; i += step) if (d[(j * W + i) * 4 + 3] > 128)
    out.push((i - W / 2) / 50 + (Math.random() - .5) * .03, (H / 2 - j) / 50 + (Math.random() - .5) * .03, (Math.random() - .5) * .6);
  return new Float32Array(out);
}
const home = ghostPositions(phone ? 3 : 2), N = home.length / 3;
const rand = new Float32Array(N * 3), seed = new Float32Array(N);
for (let i = 0; i < N; i++) { rand[i * 3] = (Math.random() - .5) * 14; rand[i * 3 + 1] = (Math.random() - .5) * 9 - 2; rand[i * 3 + 2] = (Math.random() - .5) * 4; seed[i] = Math.random(); }
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(home, 3));
geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 3));
geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
const ghostMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(99, 99) }, uScatter: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uScale: { value: 1 }, uAlpha: { value: 1 }, uPuff: { value: 0 } },
  vertexShader: `
    attribute vec3 aRand; attribute float aSeed; uniform float uTime, uScatter, uPx, uScale, uAlpha, uPuff; uniform vec2 uMouse; varying float vA;
    void main(){
      vec3 p = position;
      p.x += sin(uTime*0.6 + aSeed*6.28)*0.04 + sin(uTime*0.23 + p.y*2.0)*0.05;
      p.y += cos(uTime*0.5 + aSeed*6.28)*0.04 + sin(uTime*0.4)*0.08;
      vec2 d = p.xy - uMouse; float L = length(d);
      p.xy += normalize(d + 0.001) * smoothstep(1.3, 0.0, L) * 0.9;        // cursor pushes the ghost apart
      p.xyz += (aRand * 0.25 + vec3(normalize(p.xy + 0.001), 0.0) * 0.55) * uPuff; // click/tap: puff apart, then re-form
      p = mix(p, (aRand + vec3(0.0, sin(uTime + aSeed*9.0)*0.2, 0.0)) / uScale, uScatter); // scatter fills the viewport whatever the ghost's size
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (2.2 + aSeed*2.0) * uPx * (6.0 / -mv.z) * clamp(sqrt(uScale), 0.4, 1.0);
      vA = (0.35 + 0.65*aSeed) * (1.0 - uScatter*0.6) * uAlpha;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    precision highp float; varying float vA;
    void main(){ float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, r) * vA;
      gl_FragColor = vec4(mix(vec3(0.35, 0.84, 0.77), vec3(1.0), a*0.6), a); }`
});
const ghost = new THREE.Points(geo, ghostMat); ghostScene.add(ghost);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); ghostR.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  fog.material.uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
resize(); addEventListener("resize", resize);

// where the ghost lives, per beat. x/y in world units (or follow a DOM element), s = scale, a = particle alpha, dim = fog level
const portrait = () => camera.aspect < 1;
const world = (el) => { const r = el.getBoundingClientRect(), u = (2 * halfH) / innerHeight; return { x: (r.left + r.width / 2 - innerWidth / 2) * u, y: (innerHeight / 2 - r.top - r.height / 2) * u }; };
const stops = {
  hero: () => hero.classList.contains("docked") || reduce
    ? { el: slot, s: narrow ? 0.45 : 0.58, scatter: 0, a: 1, dim: 1 }                              // docked: parked in the empty slot beside / above the install block
    : { el: null, x: 0, y: narrow ? 0.5 : 0.4, s: narrow ? 0.62 : 0.82, scatter: 0, a: 1, dim: 1 }, // screen 1: the ghost alone, h1 low
  1: () => ({ el: null, x: 0, y: 0, s: 1, scatter: 1, a: 0.8, dim: 0.6 }),                                        // scattered through the fog
  2: (el) => ({ el: el.querySelector(".win"), s: 0.9, scatter: 1, a: 0.7, dim: 0.6 }),                            // the cloud gathers around the window
  3: (el) => ({ el: el.querySelector(".ghost-cursor"), s: 0.16, scatter: 0, a: 0.35, dim: 0.6 }),                   // re-forms as the cursor that does the work
  4: () => ({ el: null, x: 0, y: 0, s: 1, scatter: 1, a: 0.7, dim: 0.6 }),                                        // scatters back into the full-screen field as chapter 3 ends, under the content
  end: () => ({ el: null, x: 0, y: 0, s: 1, scatter: 1, a: 0.6, dim: 0.4 })                                       // and stays there, dimmer, for the rest of the page
};
const goal = { ...stops.hero(), beat: "hero" }, cur = { x: 0, y: 0, ...goal }; // x/y seeded: a stop that follows an element has none until its first frame
const puff = { v: 0 }; // click or tap on the hero: puff apart, re-form. Drags never reach click, so a swipe still scrolls.
hero.addEventListener("click", (e) => { if (window.gsap && !reduce && goal.beat === "hero" && !e.target.closest("a, button")) gsap.timeline().to(puff, { v: 1, duration: 0.45, ease: "power3.out" }).to(puff, { v: 0, duration: 1.6, ease: "power2.inOut" }); });
const target = new THREE.Vector2(99, 99), mouse = new THREE.Vector2(99, 99), fogMouse = new THREE.Vector2(0.5, 0.5);
if (!phone) addEventListener("pointermove", (e) => {
  const nx = e.clientX / innerWidth, ny = e.clientY / innerHeight;
  target.set((nx * 2 - 1) * halfH * camera.aspect, (1 - ny * 2) * halfH); fogMouse.set(nx, 1 - ny);
});
document.addEventListener("pointerleave", () => target.set(99, 99));

function frame(ms, k = 0.06) {
  const t = ms / 1000;
  if (goal.el) Object.assign(goal, world(goal.el));
  for (const key of ["x", "y", "s", "scatter", "a", "dim"]) cur[key] += (goal[key] - cur[key]) * k;
  ghost.position.set(cur.x, cur.y, 0); ghost.scale.setScalar(cur.s);
  mouse.lerp(target, 0.08);
  const u = ghostMat.uniforms;
  u.uTime.value = t; u.uScatter.value = cur.scatter; u.uScale.value = cur.s; u.uAlpha.value = cur.a; u.uPuff.value = puff.v;
  u.uMouse.value.set((mouse.x - cur.x) / cur.s, (mouse.y - cur.y) / cur.s);
  ghostCanvas.classList.toggle("over", goal.beat === 3 && cur.s < 0.3); // the ghost layer sits under the page; only the small cursor ride in chapter 3 goes on top
  fog.material.uniforms.uTime.value = t; fog.material.uniforms.uDim.value = cur.dim;
  fog.material.uniforms.uMouse.value.lerp(fogMouse, 0.05);
  renderer.render(scene, camera); ghostR.render(ghostScene, camera);
}
const seen = new Set([hero]); let visible = true;
let tick = 0;
function loop(ms) { if (visible && (seen.size || tick++ % 3 === 0)) frame(ms); requestAnimationFrame(loop); } // the field never leaves after chapter 3, so past the story it renders at a third of the frame rate
if (reduce) { frame(1800, 1); }
else {
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting ? seen.add(e.target) : seen.delete(e.target)));
  io.observe(hero); io.observe(story);
  document.addEventListener("visibilitychange", () => { visible = !document.hidden; });
  requestAnimationFrame(loop);
}

/* ---------- scroll choreography (reveals live in site.js) ---------- */

if (!reduce && window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);

  let lenis;
  if (window.Lenis && !phone) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000)); gsap.ticker.lagSmoothing(0);
  }

  // hero. Desktop: pinned for one screen; a little way in it docks (ghost to the right slot, install block in on the left; CSS transitions do the layout).
  // Phones: no pin, the ghost just shrinks a little in place while the install block scrolls up. Then the ghost scatters into the fog as the hero leaves.
  const scatterOn = (start, end) => ScrollTrigger.create({ trigger: hero, start, end, scrub: true, onUpdate: (s) => { if (goal.beat === "hero") goal.scatter = s.progress; } });
  let heroPin;
  if (narrow) {
    ScrollTrigger.create({ trigger: hero.querySelector(".hero-head"), start: "top top", end: "bottom top", scrub: true, onUpdate: (s) => { if (goal.beat === "hero") goal.s = 0.62 - 0.2 * s.progress; } });
    scatterOn("bottom 90%", "bottom top");
  } else {
    heroPin = ScrollTrigger.create({ trigger: hero, start: "top top", end: "+=90%", pin: true, anticipatePin: 1 });
    ScrollTrigger.create({ start: () => heroPin.start + innerHeight * 0.12, end: "max", onToggle: (s) => { hero.classList.toggle("docked", s.isActive); if (goal.beat === "hero") Object.assign(goal, stops.hero()); } });
    scatterOn(() => heroPin.end, () => heroPin.end + innerHeight);
  }

  const pin = (el, tl) => ScrollTrigger.create(phone
    ? { trigger: el, start: "top 70%", animation: tl, toggleActions: "play none none reverse" }
    : { trigger: el, start: "top top", end: "+=220%", pin: true, scrub: 0.6, animation: tl, anticipatePin: 1 });

  const ch = (n) => document.querySelector(`[data-chapter="${n}"]`);
  const blur = (px) => `blur(${px}px)`;

  // every chapter: the one big line first (desktop), then the detail layout blurs in; label "detail" is where the scene work starts
  const intro = (n) => {
    const tl = gsap.timeline(), el = ch(n), parts = [el.querySelector(".ch-copy"), el.querySelector(".ch-scene")];
    if (!phone) tl.fromTo(el.querySelector(".ch-big"), { opacity: 0, filter: blur(16), scale: 0.96 }, { opacity: 1, filter: blur(0), scale: 1, duration: 0.8 }).addLabel("big", "+=0.6") // hold point: centre of a 1.2 s plateau
      .to(el.querySelector(".ch-big"), { opacity: 0, filter: blur(18), scale: 1.06, duration: 0.8 }, "+=0.6")
      .from(parts, { opacity: 0, filter: blur(14), y: 24, duration: 0.9 }, "<0.3");
    tl.addLabel("detail").from(el.querySelectorAll(".ch-copy > *"), { opacity: 0, y: 16, stagger: 0.15, duration: 0.6 }, "detail");
    return tl;
  };

  // 1: the login wall stacks up
  const t1 = intro(1);
  t1.from(ch(1).querySelector(".win"), { scale: 0.92, opacity: 0, duration: 1 }, "detail")
    .from(ch(1).querySelectorAll(".modal"), { y: 220, opacity: 0, rotate: 0, stagger: 0.6, duration: 1 }, "<0.4")
    .from(ch(1).querySelector(".win-foot"), { opacity: 0, duration: 0.5 });

  // 2: your browser assembles out of the fog
  const t2 = intro(2);
  t2.from(ch(2).querySelector(".win"), { opacity: 0, scale: 0.96, filter: blur(18), duration: 1.2 }, "detail")
    .from(ch(2).querySelectorAll(".dash-side b, .dash-head"), { opacity: 0, x: -8, stagger: 0.08, duration: 0.5 }, "<0.5")
    .from(ch(2).querySelectorAll(".tile i"), { scaleY: 0, transformOrigin: "bottom", stagger: 0.12, duration: 0.6 }, "<0.3")
    .from(ch(2).querySelectorAll(".chart i"), { scaleY: 0, transformOrigin: "bottom", stagger: 0.05, duration: 0.6 }, "<0.3")
    .from(ch(2).querySelector(".tab-group"), { opacity: 0, duration: 0.4 });

  // 3: the ghost cursor fills, uploads, clicks (the particle ghost rides the SVG cursor's position)
  const t3 = intro(3), cur3 = ch(3).querySelector(".ghost-cursor"), calls = ch(3).querySelectorAll(".call");
  const fields = ch(3).querySelectorAll(".frow em"); const ok = ch(3).querySelector(".ok");
  gsap.set(fields, { clipPath: "inset(0 100% 0 0)" }); gsap.set(ok, { opacity: 0 }); gsap.set(calls, { opacity: 0, x: -10 });
  gsap.set(cur3, { "--cx": phone ? "60vw" : "300px", "--cy": phone ? "230px" : "196px", opacity: 0 }); // the particle ghost rides this element; the SVG itself shows only under reduced motion
  t3.from(ch(3).querySelector(".win"), { opacity: 0, y: 30, duration: 0.8 }, "detail")
    .to(cur3, { "--cx": phone ? "40px" : "150px", "--cy": phone ? "44px" : "30px", duration: 0.8, ease: "power2.inOut" })
    .to(fields[0], { clipPath: "inset(0 0% 0 0)", duration: 0.6 }).to(calls[0], { opacity: 1, x: 0, duration: 0.3 }, "<")
    .to(fields[1], { clipPath: "inset(0 0% 0 0)", duration: 0.6 })
    .to(cur3, { "--cx": phone ? "40px" : "150px", "--cy": phone ? "160px" : "125px", duration: 0.7, ease: "power2.inOut" })
    .to(fields[2], { clipPath: "inset(0 0% 0 0)", duration: 0.5 }).to(ok, { opacity: 1, duration: 0.3 }).to(calls[1], { opacity: 1, x: 0, duration: 0.3 }, "<")
    .to(cur3, { "--cx": phone ? "40px" : "60px", "--cy": phone ? "228px" : "178px", duration: 0.7, ease: "power2.inOut" })
    .to(ch(3).querySelector(".f-submit"), { scale: 0.94, duration: 0.15, yoyo: true, repeat: 1 }).to(calls[2], { opacity: 1, x: 0, duration: 0.3 }, "<");

  // 4: four hops light up, then the facts
  const t4 = intro(4);
  t4.from(ch(4).querySelector(".hops"), { opacity: 0, duration: 0.6 }, "detail")
    .from(ch(4).querySelectorAll(".hop"), { opacity: 0, y: 14, stagger: 0.5, duration: 0.6 }, "<0.2")
    .from(ch(4).querySelectorAll(".hop .dot"), { scale: 0.3, stagger: 0.5, duration: 0.6 }, "<")
    .from(ch(4).querySelector(".machine"), { opacity: 0, duration: 0.4 })
    .from(ch(4).querySelectorAll(".facts li"), { opacity: 0, y: 10, stagger: 0.4, duration: 0.6 });

  // pin each chapter; on desktop it blurs through into the next one at the end of its scroll
  const pins = [t1, t2, t3, t4].map((tl, i) => {
    const el = ch(i + 1);
    if (!phone) tl.addLabel("done", "+=0.8").addLabel("exit", "+=0.8").to([el.querySelector(".ch-copy"), el.querySelector(".ch-scene")], { opacity: 0, filter: blur(12), y: -30, duration: 0.7 }, "exit");
    return pin(el, tl);
  });

  // the ghost's journey: one stop per beat, lerped in the render loop (created after the pins so the spacing is known)
  const stop = (trigger, beat, start = "top 60%", end = "bottom 40%") => ScrollTrigger.create({ trigger, start, end, onToggle: (s) => { if (s.isActive) { goal.el = null; Object.assign(goal, stops[beat](trigger), { beat }); } } });
  stop(hero, "hero", "top bottom", heroPin ? () => heroPin.end + innerHeight * 0.6 : "bottom 40%"); // through the pin, so scrolling back up re-docks the ghost
  // a pinned element's own pin spacing is not applied to other triggers on it, so chapter stops take their range from the pin
  [1, 2, 3, 4].forEach((n) => phone ? stop(ch(n), n) : stop(ch(n), n, () => pins[n - 1].start - innerHeight * 0.4, () => pins[n - 1].end + innerHeight * 0.6));
  stop(document.getElementById("jobs"), "end", "top 85%", "bottom top");

  // step mode (desktop + motion, inside the story: hero pin start → ch4 pin end). One gesture = exactly one step, whatever its size:
  // hero big ghost → hero docked → ch1 big → ch1 done → … → ch4 done → release into #jobs. Wheel is intercepted (capture, so Lenis never sees
  // it); the first event of a gesture steps, then the machine is locked until the glide has finished AND the stream has been quiet 200 ms,
  // so trackpad momentum never steps twice. Keys step too. Nav links and the scrollbar are native jumps that settle on the nearest step;
  // outside the story (and past either end) scrolling is untouched.
  if (!narrow && lenis) {
    const tls = [t1, t2, t3, t4], jobs = document.getElementById("jobs");
    const steps = () => [heroPin.start, heroPin.start + innerHeight * 0.5, ...pins.flatMap((p, i) => ["big", "done"].map((l) => p.start + (p.end - p.start) * tls[i].labels[l] / tls[i].duration())), jobs.offsetTop];
    const inStory = (y) => { const s = steps(); return y >= s[0] - 1 && y <= s[s.length - 1] + 1; };
    const released = (y, dir) => { const s = steps(); return (dir < 0 && y <= s[0] + 6) || (dir > 0 && y >= s[s.length - 1] - 6); }; // past either end: normal scrolling
    let gliding = false, stepped = false, lastT = -1e9, lastDir = 0, ref = 0, settleT;
    const glide = (y, d = 0.9) => { gliding = true; lenis.scrollTo(y, { duration: d, lock: true, easing: (t) => 1 - Math.pow(1 - t, 3), onComplete: () => { gliding = false; } }); };
    // one step on from the step we are on, else the next step in that direction (the last step is the top of #jobs: the release)
    const next = (y, dir) => { const s = steps(), at = s.findIndex((v) => Math.abs(v - y) < 6);
      return at >= 0 ? at + dir : dir < 0 ? s.length - 1 - [...s].reverse().findIndex((v) => v < y) : s.findIndex((v) => v > y); };
    const go = (y, dir) => { const s = steps(), i = Math.min(s.length - 1, Math.max(0, next(y, dir)));
      glide(s[i], (dir > 0 && i === 2) || (dir < 0 && i === 1) ? 1.5 : i === s.length - 1 ? 1.1 : 0.9); }; // docked ↔ ch1 big slower, so the dispersal is seen
    // a new gesture begins on a gap between event timestamps (not timers: a stalled frame must not look like silence), or, once the
    // glide is over, when the direction flips or |deltaY| surges above the decaying momentum tail (macOS keeps the tail flowing for
    // seconds after the fingers lift, so the next swipe often arrives with no gap at all)
    addEventListener("wheel", (e) => { const y = scrollY, dir = Math.sign(e.deltaY), a = Math.abs(e.deltaY);
      const fresh = e.timeStamp - lastT > 200 || (!gliding && dir && a >= 10 && (dir !== lastDir || a > 1.5 * ref));
      if (fresh) { stepped = false; ref = a; } else ref = ref * 0.7 + a * 0.3;
      lastT = e.timeStamp; if (dir) lastDir = dir;
      if (!stepped && (e.ctrlKey || !dir || !inStory(y) || released(y, dir))) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (stepped) return; // the rest of a gesture that already stepped (or arrived mid-glide)
      stepped = true; if (!gliding) go(y, dir); }, { capture: true, passive: false });
    const keyDir = { ArrowDown: 1, PageDown: 1, " ": 1, ArrowUp: -1, PageUp: -1 };
    addEventListener("keydown", (e) => { const y = scrollY, dir = e.key === " " && e.shiftKey ? -1 : keyDir[e.key];
      if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.target.closest("a, button, summary, input, textarea, select, [contenteditable]") || !inStory(y) || released(y, dir)) return;
      e.preventDefault(); if (!gliding) go(y, dir); }, { capture: true });
    let touchY = null; // desktop touchscreens: one swipe = one step (native scroll is prevented inside the story)
    addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { capture: true, passive: true });
    addEventListener("touchmove", (e) => { const y = scrollY, d = touchY === null ? 0 : touchY - e.touches[0].clientY, dir = Math.sign(d);
      if (touchY === null || !inStory(y) || released(y, dir)) return;
      e.preventDefault(); if (Math.abs(d) < 12) return;
      touchY = null; if (!gliding) go(y, dir); }, { capture: true, passive: false });
    // a native scroll (scrollbar, anchor, Home/End, scroll restoration) that comes to rest inside the story settles on the nearest step
    const settle = () => { const y = scrollY, s = steps(); if (gliding || !inStory(y)) return;
      const i = s.reduce((b, v, k) => Math.abs(v - y) < Math.abs(s[b] - y) ? k : b, 0); if (Math.abs(s[i] - y) > 6) glide(s[i]); };
    lenis.on("scroll", (l) => { if (l.isScrolling === "native") { clearTimeout(settleT); settleT = setTimeout(settle, 150); } });
  }
}
}
