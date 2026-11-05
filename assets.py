# -*- coding: utf-8 -*-
"""
從 Minecraft 客戶端 jar 讀出 blockstates / models / textures，
把一個 blockstate 烘焙成一包四邊形（quad），給前端直接畫。

座標：模型內部是 0..16，輸出時換算成 0..1 的方塊區域座標。
"""

import json
import math
import re
import zipfile
from pathlib import Path

# 方向向量
DIR_VEC = {
    "down": (0, -1, 0), "up": (0, 1, 0),
    "north": (0, 0, -1), "south": (0, 0, 1),
    "west": (-1, 0, 0), "east": (1, 0, 0),
}
# Minecraft 固定的面明暗
SHADE = {"up": 1.0, "down": 0.5, "north": 0.8, "south": 0.8, "west": 0.6, "east": 0.6}

# 本來就看不見的方塊
INVISIBLE = {
    "air", "cave_air", "void_air", "structure_void", "light", "barrier",
    "moving_piston", "nether_portal_block",
}

STATE_RE = re.compile(r"^([a-z0-9_.-]+:)?([a-z0-9_.-]+)(?:\[(.*)\])?$")


def split_state(text):
    m = STATE_RE.match(text.strip())
    if not m:
        return None, {}
    name = m.group(2)
    props = {}
    if m.group(3):
        for part in m.group(3).split(","):
            if "=" in part:
                k, v = part.split("=", 1)
                props[k] = v
    return name, props


# ----------------------------------------------------------------- 幾何

def face_corners(d, x1, y1, z1, x2, y2, z2):
    """回傳對應 (u1,v1) (u1,v2) (u2,v2) (u2,v1) 的四個角"""
    if d == "up":
        return [(x1, y2, z1), (x1, y2, z2), (x2, y2, z2), (x2, y2, z1)]
    if d == "down":
        return [(x1, y1, z2), (x1, y1, z1), (x2, y1, z1), (x2, y1, z2)]
    if d == "north":
        return [(x2, y2, z1), (x2, y1, z1), (x1, y1, z1), (x1, y2, z1)]
    if d == "south":
        return [(x1, y2, z2), (x1, y1, z2), (x2, y1, z2), (x2, y2, z2)]
    if d == "west":
        return [(x1, y2, z1), (x1, y1, z1), (x1, y1, z2), (x1, y2, z2)]
    # east
    return [(x2, y2, z2), (x2, y1, z2), (x2, y1, z1), (x2, y2, z1)]


def default_uv(d, x1, y1, z1, x2, y2, z2):
    if d == "up":
        return [x1, z1, x2, z2]
    if d == "down":
        return [x1, 16 - z2, x2, 16 - z1]
    if d == "north":
        return [16 - x2, 16 - y2, 16 - x1, 16 - y1]
    if d == "south":
        return [x1, 16 - y2, x2, 16 - y1]
    if d == "west":
        return [z1, 16 - y2, z2, 16 - y1]
    return [16 - z2, 16 - y2, 16 - z1, 16 - y1]  # east


def rot_x(p, t):
    c, s = math.cos(t), math.sin(t)
    return (p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c)


def rot_y(p, t):
    c, s = math.cos(t), math.sin(t)
    return (p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c)


def rot_z(p, t):
    c, s = math.cos(t), math.sin(t)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2])


ROT = {"x": rot_x, "y": rot_y, "z": rot_z}


def apply_rotation(p, origin, axis, angle, rescale):
    t = math.radians(angle)
    q = (p[0] - origin[0], p[1] - origin[1], p[2] - origin[2])
    q = ROT[axis](q, t)
    if rescale and angle:
        f = 1.0 / math.cos(t)
        if axis == "x":
            q = (q[0], q[1] * f, q[2] * f)
        elif axis == "y":
            q = (q[0] * f, q[1], q[2] * f)
        else:
            q = (q[0] * f, q[1] * f, q[2])
    return (q[0] + origin[0], q[1] + origin[1], q[2] + origin[2])


def variant_rotate(p, rx, ry):
    """blockstate 的 x / y 旋轉，繞方塊中心 (8,8,8)"""
    q = (p[0] - 8.0, p[1] - 8.0, p[2] - 8.0)
    if rx:
        q = rot_x(q, math.radians(-rx))
    if ry:
        q = rot_y(q, math.radians(-ry))
    return (q[0] + 8.0, q[1] + 8.0, q[2] + 8.0)


