const API_BASE = "/api/recordings";

async function readJsonResponse(response) {
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    throw new Error(errorPayload?.error || "Request failed.");
  }

  return response.json();
}

export async function saveRecording(entry) {
  const formData = new FormData();

  formData.append(
    "file",
    entry.blob,
    entry.name || `${formatFallbackFileTimestamp()}.mp3`
  );
  formData.append("fileName", entry.name || "");
  formData.append("createdAt", entry.createdAt || new Date().toISOString());
  formData.append("durationMs", String(entry.durationMs || 0));
  formData.append("mimeType", entry.mimeType || entry.blob?.type || "");

  const response = await fetch(API_BASE, {
    method: "POST",
    body: formData,
  });

  return readJsonResponse(response);
}

export async function getAllRecordings() {
  const response = await fetch(API_BASE, {
    cache: "no-store",
  });

  const payload = await readJsonResponse(response);
  return payload.recordings ?? [];
}

export async function getRecordingById(id) {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to load the selected recording.");
  }

  const blob = await response.blob();

  return {
    id,
    mimeType: response.headers.get("content-type") || blob.type || "",
    blob,
  };
}

export async function deleteRecordingById(id) {
  const response = await fetch(`${API_BASE}?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  return readJsonResponse(response);
}

export async function clearAllRecordings() {
  const response = await fetch(API_BASE, {
    method: "DELETE",
  });

  return readJsonResponse(response);
}

function formatFallbackFileTimestamp() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}`;
}
