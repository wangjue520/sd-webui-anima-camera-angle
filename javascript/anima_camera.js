/**
 * Anima 相机控制 — WebUI 扩展前端
 * 移植自 ComfyUI 插件 Comfyui-Anima_camera_angle (MIT)
 * https://github.com/xunying7860/Comfyui-Anima_camera_angle
 */
(function () {
  "use strict";
  const MY_SRC = (document.currentScript && document.currentScript.src) || "";
  console.log("[AnimaCamera] WebUI extension loading...");

  // ============================================================
  // 1. 默认配置 & 工具
  // ============================================================
  function toFixed2(v) { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; }
  function clamp(v, mn, mx) { return v < mn ? mn : v > mx ? mx : v; }
  function fmt(v) { const n = parseFloat(v); return isNaN(n) ? "0.00" : Math.round(n * 100) / 100 + ""; }

  const DEFAULT_TAGS = {
    azimuth: { directions: { front: { tag: "from front" }, back: { tag: "from behind" }, left: { tag: "facing right" }, right: { tag: "facing left" } }, enabled: true, weight: 10, extra: 0, deadzone_ratio: 0.05 },
    elevation: { extra: 0, enabled: true, categories: { high: { tag: "high angle" }, eye: { tag: "eye-level" }, low: { tag: "low angle" } } },
    distance: { categories: { ecu: { tag: "extreme close-up" }, cu: { tag: "close-up" }, medium: { tag: "medium shot" }, cowboy_shot: { tag: "cowboy shot" }, full: { tag: "full body" }, wide: { tag: "wide shot" } }, enabled: true, extra: 0 },
    tilt: { dutch_tag: "dutch angle", enabled: true, extra: 0, deadzone: 0.15 },
    extra_master: 1, weight_max: 10, weight_min: 0.1, xy_mult_enabled: true, xy_mult: 10,
  };

  const DIST_GEARS = [-0.85, -0.52, -0.17, 0.10, 0.45, 0.85];
  const DIST_NAMES = { wide: "远景", full: "全身", cowboy_shot: "牛仔", medium: "中景", cu: "近景", ecu: "特写" };
  function distKey(z) {
    return z > 0.7 ? "ecu" : z > 0.2 ? "cu" : z > 0.0 ? "medium" : z > -0.35 ? "cowboy_shot" : z >= -0.7 ? "full" : "wide";
  }

  // ============================================================
  // 2. computePrompt（与 Python 后端算法一致，仅用于实时预览）
  // ============================================================
  function splitTags(tag) { return String(tag).split(",").map(t => t.trim()).filter(t => t); }
  function emitWeighted(tag, w, wmin, wmax) {
    return splitTags(tag).map(t => `(${t}:${fmt(clamp(w, wmin, wmax))})`);
  }
  function computePrompt(px, py, pz, roll, c) {
    const p = [], wmin = parseFloat(c.weight_min) || 0.1, wmax = parseFloat(c.weight_max) || 10, dz = parseFloat(c.azimuth.deadzone_ratio) || 0.05;
    const em = parseFloat(c.extra_master) || 1;
    const xyM = c.xy_mult_enabled ? parseFloat(c.xy_mult) || 10 : null;
    const curMax = xyM !== null ? Math.max(wmax, xyM) : wmax;
    // 方位
    if (c.azimuth.enabled !== false) {
      const az = px * Math.PI;
      const d = { front: Math.max(0, Math.cos(az)), back: Math.max(0, -Math.cos(az)), right: Math.max(0, Math.sin(az)), left: Math.max(0, -Math.sin(az)) };
      const s = d.front + d.back + d.right + d.left; if (s > 0) { d.front /= s; d.back /= s; d.right /= s; d.left /= s; }
      const AZ_POLE = 0.9, azGate = Math.max(0, Math.min(1, (1 - Math.abs(py)) / (1 - AZ_POLE)));
      const azW = xyM !== null ? xyM : (parseFloat(c.azimuth.weight) || 1);
      const azBudget = (azW + (parseFloat(c.azimuth.extra) || 0) * em) * azGate;
      const azCap = curMax + Math.max(0, (parseFloat(c.azimuth.extra) || 0) * em);
      for (const [k, nv] of Object.entries(d)) { const w = nv * azBudget; if (nv <= 0 || w < dz) continue; p.push(...emitWeighted(c.azimuth.directions[k].tag, w, wmin, azCap)); }
    }
    // 高度
    if (c.elevation.enabled !== false) {
      const ek = py > 0.2 ? "high" : py >= -0.2 ? "eye" : "low";
      const ei = c.elevation.categories[ek]; if (ei && ei.tag) { const elMult = xyM !== null ? xyM : (ek === "eye" ? 15 : 10); const ew = Math.abs(py) * elMult + em * (parseFloat(c.elevation.extra) || 0); if (ew >= dz) p.push(...emitWeighted(ei.tag, ew, wmin, curMax + Math.max(0, (parseFloat(c.elevation.extra) || 0) * em))); }
    }
    // 距离
    if (c.distance.enabled !== false) {
      const dk = distKey(pz);
      const di = c.distance.categories[dk]; if (di && di.tag) { const dw = 1 + em * (parseFloat(c.distance.extra) || 0); p.push(...emitWeighted(di.tag, dw, 0.1, wmax + Math.max(0, (parseFloat(c.distance.extra) || 0) * em))); }
    }
    // 倾斜
    if (c.tilt.enabled !== false && roll > 0) { const tw = 1 + em * (parseFloat(c.tilt.extra) || 0); p.push(...emitWeighted(c.tilt.dutch_tag, tw, 0.1, wmax + Math.max(0, (parseFloat(c.tilt.extra) || 0) * em))); }
    return p.join(", ");
  }

  // ============================================================
  // 3. Three.js 加载
  // ============================================================
  let threePromise = null;
  function loadTHREE() {
    if (!threePromise) {
      let src = MY_SRC;
      if (!src) {
        const s = Array.from(document.querySelectorAll("script[src]")).find(el => /anima_camera\.js/.test(el.src));
        src = s ? s.src : "";
      }
      const url = src.replace(/javascript\/anima_camera\.js.*$/, "three.module.js");
      threePromise = import(url);
    }
    return threePromise;
  }

  // ============================================================
  // 4. 单个实例（txt2img / img2img）初始化
  // ============================================================
  async function initAnimaCam(mount) {
    const tab = mount.dataset.tab || "txt2img";
    const appRoot = gradioApp();

    // ---- 隐藏 Gradio 文本框读写（JS ↔ 后端的传输通道，带引用缓存） ----
    const elCache = {};
    function qEl(suffix) {
      let el = elCache[suffix];
      if (!el || !el.isConnected) {
        const root = appRoot.querySelector("#anima_cam_" + suffix + "_" + tab);
        el = root ? root.querySelector("textarea, input") : null;
        elCache[suffix] = el;
      }
      return el;
    }
    function getV(suffix, def) {
      const el = qEl(suffix);
      return el && el.value !== "" ? el.value : (def !== undefined ? def : "");
    }
    function setV(suffix, v) {
      const el = qEl(suffix);
      if (!el) return;
      const sv = String(v);
      if (el.value !== sv) {
        el.value = sv;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    const container = document.createElement("div");
    container.className = "an3-w";
    mount.appendChild(container);

    // ---- 参数状态 ----
    const S = { px: 0, py: 0, pz: 0, rv: 0, cfg: JSON.parse(JSON.stringify(DEFAULT_TAGS)), azimuth: 0, elevation: 15, dist: 5.5, dragging: false, tgt: null, hovered: null };
    // ---- 标签数据 TAGS ----
    const TAGS = JSON.parse(JSON.stringify(DEFAULT_TAGS));

    function snapDist() {
      let idx = 0;
      for (let i = 1; i < DIST_GEARS.length; i++) {
        if (Math.abs(S.pz - DIST_GEARS[i]) < Math.abs(S.pz - DIST_GEARS[idx])) idx = i;
      }
      S.pz = DIST_GEARS[idx];
      S.dist = S.pz * 4.5 + 5.5;
    }

    function syncTagsToWidget() {
      setV("tags_json", JSON.stringify(TAGS));
    }

    // ---- 从隐藏文本框读取状态 ----
    function readW() {
      S.px = toFixed2(getV("pos_x", "0")); S.py = toFixed2(getV("pos_y", "0"));
      S.pz = toFixed2(getV("pos_z", "0")); S.rv = toFixed2(getV("roll", "0"));
      S.azimuth = (S.px * 180 + 360) % 360; S.elevation = S.py * 45 + 15; S.dist = S.pz * 4.5 + 5.5;
      snapDist();
    }

    // ---- 写回隐藏文本框 ----
    function syncN() {
      setV("pos_x", toFixed2(S.px)); setV("pos_y", toFixed2(S.py));
      setV("pos_z", toFixed2(S.pz)); setV("roll", toFixed2(S.rv));
      refreshNumRows();
    }

    // ---- TAGS → 预览配置 ----
    function syncCfg() {
      S.cfg.azimuth.enabled = TAGS.azimuth.enabled;
      S.cfg.azimuth.weight = TAGS.azimuth.weight ?? 10;
      S.cfg.azimuth.extra = TAGS.azimuth.extra ?? 0;
      S.cfg.azimuth.deadzone_ratio = TAGS.azimuth.deadzone_ratio ?? 0.05;
      S.cfg.elevation.enabled = TAGS.elevation.enabled;
      S.cfg.elevation.extra = TAGS.elevation.extra ?? 0;
      S.cfg.distance.enabled = TAGS.distance.enabled;
      S.cfg.distance.extra = TAGS.distance.extra ?? 0;
      S.cfg.tilt.enabled = TAGS.tilt.enabled;
      S.cfg.tilt.extra = TAGS.tilt.extra ?? 0;
      S.cfg.extra_master = TAGS.extra_master ?? 1;
      S.cfg.xy_mult_enabled = TAGS.xy_mult_enabled ?? false;
      S.cfg.xy_mult = TAGS.xy_mult ?? 10;
      if (TAGS.azimuth && TAGS.azimuth.directions) S.cfg.azimuth.directions = TAGS.azimuth.directions;
      if (TAGS.elevation && TAGS.elevation.categories) S.cfg.elevation.categories = TAGS.elevation.categories;
      if (TAGS.distance && TAGS.distance.categories) S.cfg.distance.categories = TAGS.distance.categories;
      if (TAGS.tilt && TAGS.tilt.dutch_tag) S.cfg.tilt.dutch_tag = TAGS.tilt.dutch_tag;
    }

    // ============================================================
    // 4a. Three.js 场景（WebGL 不可用时降级为纯滑条模式）
    // ============================================================
    let sceneOK = false;
    let hDir = null, hRoll = null;
    try {
      const THREE = await loadTHREE();

      let CW = Math.max(mount.clientWidth || 360, 280);
      let CH = Math.round(CW * 500 / 560);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0a0a14);
      const cam3d = new THREE.PerspectiveCamera(45, CW / CH, 0.1, 100);
      cam3d.position.set(4, 3.5, 4);
      cam3d.lookAt(0, 0.3, 0);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(CW, CH, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const wrap = document.createElement("div");
      wrap.className = "an3-cw";
      container.appendChild(wrap);
      wrap.appendChild(renderer.domElement);
      const ol = document.createElement("div");
      ol.className = "an3-ol";
      ol.innerHTML = '<span class="h">拖拽</span><div class="i"><div class="d">正面 · 0°</div><div class="r"></div></div>';
      wrap.appendChild(ol);
      hDir = ol.querySelector(".d");
      hRoll = ol.querySelector(".r");

      const ro = new ResizeObserver(() => {
        const nw = mount.clientWidth || 0;
        if (nw >= 100 && nw !== CW) {
          CW = nw; CH = Math.round(CW * 500 / 560);
          renderer.setSize(CW, CH, false);
          cam3d.aspect = CW / CH;
          cam3d.updateProjectionMatrix();
        }
      });
      ro.observe(mount);

      scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      const ml = new THREE.DirectionalLight(0xffffff, 0.8); ml.position.set(5, 10, 5); scene.add(ml);
      const fl = new THREE.DirectionalLight(0xE93D82, 0.3); fl.position.set(-5, 5, -5); scene.add(fl);

      const CENTER = new THREE.Vector3(0, 0.5, 0), AZ_R = 1.8, EL_R = 1.4;
      scene.add(new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a));

      const card = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.02), new THREE.MeshBasicMaterial({ color: 0x3a3a4a }));
      card.position.copy(CENTER); scene.add(card);
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.2, 1.2, 0.02)), new THREE.LineBasicMaterial({ color: 0xE93D82 }));
      frame.position.copy(CENTER); scene.add(frame);
      const gr2 = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.58, 64), new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
      gr2.position.set(0, 0.01, 0); gr2.rotation.x = -Math.PI / 2; scene.add(gr2);

      const camCone = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.5 }));
      scene.add(camCone);
      const camGlow = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 }));
      scene.add(camGlow);

      const azRing = new THREE.Mesh(new THREE.TorusGeometry(AZ_R, 0.04, 16, 100), new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.7 }));
      azRing.rotation.x = Math.PI / 2; azRing.position.y = 0.02; scene.add(azRing);
      const azH = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 32), new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.6 }));
      scene.add(azH);
      const azG = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.2 }));
      scene.add(azG);

      const arcPts = []; for (let i = 0; i <= 32; i++) { const a = (-30 + 90 * i / 32) * Math.PI / 180; arcPts.push(new THREE.Vector3(-0.8, EL_R * Math.sin(a) + CENTER.y, EL_R * Math.cos(a))); }
      const arc = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arcPts), 32, 0.04, 8, false), new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.8 }));
      scene.add(arc);
      const elH = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 32), new THREE.MeshStandardMaterial({ color: 0x00FFD0, emissive: 0x00FFD0, emissiveIntensity: 0.6 }));
      scene.add(elH);
      const elG = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.2 }));
      scene.add(elG);

      const distH = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 32), new THREE.MeshStandardMaterial({ color: 0xFFB800, emissive: 0xFFB800, emissiveIntensity: 0.7 }));
      scene.add(distH);
      const distG = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.25 }));
      scene.add(distG);
      let distTube = null;

      // ---- 更新 3D ----
      function upd3d() {
        const ar = S.azimuth * Math.PI / 180, er = S.elevation * Math.PI / 180, vd = 2.6 - (S.dist / 10) * 2.0;
        const cx = vd * Math.sin(ar) * Math.cos(er), cy = CENTER.y + vd * Math.sin(er), cz = vd * Math.cos(ar) * Math.cos(er);
        camCone.position.set(cx, cy, cz); camCone.lookAt(CENTER); camCone.rotateX(Math.PI / 2);
        camGlow.position.copy(camCone.position);
        const ax = AZ_R * Math.sin(ar), az2 = AZ_R * Math.cos(ar); azH.position.set(ax, 0.16, az2); azG.position.copy(azH.position);
        const ey = CENTER.y + EL_R * Math.sin(er), ez = EL_R * Math.cos(er); elH.position.set(-0.8, ey, ez); elG.position.copy(elH.position);
        const dt = 0.15 + (10 - S.dist) / 10 * 0.7; distH.position.lerpVectors(CENTER, camCone.position, dt); distG.position.copy(distH.position);
        if (distTube) { scene.remove(distTube); distTube.geometry.dispose(); distTube.material.dispose(); }
        distTube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(CENTER.clone(), camCone.position.clone()), 1, 0.025, 8, false), new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.8 }));
        scene.add(distTube);
        const ad = S.px * 180;
        hDir.textContent = Math.abs(S.px) > 0.85 ? "背面 · 180°" : S.px < -0.05 ? "左 " + Math.abs(ad).toFixed(0) + "°" : S.px > 0.05 ? "右 " + ad.toFixed(0) + "°" : "正面 · 0°";
        hRoll.textContent = S.rv > 0 ? "倾斜: " + (S.rv * 10).toFixed(2) : "";
      }

      // 渲染循环（不可见时跳过渲染以节省资源）
      (function anim() {
        requestAnimationFrame(anim);
        if (!mount.isConnected) return;
        gr2.rotation.z += 0.005;
        if (mount.offsetParent !== null || mount.clientWidth > 0) {
          try { renderer.render(scene, cam3d); } catch (_) {}
          tick();
        }
      })();

      // ---- 鼠标交互 ----
      const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
      const hList = [
        { m: azH, g: azG, n: "az" }, { m: elH, g: elG, n: "el" }, { m: distH, g: distG, n: "dist" },
      ];
      function setScale(h, s) { h.m.scale.setScalar(s); if (h.g) h.g.scale.setScalar(s); }
      renderer.domElement.addEventListener("pointerdown", e => {
        const r = renderer.domElement.getBoundingClientRect();
        mouse.x = (e.clientX - r.left) / r.width * 2 - 1; mouse.y = -(e.clientY - r.top) / r.height * 2 + 1;
        ray.setFromCamera(mouse, cam3d);
        for (const h of hList) { if (ray.intersectObject(h.m).length > 0) { S.dragging = true; S.tgt = h.n; setScale(h, 1.3); e.preventDefault(); return; } }
      });
      renderer.domElement.addEventListener("pointermove", e => {
        const r = renderer.domElement.getBoundingClientRect();
        mouse.x = (e.clientX - r.left) / r.width * 2 - 1; mouse.y = -(e.clientY - r.top) / r.height * 2 + 1;
        ray.setFromCamera(mouse, cam3d);
        if (!S.dragging) {
          let f = null; for (const h of hList) { if (ray.intersectObject(h.m).length > 0) { f = h; break; } }
          if (S.hovered && S.hovered !== f) setScale(S.hovered, 1.0);
          if (f) { setScale(f, 1.15); S.hovered = f; } else S.hovered = null;
          return;
        }
        const plane = new THREE.Plane(), pt = new THREE.Vector3();
        if (S.tgt === "az") {
          plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
          if (ray.ray.intersectPlane(plane, pt)) { let a = Math.atan2(pt.x, pt.z) * 180 / Math.PI; if (a < 0) a += 360; S.azimuth = Math.max(0, Math.min(360, a)); S.px = ((S.azimuth + 180) % 360 - 180) / 180; syncN(); }
        } else if (S.tgt === "el") {
          plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-0.8, 0, 0));
          if (ray.ray.intersectPlane(plane, pt)) { let a = Math.atan2(pt.y - CENTER.y, pt.z) * 180 / Math.PI; a = Math.max(-30, Math.min(60, a)); S.elevation = a; S.py = (a - 15) / 45; syncN(); }
        } else if (S.tgt === "dist") { S.dist = Math.max(1, Math.min(10, S.dist + (e.movementY || 0) * 0.05)); S.pz = (S.dist - 5.5) / 4.5; syncN(); }
      });
      renderer.domElement.addEventListener("pointerup", () => {
        if (!S.dragging) return;
        if (S.tgt === "dist") snapDist();
        S.dragging = false; S.tgt = null; if (S.hovered) setScale(S.hovered, 1.0); syncN();
      });
      renderer.domElement.addEventListener("pointercancel", () => { S.dragging = false; S.tgt = null; });
      // 滚轮切换距离档位（捕获阶段监听，仅当光标在 3D 画布内时生效）
      window.addEventListener("wheel", e => {
        const rc = renderer.domElement.getBoundingClientRect();
        if (e.clientX < rc.left || e.clientX > rc.right || e.clientY < rc.top || e.clientY > rc.bottom) return;
        e.preventDefault(); e.stopPropagation();
        let idx = DIST_GEARS.indexOf(S.pz);
        if (idx < 0) { snapDist(); idx = DIST_GEARS.indexOf(S.pz); }
        const dir = e.deltaY > 0 ? 1 : -1;
        const ni = Math.max(0, Math.min(DIST_GEARS.length - 1, (idx >= 0 ? idx : 3) + dir));
        S.pz = DIST_GEARS[ni]; S.dist = S.pz * 4.5 + 5.5; syncN();
      }, { capture: true, passive: false });

      sceneOK = true;
      // 供 tick() 调用
      S._upd3d = upd3d;
    } catch (e) {
      console.error("[AnimaCamera] 3D 场景初始化失败，降级为滑条模式:", e);
      const errBox = document.createElement("div");
      errBox.style.cssText = "padding:8px;font-size:11px;color:#e67e22;border:1px dashed #e67e22;border-radius:6px";
      errBox.textContent = "3D 场景初始化失败（WebGL 不可用），可使用下方滑条控制相机";
      container.appendChild(errBox);
    }

    // ---- 每帧逻辑：读状态、更新 3D、刷新预览 ----
    let previewEl = null;
    function tick() {
      if (!S.dragging) readW();
      syncCfg();
      if (sceneOK && S._upd3d) S._upd3d();
      if (previewEl) previewEl.value = computePrompt(S.px, S.py, S.pz, S.rv, S.cfg);
    }
    if (!sceneOK) {
      // 降级模式：低频刷新即可
      setInterval(() => { if (mount.isConnected) tick(); }, 300);
    }

    // ---- 按钮行 ----
    const bRow = document.createElement("div"); bRow.className = "btn-r"; container.appendChild(bRow);
    const rst = document.createElement("button"); rst.textContent = "归位";
    rst.onclick = () => { S.azimuth = 0; S.elevation = 15; S.dist = 5.5; S.px = S.py = S.pz = S.rv = 0; syncN(); };
    bRow.appendChild(rst);
    const tagBtn = document.createElement("button"); tagBtn.textContent = "标签";
    bRow.appendChild(tagBtn);

    // ---- 数值微调行 ----
    const numRows = [];
    function makeNumRow(label, min, max, step, get, set, fmtVal) {
      const row = document.createElement("div"); row.className = "num-row";
      const lbl = document.createElement("span"); lbl.className = "nl"; lbl.textContent = label; row.appendChild(lbl);
      const sl = document.createElement("input"); sl.type = "range"; sl.min = min; sl.max = max; sl.step = step; row.appendChild(sl);
      const sv = document.createElement("span"); sv.className = "nv"; row.appendChild(sv);
      sl.addEventListener("input", () => { set(parseFloat(sl.value)); syncN(); });
      container.appendChild(row);
      numRows.push({ sl, sv, get, fmtVal: fmtVal || (v => String(toFixed2(v))) });
    }
    makeNumRow("方位 X", -1, 1, 0.05, () => S.px, v => { S.px = v; S.azimuth = (v * 180 + 360) % 360; });
    makeNumRow("高度 Y", -1, 1, 0.01, () => S.py, v => { S.py = v; S.elevation = v * 45 + 15; });
    makeNumRow("距离 Z", -1, 1, 0.05, () => S.pz, v => { S.pz = v; snapDist(); }, v => toFixed2(v) + " " + (DIST_NAMES[distKey(v)] || ""));
    makeNumRow("倾斜 Roll", 0, 1, 0.1, () => S.rv, v => { S.rv = v; });
    function refreshNumRows() {
      for (const r of numRows) {
        if (document.activeElement === r.sl) continue;
        const v = r.get();
        r.sl.value = v;
        r.sv.textContent = r.fmtVal(v);
      }
    }

    // ---- 标签编辑面板 ----
    const tagPanel = document.createElement("div");
    tagPanel.className = "tag-panel";
    container.appendChild(tagPanel);
    tagBtn.onclick = function () {
      const show = tagPanel.style.display === "none" || !tagPanel.style.display;
      tagPanel.style.display = show ? "block" : "none";
      this.textContent = show ? "收起标签" : "标签";
    };

    function restoreTags() {
      const raw = getV("tags_json", "{}");
      try {
        if (raw && raw !== "{}") {
          const d = JSON.parse(raw);
          if (typeof d === "object" && d) {
            (function mergeSafe(t, s) {
              for (const k of Object.keys(s)) {
                if (k === "directions" || k === "categories") { t[k] = s[k]; continue; }
                if (typeof s[k] === "object" && s[k] && !Array.isArray(s[k]) && typeof t[k] === "object" && t[k] && !Array.isArray(t[k])) {
                  mergeSafe(t[k], s[k]);
                } else if (s[k] !== undefined) {
                  t[k] = s[k];
                }
              }
            })(TAGS, d);
          }
        }
      } catch (_) {}
      // 兜底：确保关键字段不缺失
      if (TAGS.elevation.extra == null) TAGS.elevation.extra = 0;
      if (TAGS.distance.extra == null) TAGS.distance.extra = 0;
      if (TAGS.tilt.extra == null) TAGS.tilt.extra = 0;
      if (TAGS.azimuth.extra == null) TAGS.azimuth.extra = 0;
      if (TAGS.azimuth.weight == null) TAGS.azimuth.weight = 10;
      if (TAGS.extra_master == null) TAGS.extra_master = 1;
      if (TAGS.xy_mult_enabled == null) TAGS.xy_mult_enabled = true;
      if (TAGS.xy_mult == null) TAGS.xy_mult = 10;
      refreshTagPanel();
    }

    function refreshTagPanel() {
      tagPanel.querySelectorAll("input").forEach(inp => {
        if (inp.type === "text") {
          const path = inp._tagPath;
          if (path) { let o = TAGS; for (const p of path) { if (o && typeof o === "object") o = o[p]; } if (typeof o === "string") inp.value = o; }
        } else if (inp.type === "checkbox") {
          if (inp._isXyChk) { inp.checked = TAGS.xy_mult_enabled !== false; return; }
          const axis = inp._tagAxis;
          if (axis && TAGS[axis]) inp.checked = TAGS[axis].enabled !== false;
        } else if (inp.type === "range") {
          if (inp._isXySl) { inp.value = TAGS.xy_mult; const sib = inp.nextElementSibling; if (sib) sib.textContent = inp.value; return; }
          if (inp._isEmSl) { inp.value = TAGS.extra_master; const sib = inp.nextElementSibling; if (sib) sib.textContent = parseFloat(inp.value).toFixed(1); return; }
          const axis = inp._tagAxis;
          const key = inp._tagKey || "extra";
          if (axis && TAGS[axis]) { inp.value = TAGS[axis][key] ?? 0; const sib = inp.nextElementSibling; if (sib) sib.textContent = parseFloat(inp.value).toFixed(1); }
        }
      });
    }

    const tagFields = [
      ["方位", [
        ["前方", "azimuth > directions > front > tag", "from front"],
        ["后方", "azimuth > directions > back > tag", "from behind"],
        ["左侧", "azimuth > directions > left > tag", "facing right"],
        ["右侧", "azimuth > directions > right > tag", "facing left"],
      ]],
      ["高度", [
        ["俯视", "elevation > categories > high > tag", "high angle"],
        ["平视", "elevation > categories > eye > tag", "eye-level"],
        ["仰视", "elevation > categories > low > tag", "low angle"],
      ]],
      ["距离", [
        ["特写", "distance > categories > ecu > tag", "extreme close-up"],
        ["近景", "distance > categories > cu > tag", "close-up"],
        ["中景", "distance > categories > medium > tag", "medium shot"],
        ["牛仔", "distance > categories > cowboy_shot > tag", "cowboy shot"],
        ["全身", "distance > categories > full > tag", "full body"],
        ["远景", "distance > categories > wide > tag", "wide shot"],
      ]],
      ["倾斜", [["倾斜", "tilt > dutch_tag", "dutch angle"]]],
    ];
    tagFields.forEach(([group, fields]) => {
      const gl = document.createElement("div"); gl.className = "tag-group-label"; gl.textContent = group; tagPanel.appendChild(gl);
      fields.forEach(([label, path, def]) => {
        const parts = path.split(" > ");
        const row = document.createElement("div"); row.className = "tag-row";
        const lbl = document.createElement("span"); lbl.className = "tl"; lbl.textContent = label; row.appendChild(lbl);
        const inp = document.createElement("input"); inp.type = "text";
        let val = def;
        try { let o = TAGS; for (const p of parts) { if (o && typeof o === "object") o = o[p]; } if (typeof o === "string") val = o; } catch (_) {}
        inp.value = val;
        inp.oninput = function () {
          let o = TAGS; for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
          o[parts[parts.length - 1]] = this.value;
          syncTagsToWidget();
        };
        inp._tagPath = parts;
        row.appendChild(inp); tagPanel.appendChild(row);
      });
    });

    // ---- 参数控制分组 ----
    (function buildCtrlPanel() {
      const gl = document.createElement("div"); gl.className = "ctrl-header";
      const glT = document.createElement("span"); glT.textContent = "参数控制"; gl.appendChild(glT);
      const rstBtn = document.createElement("button"); rstBtn.textContent = "↺"; rstBtn.title = "复位参数控制";
      rstBtn.onclick = function () {
        TAGS.xy_mult_enabled = true; TAGS.xy_mult = 10;
        TAGS.extra_master = 1;
        ["azimuth", "elevation", "distance", "tilt"].forEach(a => { if (TAGS[a]) { TAGS[a].extra = 0; TAGS[a].enabled = true; } });
        refreshTagPanel();
        syncTagsToWidget();
      };
      gl.appendChild(rstBtn);
      tagPanel.appendChild(gl);

      // XY 乘数覆盖
      const rowXy = document.createElement("div"); rowXy.className = "ctrl-row";
      const lblXy = document.createElement("span"); lblXy.className = "cl"; lblXy.textContent = "XY乘数"; rowXy.appendChild(lblXy);
      const slXy = document.createElement("input"); slXy.type = "range"; slXy.min = 1; slXy.max = 20; slXy.step = 0.1;
      slXy.value = TAGS.xy_mult ?? 10; slXy._isXySl = true;
      slXy.oninput = function () { TAGS.xy_mult = parseFloat(this.value); svXy.textContent = this.value; syncTagsToWidget(); };
      rowXy.appendChild(slXy);
      const svXy = document.createElement("span"); svXy.className = "cv"; svXy.textContent = slXy.value;
      rowXy.appendChild(svXy);
      const chkXy = document.createElement("input"); chkXy.type = "checkbox"; chkXy.checked = TAGS.xy_mult_enabled !== false; chkXy._isXyChk = true;
      chkXy.onchange = function () { TAGS.xy_mult_enabled = this.checked; syncTagsToWidget(); };
      rowXy.appendChild(chkXy);
      tagPanel.appendChild(rowXy);

      // 额外权重总控
      const rowEm = document.createElement("div"); rowEm.className = "ctrl-row";
      const lblEm = document.createElement("span"); lblEm.className = "cl"; lblEm.textContent = "总控乘数"; rowEm.appendChild(lblEm);
      const slEm = document.createElement("input"); slEm.type = "range"; slEm.min = 0.1; slEm.max = 10; slEm.step = 0.1; slEm._isEmSl = true;
      slEm.value = TAGS.extra_master ?? 1;
      const svEm = document.createElement("span"); svEm.className = "cv"; svEm.textContent = slEm.value;
      slEm.oninput = function () { const v = parseFloat(this.value); TAGS.extra_master = v; svEm.textContent = v.toFixed(1); syncTagsToWidget(); };
      rowEm.appendChild(slEm); rowEm.appendChild(svEm); tagPanel.appendChild(rowEm);

      const ctrlKeys = [
        { axis: "azimuth", label: "方位" },
        { axis: "elevation", label: "高度" },
        { axis: "distance", label: "距离" },
        { axis: "tilt", label: "倾斜" },
      ];
      ctrlKeys.forEach(({ axis, label }) => {
        const rowEx = document.createElement("div"); rowEx.className = "ctrl-row";
        const lblEx = document.createElement("span"); lblEx.className = "cl"; lblEx.textContent = label + "额外"; rowEx.appendChild(lblEx);
        const sl = document.createElement("input"); sl.type = "range"; sl.min = -10; sl.max = 10; sl.step = 0.5;
        sl.value = TAGS[axis]?.extra ?? 0;
        const sv = document.createElement("span"); sv.className = "cv"; sv.textContent = sl.value;
        sl.oninput = function () { const v = parseFloat(this.value); TAGS[axis].extra = v; sv.textContent = v.toFixed(1); syncTagsToWidget(); };
        sl._tagAxis = axis; sl._tagKey = "extra";
        rowEx.appendChild(sl); rowEx.appendChild(sv);
        const chk = document.createElement("input"); chk.type = "checkbox"; chk.checked = TAGS[axis]?.enabled !== false;
        chk.onchange = function () { TAGS[axis].enabled = this.checked; syncTagsToWidget(); };
        chk._tagAxis = axis;
        rowEx.appendChild(chk);
        tagPanel.appendChild(rowEx);
      });
    })();

    // ---- 预览 ----
    previewEl = document.createElement("textarea");
    previewEl.className = "pr"; previewEl.readOnly = true; previewEl.rows = 2;
    container.appendChild(previewEl);
    const ph = document.createElement("div"); ph.className = "ph";
    ph.textContent = "生成时自动附加到正面提示词";
    container.appendChild(ph);

    // ---- 初始化状态 ----
    restoreTags();
    readW();
    syncN();
    refreshNumRows();
  }

  // ============================================================
  // 5. 入口
  // ============================================================
  onUiLoaded(function () {
    gradioApp().querySelectorAll(".anima-cam3d-mount").forEach(m => {
      if (m.dataset.animaInited) return;
      m.dataset.animaInited = "1";
      initAnimaCam(m).catch(e => console.error("[AnimaCamera] init failed:", e));
    });
  });
})();