def rotate_dir(d, rx, ry):
    v = DIR_VEC[d]
    if rx:
        v = rot_x(v, math.radians(-rx))
    if ry:
        v = rot_y(v, math.radians(-ry))
    best, bestdot = d, -9
    for name, w in DIR_VEC.items():
        dot = v[0] * w[0] + v[1] * w[1] + v[2] * w[2]
        if dot > bestdot:
            bestdot, best = dot, name
    return best


# ----------------------------------------------------------------- 資源

class Assets:
    def __init__(self, jar_path):
        self.path = Path(jar_path)
        self.zip = zipfile.ZipFile(str(self.path))
        self._names = set(self.zip.namelist())
        self._model_cache = {}
        self._bs_cache = {}
        self._tex_cache = {}

    # -- 低階讀取
    def _read_json(self, rel):
        full = "assets/minecraft/" + rel
        if full not in self._names:
            return None
        try:
            return json.loads(self.zip.read(full).decode("utf-8"))
        except Exception:
            return None

    def texture_bytes(self, name):
        """name 形如 'block/stone' 或 'minecraft:block/stone'"""
        n = name.split(":")[-1]
        if n in self._tex_cache:
            return self._tex_cache[n]
        full = "assets/minecraft/textures/" + n + ".png"
        data = self.zip.read(full) if full in self._names else None
        self._tex_cache[n] = data
        return data

    def has_texture(self, name):
        n = name.split(":")[-1]
        return ("assets/minecraft/textures/" + n + ".png") in self._names

    def blockstate(self, name):
        if name not in self._bs_cache:
            self._bs_cache[name] = self._read_json("blockstates/%s.json" % name)
        return self._bs_cache[name]

    def model(self, ref):
        """讀出並合併 parent 繼承鏈"""
        ref = ref.split(":")[-1]
        if ref in self._model_cache:
            return self._model_cache[ref]
        raw = self._read_json("models/%s.json" % ref)
        if raw is None:
            self._model_cache[ref] = None
            return None
        textures = dict(raw.get("textures", {}))
        elements = raw.get("elements")
        parent = raw.get("parent")
        depth = 0
        while parent and depth < 12:
            depth += 1
            pm = self._read_json("models/%s.json" % parent.split(":")[-1])
            if pm is None:
                break
            for k, v in pm.get("textures", {}).items():
                textures.setdefault(k, v)
            if elements is None:
                elements = pm.get("elements")
            parent = pm.get("parent")
        out = {"textures": textures, "elements": elements or []}
        self._model_cache[ref] = out
        return out

    # -- blockstate -> 要套用的模型清單
    def variants_for(self, name, props):
        bs = self.blockstate(name)
        if bs is None:
            return None
        out = []
        if "variants" in bs:
            chosen = None
            for key, val in bs["variants"].items():
                if self._key_matches(key, props):
                    chosen = val
                    break
            if chosen is None:
                chosen = bs["variants"].get("")
            if chosen is None:
                return []
            if isinstance(chosen, list):
                chosen = chosen[0]
            out.append(chosen)
        elif "multipart" in bs:
            for part in bs["multipart"]:
                if "when" not in part or self._when_matches(part["when"], props):
                    ap = part["apply"]
                    out.append(ap[0] if isinstance(ap, list) else ap)
        return out

    @staticmethod
    def _key_matches(key, props):
        if key == "":
            return True
        for cond in key.split(","):
            if "=" not in cond:
                return False
            k, v = cond.split("=", 1)
            if props.get(k) != v:
                return False
        return True

    def _when_matches(self, when, props):
        if "OR" in when:
            return any(self._when_matches(w, props) for w in when["OR"])
        if "AND" in when:
            return all(self._when_matches(w, props) for w in when["AND"])
        for k, v in when.items():
            have = props.get(k)
            if have is None:
                return False
            if str(have) not in str(v).split("|"):
                return False
        return True

    # -- 烘焙
    def bake(self, state_text, tex_index):
        """
        回傳 quad 清單；tex_index 是 {材質名: 索引} 的 dict，會就地長大。
        認不得的方塊回傳 None，讓前端退回純色方塊。
        """
        name, props = split_state(state_text)
        if name is None or name in INVISIBLE:
            return []

        if name in ("water", "flowing_water", "lava", "flowing_lava"):
            return self._fluid(name, props, tex_index)

        variants = self.variants_for(name, props)
        if variants is None:
            return None

        quads = []
        for var in variants:
            model = self.model(var.get("model", ""))
            if not model or not model["elements"]:
                continue
            rx = int(var.get("x", 0)) % 360
            ry = int(var.get("y", 0)) % 360
            quads.extend(self._bake_model(model, rx, ry, tex_index))
        # 方塊實體（箱子、告示牌、床…）在資源包裡沒有 elements，交給前端畫近似色塊
        return quads if quads else None

    def _resolve_tex(self, textures, ref):
        """回傳 (材質名, force_translucent)；26.3 的值可能是 {"sprite":..., ...} 物件"""
        forced = False
        seen = 0
        while seen < 12:
            seen += 1
            if isinstance(ref, dict):
                forced = forced or bool(ref.get("force_translucent"))
                ref = ref.get("sprite")
                continue
            if isinstance(ref, str) and ref.startswith("#"):
                ref = textures.get(ref[1:])
                continue
            break
        if not isinstance(ref, str):
            return None, forced
        return ref.split(":")[-1], forced

    def _bake_model(self, model, rx, ry, tex_index):
        out = []
        textures = model["textures"]
        for el in model["elements"]:
            try:
                x1, y1, z1 = [float(v) for v in el["from"]]
                x2, y2, z2 = [float(v) for v in el["to"]]
            except Exception:
                continue
            erot = el.get("rotation")
            for d, face in (el.get("faces") or {}).items():
                if d not in DIR_VEC:
                    continue
                tex, forced = self._resolve_tex(textures, face.get("texture"))
                if not tex or not self.has_texture(tex):
                    continue
                uv = face.get("uv") or default_uv(d, x1, y1, z1, x2, y2, z2)
                pts = face_corners(d, x1, y1, z1, x2, y2, z2)
                uvs = [(uv[0], uv[1]), (uv[0], uv[3]), (uv[2], uv[3]), (uv[2], uv[1])]
                frot = int(face.get("rotation", 0)) % 360
                if frot:
                    n = frot // 90
                    uvs = uvs[n:] + uvs[:n]

                if erot:
                    org = [float(v) for v in erot.get("origin", [8, 8, 8])]
                    ax = erot.get("axis", "y")
                    ang = float(erot.get("angle", 0))
                    resc = bool(erot.get("rescale", False))
                    pts = [apply_rotation(p, org, ax, ang, resc) for p in pts]
                if rx or ry:
                    pts = [variant_rotate(p, rx, ry) for p in pts]

                final_dir = el.get("shade_direction_override") or rotate_dir(d, rx, ry)
                if final_dir not in SHADE:
                    final_dir = rotate_dir(d, rx, ry)
                cull = face.get("cullface")
                if cull in DIR_VEC:
                    cull = rotate_dir(cull, rx, ry)
                else:
                    cull = None

                if tex not in tex_index:
                    tex_index[tex] = len(tex_index)

                flat = []
                for p in pts:
                    flat += [round(p[0] / 16.0, 5), round(p[1] / 16.0, 5), round(p[2] / 16.0, 5)]
                flatuv = []
                for u, v in uvs:
                    flatuv += [round(u / 16.0, 5), round(v / 16.0, 5)]

                q = {
                    "p": flat, "u": flatuv, "t": tex_index[tex],
                    "s": SHADE[final_dir],
                    "c": int(face.get("tintindex", -1)),
                    "cf": cull,
                }
                if forced:
                    q["tr"] = 1
                out.append(q)
        return out

    def _fluid(self, name, props, tex_index):
        still = "block/water_still" if "water" in name else "block/lava_still"
        if not self.has_texture(still):
            return None
        level = int(props.get("level", "0") or 0)
        h = 16.0 if level in (0, 8) else max(2.0, 16.0 - (level * 14.0 / 8.0))
        tex_index.setdefault(still, len(tex_index))
        ti = tex_index[still]
        full = h >= 16.0
        water = "water" in name
        tint = 0 if "water" in name else -1
        out = []
        for d in DIR_VEC:
            y2 = h
            pts = face_corners(d, 0.0, 0.0, 0.0, 16.0, y2, 16.0)
            uv = default_uv(d, 0.0, 0.0, 0.0, 16.0, y2, 16.0)
            uvs = [(uv[0], uv[1]), (uv[0], uv[3]), (uv[2], uv[3]), (uv[2], uv[1])]
            flat = []
            for p in pts:
                flat += [round(p[0] / 16.0, 5), round(p[1] / 16.0, 5), round(p[2] / 16.0, 5)]
            flatuv = []
            for u, v in uvs:
                flatuv += [round(u / 16.0, 5), round(v / 16.0, 5)]
            q = {
                "p": flat, "u": flatuv, "t": ti, "s": SHADE[d], "c": tint,
                "cf": d if (full or d == "down") else None,
            }
            if water:
                q["tr"] = 1
            out.append(q)
        return out



