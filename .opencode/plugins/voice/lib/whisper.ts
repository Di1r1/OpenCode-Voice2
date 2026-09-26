// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
/**
 * Пути к whisper.cpp и CUDA-библиотекам (портируемость).
 *
 * Всё настраивается через env, дефолты считаются от OPENCODE_VOICE_HOME
 * (по умолчанию ~/.local/share/opencode-voice). Каталоги CUDA ищутся по
 * кандидатам, включая glob `cuda-*`, поэтому версия toolkit не зашита.
 *
 * Env: OPENCODE_VOICE_HOME, OPENCODE_VOICE_WHISPER_DIR, WHISPER_CPP_BIN,
 *      WHISPER_CPP_MODEL, WHISPER_CPP_MODEL_SIZE, WHISPER_MODEL,
 *      CUDA_HOME, CUDA_PATH, OPENCODE_VOICE_CUDA.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Env = Record<string, string | undefined>

// Единый источник истины с Python: shared/stt-spec.json (фолбэк совпадает со спеком).
const FALLBACK_SPEC = {
  whisperCppExtraFlags: ["-mc", "0", "-sns"],
  defaultModelByDevice: { gpu: "medium", cpu: "small" },
  silenceRms: 80,
  silencePeak: 700,
}

interface Spec {
  flags: string[]
  gpu: string
  cpu: string
  silenceRms: number
  silencePeak: number
}

function loadSpec(): Spec {
  // shared/ лежит рядом с пакетом. В bundle (lib/ внутри .opencode/plugins/voice/)
  // это ../shared/, в исходниках (src/lib/) — ../../shared/. Проверяем оба.
  for (const rel of ["../shared/stt-spec.json", "../../shared/stt-spec.json"]) {
    try {
      const url = new URL(rel, import.meta.url)
      const raw = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
      const rms = Number(raw?.silence?.rms)
      const peak = Number(raw?.silence?.peak)
      return {
        flags: Array.isArray(raw?.whisperCppExtraFlags) && raw.whisperCppExtraFlags.length
          ? raw.whisperCppExtraFlags.map(String)
          : FALLBACK_SPEC.whisperCppExtraFlags,
        gpu: raw?.defaultModelByDevice?.gpu || FALLBACK_SPEC.defaultModelByDevice.gpu,
        cpu: raw?.defaultModelByDevice?.cpu || FALLBACK_SPEC.defaultModelByDevice.cpu,
        silenceRms: Number.isFinite(rms) && rms > 0 ? rms : FALLBACK_SPEC.silenceRms,
        silencePeak: Number.isFinite(peak) && peak > 0 ? peak : FALLBACK_SPEC.silencePeak,
      }
    } catch {
      // пробуем следующий кандидат
    }
  }
  return {
    flags: FALLBACK_SPEC.whisperCppExtraFlags,
    gpu: FALLBACK_SPEC.defaultModelByDevice.gpu,
    cpu: FALLBACK_SPEC.defaultModelByDevice.cpu,
    silenceRms: FALLBACK_SPEC.silenceRms,
    silencePeak: FALLBACK_SPEC.silencePeak,
  }
}

const SPEC = loadSpec()

/** Доп. флаги whisper.cpp (анти-галлюцинации), из shared/stt-spec.json. */
export const WHISPER_CPP_EXTRA_FLAGS: string[] = SPEC.flags
/** Размер модели по умолчанию для GPU/CPU, из shared/stt-spec.json. */
export const GPU_MODEL_SIZE = SPEC.gpu
export const CPU_MODEL_SIZE = SPEC.cpu

/** Порог тишины RMS: env OPENCODE_VOICE_SILENCE_RMS важнее значения из спека. */
export function silenceRms(env: Env = process.env): number {
  const n = Number(env.OPENCODE_VOICE_SILENCE_RMS)
  return Number.isFinite(n) && n > 0 ? n : SPEC.silenceRms
}

