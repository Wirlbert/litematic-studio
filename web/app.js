/* Litematic Studio — 前端 */
(function () {
  "use strict";

  var MAX_QUADS = 2200000;
  var TILE = 16;

  var S = {
    root: "", files: [], file: null, doc: null,
    regions: [],          // {name, min, size, palette, idx, info, models, full}
    sel: null,            // {id, state: null | {ri, index}}
    range: null,          // {ri, lo:[i,j,k], hi:[i,j,k]} 拖曳框選的範圍
    mode: "view",
    textured: true,
    yLo: 0, yHi: 0, yFloor: 0, yCeil: 0,
    hover: null,
    atlas: null, atlasCols: 1, atlasRows: 1, texSlot: {}, texInfo: [],
    jar: null, lang: null,
    moveSpeed: 14
  };

  var TEXIMG = {};   // 已解碼的材質圖：name -> HTMLImageElement
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------- API
  function api(path, body) {
    var opt = body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    } : {};
    return fetch(path, opt).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function msg(text, kind) {
    var el = $("msg");
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
    if (text) setTimeout(function () {
      if (el.textContent === text) { el.textContent = ""; el.className = "msg"; }
    }, 6000);
  }

  function num(n) { return n.toLocaleString(); }

  // ------------------------------------------------------------- three.js
  var renderer, scene, camera, controls, hoverBox, rangeBox, boxGroup;
  var meshes = [];
  var raycaster = new THREE.Raycaster();
  var dummy = new THREE.Object3D();
  var KEYS = {};
  var lastFrame = 0;

  function initThree() {
    var host = $("view");
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1116);

    camera = new THREE.PerspectiveCamera(55, host.clientWidth / host.clientHeight, 0.1, 6000);
    camera.position.set(40, 40, 60);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // 左鍵只負責選方塊，右鍵拖曳改成轉自己的視角，滾輪自己接（見下面 onWheel）
    controls.enableRotate = false;
    controls.enableZoom = false;
    controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: -1 };

    // 色塊模式才用得到燈光；材質模式用 Minecraft 自己的固定面明暗
    scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4f5a, 0.52));
    var d1 = new THREE.DirectionalLight(0xffffff, 0.42); d1.position.set(1, 2, 1.4);
    var d2 = new THREE.DirectionalLight(0xffffff, 0.18); d2.position.set(-1.3, 0.7, -1);
    scene.add(d1); scene.add(d2);

    hoverBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
      new THREE.LineBasicMaterial({ color: 0xffd34f })
    );
    hoverBox.visible = false;
    scene.add(hoverBox);

    // 框選範圍的外框：用 1×1×1 的邊線再縮放，拖曳時不必一直重建幾何
    rangeBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x5ad1ff })
    );
    rangeBox.visible = false;
    scene.add(rangeBox);

    boxGroup = new THREE.Group();
    scene.add(boxGroup);

    window.addEventListener("resize", onResize);
    // 一律用 pointer 事件：OrbitControls 會在 pointerdown 上呼叫 preventDefault()，
    // 那會讓相容的 mousedown / mousemove / mouseup 整串都不再發出（只剩 click）。
    // 右鍵轉視角和左鍵拖曳框選都得靠「按住時移動」，所以不能用 mouse 事件。
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    renderer.domElement.addEventListener("pointerleave", function () {
      if (LOOK.on || DRAG.on) return;
      hoverBox.visible = false; S.hover = null; updateHud();
    });
    lastFrame = performance.now();
    animate();
  }

  function onResize() {
    var host = $("view");
    if (!host.clientWidth) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  }

  // WASD / 空白 / Shift 飛行移動：同時平移相機與軌道中心，才不會把視角轉掉
  var vF = new THREE.Vector3(), vD = new THREE.Vector3();

  // 右鍵拖曳 = 轉自己的視角（第一人稱），不是繞著藍圖轉。
  // 做法：把軌道中心釘在相機正前方固定距離的位置，OrbitControls.update() 的
  // lookAt(target) 就等於轉頭；相機本身不會繞著藍圖跑。
  var LOOK = { dist: 40, yaw: 0, pitch: 0, on: false, pid: -1, x: 0, y: 0 };
  var LOOK_SENS = 0.0032;                 // 每像素的弧度
  var vL = new THREE.Vector3();

  function lookSync() {                   // 從現在的相機／軌道中心反推 yaw、pitch
    vL.copy(controls.target).sub(camera.position);
    var d = vL.length();
    LOOK.dist = Math.max(4, Math.min(600, d || 40));
    if (d > 1e-6) {
      vL.divideScalar(d);
      LOOK.pitch = Math.asin(Math.max(-1, Math.min(1, vL.y)));
      LOOK.yaw = Math.atan2(vL.x, vL.z);
    }
  }

  function lookApply() {
    var lim = Math.PI / 2 - 0.02;         // 不能正好垂直，lookAt 的上方向會退化
    LOOK.pitch = Math.max(-lim, Math.min(lim, LOOK.pitch));
    var cp = Math.cos(LOOK.pitch);
    vL.set(Math.sin(LOOK.yaw) * cp, Math.sin(LOOK.pitch), Math.cos(LOOK.yaw) * cp);
    controls.target.copy(camera.position).addScaledVector(vL, LOOK.dist);
  }

  function lookStep(ev) {
    LOOK.yaw -= (ev.clientX - LOOK.x) * LOOK_SENS;
    LOOK.pitch -= (ev.clientY - LOOK.y) * LOOK_SENS;
    LOOK.x = ev.clientX; LOOK.y = ev.clientY;
    lookApply();
  }

  // 滾輪 = 沿著視線前進／後退。用 OrbitControls 的 dolly 會把相機推向軌道中心，
  // 而軌道中心現在就在眼前，推到重合視角就壞了，所以自己接。
  function onWheel(ev) {
    ev.preventDefault();
    var step = (ev.deltaY < 0 ? 1 : -1) * Math.max(1, S.moveSpeed * 0.25);
    camera.getWorldDirection(vF);
    camera.position.addScaledVector(vF, step);
    controls.target.addScaledVector(vF, step);
  }

  // ------------------------------------------------------------- 指標
  // 左鍵：點一下選方塊，按住拖曳框一個長方體範圍（單格編輯模式則是填滿範圍）
  var DRAG = { on: false, pid: -1, anchor: null, cur: null, moved: false };

  function grab(ev) {
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function drop(ev) {
    try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch (e) {}
  }

  function onPointerDown(ev) {
    if (ev.button === 2) {                // 右鍵：轉視角
      lookSync();
      LOOK.on = true; LOOK.pid = ev.pointerId;
      LOOK.x = ev.clientX; LOOK.y = ev.clientY;
      hoverBox.visible = false; S.hover = null; updateHud();
      grab(ev);
      return;
    }
    if (ev.button !== 0) return;          // 中鍵留給 OrbitControls 平移
    DRAG.on = true; DRAG.pid = ev.pointerId; DRAG.moved = false;
    DRAG.anchor = DRAG.cur = pick(ev);
    grab(ev);
  }

  function onPointerMove(ev) {
    if (LOOK.on && ev.pointerId === LOOK.pid) { lookStep(ev); return; }

    var now = performance.now();
    if (now - moveTick < 40) return;      // raycast 不必每個事件都做
    moveTick = now;

    if (DRAG.on && ev.pointerId === DRAG.pid) {
      if (!DRAG.anchor) return;           // 從空白處開始拖曳：沒有起點就不框選
      var hit = pick(ev);
      if (!hit || hit.ri !== DRAG.anchor.ri) return;   // 跨區域不框選
      DRAG.cur = hit;
      hoverAt(hit);
      if (hit.i !== DRAG.anchor.i || hit.j !== DRAG.anchor.j || hit.k !== DRAG.anchor.k) {
        DRAG.moved = true;
      }
      if (DRAG.moved) {
        showRangeBox(rangeOf(DRAG.anchor, DRAG.cur),
          S.mode === "edit" ? 0xffa23f : 0x5ad1ff);
      }
      return;
    }
    hoverAt(pick(ev));
  }

  function onPointerUp(ev) {
    if (LOOK.on && ev.pointerId === LOOK.pid) {
      LOOK.on = false; LOOK.pid = -1; drop(ev); return;
    }
    if (!DRAG.on || ev.pointerId !== DRAG.pid) return;
    DRAG.on = false; drop(ev);
    var a = DRAG.anchor, b = DRAG.cur;
    DRAG.anchor = DRAG.cur = null;
    if (!a || ev.type === "pointercancel") { if (!S.range) showRangeBox(null); return; }
    if (DRAG.moved && b && b.ri === a.ri) applyRange(rangeOf(a, b), ev);
    else { if (!S.range) showRangeBox(null); applyClick(a, ev); }
  }

  function flyStep(dt) {
    var f = (KEYS.KeyW ? 1 : 0) - (KEYS.KeyS ? 1 : 0);
    var r = (KEYS.KeyD ? 1 : 0) - (KEYS.KeyA ? 1 : 0);
    var u = (KEYS.Space ? 1 : 0) - ((KEYS.ShiftLeft || KEYS.ShiftRight) ? 1 : 0);
    if (!f && !r && !u) return;

    camera.getWorldDirection(vF);
    vF.y = 0;
    if (vF.lengthSq() < 1e-8) {           // 正上方或正下方俯視時改用相機的上方向
      vF.set(0, 1, 0).applyQuaternion(camera.quaternion);
      vF.y = 0;
      if (vF.lengthSq() < 1e-8) vF.set(0, 0, -1);
    }
    vF.normalize();

    var sp = S.moveSpeed * ((KEYS.ControlLeft || KEYS.ControlRight) ? 3 : 1) * dt;
    vD.set(0, 0, 0);
    vD.addScaledVector(vF, f * sp);
    vD.x += -vF.z * r * sp;               // 右向量 = forward × up = (-fz, 0, fx)
    vD.z += vF.x * r * sp;
    vD.y += u * sp;

    camera.position.add(vD);
    controls.target.add(vD);
  }

  function animate() {
    requestAnimationFrame(animate);
    var now = performance.now();
    var dt = Math.min(0.08, (now - lastFrame) / 1000);
    lastFrame = now;
    flyStep(dt);
    controls.update();
    renderer.render(scene, camera);
  }

  function clearMeshes() {
    meshes.forEach(function (m) {
      scene.remove(m);
      m.geometry.dispose();
      if (m.material && m.material.dispose) m.material.dispose();
    });
    meshes = [];
  }

  // ------------------------------------------------------------- 資料
  function b64ToArray(b64, dtype) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var u8 = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return dtype === "u2" ? new Uint16Array(buf) : new Uint32Array(buf);
  }

  function parseProps(text) {
    var a = text.indexOf("[");
    if (a < 0) return {};
    var out = {};
    text.slice(a + 1, text.lastIndexOf("]")).split(",").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length === 2) out[p[0]] = p[1];
    });
    return out;
  }

  function paletteInfo(palette) {
    return palette.map(function (e) {
      var props = parseProps(e.text);
      var col = Blocks.colorOf(e.id);
      return {
        color: new THREE.Color(col),
        hex: col,
        alpha: Blocks.alphaOf(e.id),
        shape: Blocks.shapeOf(e.id, props),
        empty: Blocks.isEmpty(e.id),
        solid: Blocks.isSolid(e.id, props),
        tint: Blocks.tintFor(e.id, props)
      };
    });
  }

  // ------------------------------------------------------------- 材質圖集
  function loadTextures(list) {
    var jobs = list.map(function (t) {
      if (!t.d || TEXIMG[t.n]) return Promise.resolve();
      return new Promise(function (res) {
        var img = new Image();
        img.onload = function () { TEXIMG[t.n] = img; res(); };
        img.onerror = function () { res(); };
        img.src = "data:image/png;base64," + t.d;
      });
    });
    return Promise.all(jobs).then(function () { buildAtlas(list); });
  }

  function buildAtlas(list) {
    var names = list.map(function (t) { return t.n; });
    var n = Math.max(1, names.length);
    var cols = Math.ceil(Math.sqrt(n));
    var rows = Math.ceil(n / cols);
    var cv = document.createElement("canvas");
    cv.width = cols * TILE; cv.height = rows * TILE;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;

    S.texSlot = {}; S.texInfo = [];
    names.forEach(function (name, s) {
      S.texSlot[name] = s;
      S.texInfo.push(null);
      var img = TEXIMG[name];
      var cx = (s % cols) * TILE, cy = ((s / cols) | 0) * TILE;
      if (!img) {
        ctx.fillStyle = "#c050c0";
        ctx.fillRect(cx, cy, TILE, TILE);
        S.texInfo[s] = { hasAlpha: false, translucent: false };
        return;
      }
      // 動畫材質是直條圖，只取第一格
      var sw = img.width, sh = img.height;
      if (sh > sw && sw > 0 && sh % sw === 0) sh = sw;
      ctx.save();
      if (name.indexOf("water_") >= 0) ctx.globalAlpha = 0.78;
      ctx.drawImage(img, 0, 0, sw, sh, cx, cy, TILE, TILE);
      ctx.restore();
    });

    // 分類：全不透明 / 鏤空 / 半透明
    var data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    names.forEach(function (name, s) {
      if (S.texInfo[s]) return;
      var cx = (s % cols) * TILE, cy = ((s / cols) | 0) * TILE;
      var hasAlpha = false, partial = false;
      for (var y = 0; y < TILE; y++) {
        var row = ((cy + y) * cv.width + cx) * 4;
        for (var x = 0; x < TILE; x++) {
          var a = data[row + x * 4 + 3];
          if (a < 255) { hasAlpha = true; if (a > 0) partial = true; }
        }
      }
      S.texInfo[s] = { hasAlpha: hasAlpha, translucent: partial };
    });

    if (S.atlas) S.atlas.dispose();
    var tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    S.atlas = tex; S.atlasCols = cols; S.atlasRows = rows;
  }

  // 判斷一個 palette 項目是不是「完整不透明方塊」（鄰接面剔除用）
  function computeFull(quads) {
    if (!quads || !quads.length) return false;
    var seen = {};
    for (var n = 0; n < quads.length; n++) {
      var q = quads[n];
      if (q.tr) continue;
      var ti = S.texInfo[q.t];
      if (!ti || ti.hasAlpha) continue;
      var p = q.p, dir = null, a, b;
      var allX0 = true, allX1 = true, allY0 = true, allY1 = true, allZ0 = true, allZ1 = true;
      for (var t = 0; t < 4; t++) {
        if (p[t * 3] !== 0) allX0 = false;
        if (p[t * 3] !== 1) allX1 = false;
        if (p[t * 3 + 1] !== 0) allY0 = false;
        if (p[t * 3 + 1] !== 1) allY1 = false;
        if (p[t * 3 + 2] !== 0) allZ0 = false;
        if (p[t * 3 + 2] !== 1) allZ1 = false;
      }
      if (allX0) { dir = "west"; a = 1; b = 2; }
      else if (allX1) { dir = "east"; a = 1; b = 2; }
      else if (allY0) { dir = "down"; a = 0; b = 2; }
      else if (allY1) { dir = "up"; a = 0; b = 2; }
      else if (allZ0) { dir = "north"; a = 0; b = 1; }
      else if (allZ1) { dir = "south"; a = 0; b = 1; }
      else continue;
      var amin = 9, amax = -9, bmin = 9, bmax = -9;
      for (t = 0; t < 4; t++) {
        var av = p[t * 3 + a], bv = p[t * 3 + b];
        if (av < amin) amin = av;
        if (av > amax) amax = av;
        if (bv < bmin) bmin = bv;
        if (bv > bmax) bmax = bv;
      }
      if (amin === 0 && amax === 1 && bmin === 0 && bmax === 1) seen[dir] = true;
    }
    return !!(seen.up && seen.down && seen.north && seen.south && seen.east && seen.west);
  }

  // ------------------------------------------------------------- 檔案
  function loadFileList() {
    return api("/api/files").then(function (j) {
      S.root = j.root; S.files = j.files;
      $("rootPath").textContent = j.root;
      var box = $("fileList");
      box.innerHTML = "";
      if (!j.files.length) {
        box.innerHTML = '<div class="hint">這個資料夾沒有 .litematic 檔案</div>';
      }
      j.files.forEach(function (f) {
        var el = document.createElement("div");
        el.className = "item" + (f.name === S.file ? " active" : "");
        el.innerHTML = '<div class="nm"></div><div class="ct">' +
          (f.size / 1024).toFixed(0) + ' KB</div>' +
          (f.dirty ? '<div class="tag">●</div>' : "");
        el.querySelector(".nm").textContent = f.name;
        el.onclick = function () { openFile(f.name); };
        box.appendChild(el);
      });
    });
  }

  function openFile(name) {
    msg("載入中…");
    return api("/api/schem?f=" + encodeURIComponent(name)).then(function (doc) {
      S.file = name;
      return adoptDoc(doc, true).then(loadFileList);
    }).catch(function (e) { msg(String(e.message || e), "bad"); });
  }

  // 重新烘焙模型（換檔或替換方塊後）
  function refreshModels() {
    if (!S.file) return Promise.resolve();
    return api("/api/bake", { file: S.file, have: Object.keys(TEXIMG) })
      .then(function (res) {
        if (!res.ok) {
          S.textured = false;
          $("chkTex").checked = false;
          $("chkTex").disabled = true;
          $("texNote").textContent = res.error || "沒有載入材質";
          return;
        }
        S.jar = res.jar;
        $("chkTex").disabled = false;
        $("texNote").textContent = res.jar;
        return loadTextures(res.textures).then(function () {
          res.regions.forEach(function (rr) {
            var r = S.regions.filter(function (x) { return x.name === rr.name; })[0];
            if (!r) return;
            r.models = rr.models;
            r.full = rr.models.map(computeFull);
          });
        });
      })
      .catch(function (e) {
        S.textured = false;
        $("chkTex").checked = false;
        $("texNote").textContent = String(e.message || e);
      });
  }

  function adoptDoc(doc, resetView) {
    S.doc = doc;
    S.sel = null;
    S.range = null;
    if (rangeBox) rangeBox.visible = false;
    S.regions = doc.regions.map(function (r) {
      return {
        name: r.name, min: r.min, size: r.size,
        palette: r.palette, idx: b64ToArray(r.data, r.dtype),
        info: paletteInfo(r.palette),
        models: null, full: null,
        tileEntities: r.tileEntities, entities: r.entities
      };
    });

    var lo = Infinity, hi = -Infinity;
    S.regions.forEach(function (r) {
      lo = Math.min(lo, r.min[1]); hi = Math.max(hi, r.min[1] + r.size[1] - 1);
    });
    S.yFloor = lo; S.yCeil = hi; S.yLo = lo; S.yHi = hi;
    $("yMin").min = $("yMax").min = lo;
    $("yMin").max = $("yMax").max = hi;
    $("yMin").value = lo; $("yMax").value = hi;

    var span = Math.max(doc.size[0], doc.size[1], doc.size[2]);
    S.moveSpeed = Math.max(8, Math.min(60, span / 3));

    $("hdrFile").textContent = doc.file + "  —  " + doc.size.join(" × ") +
      (doc.author ? "  by " + doc.author : "");
    $("info").textContent =
      "尺寸  " + doc.size.join(" × ") + "\n" +
      "體積  " + num(doc.volume) + " 格\n" +
      "區域  " + doc.regions.length + "\n" +
      "容器  " + S.regions.reduce(function (a, r) { return a + r.tileEntities; }, 0) +
      "   實體 " + S.regions.reduce(function (a, r) { return a + r.entities; }, 0) +
      (doc.description ? "\n說明  " + doc.description : "");

    setDirty(doc.dirty);
    ["btnSave", "btnRevert", "btnBackups"].forEach(function (id) { $(id).disabled = false; });
    renderPalette();
    showSel();
    drawOutline();
    return refreshModels().then(function () {
      rebuild();
      if (resetView) fitCamera();
      msg("");
    });
  }

  function setDirty(d) {
    if (S.doc) S.doc.dirty = d;
    $("dirty").classList.toggle("hidden", !d);
  }

  // ------------------------------------------------------------- 選取
  function selMatch(r, ri, p, i, j, k) {
    if (S.range) return inRange(S.range, ri, i, j, k);
    if (!S.sel) return false;
    if (S.sel.state) return S.sel.state.ri === ri && S.sel.state.index === p;
    return r.palette[p].id === S.sel.id;
  }

  // 一個方塊 ID 底下的所有狀態
  function statesOf(id) {
    var out = [];
    S.regions.forEach(function (r, ri) {
      r.palette.forEach(function (e, i) {
        if (e.id === id && e.count > 0) {
          out.push({ ri: ri, index: i, text: e.text, count: e.count });
        }
      });
    });
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
  }

  function blockGroups() {
    var map = {}, order = [];
    S.regions.forEach(function (r, ri) {
      r.palette.forEach(function (e, i) {
        if (Blocks.isEmpty(e.id) || !e.count) return;
        var g = map[e.id];
        if (!g) {
          g = map[e.id] = { id: e.id, count: 0, states: 0, hex: r.info[i].hex };
          order.push(g);
        }
        g.count += e.count;
        g.states++;
      });
    });
    order.sort(function (a, b) { return b.count - a.count; });
    return order;
  }

  function select(id, state) {
    S.sel = { id: id, state: state || null };
    S.range = null;
    showRangeBox(null);
    renderPalette();
    showSel();
    rebuild();
  }

  function clearSel() {
    S.sel = null;
    S.range = null;
    showRangeBox(null);
    renderPalette();
    showSel();
    rebuild();
  }

  function showSel() {
    if (S.range) { showRange(); return; }
    var ok = !!S.sel;
    ["newBlock", "btnApply", "btnAir", "stateSel"].forEach(function (id) {
      $(id).disabled = !ok;
    });
    var sel = $("stateSel");
    if (!ok) {
      $("selInfo").textContent =
        "在右上清單或 3D 畫面中選一個方塊，或在畫面上拖曳框選一塊範圍";
      sel.innerHTML = "";
      $("newBlock").value = "";
      return;
    }

    var states = statesOf(S.sel.id);
    var total = states.reduce(function (a, s) { return a + s.count; }, 0);
    $("selInfo").innerHTML = "";
    var line1 = document.createElement("b");
    line1.textContent = Blocks.nameOf(S.sel.id);
    var line2 = document.createElement("div");
    line2.className = "hint";
    line2.textContent = S.sel.id + "　共 " + num(total) + " 格" +
      (states.length > 1 ? "　" + states.length + " 種狀態" : "");
    $("selInfo").appendChild(line1);
    $("selInfo").appendChild(line2);

    // 下拉：全部狀態 + 各別狀態
    sel.innerHTML = "";
    var optAll = document.createElement("option");
    optAll.value = "*";
    optAll.textContent = "全部狀態（" + num(total) + " 格" +
      (states.length > 1 ? "・" + states.length + " 種" : "") + "）";
    sel.appendChild(optAll);
    if (states.length > 1) {
      states.forEach(function (st) {
        var o = document.createElement("option");
        o.value = st.ri + ":" + st.index;
        o.textContent = (Blocks.stateLabel(st.text) || "（無狀態）") +
          "（" + num(st.count) + " 格）";
        o.title = st.text;
        sel.appendChild(o);
      });
    }

    var want = S.sel.state ? (S.sel.state.ri + ":" + S.sel.state.index) : "*";
    sel.value = want;
    if (sel.value !== want) sel.value = "*";
    // 一定要重算「換成」的預設值：選了別的方塊卻留著上一個的值，
    // 按下套用就會換成完全不相干的東西。
    syncNewBlock();
  }

  // 框選範圍時的「替換」面板
  function showRange() {
    var rg = S.range, r = S.regions[rg.ri];
    ["newBlock", "btnApply", "btnAir", "stateSel"].forEach(function (id) {
      $(id).disabled = false;
    });
    var s = rangeSize(rg), cells = rangeCells(rg), c = rangeContents(rg);

    $("selInfo").innerHTML = "";
    var line1 = document.createElement("b");
    line1.textContent = "選取範圍 " + s[0] + " × " + s[1] + " × " + s[2];
    var line2 = document.createElement("div");
    line2.className = "hint";
    line2.textContent =
      num(cells) + " 格・其中 " + num(cells - c.empty) + " 格有方塊　" +
      (r.min[0] + rg.lo[0]) + "," + (r.min[1] + rg.lo[1]) + "," + (r.min[2] + rg.lo[2]) +
      " ～ " +
      (r.min[0] + rg.hi[0]) + "," + (r.min[1] + rg.hi[1]) + "," + (r.min[2] + rg.hi[2]) +
      (S.regions.length > 1 ? "　區域 " + r.name : "");
    $("selInfo").appendChild(line1);
    $("selInfo").appendChild(line2);

    var sel = $("stateSel");
    sel.innerHTML = "";
    var optAll = document.createElement("option");
    optAll.value = "*";
    optAll.textContent = "整個範圍（" + num(cells) + " 格，含空氣）";
    sel.appendChild(optAll);
    c.kinds.forEach(function (g) {
      var o = document.createElement("option");
      o.value = "id:" + g.id;
      o.textContent = Blocks.nameOf(g.id) + "（" + num(g.count) + " 格）";
      o.title = g.id;
      sel.appendChild(o);
    });
    sel.value = "*";
    syncNewBlock();
  }

  // 「換成」欄位的預設值跟著下拉走
  function syncNewBlock() {
    if (S.range) {
      var rv = $("stateSel").value;
      if (rv.indexOf("id:") === 0) { $("newBlock").value = rv.slice(3); return; }
      var kinds = rangeContents(S.range).kinds;
      $("newBlock").value = kinds.length ? kinds[0].id : "minecraft:stone";
      return;
    }
    if (!S.sel) return;
    var v = $("stateSel").value;
    if (v === "*") {
      $("newBlock").value = S.sel.id;
    } else {
      var parts = v.split(":");
      var r = S.regions[+parts[0]];
      var e = r && r.palette[+parts[1]];
      $("newBlock").value = e ? e.text : S.sel.id;
    }
  }

  // ------------------------------------------------------------- 走訪
  function visitBlocks(cb) {
    for (var ri = 0; ri < S.regions.length; ri++) {
      var r = S.regions[ri];
      var W = r.size[0], H = r.size[1], L = r.size[2];
      var mx = r.min[0], my = r.min[1], mz = r.min[2];
      var idx = r.idx, info = r.info, HL = H * L;
      for (var j = 0; j < H; j++) {
        var wy = my + j;
        if (wy < S.yLo || wy > S.yHi) continue;
        for (var i = 0; i < W; i++) {
          var base = i * HL + j * L;
          for (var k = 0; k < L; k++) {
            var p = idx[base + k];
            if (info[p].empty) continue;
            cb(r, ri, i, j, k, p, mx + i, wy, mz + k);
          }
        }
      }
    }
  }

  var DELTA = {
    east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0],
    down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1]
  };

  function neighborFull(r, i, j, k, dir) {
    var d = DELTA[dir];
    if (!d || !r.full) return false;
    var ni = i + d[0], nj = j + d[1], nk = k + d[2];
    if (ni < 0 || nj < 0 || nk < 0 ||
        ni >= r.size[0] || nj >= r.size[1] || nk >= r.size[2]) return false;
    var wy = r.min[1] + nj;
    if (wy < S.yLo || wy > S.yHi) return false;   // 切面要看得到
    return !!r.full[r.idx[ni * r.size[1] * r.size[2] + nj * r.size[2] + nk]];
  }

  function bucketOf(q) {
    var ti = S.texInfo[q.t];
    if (!ti) return "op";
    if (ti.translucent || q.tr) return "tr";
    return ti.hasAlpha ? "cut" : "op";
  }

  // ------------------------------------------------------------- 建模
  function rebuild() {
    clearMeshes();
    if (!S.regions.length) return;
    var useTex = !!(S.textured && S.atlas && S.regions[0].models);
    var stats = useTex ? buildTextured() : { quads: 0, blocks: 0 };
    var extra = buildColored(useTex);
    $("counts").textContent = (useTex ? "材質模式　" : "色塊模式　") +
      (stats.quads ? num(stats.quads) + " 面　" : "") +
      "方塊 " + num((stats.blocks || 0) + extra) +
      (stats.overflow ? "　（已達上限，請縮小 Y 層範圍）" : "");
    $("yLabel").textContent = S.yLo + " … " + S.yHi;
  }

  function buildTextured() {
    var ghostOn = $("chkGhost").checked && !!(S.sel || S.range);
    var onlySel = $("chkOnlySel").checked && !!(S.sel || S.range);
    var cull = $("chkCull").checked;
    var counts = { op: 0, cut: 0, tr: 0, ghost: 0 };
    var blocks = 0, overflow = false, totalQuads = 0;

    function each(cb) {
      visitBlocks(function (r, ri, i, j, k, p, wx, wy, wz) {
        var quads = r.models && r.models[p];
        if (!quads || !quads.length) return;          // 沒模型的交給色塊
        var isSel = selMatch(r, ri, p, i, j, k);
        if (onlySel && !isSel) return;
        var ghost = ghostOn && !isSel;
        var any = false;
        for (var n = 0; n < quads.length; n++) {
          var q = quads[n];
          if (cull && !isSel && q.cf && neighborFull(r, i, j, k, q.cf)) continue;
          cb(q, wx, wy, wz, ghost, r, ri, i, j, k, p);
          any = true;
        }
        if (any) blocks++;
      });
    }

    each(function (q, wx, wy, wz, ghost) {
      if (totalQuads++ > MAX_QUADS) { overflow = true; return; }
      counts[ghost ? "ghost" : bucketOf(q)]++;
    });
    blocks = Math.round(blocks / 2);   // each() 會被跑兩次

    var buf = {};
    ["op", "cut", "tr", "ghost"].forEach(function (key) {
      var n = counts[key];
      if (!n) return;
      buf[key] = {
        pos: new Float32Array(n * 18),
        uv: new Float32Array(n * 12),
        col: new Float32Array(n * 18),
        rec: new Int32Array(n * 5),
        q: 0
      };
    });

    var cols = S.atlasCols, rows = S.atlasRows;
    var wrote = 0;
    var order = [0, 1, 2, 0, 2, 3];
    each(function (q, wx, wy, wz, ghost, r, ri, i, j, k, p) {
      if (wrote++ > MAX_QUADS) return;
      var b = buf[ghost ? "ghost" : bucketOf(q)];
      if (!b || b.q >= b.rec.length / 5) return;
      var o = b.q;
      var cx = q.t % cols, cy = (q.t / cols) | 0;

      var sh = q.s;
      var tint = q.c >= 0 ? r.info[p].tint : null;
      var cr, cg, cb2;
      if (ghost) { cr = 0.42; cg = 0.45; cb2 = 0.5; }
      else if (tint) { cr = sh * tint[0]; cg = sh * tint[1]; cb2 = sh * tint[2]; }
      else { cr = sh; cg = sh; cb2 = sh; }

      var P = q.p, U = q.u;
      for (var t = 0; t < 6; t++) {
        var c = order[t];
        var vi = o * 18 + t * 3;
        b.pos[vi] = P[c * 3] + wx;
        b.pos[vi + 1] = P[c * 3 + 1] + wy;
        b.pos[vi + 2] = P[c * 3 + 2] + wz;
        b.col[vi] = cr; b.col[vi + 1] = cg; b.col[vi + 2] = cb2;
        var ui = o * 12 + t * 2;
        var u = U[c * 2], v = U[c * 2 + 1];
        u = u < 0 ? 0 : (u > 1 ? 1 : u);
        v = v < 0 ? 0 : (v > 1 ? 1 : v);
        b.uv[ui] = (cx + (0.5 + u * (TILE - 1)) / TILE) / cols;
        b.uv[ui + 1] = (cy + (0.5 + v * (TILE - 1)) / TILE) / rows;
      }
      b.rec[o * 5] = ri; b.rec[o * 5 + 1] = i; b.rec[o * 5 + 2] = j;
      b.rec[o * 5 + 3] = k; b.rec[o * 5 + 4] = p;
      b.q++;
    });

    ["op", "cut", "tr", "ghost"].forEach(function (key) {
      var b = buf[key];
      if (!b || !b.q) return;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(b.pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(b.uv, 2));
      geo.setAttribute("color", new THREE.BufferAttribute(b.col, 3));
      geo.setDrawRange(0, b.q * 6);
      var opt = { map: S.atlas, vertexColors: true, side: THREE.DoubleSide };
      if (key === "cut") opt.alphaTest = 0.5;
      if (key === "tr") { opt.transparent = true; opt.depthWrite = false; opt.alphaTest = 0.02; }
      if (key === "ghost") { opt.transparent = true; opt.opacity = 0.09; opt.depthWrite = false; }
      var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial(opt));
      mesh.userData.rec = b.rec;
      mesh.userData.pickable = key !== "ghost";
      mesh.renderOrder = key === "op" ? 0 : (key === "ghost" ? 3 : (key === "cut" ? 1 : 2));
      scene.add(mesh);
      meshes.push(mesh);
    });

    return { quads: totalQuads, blocks: blocks, overflow: overflow };
  }

  // 沒有模型的方塊（箱子、告示牌…）或色塊模式：用近似外形的彩色方塊
  function buildColored(onlyFallback) {
    var ghostOn = $("chkGhost").checked && !!(S.sel || S.range);
    var onlySel = $("chkOnlySel").checked && !!(S.sel || S.range);
    var cull = $("chkCull").checked;
    var buckets = {};
    var count = 0;

    visitBlocks(function (r, ri, i, j, k, p, wx, wy, wz) {
      if (onlyFallback) {
        var qs = r.models && r.models[p];
        if (qs && qs.length) return;                 // 已經用材質畫過了
      }
      var inf = r.info[p];
      var isSel = selMatch(r, ri, p, i, j, k);
      if (onlySel && !isSel) return;
      if (!onlyFallback && !isSel && cull && inf.solid && occluded(r, i, j, k)) return;
      var key, alpha, color;
      if (ghostOn && !isSel) { key = "ghost"; alpha = 0.09; color = 0x9aa3b0; }
      else {
        var a = inf.alpha;
        key = a >= 1 ? "op" : (a > 0.7 ? "t85" : (a > 0.4 ? "t55" : "t35"));
        alpha = a >= 1 ? 1 : (key === "t85" ? 0.85 : key === "t55" ? 0.55 : 0.35);
        color = inf.color;
      }
      var b = buckets[key] || (buckets[key] = { alpha: alpha, items: [] });
      b.items.push({ sh: inf.shape, x: wx, y: wy, z: wz, c: color, rec: [ri, i, j, k, p] });
      count++;
    });

    Object.keys(buckets).forEach(function (key) {
      var b = buckets[key];
      var n = b.items.length;
      var mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({
          transparent: b.alpha < 1, opacity: b.alpha, depthWrite: b.alpha > 0.5
        }),
        n
      );
      var c = new THREE.Color();
      var rec = new Int32Array(n * 5);
      for (var t = 0; t < n; t++) {
        var it = b.items[t], sh = it.sh;
        dummy.position.set(it.x + 0.5 + sh[3], it.y + 0.5 + sh[4], it.z + 0.5 + sh[5]);
        dummy.scale.set(sh[0], sh[1], sh[2]);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(t, dummy.matrix);
        mesh.setColorAt(t, typeof it.c === "number" ? c.setHex(it.c) : it.c);
        rec.set(it.rec, t * 5);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData.rec = rec;
      mesh.userData.instanced = true;
      mesh.userData.pickable = key !== "ghost";
      mesh.renderOrder = key === "op" ? 0 : 2;
      scene.add(mesh);
      meshes.push(mesh);
    });
    return count;
  }

  function occluded(r, i, j, k) {
    var W = r.size[0], H = r.size[1], L = r.size[2], HL = H * L;
    if (i === 0 || i === W - 1 || k === 0 || k === L - 1 || j === 0 || j === H - 1) return false;
    var wyUp = r.min[1] + j + 1, wyDn = r.min[1] + j - 1;
    if (wyUp < S.yLo || wyUp > S.yHi || wyDn < S.yLo || wyDn > S.yHi) return false;
    var idx = r.idx, info = r.info, c = i * HL + j * L + k;
    return info[idx[c + HL]].solid && info[idx[c - HL]].solid &&
           info[idx[c + L]].solid && info[idx[c - L]].solid &&
           info[idx[c + 1]].solid && info[idx[c - 1]].solid;
  }

  function drawOutline() {
    while (boxGroup.children.length) {
      var c = boxGroup.children.pop();
      c.geometry.dispose(); c.material.dispose();
    }
    if (!$("chkBox").checked) return;
    S.regions.forEach(function (r) {
      var W = r.size[0], H = r.size[1], L = r.size[2];
      var box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, L)),
        new THREE.LineBasicMaterial({ color: 0x3d4654 })
      );
      box.position.set(r.min[0] + W / 2, r.min[1] + H / 2, r.min[2] + L / 2);
      boxGroup.add(box);
    });
  }

  function bounds() {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    S.regions.forEach(function (r) {
      for (var n = 0; n < 3; n++) {
        lo[n] = Math.min(lo[n], r.min[n]);
        hi[n] = Math.max(hi[n], r.min[n] + r.size[n]);
      }
    });
    return { lo: lo, hi: hi };
  }

  function fitCamera(dir) {
    if (!S.regions.length) return;
    var b = bounds();
    var cx = (b.lo[0] + b.hi[0]) / 2, cy = (b.lo[1] + b.hi[1]) / 2, cz = (b.lo[2] + b.hi[2]) / 2;
    var span = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]);
    var d = span * 1.5 + 6;
    controls.target.set(cx, cy, cz);
    if (dir === "top") camera.position.set(cx + 0.01, cy + d, cz);
    else if (dir === "side") camera.position.set(cx + d, cy, cz);
    else camera.position.set(cx + d * 0.75, cy + d * 0.6, cz + d * 0.8);
    controls.update();
  }

  // ------------------------------------------------------------- 互動
  function pick(ev) {
    var host = $("view");
    var rect = host.getBoundingClientRect();
    var m = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(m, camera);
    var targets = meshes.filter(function (x) { return x.userData.pickable; });
    var hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    var h = hits[0];
    var rec = h.object.userData.rec;
    var t = h.object.userData.instanced
      ? h.instanceId * 5
      : ((h.faceIndex / 2) | 0) * 5;
    if (t < 0 || t + 4 >= rec.length) return null;
    return { ri: rec[t], i: rec[t + 1], j: rec[t + 2], k: rec[t + 3], p: rec[t + 4] };
  }

  var moveTick = 0;
  function hoverAt(hit) {
    S.hover = hit;
    if (hit) {
      var r = S.regions[hit.ri];
      hoverBox.position.set(
        r.min[0] + hit.i + 0.5, r.min[1] + hit.j + 0.5, r.min[2] + hit.k + 0.5);
      hoverBox.visible = true;
    } else {
      hoverBox.visible = false;
    }
    updateHud();
  }

  function updateHud() {
    var h = S.hover;
    if (!h) { $("hud").textContent = ""; return; }
    var r = S.regions[h.ri];
    var e = r.palette[h.p];
    var label = Blocks.stateLabel(e.text);
    $("hud").textContent =
      Blocks.nameOf(e.id) + (label ? "　" + label : "") + "\n" +
      e.text + "\n座標 " +
      (r.min[0] + h.i) + ", " + (r.min[1] + h.j) + ", " + (r.min[2] + h.k) +
      (S.regions.length > 1 ? "　區域 " + r.name : "");
  }

  function applyClick(hit, ev) {
    var r = S.regions[hit.ri];
    if (S.mode === "edit") {
      if (ev.shiftKey) {
        $("brush").value = r.palette[hit.p].text;
        msg("筆刷 = " + Blocks.nameOf(r.palette[hit.p].id), "ok");
        return;
      }
      var to = ev.ctrlKey || ev.metaKey ? "minecraft:air" : $("brush").value.trim();
      doOp({ op: "setblock", region: r.name, pos: [hit.i, hit.j, hit.k], to: to },
        function (res) {
          r.idx[hit.i * r.size[1] * r.size[2] + hit.j * r.size[2] + hit.k] = res.index;
        });
      return;
    }
    select(r.palette[hit.p].id, { ri: hit.ri, index: hit.p });
  }

  // ------------------------------------------------------------- 範圍
  function rangeOf(a, b) {
    return {
      ri: a.ri,
      lo: [Math.min(a.i, b.i), Math.min(a.j, b.j), Math.min(a.k, b.k)],
      hi: [Math.max(a.i, b.i), Math.max(a.j, b.j), Math.max(a.k, b.k)]
    };
  }

  function rangeSize(rg) {
    return [rg.hi[0] - rg.lo[0] + 1, rg.hi[1] - rg.lo[1] + 1, rg.hi[2] - rg.lo[2] + 1];
  }

  function rangeCells(rg) {
    var s = rangeSize(rg);
    return s[0] * s[1] * s[2];
  }

  // 範圍裡每種方塊各幾格。idx 本機就有，不用問伺服器
  function rangeContents(rg) {
    var r = S.regions[rg.ri];
    var HL = r.size[1] * r.size[2], L = r.size[2];
    var map = {}, order = [], empty = 0;
    for (var i = rg.lo[0]; i <= rg.hi[0]; i++) {
      for (var j = rg.lo[1]; j <= rg.hi[1]; j++) {
        var base = i * HL + j * L;
        for (var k = rg.lo[2]; k <= rg.hi[2]; k++) {
          var e = r.palette[r.idx[base + k]];
          if (Blocks.isEmpty(e.id)) { empty++; continue; }
          var g = map[e.id];
          if (!g) { g = map[e.id] = { id: e.id, count: 0 }; order.push(g); }
          g.count++;
        }
      }
    }
    order.sort(function (a, b) { return b.count - a.count; });
    return { kinds: order, empty: empty };
  }

  function inRange(rg, ri, i, j, k) {
    return ri === rg.ri &&
      i >= rg.lo[0] && i <= rg.hi[0] &&
      j >= rg.lo[1] && j <= rg.hi[1] &&
      k >= rg.lo[2] && k <= rg.hi[2];
  }

  function showRangeBox(rg, color) {
    if (!rg) { rangeBox.visible = false; return; }
    var r = S.regions[rg.ri], s = rangeSize(rg);
    rangeBox.scale.set(s[0] + 0.04, s[1] + 0.04, s[2] + 0.04);
    rangeBox.position.set(
      r.min[0] + rg.lo[0] + s[0] / 2,
      r.min[1] + rg.lo[1] + s[1] / 2,
      r.min[2] + rg.lo[2] + s[2] / 2);
    rangeBox.material.color.setHex(color || 0x5ad1ff);
    rangeBox.visible = true;
  }

  function setRange(rg) {
    S.range = rg;
    if (rg) S.sel = null;
    showRangeBox(rg, 0x5ad1ff);
    renderPalette();
    showSel();
    rebuild();
  }

  // 拖曳結束：瀏覽模式是框選，單格編輯模式是整塊填滿
  function applyRange(rg, ev) {
    if (S.mode !== "edit") { setRange(rg); return; }
    var to = (ev.ctrlKey || ev.metaKey) ? "minecraft:air" : $("brush").value.trim();
    if (!to) { msg("筆刷是空的", "bad"); showRangeBox(null); return; }
    showRangeBox(rg, 0xffa23f);
    var done = function () { if (!S.range) showRangeBox(null); };
    doOp({
      op: "fill_box", region: S.regions[rg.ri].name,
      from: rg.lo, to_pos: rg.hi, to: to
    }, function (res) { patchBox(rg, res.index, null); }).then(done, done);
  }

  // 伺服器改完之後，本機的 idx 也要跟著改，不然畫面跟檔案會不一致
  function patchBox(rg, index, only) {
    var r = S.regions[rg.ri];
    var HL = r.size[1] * r.size[2], L = r.size[2];
    for (var i = rg.lo[0]; i <= rg.hi[0]; i++) {
      for (var j = rg.lo[1]; j <= rg.hi[1]; j++) {
        var base = i * HL + j * L;
        for (var k = rg.lo[2]; k <= rg.hi[2]; k++) {
          if (only && r.palette[r.idx[base + k]].id !== only) continue;
          r.idx[base + k] = index;
        }
      }
    }
  }

  // ------------------------------------------------------------- 清單
  function renderPalette() {
    var box = $("palette");
    var q = $("search").value.trim().toLowerCase();
    box.innerHTML = "";

    var groups = blockGroups();
    $("blockSummary").textContent = groups.length + " 種方塊";

    var shown = 0;
    groups.forEach(function (g) {
      var name = Blocks.nameOf(g.id);
      if (q && g.id.toLowerCase().indexOf(q) < 0 && name.toLowerCase().indexOf(q) < 0) return;
      shown++;
      var el = document.createElement("div");
      var active = S.sel && S.sel.id === g.id;
      el.className = "item" + (active ? " active" : "");
      el.innerHTML =
        '<div class="sw"></div>' +
        '<div class="nm2"><b></b><small></small></div>' +
        '<div class="ct">' + num(g.count) + "</div>";
      el.querySelector(".sw").style.background = g.hex;
      el.querySelector("b").textContent = name;
      el.querySelector("small").textContent =
        g.id.replace("minecraft:", "") + (g.states > 1 ? "　" + g.states + " 種狀態" : "");
      el.title = g.id;
      el.onclick = function () { select(g.id, null); };
      box.appendChild(el);
    });

    if (!shown) {
      box.innerHTML = '<div class="hint">沒有符合的方塊</div>';
    }
  }

  // ------------------------------------------------------------- 操作
  function doOp(body, patch) {
    body.file = S.file;
    return api("/api/op", body).then(function (res) {
      if (patch) patch(res);
      res.regions.forEach(function (rr) {
        var r = S.regions.filter(function (x) { return x.name === rr.name; })[0];
        if (!r) return;
        r.palette = rr.palette;
        r.info = paletteInfo(rr.palette);
      });
      setDirty(true);
      renderPalette();
      showSel();
      var extra = [];
      if (res.changed_states) extra.push(res.changed_states + " 種狀態");
      if (res.dropped_tile_entities) extra.push("移除 " + res.dropped_tile_entities + " 個容器內容");
      if (res.dropped_props) extra.push("捨棄 " + res.dropped_props + " 個新方塊沒有的狀態屬性");
      if (res.filled) extra.push(res.filled + " 格");
      msg("已套用" + (extra.length ? "：" + extra.join("、") : "") + "（記得按儲存）", "ok");
      return refreshModels().then(rebuild);
    }).catch(function (e) { msg(String(e.message || e), "bad"); throw e; });
  }

  function applyReplace(to) {
    if (!to) return;
    if (S.range) { replaceInRange(to); return; }
    if (!S.sel) return;
    var v = $("stateSel").value;
    var newId = to.split("[")[0];
    if (newId.indexOf(":") < 0) newId = "minecraft:" + newId;

    var done = function () {
      // 換完之後把選取移到新方塊上，不然選的是一個已經不存在的 ID
      var still = statesOf(newId).length ? newId : null;
      S.sel = still ? { id: still, state: null } : null;
      renderPalette();
      showSel();
      rebuild();
    };

    if (v === "*") {
      doOp({ op: "replace_id", from_id: S.sel.id, to_id: to, keep_props: true }).then(done, function () {});
    } else {
      var parts = v.split(":");
      doOp({
        op: "replace_state",
        region: S.regions[+parts[0]].name,
        index: +parts[1],
        to: to
      }).then(done, function () {});
    }
  }

  // 只動框選範圍裡的方塊：整個範圍填滿，或只換掉其中某一種方塊
  function replaceInRange(to) {
    var rg = S.range, v = $("stateSel").value;
    var only = v.indexOf("id:") === 0 ? v.slice(3) : null;
    doOp({
      op: "fill_box", region: S.regions[rg.ri].name,
      from: rg.lo, to_pos: rg.hi, to: to, only: only
    }, function (res) { patchBox(rg, res.index, only); })
      .then(function () { showSel(); }, function () {});
  }

  function save() {
    if (!S.file) return;
    api("/api/save", { file: S.file }).then(function (res) {
      setDirty(false);
      loadFileList();
      msg("已儲存" + (res.backup ? "，舊檔備份為 " + res.backup : ""), "ok");
    }).catch(function (e) { msg(String(e.message || e), "bad"); });
  }

  function setMode(m) {
    S.mode = m;
    $("modeView").classList.toggle("active", m === "view");
    $("modeEdit").classList.toggle("active", m === "edit");
    $("editHint").classList.toggle("hidden", m !== "edit");
    $("modeHint").classList.toggle("hidden", m === "edit");
    $("brushPanel").classList.toggle("dim", m !== "edit");
  }

  function setY(which, v) {
    v = Math.max(S.yFloor, Math.min(S.yCeil, v));
    if (which === "lo") {
      S.yLo = v;
      if (S.yLo > S.yHi) { S.yHi = S.yLo; $("yMax").value = S.yHi; }
      $("yMin").value = S.yLo;
    } else {
      S.yHi = v;
      if (S.yHi < S.yLo) { S.yLo = S.yHi; $("yMin").value = S.yLo; }
      $("yMax").value = S.yHi;
    }
    rebuild();
  }

  function toggleChk(id) {
    var el = $(id);
    el.checked = !el.checked;
    if (el.onchange) el.onchange();
  }

  function toggleHelp(force) {
    var m = $("helpModal");
    var show = force === undefined ? m.classList.contains("hidden") : force;
    m.classList.toggle("hidden", !show);
  }

  // ------------------------------------------------------------- 鍵盤
  function typing() {
    var ae = document.activeElement;
    if (!ae) return false;
    if (ae.tagName === "TEXTAREA" || ae.tagName === "SELECT") return true;
    return ae.tagName === "INPUT" &&
      /^(text|search|number|email|url|password)$/.test(ae.type);
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); save(); return;
    }
    if (typing()) return;

    if (e.code === "Space" || e.code === "ShiftLeft" || e.code === "ShiftRight" ||
        e.code === "ControlLeft" || e.code === "ControlRight" ||
        e.code === "KeyW" || e.code === "KeyA" || e.code === "KeyS" || e.code === "KeyD") {
      KEYS[e.code] = true;
      if (e.code === "Space") e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.code) {
      case "KeyF": fitCamera(); break;
      case "Digit1": fitCamera(); break;
      case "Digit2": fitCamera("top"); break;
      case "Digit3": fitCamera("side"); break;
      case "KeyX": toggleChk("chkTex"); break;
      case "KeyG": toggleChk("chkGhost"); break;
      case "KeyH": toggleChk("chkOnlySel"); break;
      case "KeyC": toggleChk("chkCull"); break;
      case "KeyB": toggleChk("chkBox"); break;
      case "BracketLeft": setY("hi", S.yHi - 1); break;
      case "BracketRight": setY("hi", S.yHi + 1); break;
      case "Minus": setY("lo", S.yLo - 1); break;
      case "Equal": setY("lo", S.yLo + 1); break;
      case "KeyR": S.yLo = S.yFloor; S.yHi = S.yCeil;
        $("yMin").value = S.yFloor; $("yMax").value = S.yCeil; rebuild(); break;
      case "KeyQ": setMode("view"); break;
      case "KeyE": setMode("edit"); break;
      case "Delete": if (S.sel || S.range) applyReplace("minecraft:air"); break;
      case "Slash": e.preventDefault(); toggleHelp(); break;
      case "Escape":
        if (!$("helpModal").classList.contains("hidden")) toggleHelp(false);
        else if (!$("modal").classList.contains("hidden")) $("modal").classList.add("hidden");
        else clearSel();
        break;
      default: break;
    }
  }

  function onKeyUp(e) { delete KEYS[e.code]; }
  function clearKeys() { KEYS = {}; }

  // ------------------------------------------------------------- 綁定
  function bind() {
    $("btnReloadFiles").onclick = loadFileList;
    $("btnSave").onclick = save;
    $("btnRevert").onclick = function () {
      if (!confirm("放棄所有未儲存的變更，重新從檔案載入？")) return;
      api("/api/revert", { file: S.file }).then(function (doc) {
        adoptDoc(doc).then(function () { msg("已重新載入", "ok"); });
      });
    };

    $("stateSel").onchange = function () {
      if (S.range) { syncNewBlock(); return; }
      if (!S.sel) return;
      var v = this.value;
      S.sel.state = v === "*" ? null
        : { ri: +v.split(":")[0], index: +v.split(":")[1] };
      syncNewBlock();
      renderPalette();
      rebuild();
    };

    $("btnApply").onclick = function () { applyReplace($("newBlock").value.trim()); };
    $("newBlock").onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("btnApply").click(); }
    };
    $("btnAir").onclick = function () { applyReplace("minecraft:air"); };

    $("search").oninput = renderPalette;

    $("yMin").oninput = function () { setY("lo", +this.value); };
    $("yMax").oninput = function () { setY("hi", +this.value); };
    ["chkGhost", "chkOnlySel", "chkCull"].forEach(function (id) {
      $(id).onchange = rebuild;
    });
    $("chkTex").onchange = function () { S.textured = this.checked; rebuild(); };
    $("chkBox").onchange = drawOutline;

    $("btnFit").onclick = function () { fitCamera(); };
    $("btnTop").onclick = function () { fitCamera("top"); };
    $("btnSide").onclick = function () { fitCamera("side"); };

    $("modeView").onclick = function () { setMode("view"); };
    $("modeEdit").onclick = function () { setMode("edit"); };

    $("btnHelp").onclick = function () { toggleHelp(); };
    $("btnCloseHelp").onclick = function () { toggleHelp(false); };
    $("helpModal").onclick = function (e) { if (e.target === this) toggleHelp(false); };

    $("btnBackups").onclick = function () {
      api("/api/backups?f=" + encodeURIComponent(S.file)).then(function (j) {
        var box = $("backupList");
        box.innerHTML = j.backups.length ? "" : '<div class="hint">還沒有備份</div>';
        j.backups.forEach(function (b) {
          var el = document.createElement("div");
          el.className = "item";
          el.innerHTML = '<div class="nm"></div><div class="ct">' +
            new Date(b.mtime * 1000).toLocaleString() + "</div>";
          el.querySelector(".nm").textContent = b.name;
          el.onclick = function () {
            if (!confirm("把 " + b.name + " 還原成目前的檔案？\n（現在的內容會先另存成新備份）")) return;
            api("/api/restore", { file: S.file, backup: b.name }).then(function (doc) {
              adoptDoc(doc);
              $("modal").classList.add("hidden");
              msg("已還原備份", "ok");
            }).catch(function (e) { alert(e.message || e); });
          };
          box.appendChild(el);
        });
        $("modal").classList.remove("hidden");
      });
    };
    $("btnCloseModal").onclick = function () { $("modal").classList.add("hidden"); };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);

    var dl = $("blockList");
    Blocks.SUGGEST.forEach(function (b) {
      var o = document.createElement("option");
      o.value = b;
      o.label = Blocks.nameOf(b);
      dl.appendChild(o);
    });

    window.addEventListener("beforeunload", function (e) {
      if (S.doc && S.doc.dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  // ------------------------------------------------------------- 啟動
  if (!window.THREE) {
    document.body.innerHTML =
      '<div style="padding:40px;font-size:14px">three.js 載不起來。<br>' +
      '請連一次網路後重新啟動 server.py（它會把 three.js 下載到 vendor/ 之後就能離線使用）。</div>';
    return;
  }
  initThree();
  bind();
  setMode("view");
  showSel();

  api("/api/lang").then(function (j) {
    Blocks.setNames(j.blocks);
    S.lang = j.lang;
  }).catch(function () {
    // 沒有語言檔就顯示英文 ID
  }).then(function () {
    return loadFileList();
  }).then(function () {
    if (S.files.length) openFile(S.files[0].name);
  });
})();
