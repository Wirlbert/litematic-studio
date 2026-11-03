// 方塊顏色與外形推測表（沒有材質，用顏色近似，夠辨識結構）
(function (global) {
  "use strict";

  var DYE = {
    white: "#f9fffe", orange: "#f9801d", magenta: "#c74ebd", light_blue: "#3ab3da",
    yellow: "#fed83d", lime: "#80c71f", pink: "#f38baa", gray: "#474f52",
    light_gray: "#9d9d97", cyan: "#169c9c", purple: "#8932b8", blue: "#3c44aa",
    brown: "#835432", green: "#5e7c16", red: "#b02e26", black: "#1d1d21"
  };

  var WOOD = {
    oak: "#b8945f", spruce: "#6b5032", birch: "#d7c185", jungle: "#a87754",
    acacia: "#ba6337", dark_oak: "#4b3418", mangrove: "#773636", cherry: "#e3b0b6",
    bamboo: "#c2b23f", crimson: "#6a344b", warped: "#2b7569", pale_oak: "#e4ddd3"
  };

  var EXACT = {
    stone: "#7d7d7d", granite: "#9a6a55", andesite: "#8a8a8a", diorite: "#bfbfbd",
    polished_granite: "#a26e58", polished_andesite: "#929292", polished_diorite: "#c7c7c4",
    cobblestone: "#7a7a7a", mossy_cobblestone: "#6b7a5b", smooth_stone: "#9b9b9b",
    stone_bricks: "#7a7a7a", mossy_stone_bricks: "#6f7a68", cracked_stone_bricks: "#777777",
    chiseled_stone_bricks: "#79797a", bricks: "#96584c",
    deepslate: "#575759", cobbled_deepslate: "#4e4e51", polished_deepslate: "#484849",
    deepslate_bricks: "#4a4a4d", deepslate_tiles: "#3b3b3d", chiseled_deepslate: "#3f3f42",
    tuff: "#6b6b65", calcite: "#dfdfd7", dripstone_block: "#866b5c", amethyst_block: "#8464c0",
    netherrack: "#6f3634", nether_bricks: "#2d161a", red_nether_bricks: "#450206",
    blackstone: "#2a2328", polished_blackstone: "#352f39", polished_blackstone_bricks: "#2e2831",
    basalt: "#4c4c53", smooth_basalt: "#48484e", soul_sand: "#51392f", soul_soil: "#4b3a2e",
    magma_block: "#8e3f1d", glowstone: "#f9d49c", shroomlight: "#f08b3f",
    crying_obsidian: "#25124a", obsidian: "#15121f", bedrock: "#565656",
    end_stone: "#dddea8", end_stone_bricks: "#d9e0a3", purpur_block: "#a97ba9",
    dirt: "#866043", coarse_dirt: "#7a5a3c", rooted_dirt: "#90674a", podzol: "#5b3a1d",
    grass_block: "#7fb238", dirt_path: "#947a40", farmland: "#5c3f24", mycelium: "#6f6264",
    mud: "#3b3a3c", packed_mud: "#8e6a4e", clay: "#a4a8b8", moss_block: "#596d2a",
    sand: "#dbd3a0", red_sand: "#bf6a2d", sandstone: "#d7cc9e", red_sandstone: "#bf6a2d",
    smooth_sandstone: "#dbd0a3", gravel: "#8a8687",
    glass: "#d8f0f5", tinted_glass: "#2c2a2a", glass_pane: "#d8f0f5",
    water: "#3f76e4", lava: "#e87a1b", ice: "#7eb6ff", blue_ice: "#74a8f7",
    packed_ice: "#8cb4f0", snow: "#f7feff", snow_block: "#f0fafa", powder_snow: "#f7feff",
    iron_block: "#d8d8d8", gold_block: "#f7d751", diamond_block: "#4aedd9",
    emerald_block: "#42e18b", netherite_block: "#443f42", copper_block: "#c16d53",
    exposed_copper: "#a2796a", weathered_copper: "#6f9b7c", oxidized_copper: "#53a486",
    redstone_block: "#a81e09", lapis_block: "#1d47a5", coal_block: "#121212",
    quartz_block: "#ebe6dd", smooth_quartz: "#ebe6dd", chiseled_quartz_block: "#e8e3da",
    iron_ore: "#8a8a8a", gold_ore: "#8a8a7d", diamond_ore: "#7a8a8a", coal_ore: "#5e5e5e",
    redstone_ore: "#8a6a6a", lapis_ore: "#6a7a8a", emerald_ore: "#6a8a7a",
    ancient_debris: "#5c4136", nether_gold_ore: "#74453c", nether_quartz_ore: "#7a4740",
    redstone_wire: "#a81e09", redstone_torch: "#ff4a27", torch: "#ffd966",
    soul_torch: "#7ff0e8", lantern: "#f0b254", soul_lantern: "#60d4cf",
    repeater: "#c7c7c7", comparator: "#c7c7c7", observer: "#6e6e6e", target: "#decdbd",
    piston: "#9c7f4e", sticky_piston: "#85a24a", piston_head: "#9c7f4e",
    dispenser: "#6e6e6e", dropper: "#6e6e6e", hopper: "#4b4b4b",
    note_block: "#5b3a1d", jukebox: "#5b3a1d", lectern: "#9c7f4e",
    redstone_lamp: "#8f5e36", daylight_detector: "#8a7a5c", lever: "#7a6450",
    tripwire_hook: "#9c8a6a", slime_block: "#6ec35a", honey_block: "#f9b418",
    chest: "#a06f23", trapped_chest: "#a06f23", ender_chest: "#15353a", barrel: "#87682f",
    furnace: "#6e6e6e", blast_furnace: "#5e5e5e", smoker: "#5e4a3a",
    crafting_table: "#825432", anvil: "#4a4a4a", cauldron: "#4a4a4a",
    campfire: "#a05a2c", soul_campfire: "#4ec6c4", beacon: "#6ad3cf",
    spawner: "#1b2b35", sculk: "#0e2229", sculk_catalyst: "#1b3b43",
    sculk_sensor: "#15454f", sculk_shrieker: "#365c55", bubble_column: "#3f76e4",
    hay_block: "#a68c1c", bone_block: "#e1ddca", sponge: "#c3c32b", wet_sponge: "#a2ab30",
    scaffolding: "#b89b5e", ladder: "#8a6f40", vine: "#4a7a29", cobweb: "#dbdbdb",
    rail: "#9a8f6a", powered_rail: "#9a7a3a", detector_rail: "#9a8f6a", activator_rail: "#9a6a4a",
    iron_bars: "#9a9a9a", chain: "#5b5b63", end_rod: "#e7e2d6", lightning_rod: "#c16d53",
    tnt: "#b02e26", barrier: "#ff0000", structure_void: "#888888",
    oak_leaves: "#4f8f2c", spruce_leaves: "#3e6e3e", birch_leaves: "#6f9a4a",
    jungle_leaves: "#4f9a2c", acacia_leaves: "#6f9a3a", dark_oak_leaves: "#3f7a2c",
    azalea_leaves: "#5f8f3a", mangrove_leaves: "#4f8f4c", cherry_leaves: "#f2b8d4"
  };
  // 這些當成空氣（不畫）
  var EMPTY = { air: 1, cave_air: 1, void_air: 1, structure_void: 1, light: 1, moving_piston: 1 };

  // 這些要半透明
  var TRANSPARENT = {
    glass: 0.35, tinted_glass: 0.55, glass_pane: 0.35, water: 0.45, ice: 0.6,
    blue_ice: 0.7, packed_ice: 0.75, slime_block: 0.6, honey_block: 0.65,
    bubble_column: 0.3, barrier: 0.15, powder_snow: 0.7, cobweb: 0.45, spawner: 0.5
  };

  var FAMILY_SUFFIX = [
    "_slab", "_stairs", "_wall", "_fence_gate", "_fence", "_door", "_trapdoor",
    "_button", "_pressure_plate", "_wall_sign", "_hanging_sign", "_sign",
    "_carpet", "_pane", "_bars", "_block", "_planks", "_log", "_wood", "_stem",
    "_hyphae", "_bed", "_candle", "_shulker_box", "_glazed_terracotta",
    "_concrete_powder", "_concrete", "_terracotta", "_wool", "_stained_glass_pane",
    "_stained_glass", "_banner", "_sapling", "_leaves", "_fence_post"
  ];

  function hashColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var r = 90 + (h & 0x7f), g = 90 + ((h >> 8) & 0x7f), b = 90 + ((h >> 16) & 0x7f);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function mix(hex, other, t) {
    var a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
    var r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
    var g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
    var c = Math.round((a & 255) * (1 - t) + (b & 255) * t);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + c).toString(16).slice(1);
  }

  var cache = {};

  function shortId(full) {
    var s = full.indexOf(":") >= 0 ? full.split(":")[1] : full;
    return s;
  }

  function colorOf(fullId) {
    var name = shortId(fullId);
    if (cache[name]) return cache[name];
    var c = resolve(name);
    cache[name] = c;
    return c;
  }

  function resolve(name) {
    if (EXACT[name]) return EXACT[name];

    // 染色家族
    for (var dye in DYE) {
      if (name.indexOf(dye + "_") === 0) {
        var rest = name.slice(dye.length + 1);
        var base = DYE[dye];
        if (rest.indexOf("terracotta") >= 0) return mix(base, "#8f5a42", 0.55);
        if (rest.indexOf("concrete_powder") >= 0) return mix(base, "#ffffff", 0.2);
        if (rest.indexOf("glazed") >= 0) return mix(base, "#ffffff", 0.3);
        if (rest.indexOf("stained_glass") >= 0) return mix(base, "#ffffff", 0.15);
        return base;
      }
    }
    if (name === "terracotta") return "#985e44";

    // 木頭家族
    for (var w in WOOD) {
      if (name.indexOf(w + "_") === 0 || name === w) {
        var r2 = name.slice(w.length + 1);
        if (r2.indexOf("leaves") >= 0) return mix(WOOD[w], "#4f8f2c", 0.75);
        if (r2.indexOf("log") >= 0 || r2.indexOf("stem") >= 0 || r2.indexOf("wood") >= 0 || r2.indexOf("hyphae") >= 0)
          return mix(WOOD[w], "#000000", 0.2);
        return WOOD[w];
      }
    }
    if (name.indexOf("stripped_") === 0) return resolve(name.slice(9));
    if (name.indexOf("waxed_") === 0) return resolve(name.slice(6));

    // 去掉後綴再試一次（例如 deepslate_brick_stairs -> deepslate_bricks）
    for (var i = 0; i < FAMILY_SUFFIX.length; i++) {
      var sfx = FAMILY_SUFFIX[i];
      if (name.length > sfx.length && name.slice(-sfx.length) === sfx) {
        var base2 = name.slice(0, -sfx.length);
        if (EXACT[base2]) return EXACT[base2];
        if (EXACT[base2 + "s"]) return EXACT[base2 + "s"];
        if (EXACT[base2 + "_block"]) return EXACT[base2 + "_block"];
        var sub = resolveSoft(base2);
        if (sub) return sub;
      }
    }
    if (name.indexOf("copper") >= 0) return "#c16d53";
    if (name.indexOf("deepslate") >= 0) return "#4e4e51";
    if (name.indexOf("blackstone") >= 0) return "#2a2328";
    if (name.indexOf("quartz") >= 0) return "#ebe6dd";
    if (name.indexOf("nether_brick") >= 0) return "#2d161a";
    if (name.indexOf("sandstone") >= 0) return "#d7cc9e";
    if (name.indexOf("prismarine") >= 0) return "#5f9e8f";
    if (name.indexOf("purpur") >= 0) return "#a97ba9";
    if (name.indexOf("mushroom") >= 0) return "#c9c1b1";
    if (name.indexOf("coral") >= 0) return "#cc4f6a";
    return hashColor(name);
  }

  function resolveSoft(name) {
    if (EXACT[name]) return EXACT[name];
    for (var w in WOOD) if (name === w || name.indexOf(w + "_") === 0) return WOOD[w];
    for (var d in DYE) if (name === d || name.indexOf(d + "_") === 0) return DYE[d];
    return null;
  }

  function isEmpty(fullId) { return !!EMPTY[shortId(fullId)]; }

  function alphaOf(fullId) {
    var n = shortId(fullId);
    if (TRANSPARENT[n] !== undefined) return TRANSPARENT[n];
    if (n.indexOf("stained_glass") >= 0 || n.indexOf("glass") >= 0) return 0.35;
    if (n.indexOf("leaves") >= 0) return 0.85;
    if (n === "water" || n.indexOf("_water") >= 0) return 0.45;
    return 1;
  }

  // 回傳 [sx, sy, sz, ox, oy, oz] —— 尺寸與中心位移（方塊中心為 0）
  function shapeOf(fullId, props) {
    var n = shortId(fullId);
    var p = props || {};
    var full = [1, 1, 1, 0, 0, 0];

    if (n.slice(-5) === "_slab" || n === "snow") {
      var t = p.type || p.layers;
      if (t === "double") return full;
      if (t === "top") return [1, 0.5, 1, 0, 0.25, 0];
      if (n === "snow") {
        var ly = parseInt(p.layers || "1", 10) / 8;
        return [1, ly, 1, 0, -0.5 + ly / 2, 0];
      }
      return [1, 0.5, 1, 0, -0.25, 0];
    }
    if (n.slice(-9) === "_trapdoor") {
      if (p.open === "true") {
        var f = p.facing || "north";
        if (f === "north") return [1, 1, 0.19, 0, 0, -0.405];
        if (f === "south") return [1, 1, 0.19, 0, 0, 0.405];
        if (f === "west") return [0.19, 1, 1, -0.405, 0, 0];
        return [0.19, 1, 1, 0.405, 0, 0];
      }
      return p.half === "top" ? [1, 0.19, 1, 0, 0.405, 0] : [1, 0.19, 1, 0, -0.405, 0];
    }
    if (n.slice(-5) === "_door") {
      var fd = p.facing || "north";
      if (fd === "north") return [1, 1, 0.19, 0, 0, -0.405];
      if (fd === "south") return [1, 1, 0.19, 0, 0, 0.405];
      if (fd === "west") return [0.19, 1, 1, -0.405, 0, 0];
      return [0.19, 1, 1, 0.405, 0, 0];
    }
    if (n.slice(-7) === "_carpet" || n.slice(-15) === "_pressure_plate" || n === "moss_carpet")
      return [1, 0.0625, 1, 0, -0.47, 0];
    if (n === "redstone_wire" || n.slice(-5) === "_rail" || n === "rail" || n === "lily_pad" || n === "tripwire")
      return [1, 0.07, 1, 0, -0.465, 0];
    if (n === "repeater" || n === "comparator" || n === "daylight_detector")
      return [1, 0.13, 1, 0, -0.435, 0];
    if (n === "hopper") return [1, 0.7, 1, 0, -0.15, 0];
    if (n === "cauldron" || n.indexOf("cauldron") >= 0) return [1, 0.9, 1, 0, -0.05, 0];
    if (n === "enchanting_table") return [1, 0.75, 1, 0, -0.125, 0];
    if (n === "chest" || n === "trapped_chest" || n === "ender_chest") return [0.88, 0.88, 0.88, 0, -0.06, 0];
    if (n === "torch" || n === "redstone_torch" || n === "soul_torch") return [0.22, 0.62, 0.22, 0, -0.19, 0];
    if (n.indexOf("wall_torch") >= 0) return [0.22, 0.5, 0.22, 0, 0, 0];
    if (n === "lever" || n.slice(-7) === "_button") return [0.3, 0.2, 0.3, 0, -0.4, 0];
    if (n.slice(-6) === "_fence" || n.slice(-5) === "_wall" || n === "iron_bars" ||
        n.slice(-6) === "_chain" || n === "chain" || n.slice(-6) === "_pane" ||
        n.indexOf("glass_pane") >= 0 || n === "end_rod" || n === "lightning_rod")
      return [0.32, 1, 0.32, 0, 0, 0];
    if (n.slice(-11) === "_fence_gate") return [1, 0.7, 0.3, 0, 0.1, 0];
    if (n === "ladder" || n === "vine" || n.slice(-5) === "_sign" || n.indexOf("banner") >= 0)
      return [1, 1, 0.12, 0, 0, -0.44];
    if (n === "scaffolding") return [1, 1, 1, 0, 0, 0];
    if (n === "campfire" || n === "soul_campfire") return [1, 0.45, 1, 0, -0.28, 0];
    if (n === "lantern" || n === "soul_lantern") return [0.4, 0.55, 0.4, 0, -0.22, 0];
    if (n === "cake") return [0.88, 0.5, 0.88, 0, -0.25, 0];
    if (n.slice(-8) === "_sapling" || n === "grass" || n === "short_grass" || n === "fern" ||
        n.slice(-7) === "_flower" || n === "dandelion" || n === "poppy" || n === "wheat" ||
        n === "sugar_cane" || n === "nether_wart" || n === "sweet_berry_bush")
      return [0.55, 0.85, 0.55, 0, -0.07, 0];
    if (n.slice(-4) === "_bed") return [1, 0.56, 1, 0, -0.22, 0];
    return full;
  }

  // 完整不透明方塊（用來做遮擋剔除）
  function isSolid(fullId, props) {
    if (isEmpty(fullId)) return false;
    if (alphaOf(fullId) < 1) return false;
    var s = shapeOf(fullId, props);
    return s[0] === 1 && s[1] === 1 && s[2] === 1;
  }

  // 常用方塊建議清單（輸入框自動完成用）
  var SUGGEST = [
    "minecraft:air", "minecraft:stone", "minecraft:cobblestone", "minecraft:smooth_stone",
    "minecraft:stone_bricks", "minecraft:deepslate", "minecraft:cobbled_deepslate",
    "minecraft:polished_deepslate", "minecraft:deepslate_bricks", "minecraft:deepslate_tiles",
    "minecraft:tuff", "minecraft:calcite", "minecraft:andesite", "minecraft:granite",
    "minecraft:diorite", "minecraft:blackstone", "minecraft:polished_blackstone",
    "minecraft:basalt", "minecraft:netherrack", "minecraft:nether_bricks",
    "minecraft:obsidian", "minecraft:bedrock", "minecraft:glass", "minecraft:tinted_glass",
    "minecraft:dirt", "minecraft:grass_block", "minecraft:sand", "minecraft:gravel",
    "minecraft:sandstone", "minecraft:clay", "minecraft:ice", "minecraft:packed_ice",
    "minecraft:snow_block", "minecraft:water", "minecraft:lava",
    "minecraft:oak_planks", "minecraft:spruce_planks", "minecraft:birch_planks",
    "minecraft:jungle_planks", "minecraft:acacia_planks", "minecraft:dark_oak_planks",
    "minecraft:crimson_planks", "minecraft:warped_planks",
    "minecraft:oak_log", "minecraft:spruce_log", "minecraft:oak_slab", "minecraft:spruce_slab",
    "minecraft:smooth_stone_slab", "minecraft:polished_deepslate_slab",
    "minecraft:oak_stairs", "minecraft:spruce_trapdoor", "minecraft:oak_trapdoor",
    "minecraft:iron_trapdoor", "minecraft:oak_fence", "minecraft:iron_bars",
    "minecraft:hopper", "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
    "minecraft:furnace", "minecraft:dispenser", "minecraft:dropper", "minecraft:observer",
    "minecraft:piston", "minecraft:sticky_piston", "minecraft:redstone_block",
    "minecraft:redstone_lamp", "minecraft:repeater", "minecraft:comparator",
    "minecraft:redstone_torch", "minecraft:torch", "minecraft:lever", "minecraft:note_block",
    "minecraft:slime_block", "minecraft:honey_block", "minecraft:target", "minecraft:tnt",
    "minecraft:iron_block", "minecraft:gold_block", "minecraft:diamond_block",
    "minecraft:emerald_block", "minecraft:netherite_block", "minecraft:copper_block",
    "minecraft:lapis_block", "minecraft:coal_block", "minecraft:quartz_block",
    "minecraft:hay_block", "minecraft:bone_block", "minecraft:sponge", "minecraft:magma_block",
    "minecraft:soul_sand", "minecraft:soul_soil", "minecraft:glowstone",
    "minecraft:sea_lantern", "minecraft:shroomlight", "minecraft:campfire",
    "minecraft:soul_campfire", "minecraft:lantern", "minecraft:soul_lantern",
    "minecraft:scaffolding", "minecraft:ladder", "minecraft:cobweb", "minecraft:end_rod"
  ];
  var DYES = Object.keys(DYE);
  for (var i = 0; i < DYES.length; i++) {
    SUGGEST.push("minecraft:" + DYES[i] + "_wool");
    SUGGEST.push("minecraft:" + DYES[i] + "_concrete");
    SUGGEST.push("minecraft:" + DYES[i] + "_terracotta");
    SUGGEST.push("minecraft:" + DYES[i] + "_stained_glass");
    SUGGEST.push("minecraft:" + DYES[i] + "_shulker_box");
  }

  // 生物群系染色（tintindex）。回傳 [r,g,b] 0..1，不需要染色回傳 null
  var GRASS = [0x91 / 255, 0xBD / 255, 0x59 / 255];
  var FOLIAGE = [0x77 / 255, 0xAB / 255, 0x2F / 255];
  var WATER = [0x3F / 255, 0x76 / 255, 0xE4 / 255];

  function tintFor(fullId, props) {
    var n = shortId(fullId);
    if (n === "spruce_leaves") return [0x61 / 255, 0x99 / 255, 0x61 / 255];
    if (n === "birch_leaves") return [0x80 / 255, 0xA7 / 255, 0x55 / 255];
    if (n.slice(-7) === "_leaves") return FOLIAGE;
    if (n === "vine") return FOLIAGE;
    if (n === "lily_pad") return [0x20 / 255, 0x80 / 255, 0x30 / 255];
    if (n === "grass_block" || n === "grass" || n === "short_grass" || n === "tall_grass" ||
        n === "fern" || n === "large_fern" || n === "sugar_cane" || n === "potted_fern")
      return GRASS;
    if (n === "water" || n === "bubble_column" || n === "water_cauldron" ||
        n === "flowing_water") return WATER;
    if (n === "redstone_wire") {
      var f = (parseInt((props && props.power) || "0", 10) || 0) / 15;
      var r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
      var g = Math.max(0, Math.min(1, f * f * 0.7 - 0.5));
      var b = Math.max(0, Math.min(1, f * f * 0.6 - 0.7));
      return [r, g, b];
    }
    if (n.slice(-5) === "_stem" && n !== "crimson_stem" && n !== "warped_stem") {
      var age = (parseInt((props && props.age) || "0", 10) || 0) / 7;
      return [age, 1 - age * 0.4, age * 0.3];
    }
    return null;
  }

  global.Blocks = {
    colorOf: colorOf, isEmpty: isEmpty, alphaOf: alphaOf,
    shapeOf: shapeOf, isSolid: isSolid, shortId: shortId,
    tintFor: tintFor, SUGGEST: SUGGEST
  };
})(window);
