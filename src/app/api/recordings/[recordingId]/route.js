import { NextResponse } from "next/server";
import {
  getMimeTypeFromName,
  readSavedRecording,
  sanitizeRecordingId,
} from "@/lib/audio-storage";

export const runtime = "nodejs";

export async function GET(request, context) {
  try {
    const params = await context.params;
    const recordingId = sanitizeRecordingId(params.recordingId);
    const { buffer, size } = await readSavedRecording(recordingId);
    const mimeType = getMimeTypeFromName(recordingId);
    const rangeHeader = request.headers.get("range");

    if (!rangeHeader) {
      return new NextResponse(buffer, {
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(size),
          "Content-Type": mimeType,
        },
      });
    }

    const matches = /bytes=(\d+)-(\d*)/.exec(rangeHeader);

    if (!matches) {
      return new NextResponse("Invalid range", { status: 416 });
    }

    const start = Number(matches[1]);
    const end = matches[2] ? Number(matches[2]) : size - 1;
    const safeEnd = Math.min(end, size - 1);

    if (!Number.isFinite(start) || start < 0 || start >= size || start > safeEnd) {
      return new NextResponse("Requested range not satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
        },
      });
    }

    const chunk = buffer.subarray(start, safeEnd + 1);

    return new NextResponse(chunk, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${safeEnd}/${size}`,
        "Content-Type": mimeType,
      },
    });
  } catch {
    return new NextResponse("Recording not found.", { status: 404 });
  }
}
