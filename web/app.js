/* Litematic Studio — 前端 */
(function () {
  "use strict";

  var MAX_QUADS = 2200000;
  var TILE = 16;

  var S = {
    root: "", files: [], file: null, doc: null,
    regions: [],          // {name, min, size, palette, idx, info, models, full}
    sel: null,            // {ri, index}
    tab: "states",
    mode: "view",
    textured: true,
    yLo: 0, yHi: 0, yFloor: 0, yCeil: 0,
    hover: null,
    atlas: null, atlasCols: 1, atlasRows: 1, texSlot: {}, texInfo: [],
    jar: null
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

  // ------------------------------------------------------------- three.js
  var renderer, scene, camera, controls, hoverBox, boxGroup;
  var meshes = [];
  var raycaster = new THREE.Raycaster();
  var dummy = new THREE.Object3D();

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

    boxGroup = new THREE.Group();
    scene.add(boxGroup);

    window.addEventListener("resize", onResize);
    renderer.domElement.addEventListener("mousemove", onMove);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("mouseleave", function () {
      hoverBox.visible = false; S.hover = null; updateHud();
    });
    animate();
  }

  function onResize() {
    var host = $("view");
    if (!host.clientWidth) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  }

  function animate() {
    requestAnimationFrame(animate);
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

    $("hdrFile").textContent = doc.file + "  —  " + doc.size.join(" × ") +
      (doc.author ? "  by " + doc.author : "");
    $("info").textContent =
      "尺寸  " + doc.size.join(" × ") + "\n" +
      "體積  " + doc.volume.toLocaleString() + " 格\n" +
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
      (stats.quads ? stats.quads.toLocaleString() + " 面　" : "") +
      "方塊 " + ((stats.blocks || 0) + extra).toLocaleString() +
      (stats.overflow ? "　（已達上限，請縮小 Y 層範圍）" : "");
    $("yLabel").textContent = S.yLo + " … " + S.yHi;
  }

  function buildTextured() {
    var ghostOn = $("chkGhost").checked && !!S.sel;
    var onlySel = $("chkOnlySel").checked && !!S.sel;
    var cull = $("chkCull").checked;
    var counts = { op: 0, cut: 0, tr: 0, ghost: 0 };
    var blocks = 0, overflow = false, totalQuads = 0;

    function each(cb) {
      visitBlocks(function (r, ri, i, j, k, p, wx, wy, wz) {
        var quads = r.models && r.models[p];
        if (!quads || !quads.length) return;          // 沒模型的交給色塊
        var isSel = S.sel && S.sel.ri === ri && S.sel.index === p;
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
    var ghostOn = $("chkGhost").checked && !!S.sel;
    var onlySel = $("chkOnlySel").checked && !!S.sel;
    var cull = $("chkCull").checked;
    var buckets = {};
    var count = 0;

    visitBlocks(function (r, ri, i, j, k, p, wx, wy, wz) {
      if (onlyFallback) {
        var qs = r.models && r.models[p];
        if (qs && qs.length) return;                 // 已經用材質畫過了
      }
      var inf = r.info[p];
      var isSel = S.sel && S.sel.ri === ri && S.sel.index === p;
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
  function onMove(ev) {
    var now = performance.now();
    if (now - moveTick < 40) return;
    moveTick = now;
    var hit = pick(ev);
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
    $("hud").textContent = r.palette[h.p].text + "\n座標 " +
      (r.min[0] + h.i) + ", " + (r.min[1] + h.j) + ", " + (r.min[2] + h.k) +
      (S.regions.length > 1 ? "   區域 " + r.name : "");
  }

  function onClick(ev) {
    var hit = pick(ev);
    if (!hit) return;
    var r = S.regions[hit.ri];
    if (S.mode === "edit") {
      if (ev.shiftKey) {
        $("brush").value = r.palette[hit.p].text;
        msg("筆刷 = " + $("brush").value, "ok");
        return;
      }
      var to = ev.ctrlKey || ev.metaKey ? "minecraft:air" : $("brush").value.trim();
      doOp({ op: "setblock", region: r.name, pos: [hit.i, hit.j, hit.k], to: to },
        function (res) {
          r.idx[hit.i * r.size[1] * r.size[2] + hit.j * r.size[2] + hit.k] = res.index;
        });
      return;
    }
    select(hit.ri, hit.p);
  }

  function select(ri, index) {
    S.sel = { ri: ri, index: index };
    renderPalette();
    showSel();
    rebuild();
  }

  function showSel() {
    var ok = !!S.sel;
    ["newBlock", "btnApply", "btnAir"].forEach(function (id) { $(id).disabled = !ok; });
    if (!ok) {
      $("selInfo").textContent = "先在清單或 3D 畫面中選一個方塊";
      $("newBlock").value = "";
      return;
    }
    var r = S.regions[S.sel.ri];
    var e = r.palette[S.sel.index];
    $("selInfo").textContent = e.text + "\n" + e.count.toLocaleString() + " 格" +
      (S.regions.length > 1 ? "（區域 " + r.name + "）" : "");
    $("newBlock").value = e.text;
  }

  // ------------------------------------------------------------- 清單
  function renderPalette() {
    var box = $("palette");
    var q = $("search").value.trim().toLowerCase();
    box.innerHTML = "";

    if (S.tab === "ids") {
      var agg = {};
      S.regions.forEach(function (r) {
        r.palette.forEach(function (e) {
          if (Blocks.isEmpty(e.id) || !e.count) return;
          agg[e.id] = (agg[e.id] || 0) + e.count;
        });
      });
      Object.keys(agg).map(function (id) { return [id, agg[id]]; })
        .sort(function (a, b) { return b[1] - a[1]; })
        .forEach(function (row) {
          if (q && row[0].indexOf(q) < 0) return;
          var el = document.createElement("div");
          el.className = "item";
          el.innerHTML = '<div class="sw"></div><div class="nm"></div><div class="ct">' +
            row[1].toLocaleString() + "</div>";
          el.querySelector(".sw").style.background = Blocks.colorOf(row[0]);
          el.querySelector(".nm").textContent = row[0].replace("minecraft:", "");
          el.onclick = function () {
            $("newBlock").value = row[0];
            $("chkAllStates").checked = true;
            for (var ri = 0; ri < S.regions.length; ri++) {
              var pi = -1;
              S.regions[ri].palette.forEach(function (e, n) {
                if (pi < 0 && e.id === row[0] && e.count) pi = n;
              });
              if (pi >= 0) { select(ri, pi); break; }
            }
          };
          box.appendChild(el);
        });
      return;
    }

    S.regions.forEach(function (r, ri) {
      var rows = r.palette.map(function (e, i) { return { e: e, i: i }; })
        .filter(function (x) { return x.e.count > 0 && !Blocks.isEmpty(x.e.id); })
        .sort(function (a, b) { return b.e.count - a.e.count; });
      if (S.regions.length > 1) {
        var hdr = document.createElement("div");
        hdr.className = "hint";
        hdr.textContent = "區域 " + r.name;
        box.appendChild(hdr);
      }
      rows.forEach(function (x) {
        if (q && x.e.text.toLowerCase().indexOf(q) < 0) return;
        var el = document.createElement("div");
        var active = S.sel && S.sel.ri === ri && S.sel.index === x.i;
        el.className = "item" + (active ? " active" : "");
        el.innerHTML = '<div class="sw"></div><div class="nm"></div><div class="ct">' +
          x.e.count.toLocaleString() + "</div>";
        el.querySelector(".sw").style.background = r.info[x.i].hex;
        el.querySelector(".nm").textContent = x.e.text.replace("minecraft:", "");
        el.title = x.e.text;
        el.onclick = function () { select(ri, x.i); };
        box.appendChild(el);
      });
    });
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
    if (!S.sel) return;
    var r = S.regions[S.sel.ri];
    var cur = r.palette[S.sel.index];
    if ($("chkAllStates").checked) {
      doOp({ op: "replace_id", from_id: cur.id, to_id: to, keep_props: true });
    } else {
      doOp({ op: "replace_state", region: r.name, index: S.sel.index, to: to });
    }
  }

  function save() {
    if (!S.file) return;
    api("/api/save", { file: S.file }).then(function (res) {
      setDirty(false);
      loadFileList();
      msg("已儲存" + (res.backup ? "，舊檔備份為 " + res.backup : ""), "ok");
    }).catch(function (e) { msg(String(e.message || e), "bad"); });
  }

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

    $("btnApply").onclick = function () {
      var to = $("newBlock").value.trim();
      if (to) applyReplace(to);
    };
    $("newBlock").onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("btnApply").click(); }
    };
    $("btnAir").onclick = function () { applyReplace("minecraft:air"); };

    $("search").oninput = renderPalette;
    $("tabStates").onclick = function () {
      S.tab = "states"; this.classList.add("active");
      $("tabIds").classList.remove("active"); renderPalette();
    };
    $("tabIds").onclick = function () {
      S.tab = "ids"; this.classList.add("active");
      $("tabStates").classList.remove("active"); renderPalette();
    };

    $("yMin").oninput = function () {
      S.yLo = +this.value;
      if (S.yLo > S.yHi) { S.yHi = S.yLo; $("yMax").value = S.yHi; }
      rebuild();
    };
    $("yMax").oninput = function () {
      S.yHi = +this.value;
      if (S.yHi < S.yLo) { S.yLo = S.yHi; $("yMin").value = S.yLo; }
      rebuild();
    };
    ["chkGhost", "chkOnlySel", "chkCull"].forEach(function (id) {
      $(id).onchange = rebuild;
    });
    $("chkTex").onchange = function () { S.textured = this.checked; rebuild(); };
    $("chkBox").onchange = drawOutline;

    $("btnFit").onclick = function () { fitCamera(); };
    $("btnTop").onclick = function () { fitCamera("top"); };
    $("btnSide").onclick = function () { fitCamera("side"); };

    $("modeView").onclick = function () {
      S.mode = "view"; this.classList.add("active");
      $("modeEdit").classList.remove("active"); $("editHint").classList.add("hidden");
    };
    $("modeEdit").onclick = function () {
      S.mode = "edit"; this.classList.add("active");
      $("modeView").classList.remove("active"); $("editHint").classList.remove("hidden");
    };

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

    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault(); save(); return;
      }
      var ae = document.activeElement;
      if (ae && (ae.tagName === "TEXTAREA" ||
          (ae.tagName === "INPUT" && /^(text|search|number|email|url)$/.test(ae.type)))) return;
      if (e.key === "Escape") { S.sel = null; renderPalette(); showSel(); rebuild(); }
      if (e.key === "[") { $("yMax").value = Math.max(S.yFloor, S.yHi - 1); $("yMax").oninput.call($("yMax")); }
      if (e.key === "]") { $("yMax").value = Math.min(S.yCeil, S.yHi + 1); $("yMax").oninput.call($("yMax")); }
    });

    var dl = $("blockList");
    Blocks.SUGGEST.forEach(function (b) {
      var o = document.createElement("option"); o.value = b; dl.appendChild(o);
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
  showSel();
  loadFileList().then(function () {
    if (S.files.length) openFile(S.files[0].name);
  });
})();
