import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  clearSavedRecordings,
  listSavedRecordings,
  saveRecordingToDisk,
  deleteSavedRecording,
} from "@/lib/audio-storage";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const OUTPUT_MIME_TYPE = "audio/mpeg";

export async function GET() {
  try {
    const recordings = await listSavedRecordings();
    return NextResponse.json({ recordings });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to list recordings." },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const fileName = String(formData.get("fileName") || file?.name || "");
    const createdAt = String(formData.get("createdAt") || new Date().toISOString());
    const durationMs = Number(formData.get("durationMs") || 0);
    const mimeType = String(formData.get("mimeType") || file?.type || "");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No recording file was provided." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mp3Buffer = await convertAudioBufferToMp3({
      buffer,
      inputMimeType: mimeType,
      inputFileName: file?.name || fileName,
    });
    const recording = await saveRecordingToDisk({
      buffer: mp3Buffer,
      fileName: buildMp3FileName(createdAt),
      createdAt,
      durationMs,
      mimeType: OUTPUT_MIME_TYPE,
    });

    return NextResponse.json({ recording }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to save recording." },
      { status: 500 }
    );
  }
}

async function convertAudioBufferToMp3({
  buffer,
  inputMimeType,
  inputFileName,
}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "audiooffairlogger-"));
  const inputPath = path.join(
    tempDir,
    `input${getInputExtension(inputMimeType, inputFileName)}`
  );
  const outputPath = path.join(tempDir, "output.mp3");

  try {
    await writeFile(inputPath, buffer);

    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath,
    ]);

    return await readFile(outputPath);
  } catch (error) {
    const details = [error?.message, error?.stderr].filter(Boolean).join(" ");
    throw new Error(
      details || "Failed to convert the recording into an MP3 file."
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildMp3FileName(createdAt) {
  return `${formatFileTimestamp(createdAt)}.mp3`;
}

function formatFileTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value)
      .replace(/\D+/g, "")
      .slice(0, 14) || String(Date.now());
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${day}${month}${year}_${hours}${minutes}${seconds}`;
}

function getInputExtension(inputMimeType, inputFileName) {
  const normalizedMimeType = String(inputMimeType || "").toLowerCase();

  if (normalizedMimeType.includes("mp4")) {
    return ".mp4";
  }

  if (normalizedMimeType.includes("mpeg")) {
    return ".mp3";
  }

  if (normalizedMimeType.includes("ogg")) {
    return ".ogg";
  }

  if (normalizedMimeType.includes("wav")) {
    return ".wav";
  }

  if (normalizedMimeType.includes("webm")) {
    return ".webm";
  }

  const fileExtension = path.extname(String(inputFileName || "").trim());
  return fileExtension || ".bin";
}

export async function DELETE(request) {
  try {
    const recordingId = request.nextUrl.searchParams.get("id");

    if (recordingId) {
      await deleteSavedRecording(recordingId);
      return NextResponse.json({ success: true });
    }

    await clearSavedRecordings();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to delete recording(s)." },
      { status: 500 }
    );
  }
}
