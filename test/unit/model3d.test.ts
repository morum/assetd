import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contactSheetOutputSchema, inspectOutputSchema, searchOutputSchema, similarOutputSchema, statusOutputSchema } from "../../src/contracts/json.ts";
import { ExitCode } from "../../src/core/errors.ts";
import { renderViews, VIEWS } from "../../src/render/rasterizer.ts";
import type { ModelScene } from "../../src/processors/model3d/model-scene.ts";
import { writeImage } from "../helpers.ts";
import { cli, tempProject, type TempProject } from "../helpers.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "models");

let project: TempProject;
beforeEach(() => {
  project = tempProject();
});
afterEach(() => project.cleanup());

function copyFixtures(dest: string) {
  fs.cpSync(FIXTURES, project.file(dest), { recursive: true });
}

/** A 1x1x1 cube, translated by a node, with a material, animation and skin. */
async function writeGltf(logical: string, opts: { texture?: "embedded" | "missing"; format: "glb" | "gltf" }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4];
  const position = doc.createAccessor().setType("VEC3").setArray(new Float32Array(p)).setBuffer(buffer);
  const uv = doc.createAccessor().setType("VEC2").setArray(new Float32Array(16)).setBuffer(buffer);
  const indices = doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer);
  const material = doc.createMaterial("crate wood").setBaseColorFactor([0.6, 0.4, 0.2, 1]);
  if (opts.texture) {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#884422" } }).png().toBuffer();
    const tex = doc.createTexture("wood").setMimeType("image/png").setImage(new Uint8Array(png));
    if (opts.texture === "missing") tex.setURI("textures/wood.png");
    material.setBaseColorTexture(tex);
  }
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setIndices(indices).setMaterial(material);
  const mesh = doc.createMesh("crate").addPrimitive(prim);
  const joint = doc.createNode("root joint");
  const node = doc.createNode("crate").setMesh(mesh).setTranslation([10, 0, 0]).setScale([2, 2, 2]);
  node.setSkin(doc.createSkin("rig").addJoint(joint));
  doc.createScene("main").addChild(node).addChild(joint);
  const times = doc.createAccessor().setArray(new Float32Array([0, 1.5])).setType("SCALAR").setBuffer(buffer);
  const values = doc.createAccessor().setArray(new Float32Array([0, 0, 0, 0, 1, 0])).setType("VEC3").setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(times).setOutput(values);
  doc.createAnimation("bounce").addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("translation").setSampler(sampler));
  doc.getRoot().getAsset().generator = "assetd test";
  const target = project.file(logical);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const io = new NodeIO();
  if (opts.format === "glb") fs.writeFileSync(target, await io.writeBinary(doc));
  else await io.write(target, doc);
  if (opts.texture === "missing") fs.rmSync(path.join(path.dirname(target), "textures"), { recursive: true, force: true });
}