# ----------------------------------------------------------------- 語言檔

LANG_PREFER = ("zh_tw", "zh_hk", "zh_cn")


def _find_assets_root(start):
    """往上找啟動器的 assets 資料夾（裡面要有 indexes/）"""
    start = Path(start).resolve()
    for up in [start] + list(start.parents)[:7]:
        cand = up / "assets"
        if (cand / "indexes").is_dir():
            return cand
        if (up / "indexes").is_dir() and (up / "objects").is_dir():
            return up
    return None


def _index_id_for_jar(jar_path):
    """從 versions/<ver>/<ver>.json 讀出 assetIndex 的 id"""
    jar = Path(jar_path)
    vj = jar.with_suffix(".json")
    if not vj.exists():
        return None
    try:
        d = json.loads(vj.read_text(encoding="utf-8"))
    except Exception:
        return None
    ai = d.get("assetIndex") or {}
    return str(ai.get("id") or d.get("assets") or "") or None


def load_block_names(jar_path, zip_obj=None, prefer=LANG_PREFER):
    """
    讀出中文方塊名。回傳 (names, lang, source)：
    names 是 {方塊短 id: 譯名}，找不到時是 {}。

    原版 jar 裡只有 en_us，其他語言放在啟動器的 assets/objects 內容定址儲存區，
    要透過 assets/indexes/<id>.json 查雜湊才找得到。
    """
    # 1) jar 內（資源包或某些整合包會直接塞進去）
    if zip_obj is not None:
        for lang in prefer:
            name = "assets/minecraft/lang/%s.json" % lang
            try:
                raw = zip_obj.read(name)
            except KeyError:
                continue
            try:
                return _blocks_from_lang(json.loads(raw.decode("utf-8"))), lang, "jar"
            except Exception:
                pass

    # 2) 啟動器的 assets 儲存區
    root = _find_assets_root(Path(jar_path).parent)
    if root is None:
        return {}, None, None

    wanted = _index_id_for_jar(jar_path)
    indexes = sorted((root / "indexes").glob("*.json"))
    if wanted:
        indexes.sort(key=lambda p: (p.stem != wanted,))

    for ip in indexes:
        try:
            objects = json.loads(ip.read_text(encoding="utf-8")).get("objects", {})
        except Exception:
            continue
        for lang in prefer:
            entry = objects.get("minecraft/lang/%s.json" % lang)
            if not entry:
                continue
            h = entry.get("hash", "")
            blob = root / "objects" / h[:2] / h
            if not blob.exists():
                continue
            try:
                data = json.loads(blob.read_text(encoding="utf-8"))
            except Exception:
                continue
            return _blocks_from_lang(data), lang, str(ip)
    return {}, None, None


