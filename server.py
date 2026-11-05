#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Litematic Studio — 本機 .litematic 預覽 / 編輯伺服器

用法:
    python server.py [schematics 資料夾] [--port 8731] [--no-browser]

預設把上層資料夾 (..) 當作 schematics 資料夾。
所有運算都在本機，不會連外（除了第一次下載 three.js）。
"""

import argparse
import base64
import io
import json
import re
import shutil
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import assets as mcassets

try:
    import numpy as np
    from litemapy import Schematic, Region, BlockState
except ImportError as exc:  # pragma: no cover
    print("缺少套件:", exc)
    print("請先執行:  python -m pip install litemapy")
    sys.exit(1)

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
VENDOR = HERE / "vendor"

VENDOR_FILES = {
    "three.min.js": "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
    "OrbitControls.js": "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
}

BLOCK_RE = re.compile(r"^([a-z0-9_.-]+:)?([a-z0-9_.-]+)(\[(.*)\])?$")

# ---------------------------------------------------------------- 工具函式


def parse_blockstate(text):
    """'minecraft:oak_stairs[facing=east,half=top]' -> BlockState"""
    text = (text or "").strip().lower().replace(" ", "")
    m = BLOCK_RE.match(text)
    if not m:
        raise ValueError("方塊 ID 格式不正確: %r" % text)
    ns = (m.group(1) or "minecraft:")[:-1]
    name = m.group(2)
    props = {}
    if m.group(4):
        for part in m.group(4).split(","):
            if not part:
                continue
            if "=" not in part:
                raise ValueError("方塊狀態格式不正確: %r" % part)
            k, v = part.split("=", 1)
            props[k.strip()] = v.strip()
    return BlockState(ns + ":" + name, **props)


def state_text(state):
    """BlockState -> 'minecraft:stone[facing=north,...]'"""
    return state.to_block_state_identifier()


def region_blocks(region):
    return region._Region__blocks  # numpy uint32, [x][y][z] (store 座標)


def region_palette(region):
    return region._Region__palette  # list[BlockState]


def set_region_palette(region, palette):
    region._Region__palette = palette


def region_min(region):
    """store index 0 對應的 schematic 座標（size 為負時 Position 是最大角）"""
    def lo(origin, size):
        return origin if size > 0 else origin + size + 1
    return [
        lo(region.x, region.width),
        lo(region.y, region.height),
        lo(region.z, region.length),
    ]


def palette_index_of(region, state):
    palette = region_palette(region)
    for i, s in enumerate(palette):
        if s == state:
            return i
    palette.append(state)
    return len(palette) - 1


def drop_tile_entities(region, positions_mask):
    """把 positions_mask 為 True 的格子上的 tile entity 移除（方塊已被換掉）"""
    tes = region.tile_entities
    if not tes:
        return 0
    keep = []
    dropped = 0
    for te in tes:
        try:
            # tile entity 的座標是 region 內的相對座標
            i, j, k = (abs(int(v)) for v in te.position)
        except Exception:
            keep.append(te)
            continue
        try:
            if positions_mask[i, j, k]:
                dropped += 1
                continue
        except IndexError:
            pass
        keep.append(te)
    if dropped:
        region.tile_entities.clear()
        region.tile_entities.extend(keep)
    return dropped


# 「保留狀態」時，哪些屬性可以安全地搬到新方塊上。
# 不認識的目標方塊一律不保留屬性（少帶屬性 Minecraft 會補預設值，帶錯屬性才會壞）。
SUFFIX_PROPS = [
    ("_slab", {"type", "waterlogged"}),
    ("_stairs", {"facing", "half", "shape", "waterlogged"}),
    ("_trapdoor", {"facing", "half", "open", "powered", "waterlogged"}),
    ("_fence_gate", {"facing", "in_wall", "open", "powered"}),
    ("_door", {"facing", "half", "hinge", "open", "powered"}),
    ("_wall_sign", {"facing", "waterlogged"}),
    ("_hanging_sign", {"attached", "rotation", "waterlogged"}),
    ("_sign", {"rotation", "waterlogged"}),
    ("_pressure_plate", {"powered"}),
    ("_button", {"face", "facing", "powered"}),
    ("_fence", {"north", "south", "east", "west", "waterlogged"}),
    ("_wall", {"north", "south", "east", "west", "up", "waterlogged"}),
    ("_pane", {"north", "south", "east", "west", "waterlogged"}),
    ("_bars", {"north", "south", "east", "west", "waterlogged"}),
    ("_bed", {"facing", "occupied", "part"}),
    ("_candle", {"candles", "lit", "waterlogged"}),
    ("_banner", {"rotation"}),
    ("_leaves", {"distance", "persistent", "waterlogged"}),
    ("_shulker_box", {"facing"}),
    ("_glazed_terracotta", {"facing"}),
    ("_rail", {"shape", "waterlogged", "powered"}),
    ("_log", {"axis"}),
    ("_wood", {"axis"}),
    ("_stem", {"axis"}),
    ("_hyphae", {"axis"}),
    ("_pillar", {"axis"}),
    ("_froglight", {"axis"}),
    ("_amethyst_bud", {"facing", "waterlogged"}),
]

_AXIS = {"axis"}
_FACING = {"facing"}
EXACT_PROPS = {
    "observer": {"facing", "powered"},
    "piston": {"facing", "extended"},
    "sticky_piston": {"facing", "extended"},
    "dispenser": {"facing", "triggered"},
    "dropper": {"facing", "triggered"},
    "hopper": {"facing", "enabled"},
    "furnace": {"facing", "lit"},
    "blast_furnace": {"facing", "lit"},
    "smoker": {"facing", "lit"},
    "chest": {"facing", "type", "waterlogged"},
    "trapped_chest": {"facing", "type", "waterlogged"},
    "ender_chest": {"facing", "waterlogged"},
    "barrel": {"facing", "open"},
    "repeater": {"facing", "delay", "locked", "powered"},
    "comparator": {"facing", "mode", "powered"},
    "redstone_wire": {"north", "south", "east", "west", "power"},
    "redstone_lamp": {"lit"},
    "redstone_torch": {"lit"},
    "wall_torch": _FACING,
    "redstone_wall_torch": {"facing", "lit"},
    "soul_wall_torch": _FACING,
    "lever": {"face", "facing", "powered"},
    "tripwire_hook": {"attached", "facing", "powered"},
    "target": {"power"},
    "daylight_detector": {"inverted", "power"},
    "note_block": {"instrument", "note", "powered"},
    "jukebox": {"has_record"},
    "lectern": {"facing", "has_book", "powered"},
    "campfire": {"facing", "lit", "signal_fire", "waterlogged"},
    "soul_campfire": {"facing", "lit", "signal_fire", "waterlogged"},
    "lantern": {"hanging", "waterlogged"},
    "soul_lantern": {"hanging", "waterlogged"},
    "ladder": {"facing", "waterlogged"},
    "vine": {"north", "south", "east", "west", "up"},
    "scaffolding": {"bottom", "distance", "waterlogged"},
    "iron_bars": {"north", "south", "east", "west", "waterlogged"},
    "chain": {"axis", "waterlogged"},
    "end_rod": _FACING,
    "lightning_rod": {"facing", "powered", "waterlogged"},
    "anvil": _FACING,
    "chipped_anvil": _FACING,
    "damaged_anvil": _FACING,
    "loom": _FACING,
    "stonecutter": {"facing"},
    "grindstone": {"face", "facing"},
    "smithing_table": set(),
    "water": {"level"},
    "lava": {"level"},
    "snow": {"layers"},
    "tnt": {"unstable"},
    "basalt": _AXIS,
    "polished_basalt": _AXIS,
    "bone_block": _AXIS,
    "hay_block": _AXIS,
    "muddy_mangrove_roots": _AXIS,
    "deepslate": _AXIS,
    "purpur_pillar": _AXIS,
    "quartz_pillar": _AXIS,
    "nether_portal": _AXIS,
    "beehive": {"facing", "honey_level"},
    "bee_nest": {"facing", "honey_level"},
    "composter": {"level"},
    "cauldron": set(),
    "water_cauldron": {"level"},
    "sculk_sensor": {"power", "sculk_sensor_phase", "waterlogged"},
    "sculk_shrieker": {"can_summon", "shrieking", "waterlogged"},
    "respawn_anchor": {"charges"},
    "big_dripleaf": {"facing", "tilt", "waterlogged"},
    "cake": {"bites"},
    "farmland": {"moisture"},
    "crafter": {"crafting", "orientation", "triggered"},
}


def allowed_props_for(block_id):
    """回傳 None 代表不認識這個方塊（保守起見不保留任何屬性）"""
    short = block_id.split(":")[-1]
    if short in EXACT_PROPS:
        return EXACT_PROPS[short]
    for sfx, props in SUFFIX_PROPS:
        if short.endswith(sfx):
            return props
    return None


def carry_props(source_state, target_id):
    """把來源方塊的屬性搬到新方塊上，只留目標方塊真的有的屬性"""
    allowed = allowed_props_for(target_id)
    src = dict(source_state.properties())
    if not src:
        return {}, 0
    if allowed is None:
        return {}, len(src)
    kept = {k: v for k, v in src.items() if k in allowed}
    return kept, len(src) - len(kept)


# ---------------------------------------------------------------- 狀態管理


class Doc:
    """一個載入在記憶體中的 schematic"""

    def __init__(self, path):
        self.path = path
        self.schem = Schematic.load(str(path))
        self.dirty = False
        self.mtime = path.stat().st_mtime

    def regions(self):
        return list(self.schem.regions.items())

    def region(self, name):
        return self.schem.regions[name]

    def counts(self, region):
        blocks = region_blocks(region)
        n = len(region_palette(region))
        return np.bincount(blocks.ravel(), minlength=n)[:n].tolist()

    def palette_json(self, region):
        counts = self.counts(region)
        return [
            {"text": state_text(s), "id": s.id, "count": int(c)}
            for s, c in zip(region_palette(region), counts)
        ]

    def to_json(self, with_data=True):
        regions = []
        total = 0
        for name, reg in self.regions():
            blocks = region_blocks(reg)
            pal = region_palette(reg)
            entry = {
                "name": name,
                "min": region_min(reg),
                "size": [abs(reg.width), abs(reg.height), abs(reg.length)],
                "palette": self.palette_json(reg),
                "tileEntities": len(reg.tile_entities),
                "entities": len(reg.entities),
            }
            if with_data:
                dtype = np.uint16 if len(pal) <= 65535 else np.uint32
                arr = np.ascontiguousarray(blocks.astype(dtype))
                entry["dtype"] = "u2" if dtype is np.uint16 else "u4"
                entry["data"] = base64.b64encode(arr.tobytes()).decode("ascii")
            regions.append(entry)
            total += int(blocks.size)
        meta = self.schem
        return {
            "file": self.path.name,
            "name": getattr(meta, "name", "") or self.path.stem,
            "author": getattr(meta, "author", "") or "",
            "description": getattr(meta, "description", "") or "",
            "size": [meta.width, meta.height, meta.length],
            "volume": total,
            "dirty": self.dirty,
            "regions": regions,
        }


ASSETS = {"obj": None, "jar": None, "error": None, "names": {}, "lang": None}


def bake_doc(doc, have=None):
    """把這份 schematic 用到的每個 blockstate 烘焙成 quad，順便帶上需要的材質"""
    a = ASSETS["obj"]
    if a is None:
        return {"ok": False, "error": ASSETS["error"] or "沒有載入材質", "jar": None}
    have = set(have or [])
    tex_index = {}
    regions = []
    for name, reg in doc.regions():
        models = []
        for state in region_palette(reg):
            text = state_text(state)
            try:
                models.append(a.bake(text, tex_index))
            except Exception:
                traceback.print_exc()
                models.append(None)
        regions.append({"name": name, "models": models})

    textures = []
    for tname, _ in sorted(tex_index.items(), key=lambda kv: kv[1]):
        if tname in have:
            textures.append({"n": tname, "cached": True})
            continue
        raw = a.texture_bytes(tname)
        textures.append({
            "n": tname,
            "d": base64.b64encode(raw).decode("ascii") if raw else None,
        })
    return {"ok": True, "jar": str(ASSETS["jar"]), "textures": textures, "regions": regions}


class Store:
    def __init__(self, root):
        self.root = root
        self.docs = {}
        self.lock = threading.Lock()

    def path_for(self, filename):
        name = Path(unquote(filename)).name
        if not name.lower().endswith(".litematic"):
            raise ValueError("只接受 .litematic 檔案")
        p = (self.root / name).resolve()
        if p.parent != self.root.resolve():
            raise ValueError("路徑超出資料夾範圍")
        return p

    def get(self, filename, reload=False):
        p = self.path_for(filename)
        with self.lock:
            doc = self.docs.get(p.name)
            if doc is None or reload:
                doc = Doc(p)
                self.docs[p.name] = doc
            return doc

    def forget(self, filename):
        with self.lock:
            self.docs.pop(self.path_for(filename).name, None)

    def list_files(self):
        out = []
        for p in sorted(self.root.glob("*.litematic")):
            st = p.stat()
            doc = self.docs.get(p.name)
            out.append(
                {
                    "name": p.name,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "dirty": bool(doc and doc.dirty),
                }
            )
        return out


# ---------------------------------------------------------------- 編輯操作


def op_replace_state(doc, body):
    """把某個 region 的 palette 第 index 項整個換成另一個 blockstate"""
    region = doc.region(body["region"])
    index = int(body["index"])
    new_state = parse_blockstate(body["to"])
    pal = region_palette(region)
    if not (0 <= index < len(pal)):
        raise ValueError("palette index 超出範圍")
    old_state = pal[index]
    blocks = region_blocks(region)
    dropped = 0
    if old_state.id != new_state.id and region.tile_entities:
        dropped = drop_tile_entities(region, blocks == index)
    if index == 0:
        # index 0 必須是空氣，改用 append 的方式
        pal.append(new_state)
        blocks[blocks == 0] = len(pal) - 1
    else:
        pal[index] = new_state
    doc.dirty = True
    return {"dropped_tile_entities": dropped}


def op_replace_id(doc, body):
    """跨所有 region，把所有 ID 相同的 blockstate 換成新 ID（可保留狀態）"""
    from_id = parse_blockstate(body["from_id"]).id
    target = parse_blockstate(body["to_id"])
    keep_props = bool(body.get("keep_props", True))
    changed = 0
    dropped = 0
    dropped_props = 0
    for _, region in doc.regions():
        pal = region_palette(region)
        blocks = region_blocks(region)
        for i, s in enumerate(list(pal)):
            if s.id != from_id:
                continue
            if keep_props and not dict(target.properties()):
                kept, lost = carry_props(s, target.id)
                dropped_props += lost
                new_state = BlockState(target.id, **kept) if kept else target
            else:
                new_state = target
            if region.tile_entities:
                dropped += drop_tile_entities(region, blocks == i)
            if i == 0:
                pal.append(new_state)
                blocks[blocks == 0] = len(pal) - 1
            else:
                pal[i] = new_state
            changed += 1
    if not changed:
        raise ValueError("找不到 %s" % from_id)
    doc.dirty = True
    return {
        "changed_states": changed,
        "dropped_tile_entities": dropped,
        "dropped_props": dropped_props,
    }


def op_setblock(doc, body):
    """用 store 座標直接寫單一格"""
    region = doc.region(body["region"])
    i, j, k = (int(v) for v in body["pos"])
    blocks = region_blocks(region)
    if not (0 <= i < blocks.shape[0] and 0 <= j < blocks.shape[1] and 0 <= k < blocks.shape[2]):
        raise ValueError("座標超出範圍")
    new_state = parse_blockstate(body["to"])
    idx = palette_index_of(region, new_state)
    old_idx = int(blocks[i, j, k])
    if region.tile_entities and region_palette(region)[old_idx].id != new_state.id:
        mask = np.zeros(blocks.shape, dtype=bool)
        mask[i, j, k] = True
        drop_tile_entities(region, mask)
    blocks[i, j, k] = idx
    doc.dirty = True
    return {"index": int(idx)}


def op_fill_box(doc, body):
    """用 store 座標填一個長方體。only 可以限定只換掉其中某個 ID 或某個狀態"""
    region = doc.region(body["region"])
    blocks = region_blocks(region)
    a = [int(v) for v in body["from"]]
    b = [int(v) for v in body["to_pos"]]
    lo = [max(0, min(a[n], b[n])) for n in range(3)]
    hi = [min(blocks.shape[n] - 1, max(a[n], b[n])) for n in range(3)]
    if any(hi[n] < lo[n] for n in range(3)):
        raise ValueError("範圍不在這個區域裡")
    new_state = parse_blockstate(body["to"])
    idx = palette_index_of(region, new_state)
    sub = (slice(lo[0], hi[0] + 1), slice(lo[1], hi[1] + 1), slice(lo[2], hi[2] + 1))

    mask = np.zeros(blocks.shape, dtype=bool)
    only = body.get("only")
    if only not in (None, "", "*"):
        # 有中括號就是指定到某一個狀態，沒有就是這個 ID 的全部狀態
        exact = "[" in only
        want_id = parse_blockstate(only).id
        hits = []
        for n, st in enumerate(region_palette(region)):
            if (state_text(st) == only) if exact else (st.id == want_id):
                hits.append(n)
        if not hits:
            raise ValueError("找不到要被取代的方塊: %s" % only)
        mask[sub] = np.isin(blocks[sub], hits)
    else:
        mask[sub] = True
    mask &= blocks != idx            # 已經是目標方塊的格子不必動
    count = int(mask.sum())

    dropped = 0
    if count and region.tile_entities:
        dropped = drop_tile_entities(region, mask)
    blocks[mask] = idx
    doc.dirty = True
    return {"index": int(idx), "filled": count, "dropped_tile_entities": dropped}


OPS = {
    "replace_state": op_replace_state,
    "replace_id": op_replace_id,
    "setblock": op_setblock,
    "fill_box": op_fill_box,
}


def save_doc(doc, make_backup=True):
    backup = None
    if make_backup and doc.path.exists():
        bdir = HERE / "backups"
        bdir.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = bdir / ("%s.%s.litematic" % (doc.path.stem, stamp))
        shutil.copy2(doc.path, backup)
    tmp = doc.path.with_suffix(".litematic.tmp")
    doc.schem.save(str(tmp))
    tmp.replace(doc.path)
    doc.dirty = False
    doc.mtime = doc.path.stat().st_mtime
    return backup.name if backup else None


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "LitematicStudio/1.0"
    store = None

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    # -- helpers
    def send_json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, path):
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(path.suffix.lower(), "application/octet-stream")
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # -- routes
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                return self.send_file(WEB / "index.html")
            if u.path.startswith("/web/"):
                return self.send_file(WEB / u.path[5:])
            if u.path.startswith("/vendor/"):
                return self.send_file(VENDOR / u.path[8:])
            if u.path == "/api/files":
                return self.send_json({"root": str(self.store.root), "files": self.store.list_files()})
            if u.path == "/api/schem":
                doc = self.store.get(q["f"][0], reload=q.get("reload", ["0"])[0] == "1")
                return self.send_json(doc.to_json())
            if u.path == "/api/lang":
                return self.send_json({
                    "lang": ASSETS["lang"],
                    "blocks": ASSETS["names"],
                })
            if u.path == "/api/assets":
                return self.send_json({
                    "ok": ASSETS["obj"] is not None,
                    "jar": str(ASSETS["jar"]) if ASSETS["jar"] else None,
                    "error": ASSETS["error"],
                })
            if u.path == "/api/backups":
                bdir = HERE / "backups"
                stem = Path(q["f"][0]).stem
                items = []
                if bdir.exists():
                    for p in sorted(bdir.glob(stem + ".*.litematic"), reverse=True):
                        items.append({"name": p.name, "mtime": p.stat().st_mtime, "size": p.stat().st_size})
                return self.send_json({"backups": items})
            self.send_error(404)
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": str(exc)}, 400)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self.read_body()
            if u.path == "/api/op":
                doc = self.store.get(body["file"])
                fn = OPS.get(body.get("op"))
                if fn is None:
                    raise ValueError("未知的操作: %s" % body.get("op"))
                result = fn(doc, body)
                result.update(
                    {
                        "ok": True,
                        "dirty": doc.dirty,
                        "regions": [
                            {"name": n, "palette": doc.palette_json(r)} for n, r in doc.regions()
                        ],
                    }
                )
                return self.send_json(result)
            if u.path == "/api/bake":
                doc = self.store.get(body["file"])
                return self.send_json(bake_doc(doc, body.get("have")))
            if u.path == "/api/save":
                doc = self.store.get(body["file"])
                backup = save_doc(doc, make_backup=body.get("backup", True))
                return self.send_json({"ok": True, "backup": backup, "dirty": False})
            if u.path == "/api/save_as":
                doc = self.store.get(body["file"])
                target = self.store.path_for(body["as"])
                doc.schem.save(str(target))
                return self.send_json({"ok": True, "file": target.name})
            if u.path == "/api/revert":
                doc = self.store.get(body["file"], reload=True)
                return self.send_json(doc.to_json())
            if u.path == "/api/restore":
                src = (HERE / "backups" / Path(body["backup"]).name).resolve()
                if src.parent != (HERE / "backups").resolve() or not src.exists():
                    raise ValueError("備份不存在")
                dst = self.store.path_for(body["file"])
                save_doc(self.store.get(body["file"]), make_backup=True)
                shutil.copy2(src, dst)
                doc = self.store.get(body["file"], reload=True)
                return self.send_json(doc.to_json())
            self.send_error(404)
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": str(exc)}, 400)


# ---------------------------------------------------------------- 啟動


def ensure_vendor():
    VENDOR.mkdir(exist_ok=True)
    import urllib.request

    for name, url in VENDOR_FILES.items():
        p = VENDOR / name
        if p.exists() and p.stat().st_size > 1000:
            continue
        try:
            print("下載 %s ..." % name)
            with urllib.request.urlopen(url, timeout=30) as r:
                p.write_bytes(r.read())
        except Exception as exc:
            print("  下載失敗 (%s)，網頁會改從 CDN 載入" % exc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=str(HERE.parent), help="schematics 資料夾")
    ap.add_argument("--port", type=int, default=8731)
    ap.add_argument("--jar", default=None, help="Minecraft 客戶端 jar（預設自動搜尋）")
    ap.add_argument("--no-textures", action="store_true", help="不載入材質，只用色塊")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print("資料夾不存在:", root)
        sys.exit(1)

    ensure_vendor()

    if not args.no_textures:
        jar = Path(args.jar) if args.jar else mcassets.find_client_jar(root)
        if jar and Path(jar).exists():
            try:
                ASSETS["obj"] = mcassets.Assets(jar)
                ASSETS["jar"] = jar
                print("材質   :", jar)
                names, lang, src = mcassets.load_block_names(jar, ASSETS["obj"].zip)
                ASSETS["names"] = names
                ASSETS["lang"] = lang
                if names:
                    print("方塊名 : %s（%d 筆）" % (lang, len(names)))
                else:
                    print("方塊名 : 找不到中文語言檔，清單會顯示英文 ID")
            except Exception as exc:
                ASSETS["error"] = "jar 讀取失敗: %s" % exc
                print("[!]", ASSETS["error"])
        else:
            ASSETS["error"] = "找不到 Minecraft 客戶端 jar，請用 --jar 指定"
            print("[!]", ASSETS["error"])

    Handler.store = Store(root)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = "http://127.0.0.1:%d/" % args.port
    print("=" * 52)
    print(" Litematic Studio")
    print(" 資料夾 :", root)
    print(" 網址   :", url)
    print(" 按 Ctrl+C 結束")
    print("=" * 52)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n再見。")


if __name__ == "__main__":
    main()
