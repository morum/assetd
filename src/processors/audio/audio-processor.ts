import { downmix, levels } from "../../embeddings/audio-utils.ts";
import type { AssetMetadata, FileInfo } from "../../core/types.ts";
import type { AssetProcessor, FileContent, ProcessedAsset } from "../types.ts";

export const AUDIO_EXTENSIONS = ["wav", "ogg", "oga", "mp3", "flac", "opus", "m4a", "aiff", "aif"] as const;

type Decoded = { channelData: Float32Array[]; sampleRate: number };
let decoder: Promise<(buf: Uint8Array) => Promise<Decoded>> | undefined;

/** WASM decoders (no FFmpeg, identical on Windows and Linux), loaded on first use. */
function decodeAudio(data: Buffer): Promise<Decoded> {
  decoder ??= import("audio-decode").then((m) => m.default as unknown as (buf: Uint8Array) => Promise<Decoded>);
  return decoder.then((decode) => decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
}

const FORMAT_NAMES: Record<string, string> = { oga: "ogg", aif: "aiff" };

export interface DecodedAudio {
  metadata: AssetMetadata;
  mono: Float32Array;
  sampleRate: number;
}

export async function decodeAndDescribe(file: FileInfo, data: Buffer): Promise<DecodedAudio> {
  const decoded = await decodeAudio(data);
  const channels = decoded.channelData.length;
  const frames = decoded.channelData[0]?.length ?? 0;
  if (channels === 0 || frames === 0 || !decoded.sampleRate) throw new Error("No audio samples decoded");
  const durationSeconds = frames / decoded.sampleRate;
  const mono = downmix(decoded.channelData);
  const { peakDb, rmsDb } = levels(mono);
  const metadata: AssetMetadata = {
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    channels,
    sampleRate: decoded.sampleRate,
    format: FORMAT_NAMES[file.extension] ?? file.extension,
    bitrateKbps: Math.round((data.byteLength * 8) / durationSeconds / 1000),
    peakDb,
    rmsDb,
  };
  return { metadata, mono, sampleRate: decoded.sampleRate };
}

export class AudioProcessor implements AssetProcessor {
  readonly id = "audio";
  readonly version: string = "1";
  readonly kind = "audio" as const;
  readonly channels = ["audio"] as const;
  readonly extensions = AUDIO_EXTENSIONS;

  supports(file: FileInfo): boolean {
    return (AUDIO_EXTENSIONS as readonly string[]).includes(file.extension);
  }

  async extractMetadata(content: FileContent): Promise<AssetMetadata> {
    return (await decodeAndDescribe(content.file, content.data)).metadata;
  }

  async process(content: FileContent): Promise<ProcessedAsset> {
    const { metadata, mono, sampleRate } = await decodeAndDescribe(content.file, content.data);
    return { kind: "audio", metadata, embeddingRequests: [{ channel: "audio", input: { type: "audio", audio: { samples: mono, sampleRate } } }] };
  }
}