/** Порог тишины peak: env OPENCODE_VOICE_SILENCE_PEAK важнее значения из спека. */
export function silencePeak(env: Env = process.env): number {
  const n = Number(env.OPENCODE_VOICE_SILENCE_PEAK)
  return Number.isFinite(n) && n > 0 ? n : SPEC.silencePeak
}

export function whisperHome(env: Env = process.env, home: string = os.homedir()): string {
  return env.OPENCODE_VOICE_HOME || path.join(home, ".local/share/opencode-voice")
}

export function whisperDir(env: Env = process.env, home: string = os.homedir()): string {
  return env.OPENCODE_VOICE_WHISPER_DIR || path.join(whisperHome(env, home), "whisper")
}

/** Существующие каталоги с CUDA-рантаймом/драйвером (без привязки к версии). */
export function cudaLibDirs(env: Env = process.env, home: string = os.homedir()): string[] {
  const out: string[] = []
  const add = (p?: string) => {
    if (p && existsSync(p) && !out.includes(p)) out.push(p)
  }
  add("/usr/lib/wsl/lib")
  for (const base of ["/usr/local", "/opt", home, whisperDir(env, home)]) {
    if (!existsSync(base)) continue
    add(path.join(base, "cuda", "lib64"))
    let entries: string[] = []
    try {
      entries = readdirSync(base)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (name.startsWith("cuda-")) add(path.join(base, name, "lib64"))
    }
  }
  add(env.CUDA_HOME ? path.join(env.CUDA_HOME, "lib64") : undefined)
  add(env.CUDA_PATH ? path.join(env.CUDA_PATH, "lib64") : undefined)
  return out
}

/** Есть ли CUDA-драйвер/рантайм (или явно выключено через OPENCODE_VOICE_CUDA=0). */
export function hasCuda(env: Env = process.env, home: string = os.homedir()): boolean {
  if (["0", "false", "no", "off"].includes(String(env.OPENCODE_VOICE_CUDA ?? "1").toLowerCase())) return false
  const candidates = [
    "/usr/lib/wsl/lib/libcuda.so.1",
    "/usr/lib/wsl/lib/libcuda.so",
    "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    ...cudaLibDirs(env, home).flatMap((d) => [
      path.join(d, "libcuda.so.1"),
      path.join(d, "libcuda.so"),
      path.join(d, "libcudart.so"),
    ]),
  ]
  return candidates.some((p) => existsSync(p))
}

/** Путь к модели: явный WHISPER_CPP_MODEL или `<whisperDir>/ggml-<size>.bin`. */
export function whisperModelPath(size: string, env: Env = process.env, home: string = os.homedir()): string {
  return env.WHISPER_CPP_MODEL || path.join(whisperDir(env, home), `ggml-${size}.bin`)
}

/** Бинарь whisper.cpp: env, затем типовые места установки. */
export function whisperBin(env: Env = process.env, home: string = os.homedir()): string | null {
  const dir = whisperDir(env, home)
  const candidates = [
    env.WHISPER_CPP_BIN,
    path.join(dir, "bin", "whisper-cli"),
    path.join(dir, "bin", "whisper-cpp"),
    path.join(dir, "bin", "main"),
    path.join(dir, "build", "bin", "whisper-cli"),
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** Размер модели: явный env, иначе значение из spec (GPU/CPU). */
export function defaultModelSize(env: Env = process.env, cuda: boolean = hasCuda(env)): string {
  return env.WHISPER_CPP_MODEL_SIZE || env.WHISPER_MODEL || (cuda ? GPU_MODEL_SIZE : CPU_MODEL_SIZE)
}

/** LD_LIBRARY_PATH: каталог бинаря + найденные CUDA-каталоги. */
export function ldLibraryPath(env: Env = process.env, home: string = os.homedir()): string {
  const bin = whisperBin(env, home)
  const binDir = bin ? path.dirname(bin) : path.join(whisperDir(env, home), "bin")
  return [binDir, ...cudaLibDirs(env, home)].join(":")
}
