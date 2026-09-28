import fs from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
const buf = fs.readFileSync("/tmp/claude-1000/-home-morum-repository/d6a30a00-502d-4541-bdde-5a72eac82543/scratchpad/kenney/x/food-kit/Models/FBX format/burger.fbx");
try {
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "/tmp/claude-1000/-home-morum-repository/d6a30a00-502d-4541-bdde-5a72eac82543/scratchpad/kenney/x/food-kit/Models/FBX format/");
  let tris = 0; const mats = new Set();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => { if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.name + ":" + (m.map ? "map" : "nomap"))); } });
  console.log("ok tris", tris, [...mats]);
} catch (e) { console.log("FAIL", e.message, e.stack.split("\n").slice(0,4).join(" | ")); }