describe("3D model metadata", () => {
  it("reads Kenney GLB and OBJ exports of the same model consistently", async () => {
    copyFixtures("models");
    const r = await cli(project.root, "index", "models", "--json");
    expect(r.code).toBe(0);
    // The texture PNG is indexed as an image too.
    expect(r.json).toMatchObject({ indexed: 3, failed: 0 });
    const glb = inspectOutputSchema.parse((await cli(project.root, "inspect", "models/burger.glb", "--json")).json);
    const obj = inspectOutputSchema.parse((await cli(project.root, "inspect", "models/burger.obj", "--json")).json);
    expect(glb).toMatchObject({ kind: "model3d", state: "indexed" });
    expect(glb.embeddings).toEqual([expect.objectContaining({ channel: "visual", current: true })]);
    expect(glb.previews).toEqual([`.asset-index/previews/${glb.contentHash}/preview.png`]);
    expect(glb.metadata).toMatchObject({
      format: "glb",
      triangleCount: 294,
      materials: ["colormap"],
      textures: [{ uri: "Textures/colormap.png", missing: false }],
      units: "meters",
      upAxis: "Y",
      generator: "UnityGLTF",
      hasAnimations: false,
      hasSkeleton: false,
    });
    expect(obj.metadata).toMatchObject({ format: "obj", triangleCount: 294, materials: ["colormap"], units: null, missingResources: [] });
    expect(obj.metadata.dimensions).toEqual(glb.metadata.dimensions);
    const status = statusOutputSchema.parse((await cli(project.root, "status", "--json")).json);
    expect(status.types).toMatchObject({ model3d: 2, image: 1 });
  });

  it("applies node transforms and reports animations, skins and embedded textures", async () => {
    await writeGltf("m/crate.glb", { format: "glb", texture: "embedded" });
    await cli(project.root, "index", "m");
    const doc = (await cli(project.root, "inspect", "m/crate.glb", "--json")).json;
    expect(doc.metadata).toMatchObject({
      format: "glb",
      vertexCount: 8,
      triangleCount: 12,
      meshCount: 1,
      materials: ["crate wood"],
      textures: [{ uri: null, embedded: true, missing: false }],
      boundingBox: { min: [10, 0, 0], max: [12, 2, 2] },
      dimensions: [2, 2, 2],
      hasAnimations: true,
      animations: [{ name: "bounce", durationSeconds: 1.5 }],
      hasSkeleton: true,
      jointCount: 1,
      generator: "assetd test",
    });
  });

  it("indexes a .gltf whose texture file is missing, and reports it", async () => {
    await writeGltf("m/crate.gltf", { format: "gltf", texture: "missing" });
    const r = await cli(project.root, "index", "m", "--json");
    expect(r.json.failed).toBe(0);
    const doc = (await cli(project.root, "inspect", "m/crate.gltf", "--json")).json;
    expect(doc.metadata).toMatchObject({ format: "gltf", triangleCount: 12, missingResources: ["textures/wood.png"] });
  });

  it("fails a .gltf whose geometry buffer is missing without aborting the run", async () => {
    await writeGltf("m/crate.gltf", { format: "gltf" });
    fs.rmSync(project.file("m/crate.bin"));
    await writeGltf("m/ok.glb", { format: "glb" });
    const r = await cli(project.root, "index", "m", "--json");
    expect(r.json).toMatchObject({ indexed: 1, failed: 1 });
    expect(r.json.failures[0].error).toMatch(/Missing geometry buffer/);
  });

  it("parses OBJ quads, negative indices, options in map_Kd and Windows separators", async () => {
    const dir = project.file("props");
    fs.mkdirSync(path.join(dir, "tex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "box.obj"),
      ["mtllib box.mtl", "o Box", "v 0 0 0", "v 2 0 0", "v 2 3 0", "v 0 3 0", "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "usemtl red", "f -4/-4 -3/-3 -2/-2 -1/-1", ""].join("\r\n"),
    );
    fs.writeFileSync(path.join(dir, "box.mtl"), "newmtl red\nKd 1 0 0\nmap_Kd -s 1 1 1 tex\\red.png\n");
    fs.writeFileSync(path.join(dir, "tex", "red.png"), await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer());
    await cli(project.root, "index", "props");
    const doc = (await cli(project.root, "inspect", "props/box.obj", "--json")).json;
    expect(doc.metadata).toMatchObject({
      triangleCount: 2,
      vertexCount: 4,
      meshCount: 1,
      materials: ["red"],
      textures: [{ uri: "tex/red.png", missing: false }],
      dimensions: [2, 3, 0],
      missingResources: [],
    });
  });

  it("records corrupt models as failures", async () => {
    fs.mkdirSync(project.file("bad"));
    fs.writeFileSync(project.file("bad/broken.glb"), "glTF garbage");
    fs.writeFileSync(project.file("bad/broken.gltf"), "{ not json");
    const r = await cli(project.root, "index", "bad", "--json");
    expect(r.json).toMatchObject({ indexed: 0, failed: 2 });
  });
});

function cubeScene(color: [number, number, number, number]): ModelScene {
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4];
  return {
    format: "glb",
    primitives: [{ positions: new Float32Array(p), indices: new Uint32Array(idx), baseColor: color }],
    meshCount: 1, nodeCount: 1, materials: [], textures: [], animations: [], jointCount: 0, skinCount: 0,
    hasMorphTargets: false, hasVertexColors: false, vertexCount: 8, triangleCount: 12, generator: null,
    extensionsUsed: [], missingResources: [], units: "meters", upAxis: "Y",
  };
}

describe("software renderer", () => {
  it("draws the model centered on a white background, deterministically", async () => {
    const [a] = await renderViews(cubeScene([1, 0, 0, 1]), [VIEWS.perspective1!], { size: 64 });
    const [b] = await renderViews(cubeScene([1, 0, 0, 1]), [VIEWS.perspective1!], { size: 64 });
    expect(Buffer.from(a!.rgb).equals(Buffer.from(b!.rgb))).toBe(true);
    const px = (x: number, y: number) => Array.from(a!.rgb.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3));
    expect(px(0, 0)).toEqual([255, 255, 255]);
    const [r, g, bl] = px(32, 32);
    expect(r).toBeGreaterThan(90);
    expect(g).toBeLessThan(40);
    expect(bl).toBeLessThan(40);
  });

  it("renders every standard view without throwing", async () => {
    const out = await renderViews(cubeScene([0, 0, 1, 1]), Object.values(VIEWS), { size: 32, supersample: 1 });
    expect(out).toHaveLength(Object.keys(VIEWS).length);
  });
});

