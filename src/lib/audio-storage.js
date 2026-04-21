import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const AUDIO_STORAGE_DIR = "D:\\audio";

const METADATA_SUFFIX = ".meta.json";
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".bin",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
]);

export async function ensureAudioStorageDir() {
  await mkdir(AUDIO_STORAGE_DIR, { recursive: true });
}

export function sanitizeRecordingId(input) {
  const baseName = path.basename(String(input || "").trim());
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

export function getRecordingFilePath(recordingId) {
  return path.join(AUDIO_STORAGE_DIR, sanitizeRecordingId(recordingId));
}

export async function listSavedRecordings() {
  await ensureAudioStorageDir();

  const fileNames = await readdir(AUDIO_STORAGE_DIR);
  const recordings = [];

  for (const fileName of fileNames) {
    if (fileName.endsWith(METADATA_SUFFIX)) {
      continue;
    }

    const extension = path.extname(fileName).toLowerCase();

    if (!AUDIO_EXTENSIONS.has(extension)) {
      continue;
    }

    const filePath = getRecordingFilePath(fileName);
    const fileStats = await stat(filePath);

    if (!fileStats.isFile()) {
      continue;
    }

    const metadata = await readRecordingMetadata(fileName);

    recordings.push({
      id: fileName,
      name: fileName,
      createdAt: metadata?.createdAt || fileStats.birthtime.toISOString(),
      durationMs: Number(metadata?.durationMs || 0),
      size: fileStats.size,
      mimeType: metadata?.mimeType || getMimeTypeFromName(fileName),
    });
  }

  return recordings.sort(
    (left, right) => new Date(right.createdAt) - new Date(left.createdAt)
  );
}

export async function saveRecordingToDisk({
  buffer,
  fileName,
  createdAt,
  durationMs,
  mimeType,
}) {
  await ensureAudioStorageDir();

  const safeName = sanitizeRecordingId(fileName);
  const filePath = getRecordingFilePath(safeName);

  await writeFile(filePath, buffer);
  await writeFile(
    `${filePath}${METADATA_SUFFIX}`,
    JSON.stringify(
      {
        createdAt,
        durationMs: Number(durationMs || 0),
        mimeType: mimeType || getMimeTypeFromName(safeName),
      },
      null,
      2
    ),
    "utf8"
  );

  const fileStats = await stat(filePath);

  return {
    id: safeName,
    name: safeName,
    createdAt,
    durationMs: Number(durationMs || 0),
    size: fileStats.size,
    mimeType: mimeType || getMimeTypeFromName(safeName),
  };
}

export async function deleteSavedRecording(recordingId) {
  const safeName = sanitizeRecordingId(recordingId);
  const filePath = getRecordingFilePath(safeName);

  await rm(filePath, { force: true });
  await rm(`${filePath}${METADATA_SUFFIX}`, { force: true });
}

export async function clearSavedRecordings() {
  const recordings = await listSavedRecordings();

  await Promise.all(recordings.map((recording) => deleteSavedRecording(recording.id)));
}

export async function readSavedRecording(recordingId) {
  const safeName = sanitizeRecordingId(recordingId);
  const filePath = getRecordingFilePath(safeName);
  const fileStats = await stat(filePath);
  const buffer = await readFile(filePath);

  return {
    id: safeName,
    buffer,
    size: fileStats.size,
    mimeType: getMimeTypeFromName(safeName),
  };
}

async function readRecordingMetadata(fileName) {
  try {
    const filePath = getRecordingFilePath(fileName);
    const raw = await readFile(`${filePath}${METADATA_SUFFIX}`, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getMimeTypeFromName(fileName) {
  const extension = path.extname(fileName).toLowerCase();

  switch (extension) {
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "audio/mp4";
    case ".oga":
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}