def _blocks_from_lang(data):
    pre = "block.minecraft."
    out = {}
    for k, v in data.items():
        if k.startswith(pre) and isinstance(v, str):
            short = k[len(pre):]
            if "." not in short:          # 跳過 block.minecraft.x.y 這類子鍵
                out[short] = v
    return out

# ----------------------------------------------------------------- jar 搜尋

def find_client_jar(start_dir):
    """從 schematics 資料夾往上找 versions/<ver>/<ver>.jar

    同一個啟動器下常常裝了好幾個版本，所以優先挑版本名有出現在路徑裡的那個
    （例如實例資料夾名稱含有 "1.21.4" 就會挑 versions/1.21.4），
    挑不出來才退而求其次用最大的 jar。
    """
    start = Path(start_dir).resolve()
    hint = str(start).lower()
    cands = []
    for up in [start] + list(start.parents)[:6]:
        vdir = up / "versions"
        if not vdir.is_dir():
            continue
        for sub in vdir.iterdir():
            if not sub.is_dir():
                continue
            for jar in sub.glob("*.jar"):
                if "natives" in jar.name.lower():
                    continue
                try:
                    size = jar.stat().st_size
                except OSError:
                    continue
                if size < 2_000_000:      # 太小的不會是客戶端
                    continue
                named = sub.name.lower() in hint or jar.stem.lower() in hint
                cands.append((1 if named else 0, size, str(jar)))
        if cands:
            break
    if not cands:
        return None
    cands.sort(reverse=True)
    return Path(cands[0][2])