describe("3D search", () => {
  beforeEach(async () => {
    copyFixtures("models");
    await writeGltf("m/crate.glb", { format: "glb" });
    await writeImage(project, "icons/red.png", "#ff0000");
    await cli(project.root, "index", "models", "m", "icons");
  });

  it("searches 3D models by text through their renders", async () => {
    const doc = searchOutputSchema.parse((await cli(project.root, "search", "burger", "--type", "model3d", "--json")).json);
    expect(doc).toMatchObject({ type: "model3d", ranking: "visual+lexical/v1" });
    expect(doc.results.every((r) => r.kind === "model3d" && r.signals.visual !== undefined)).toBe(true);
    expect(doc.results.map((r) => r.path)).toContain("models/burger.glb");
    const all = searchOutputSchema.parse((await cli(project.root, "search", "burger", "--json")).json);
    expect(all.type).toBe("all");
    expect(all.models).toHaveLength(1); // images and 3D share the visual model
  });

  it("compares images and 3D models in the shared visual space", async () => {
    const sameKind = similarOutputSchema.parse((await cli(project.root, "similar", "models/burger.glb", "--json")).json);
    expect(sameKind.type).toBe("model3d");
    expect(sameKind.results[0]!.path).toBe("models/burger.obj");
    const toImages = similarOutputSchema.parse((await cli(project.root, "similar", "models/burger.glb", "--type", "image", "--json")).json);
    expect(toImages.results.every((r) => r.kind === "image")).toBe(true);
    const toModels = similarOutputSchema.parse((await cli(project.root, "similar", "icons/red.png", "--type", "model3d", "--json")).json);
    expect(toModels.results.every((r) => r.kind === "model3d")).toBe(true);
    expect((await cli(project.root, "similar", "icons/red.png", "--type", "audio", "--json")).code).toBe(ExitCode.USAGE_ERROR);
  });

  it("re-embeds only 3D models when the configured view count changes", async () => {
    fs.writeFileSync(project.file("assetd.json"), JSON.stringify({ model3d: { views: 4 } }));
    const r = await cli(project.root, "index", "--json");
    expect(r.json).toMatchObject({ indexed: 3, unchanged: 2 }); // 3 models re-rendered; texture + icon untouched
    const doc = (await cli(project.root, "inspect", "models/burger.glb", "--json")).json;
    expect(doc.processor.version).toBe("2+perspective1,perspective2,perspective3,perspective4");
    expect((await cli(project.root, "index", "--json")).json.indexed).toBe(0);
  });

  it("shows renders in contact sheets and shares previews between identical files", async () => {
    const sheet = contactSheetOutputSchema.parse((await cli(project.root, "contact-sheet", "models/burger.glb", "models/burger.obj", "--json")).json);
    expect(sheet.items.map((i) => i.error)).toEqual([null, null]);
    fs.copyFileSync(project.file("m/crate.glb"), project.file("m/crate copy.glb"));
    await cli(project.root, "index");
    const previews = fs.readdirSync(project.file(".asset-index/previews"));
    const a = (await cli(project.root, "inspect", "m/crate.glb", "--json")).json;
    const b = (await cli(project.root, "inspect", "m/crate copy.glb", "--json")).json;
    expect(a.previews).toEqual(b.previews);
    fs.rmSync(project.file("m"), { recursive: true });
    await cli(project.root, "index");
    expect(fs.readdirSync(project.file(".asset-index/previews")).length).toBe(previews.length - 1);
  });
});
