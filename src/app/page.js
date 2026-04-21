"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import {
  clearAllRecordings,
  deleteRecordingById,
  getAllRecordings,
  getRecordingById,
  saveRecording,
} from "@/lib/recordings-db";

const SEGMENT_DURATION_MS = 10_000;
const RECORDER_MIME_TYPES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

export default function Home() {
  const [recordings, setRecordings] = useState([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecordingUrl, setSelectedRecordingUrl] = useState("");
  const [selectedRecordingType, setSelectedRecordingType] = useState("");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [captureMimeType, setCaptureMimeType] = useState("");
  const [segmentsThisSession, setSegmentsThisSession] = useState(0);
  const [timeUntilNextSaveMs, setTimeUntilNextSaveMs] =
    useState(SEGMENT_DURATION_MS);
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const segmentTickRef = useRef(null);
  const segmentStopTimeoutRef = useRef(null);
  const segmentStartedAtRef = useRef(0);
  const shouldContinueRecordingRef = useRef(false);
  const segmentNumberRef = useRef(0);

  const selectedRecording =
    recordings.find((item) => item.id === selectedRecordingId) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function loadInitialRecordings() {
      const items = await getAllRecordings();

      if (cancelled) {
        return;
      }

      setRecordings(items);
      setSelectedRecordingId(items[0]?.id ?? null);
    }

    void loadInitialRecordings();

    return () => {
      cancelled = true;
      shouldContinueRecordingRef.current = false;
      clearSegmentStopTimeout();
      clearSegmentTick();
      stopStream();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (!selectedRecordingId) {
        setSelectedRecordingType("");
        setSelectedRecordingUrl((currentUrl) => {
          if (currentUrl) {
            URL.revokeObjectURL(currentUrl);
          }

          return "";
        });
        return;
      }

      setIsLoadingPreview(true);

      try {
        const entry = await getRecordingById(selectedRecordingId);

        if (cancelled) {
          return;
        }

        if (!entry) {
          setSelectedRecordingType("");
          setSelectedRecordingUrl((currentUrl) => {
            if (currentUrl) {
              URL.revokeObjectURL(currentUrl);
            }

            return "";
          });
          return;
        }

        const previewUrl = URL.createObjectURL(entry.blob);

        setSelectedRecordingType(entry.mimeType || entry.blob.type || "");
        setSelectedRecordingUrl((currentUrl) => {
          if (currentUrl) {
            URL.revokeObjectURL(currentUrl);
          }

          return previewUrl;
        });
      } finally {
        if (!cancelled) {
          setIsLoadingPreview(false);
        }
      }
    }

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [selectedRecordingId]);

  useEffect(() => {
    return () => {
      if (selectedRecordingUrl) {
        URL.revokeObjectURL(selectedRecordingUrl);
      }
    };
  }, [selectedRecordingUrl]);

  async function syncRecordings(preferredId) {
    const items = await getAllRecordings();

    setRecordings(items);
    setSelectedRecordingId((currentId) => {
      if (preferredId && items.some((item) => item.id === preferredId)) {
        return preferredId;
      }

      if (currentId && items.some((item) => item.id === currentId)) {
        return currentId;
      }

      return items[0]?.id ?? null;
    });
  }

  function clearSegmentTick() {
    if (segmentTickRef.current) {
      window.clearInterval(segmentTickRef.current);
      segmentTickRef.current = null;
    }
  }

  function clearSegmentStopTimeout() {
    if (segmentStopTimeoutRef.current) {
      window.clearTimeout(segmentStopTimeoutRef.current);
      segmentStopTimeoutRef.current = null;
    }
  }

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  function startSegmentTick() {
    clearSegmentTick();
    setTimeUntilNextSaveMs(SEGMENT_DURATION_MS);

    segmentTickRef.current = window.setInterval(() => {
      const elapsed = Date.now() - segmentStartedAtRef.current;
      const remaining = Math.max(0, SEGMENT_DURATION_MS - elapsed);
      setTimeUntilNextSaveMs(remaining);
    }, 1000);
  }

  async function saveClip(blob, durationMs, fallbackMimeType) {
    if (!blob || blob.size === 0) {
      return;
    }

    const segmentNumber = segmentNumberRef.current + 1;
    const createdAt = new Date().toISOString();
    const mimeType = blob.type || fallbackMimeType || "audio/webm";

    segmentNumberRef.current = segmentNumber;
    setSegmentsThisSession(segmentNumber);
    setTimeUntilNextSaveMs(SEGMENT_DURATION_MS);

    const entry = {
      id: crypto.randomUUID(),
      name: buildFileName(createdAt, segmentNumber, mimeType),
      createdAt,
      durationMs,
      size: blob.size,
      mimeType,
      blob,
    };

    await saveRecording(entry);
    await syncRecordings(entry.id);
  }

  async function finalizeStoppedSegment(blob, durationMs, mimeType) {
    try {
      await saveClip(blob, durationMs, mimeType);
    } catch (error) {
      setErrorMessage(error?.message || "Failed to save the recorded clip.");
    } finally {
      setTimeUntilNextSaveMs(SEGMENT_DURATION_MS);

      if (shouldContinueRecordingRef.current && streamRef.current?.active) {
        startRecordingSegment(streamRef.current);
        return;
      }

      stopStream();
      setIsRecording(false);
    }
  }

  function handleRecorderFailure(message) {
    shouldContinueRecordingRef.current = false;
    clearSegmentStopTimeout();
    clearSegmentTick();
    segmentStartedAtRef.current = 0;
    recorderRef.current = null;
    stopStream();
    setIsRecording(false);
    setTimeUntilNextSaveMs(SEGMENT_DURATION_MS);
    setErrorMessage(message);
  }

  function startRecordingSegment(stream) {
    const recorderConfig = createRecorder(stream);
    const recorder = recorderConfig.recorder;
    const segmentChunks = [];

    recorderRef.current = recorder;
    segmentStartedAtRef.current = Date.now();
    setCaptureMimeType(
      recorder.mimeType || recorderConfig.mimeType || "audio/webm"
    );

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        segmentChunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      handleRecorderFailure(
        event.error?.message || "Recording failed unexpectedly."
      );
    };

    recorder.onstop = () => {
      const durationMs = Math.max(1000, Date.now() - segmentStartedAtRef.current);
      const mimeType =
        recorder.mimeType ||
        recorderConfig.mimeType ||
        segmentChunks[0]?.type ||
        "audio/webm";
      const segmentBlob = createSegmentBlob(segmentChunks, mimeType);

      clearSegmentStopTimeout();
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      recorderRef.current = null;

      void finalizeStoppedSegment(segmentBlob, durationMs, mimeType);
    };

    try {
      recorder.start();
    } catch (error) {
      handleRecorderFailure(getRecorderError(error));
      return;
    }

    startSegmentTick();
    clearSegmentStopTimeout();
    segmentStopTimeoutRef.current = window.setTimeout(() => {
      const activeRecorder = recorderRef.current;

      if (activeRecorder && activeRecorder.state !== "inactive") {
        activeRecorder.stop();
      }
    }, SEGMENT_DURATION_MS);
  }

  async function startRecording() {
    if (isRecording) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErrorMessage("This browser cannot access the microphone recorder APIs.");
      return;
    }

    setErrorMessage("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      shouldContinueRecordingRef.current = true;
      segmentNumberRef.current = 0;
      setSegmentsThisSession(0);
      setSessionStartedAt(new Date().toISOString());
      setIsRecording(true);
      startRecordingSegment(stream);
    } catch (error) {
      shouldContinueRecordingRef.current = false;
      clearSegmentStopTimeout();
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      stopStream();
      recorderRef.current = null;
      setIsRecording(false);
      setErrorMessage(getRecorderError(error));
    }
  }

  function stopRecording() {
    shouldContinueRecordingRef.current = false;
    clearSegmentStopTimeout();

    const recorder = recorderRef.current;

    if (!recorder) {
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      stopStream();
      setIsRecording(false);
      return;
    }

    if (recorder.state === "inactive") {
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      stopStream();
      recorderRef.current = null;
      setIsRecording(false);
      return;
    }

    recorder.stop();
  }

  async function handleDelete(recordingId) {
    await deleteRecordingById(recordingId);
    await syncRecordings();
  }

  async function handleClearAll() {
    await clearAllRecordings();
    setSelectedRecordingType("");
    setSelectedRecordingUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }

      return "";
    });
    await syncRecordings();
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.hero}>
          <div className={styles.heroGlow} />
          <span className={styles.badge}>
            {isRecording ? "Recording live" : "Mic recorder ready"}
          </span>

          <h1 className={styles.title}>Audio Off-Air Logger</h1>
          <p className={styles.lead}>
            Record the default audio input continuously in 10-second clips, keep a
            saved list in the browser, and click any clip to preview it instantly.
          </p>

          <div className={styles.metaGrid}>
            <article className={styles.metaCard}>
              <span className={styles.metaLabel}>Input</span>
              <strong className={styles.metaValue}>Default microphone</strong>
            </article>
            <article className={styles.metaCard}>
              <span className={styles.metaLabel}>Clip length</span>
              <strong className={styles.metaValue}>10 seconds</strong>
            </article>
            <article className={styles.metaCard}>
              <span className={styles.metaLabel}>Saved clips</span>
              <strong className={styles.metaValue}>{recordings.length}</strong>
            </article>
            <article className={styles.metaCard}>
              <span className={styles.metaLabel}>Capture format</span>
              <strong className={styles.metaValue}>
                {captureMimeType
                  ? formatMimeType(captureMimeType)
                  : "Auto on start"}
              </strong>
            </article>
          </div>

          <div className={styles.statusRow}>
            <div className={styles.controls}>
              <button
                className={styles.primaryButton}
                type="button"
                onClick={startRecording}
                disabled={isRecording}
              >
                Start recording
              </button>

              <button
                className={styles.secondaryButton}
                type="button"
                onClick={stopRecording}
                disabled={!isRecording}
              >
                Stop recording
              </button>

              <button
                className={styles.ghostButton}
                type="button"
                onClick={() => void handleClearAll()}
                disabled={recordings.length === 0}
              >
                Clear saved clips
              </button>
            </div>

            <div className={styles.liveStatus}>
              <span className={styles.livePill}>
                <span className={styles.liveDot} />
                {isRecording
                  ? `Next save in ${formatClock(timeUntilNextSaveMs)}`
                  : "Waiting for microphone access"}
              </span>

              <span className={styles.sessionText}>
                {sessionStartedAt
                  ? `This session saved ${segmentsThisSession} clip${
                      segmentsThisSession === 1 ? "" : "s"
                    }`
                  : "Files stay on this device in IndexedDB storage"}
              </span>
            </div>
          </div>

          {captureMimeType && !captureMimeType.includes("mp4") ? (
            <p className={styles.warning}>
              MP4 recording is not exposed by this browser, so the logger will
              fall back to WebM. Safari usually offers the best MP4 support.
            </p>
          ) : null}

          {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
        </header>

        <section className={styles.dashboard}>
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2 className={styles.panelTitle}>Recorded files</h2>
                <p className={styles.panelSubtitle}>
                  New clips appear automatically every 10 seconds while recording.
                </p>
              </div>
              <span className={styles.listCount}>
                {recordings.length} item{recordings.length === 1 ? "" : "s"}
              </span>
            </div>

            {recordings.length === 0 ? (
              <div className={styles.emptyState}>
                <p>No recordings saved yet.</p>
                <p>
                  Press <strong>Start recording</strong> to request microphone
                  access and begin logging 10-second clips.
                </p>
              </div>
            ) : (
              <ul className={styles.recordingList}>
                {recordings.map((item) => (
                  <li
                    key={item.id}
                    className={`${styles.recordingItem} ${
                      selectedRecordingId === item.id
                        ? styles.recordingItemActive
                        : ""
                    }`}
                  >
                    <button
                      className={styles.recordingButton}
                      type="button"
                      onClick={() => setSelectedRecordingId(item.id)}
                    >
                      <span className={styles.recordingName}>{item.name}</span>
                      <span className={styles.recordingMeta}>
                        {formatDateTime(item.createdAt)}
                      </span>
                      <span className={styles.recordingMeta}>
                        {formatDuration(item.durationMs)} | {formatBytes(item.size)} |{" "}
                        {formatMimeType(item.mimeType)}
                      </span>
                    </button>

                    <button
                      className={styles.deleteButton}
                      type="button"
                      onClick={() => void handleDelete(item.id)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2 className={styles.panelTitle}>Preview player</h2>
                <p className={styles.panelSubtitle}>
                  Select any saved clip to listen before exporting or deleting it.
                </p>
              </div>
            </div>

            {!selectedRecording ? (
              <div className={styles.emptyState}>
                <p>No clip selected.</p>
                <p>Choose a saved item from the list to load the preview player.</p>
              </div>
            ) : (
              <div className={styles.previewStack}>
                <div className={styles.previewSummary}>
                  <h3 className={styles.previewName}>{selectedRecording.name}</h3>
                  <p className={styles.previewTimestamp}>
                    Created {formatDateTime(selectedRecording.createdAt)}
                  </p>
                </div>

                <div className={styles.previewInfoGrid}>
                  <div className={styles.infoBlock}>
                    <span className={styles.infoLabel}>Duration</span>
                    <strong className={styles.infoValue}>
                      {formatDuration(selectedRecording.durationMs)}
                    </strong>
                  </div>
                  <div className={styles.infoBlock}>
                    <span className={styles.infoLabel}>File size</span>
                    <strong className={styles.infoValue}>
                      {formatBytes(selectedRecording.size)}
                    </strong>
                  </div>
                  <div className={styles.infoBlock}>
                    <span className={styles.infoLabel}>Encoding</span>
                    <strong className={styles.infoValue}>
                      {formatMimeType(selectedRecording.mimeType)}
                    </strong>
                  </div>
                  <div className={styles.infoBlock}>
                    <span className={styles.infoLabel}>Preview source</span>
                    <strong className={styles.infoValue}>
                      {selectedRecordingType
                        ? formatMimeType(selectedRecordingType)
                        : "Loading"}
                    </strong>
                  </div>
                </div>

                <div className={styles.audioShell}>
                  {isLoadingPreview ? (
                    <p className={styles.helperText}>Loading audio preview...</p>
                  ) : selectedRecordingUrl ? (
                    <audio
                      className={styles.audioPlayer}
                      controls
                      preload="metadata"
                      src={selectedRecordingUrl}
                    >
                      Your browser does not support audio playback.
                    </audio>
                  ) : (
                    <p className={styles.helperText}>
                      Preview could not be loaded for this saved clip.
                    </p>
                  )}
                </div>

                <div className={styles.previewActions}>
                  {selectedRecordingUrl ? (
                    <a
                      className={styles.secondaryLink}
                      href={selectedRecordingUrl}
                      download={selectedRecording.name}
                    >
                      Download clip
                    </a>
                  ) : null}

                  <button
                    className={styles.deleteButtonAlt}
                    type="button"
                    onClick={() => void handleDelete(selectedRecording.id)}
                  >
                    Delete this clip
                  </button>
                </div>

                <p className={styles.helperText}>
                  Continuous capture uses the browser&apos;s default audio input.
                  Every saved clip stays in local browser storage until you remove
                  it.
                </p>
              </div>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}

function createSegmentBlob(chunks, mimeType) {
  if (!chunks.length) {
    return null;
  }

  const blobType = chunks[0]?.type || mimeType || "audio/webm";
  return new Blob(chunks, { type: blobType });
}

function createRecorder(stream) {
  for (const mimeType of RECORDER_MIME_TYPES) {
    if (
      typeof MediaRecorder.isTypeSupported === "function" &&
      !MediaRecorder.isTypeSupported(mimeType)
    ) {
      continue;
    }

    try {
      return {
        recorder: new MediaRecorder(stream, { mimeType }),
        mimeType,
      };
    } catch {
      continue;
    }
  }

  return {
    recorder: new MediaRecorder(stream),
    mimeType: "",
  };
}

function buildFileName(createdAt, segmentNumber, mimeType) {
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const segmentLabel = String(segmentNumber).padStart(3, "0");
  return `audio-log-${timestamp}-segment-${segmentLabel}.${getFileExtension(
    mimeType
  )}`;
}

function getFileExtension(mimeType) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  return "bin";
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatDuration(durationMs) {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** index;

  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatMimeType(mimeType) {
  if (!mimeType) {
    return "Unknown";
  }

  return mimeType.replace("audio/", "").toUpperCase();
}

function getRecorderError(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone permission was denied. Allow access and try again.";
  }

  if (error?.name === "NotFoundError") {
    return "No default audio input device was found.";
  }

  return error?.message || "The recorder could not be started.";
}
