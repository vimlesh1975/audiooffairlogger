"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import {
  clearAllRecordings,
  deleteRecordingById,
  getAllRecordings,
  getRecordingById,
  saveRecording,
} from "@/lib/recordings-db";

const DEFAULT_SEGMENT_DURATION_SECONDS = 10;
const MIN_SEGMENT_DURATION_SECONDS = 1;
const MAX_SEGMENT_DURATION_SECONDS = 3600;
const SEGMENT_DURATION_STORAGE_KEY = "audio-offairlogger-segment-duration-seconds";
const RECORDER_AUDIO_BITS_PER_SECOND = 320_000;
const METER_FLOOR_DB = -40;
const METER_CEILING_DB = 0;
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
  const [clipSearch, setClipSearch] = useState("");
  const [segmentDurationSeconds, setSegmentDurationSeconds] = useState(
    getStoredSegmentDurationSeconds
  );
  const [listenSource, setListenSource] = useState("playback");
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecordingUrl, setSelectedRecordingUrl] = useState("");
  const [selectedRecordingBlob, setSelectedRecordingBlob] = useState(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [completeWaveformStatus, setCompleteWaveformStatus] =
    useState("Standby");
  const [isRecording, setIsRecording] = useState(false);
  const [isInputMonitoring, setIsInputMonitoring] = useState(false);
  const [inputLevel, setInputLevel] = useState(METER_FLOOR_DB);
  const [peakLevel, setPeakLevel] = useState(METER_FLOOR_DB);
  const [playbackLevel, setPlaybackLevel] = useState(METER_FLOOR_DB);
  const [playbackPeakLevel, setPlaybackPeakLevel] = useState(METER_FLOOR_DB);
  const [playbackPositionMs, setPlaybackPositionMs] = useState(0);
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [selectedInputDeviceName, setSelectedInputDeviceName] =
    useState("Default microphone");
  const [segmentsThisSession, setSegmentsThisSession] = useState(0);
  const [timeUntilNextSaveMs, setTimeUntilNextSaveMs] =
    useState(() => getStoredSegmentDurationSeconds() * 1000);
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const waveformCanvasRef = useRef(null);
  const waveformDataRef = useRef(null);
  const animationFrameRef = useRef(null);
  const meterUpdatedAtRef = useRef(0);
  const previewAudioRef = useRef(null);
  const previewAudioContextRef = useRef(null);
  const previewAnalyserRef = useRef(null);
  const previewSourceNodeRef = useRef(null);
  const previewSourceElementRef = useRef(null);
  const previewWaveformCanvasRef = useRef(null);
  const previewWaveformDataRef = useRef(null);
  const completeWaveformCanvasRef = useRef(null);
  const completeWaveformPeaksRef = useRef(null);
  const waveformScrubberProgressRef = useRef(0);
  const isWaveformScrubbingRef = useRef(false);
  const previewAnimationFrameRef = useRef(null);
  const previewMeterUpdatedAtRef = useRef(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const listenSourceRef = useRef("playback");
  const segmentTickRef = useRef(null);
  const segmentStopTimeoutRef = useRef(null);
  const segmentStartedAtRef = useRef(0);
  const keepMonitoringInputRef = useRef(true);
  const shouldContinueRecordingRef = useRef(false);
  const segmentNumberRef = useRef(0);

  const selectedRecording =
    recordings.find((item) => item.id === selectedRecordingId) ?? null;
  const filteredRecordings = recordings.filter((item) =>
    item.name.toLowerCase().includes(clipSearch.trim().toLowerCase())
  );
  const segmentDurationMs = segmentDurationSeconds * 1000;
  const selectedClipDurationMs =
    playbackDurationMs || selectedRecording?.durationMs || 0;
  const selectedClipPositionMs = Math.min(
    playbackPositionMs,
    selectedClipDurationMs
  );

  const drawIdleCompleteWaveform = useCallback(() => {
    const canvas = completeWaveformCanvasRef.current;

    if (!canvas) {
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    drawWaveformBackground(context, width, height);

    context.lineWidth = Math.max(2, width * 0.002);
    context.strokeStyle = "rgba(186, 238, 255, 0.42)";
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
  }, []);

  const drawUnavailableCompleteWaveform = useCallback(() => {
    const canvas = completeWaveformCanvasRef.current;

    if (!canvas) {
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    drawWaveformBackground(context, width, height);

    context.save();
    context.setLineDash([10, 10]);
    context.lineWidth = Math.max(2, width * 0.002);
    context.strokeStyle = "rgba(255, 166, 166, 0.54)";
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
    context.restore();
  }, []);

  const drawCompleteWaveformPeaks = useCallback(() => {
    const canvas = completeWaveformCanvasRef.current;
    const waveform = completeWaveformPeaksRef.current;
    const peaks = waveform?.peaks;

    if (!canvas || !peaks?.length) {
      drawIdleCompleteWaveform();
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;
    const centerY = height / 2;
    const amplitudeHeight = height * 0.39;
    const columnWidth = width / peaks.length;
    drawWaveformBackground(context, width, height);

    function strokePeaks(startIndex, endIndex, color, shadowColor) {
      if (endIndex <= startIndex) {
        return;
      }

      context.save();
      context.lineCap = "round";
      context.lineWidth = Math.max(1, columnWidth * 0.74);
      context.strokeStyle = color;
      context.shadowBlur = 10;
      context.shadowColor = shadowColor;
      context.beginPath();

      for (let index = startIndex; index < endIndex; index += 1) {
        const peak = peaks[index];
        const minValue = Math.min(-0.012, peak.min);
        const maxValue = Math.max(0.012, peak.max);
        const x = ((index + 0.5) / peaks.length) * width;
        const topY = centerY - maxValue * amplitudeHeight;
        const bottomY = centerY - minValue * amplitudeHeight;

        context.moveTo(x, topY);
        context.lineTo(x, bottomY);
      }

      context.stroke();
      context.restore();
    }

    const scrubberProgress = Math.min(
      1,
      Math.max(0, waveformScrubberProgressRef.current)
    );
    const scrubberX = scrubberProgress * width;
    const scrubberPeakIndex = Math.round(scrubberProgress * peaks.length);

    strokePeaks(
      0,
      scrubberPeakIndex,
      "rgba(73, 174, 255, 0.98)",
      "rgba(73, 174, 255, 0.34)"
    );
    strokePeaks(
      scrubberPeakIndex,
      peaks.length,
      "rgba(255, 255, 255, 0.86)",
      "rgba(255, 255, 255, 0.2)"
    );

    context.save();
    context.strokeStyle = "rgba(255, 247, 234, 0.98)";
    context.lineWidth = Math.max(2, width * 0.0022);
    context.shadowBlur = 16;
    context.shadowColor = "rgba(255, 210, 129, 0.55)";
    context.beginPath();
    context.moveTo(scrubberX, 0);
    context.lineTo(scrubberX, height);
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = "#fff7ea";
    context.beginPath();
    context.arc(
      scrubberX,
      height / 2,
      Math.max(4, Math.min(7, height * 0.13)),
      0,
      Math.PI * 2
    );
    context.fill();
    context.restore();
  }, [drawIdleCompleteWaveform]);

  useEffect(() => {
    listenSourceRef.current = listenSource;
    applyAnalyserOutputRouting(
      analyserRef.current,
      audioContextRef.current,
      listenSource === "input"
    );
    applyAnalyserOutputRouting(
      previewAnalyserRef.current,
      previewAudioContextRef.current,
      listenSource === "playback"
    );
  }, [listenSource]);

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

    async function bootstrapInputMonitoring() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMessage("This browser cannot access the microphone recorder APIs.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          getPreferredAudioConstraints()
        );

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        await refreshSelectedInputDevice(stream);

        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;

          if (!AudioContextClass) {
            drawIdleWaveform();
            setIsInputMonitoring(true);
            return;
          }

          const context = new AudioContextClass();
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();

          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.84;

          source.connect(analyser);

          audioContextRef.current = context;
          sourceNodeRef.current = source;
          analyserRef.current = analyser;
          waveformDataRef.current = new Uint8Array(analyser.fftSize);
          meterUpdatedAtRef.current = 0;

          applyAnalyserOutputRouting(
            analyser,
            context,
            listenSourceRef.current === "input"
          );

          setInputLevel(METER_FLOOR_DB);
          setPeakLevel(METER_FLOOR_DB);

          if (context.state === "suspended") {
            void context.resume().catch(() => {});
          }

          function renderInitialWaveform() {
            const canvas = waveformCanvasRef.current;
            const data = waveformDataRef.current;

            if (!analyserRef.current || !canvas || !data) {
              drawIdleWaveform();
              return;
            }

            const preparedCanvas = prepareCanvas(canvas);

            if (!preparedCanvas) {
              return;
            }

            const { context: canvasContext, width, height } = preparedCanvas;

            analyserRef.current.getByteTimeDomainData(data);
            drawWaveformBackground(canvasContext, width, height);

            let sum = 0;
            let peak = 0;

            canvasContext.beginPath();

            for (let index = 0; index < data.length; index += 1) {
              const normalized = (data[index] - 128) / 128;
              const amplitude = Math.abs(normalized);
              const x = (index / (data.length - 1)) * width;
              const y = height / 2 + normalized * (height * 0.34);

              sum += normalized * normalized;
              peak = Math.max(peak, amplitude);

              if (index === 0) {
                canvasContext.moveTo(x, y);
              } else {
                canvasContext.lineTo(x, y);
              }
            }

            const rms = Math.sqrt(sum / data.length);
            const averageLevel = sampleToMeterDb(rms);
            const peakLevelValue = sampleToMeterDb(peak);
            const now = performance.now();

            canvasContext.lineWidth = Math.max(2, width * 0.0036);
            canvasContext.strokeStyle = "rgba(140, 244, 214, 0.98)";
            canvasContext.shadowBlur = 14;
            canvasContext.shadowColor = "rgba(140, 244, 214, 0.42)";
            canvasContext.stroke();
            canvasContext.shadowBlur = 0;

            if (now - meterUpdatedAtRef.current > 80) {
              setInputLevel(averageLevel);
              setPeakLevel(peakLevelValue);
              meterUpdatedAtRef.current = now;
            }

            animationFrameRef.current =
              window.requestAnimationFrame(renderInitialWaveform);
          }

          renderInitialWaveform();
        } catch {
          clearVisualizerFrame();

          if (sourceNodeRef.current) {
            sourceNodeRef.current.disconnect();
            sourceNodeRef.current = null;
          }

          if (analyserRef.current) {
            analyserRef.current.disconnect();
            analyserRef.current = null;
          }

          if (audioContextRef.current && audioContextRef.current.state !== "closed") {
            void audioContextRef.current.close().catch(() => {});
          }

          audioContextRef.current = null;
          waveformDataRef.current = null;
          meterUpdatedAtRef.current = 0;
          setInputLevel(METER_FLOOR_DB);
          setPeakLevel(METER_FLOOR_DB);
          drawIdleWaveform();
        }

        setIsInputMonitoring(true);
      } catch (error) {
        if (!cancelled) {
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }

          setIsInputMonitoring(false);
          setErrorMessage(getRecorderError(error));
        }
      }
    }

    void loadInitialRecordings();
    void bootstrapInputMonitoring();

    return () => {
      cancelled = true;
      keepMonitoringInputRef.current = false;
      shouldContinueRecordingRef.current = false;
      clearVisualizerFrame();

      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }

      if (analyserRef.current) {
        analyserRef.current.disconnect();
        analyserRef.current = null;
      }

      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close().catch(() => {});
      }

      audioContextRef.current = null;
      waveformDataRef.current = null;
      meterUpdatedAtRef.current = 0;

      if (previewAnimationFrameRef.current) {
        window.cancelAnimationFrame(previewAnimationFrameRef.current);
        previewAnimationFrameRef.current = null;
      }

      if (previewSourceNodeRef.current) {
        previewSourceNodeRef.current.disconnect();
        previewSourceNodeRef.current = null;
      }

      if (previewAnalyserRef.current) {
        previewAnalyserRef.current.disconnect();
        previewAnalyserRef.current = null;
      }

      if (
        previewAudioContextRef.current &&
        previewAudioContextRef.current.state !== "closed"
      ) {
        void previewAudioContextRef.current.close().catch(() => {});
      }

      previewAudioContextRef.current = null;
      previewSourceElementRef.current = null;
      previewWaveformDataRef.current = null;
      previewMeterUpdatedAtRef.current = 0;
      setIsInputMonitoring(false);
      clearSegmentStopTimeout();
      clearSegmentTick();
      stopStream();
    };
  }, []);

  useEffect(() => {
    drawIdleWaveform();
    drawIdlePreviewWaveform();
    drawIdleCompleteWaveform();

    function handleResize() {
      if (!analyserRef.current) {
        drawIdleWaveform();
      }

      if (!previewAnalyserRef.current) {
        drawIdlePreviewWaveform();
      }

      if (completeWaveformPeaksRef.current) {
        drawCompleteWaveformPeaks();
      } else {
        drawIdleCompleteWaveform();
      }
    }

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [drawCompleteWaveformPeaks, drawIdleCompleteWaveform]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }

    function handleDeviceChange() {
      if (streamRef.current?.active) {
        void refreshSelectedInputDevice(streamRef.current);
      }
    }

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange
      );
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      previewAudioRef.current?.pause();
      clearPreviewVisualizerFrame();

      if (previewSourceNodeRef.current) {
        previewSourceNodeRef.current.disconnect();
        previewSourceNodeRef.current = null;
      }

      if (previewAnalyserRef.current) {
        previewAnalyserRef.current.disconnect();
        previewAnalyserRef.current = null;
      }

      if (
        previewAudioContextRef.current &&
        previewAudioContextRef.current.state !== "closed"
      ) {
        void previewAudioContextRef.current.close().catch(() => {});
      }

      previewAudioContextRef.current = null;
      previewSourceElementRef.current = null;
      previewWaveformDataRef.current = null;
      previewMeterUpdatedAtRef.current = 0;
      setPlaybackLevel(METER_FLOOR_DB);
      setPlaybackPeakLevel(METER_FLOOR_DB);
      setPlaybackPositionMs(0);
      setPlaybackDurationMs(0);
      setIsPreviewPlaying(false);
      drawIdlePreviewWaveform();
      completeWaveformPeaksRef.current = null;
      setSelectedRecordingBlob(null);
      setCompleteWaveformStatus(selectedRecordingId ? "Loading" : "Standby");
      drawIdleCompleteWaveform();

      if (!selectedRecordingId) {
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
          setSelectedRecordingUrl((currentUrl) => {
            if (currentUrl) {
              URL.revokeObjectURL(currentUrl);
            }

            return "";
          });
          setCompleteWaveformStatus("Unavailable");
          return;
        }

        const previewUrl = URL.createObjectURL(entry.blob);

        setSelectedRecordingBlob(entry.blob);
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
  }, [drawIdleCompleteWaveform, selectedRecordingId]);

  useEffect(() => {
    return () => {
      if (selectedRecordingUrl) {
        URL.revokeObjectURL(selectedRecordingUrl);
      }
    };
  }, [selectedRecordingUrl]);

  useEffect(() => {
    if (completeWaveformPeaksRef.current) {
      drawCompleteWaveformPeaks();
    }
  }, [clipSearch, drawCompleteWaveformPeaks, selectedRecordingId]);

  useEffect(() => {
    waveformScrubberProgressRef.current =
      selectedClipDurationMs > 0
        ? Math.min(1, Math.max(0, selectedClipPositionMs / selectedClipDurationMs))
        : 0;

    if (completeWaveformPeaksRef.current) {
      drawCompleteWaveformPeaks();
    }
  }, [
    drawCompleteWaveformPeaks,
    selectedClipDurationMs,
    selectedClipPositionMs,
  ]);

  useEffect(() => {
    let cancelled = false;

    completeWaveformPeaksRef.current = null;

    if (!selectedRecordingBlob) {
      drawIdleCompleteWaveform();

      return () => {
        cancelled = true;
      };
    }

    async function renderCompleteWaveform() {
      setCompleteWaveformStatus("Rendering");
      drawIdleCompleteWaveform();

      try {
        const audioBuffer = await decodeAudioBlob(selectedRecordingBlob);

        if (cancelled) {
          return;
        }

        const preparedCanvas = completeWaveformCanvasRef.current
          ? prepareCanvas(completeWaveformCanvasRef.current)
          : null;
        const targetWidth = preparedCanvas?.width || 1200;
        const peaks = buildWaveformPeaks(
          audioBuffer,
          getCompleteWaveformBucketCount(targetWidth)
        );

        if (cancelled) {
          return;
        }

        completeWaveformPeaksRef.current = {
          duration: audioBuffer.duration,
          peaks,
        };

        drawCompleteWaveformPeaks();
        setCompleteWaveformStatus("Complete");
      } catch {
        if (!cancelled) {
          completeWaveformPeaksRef.current = null;
          drawUnavailableCompleteWaveform();
          setCompleteWaveformStatus("Unavailable");
        }
      }
    }

    void renderCompleteWaveform();

    return () => {
      cancelled = true;
    };
  }, [
    drawCompleteWaveformPeaks,
    drawIdleCompleteWaveform,
    drawUnavailableCompleteWaveform,
    selectedRecordingBlob,
  ]);

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

  function clearVisualizerFrame() {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function clearPreviewVisualizerFrame() {
    if (previewAnimationFrameRef.current) {
      window.cancelAnimationFrame(previewAnimationFrameRef.current);
      previewAnimationFrameRef.current = null;
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

  function releaseInputStream() {
    teardownVisualizer();
    stopStream();
    setIsInputMonitoring(false);
  }

  async function refreshSelectedInputDevice(stream = streamRef.current) {
    const activeTrack = stream?.getAudioTracks?.()[0];

    if (!activeTrack) {
      setSelectedInputDeviceName("Default microphone");
      return;
    }

    const settings = activeTrack.getSettings?.() ?? {};
    const activeDeviceId = settings.deviceId || "";
    let deviceName = activeTrack.label?.trim() || "Default microphone";

    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const matchingDevice = devices.find(
          (device) =>
            device.kind === "audioinput" && device.deviceId === activeDeviceId
        );

        if (matchingDevice?.label) {
          deviceName = matchingDevice.label;
        }
      } catch {
        // Keep the current track label as the best available fallback.
      }
    }

    setSelectedInputDeviceName(deviceName);
  }

  function drawIdleWaveform() {
    const canvas = waveformCanvasRef.current;

    if (!canvas) {
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    drawWaveformBackground(context, width, height);

    context.lineWidth = Math.max(2, width * 0.003);
    context.strokeStyle = "rgba(186, 238, 255, 0.5)";
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
  }

  function drawIdlePreviewWaveform() {
    const canvas = previewWaveformCanvasRef.current;

    if (!canvas) {
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    drawWaveformBackground(context, width, height);

    context.lineWidth = Math.max(2, width * 0.003);
    context.strokeStyle = "rgba(255, 210, 129, 0.54)";
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
  }

  function drawWaveformFrame() {
    const analyser = analyserRef.current;
    const canvas = waveformCanvasRef.current;
    const data = waveformDataRef.current;

    if (!analyser || !canvas || !data) {
      drawIdleWaveform();
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    analyser.getByteTimeDomainData(data);
    drawWaveformBackground(context, width, height);

    let sum = 0;
    let peak = 0;

    context.beginPath();

    for (let index = 0; index < data.length; index += 1) {
      const normalized = (data[index] - 128) / 128;
      const amplitude = Math.abs(normalized);
      const x = (index / (data.length - 1)) * width;
      const y = height / 2 + normalized * (height * 0.34);

      sum += normalized * normalized;
      peak = Math.max(peak, amplitude);

      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    const rms = Math.sqrt(sum / data.length);
    const averageLevel = sampleToMeterDb(rms);
    const peakLevelValue = sampleToMeterDb(peak);
    const now = performance.now();

    context.lineWidth = Math.max(2, width * 0.0036);
    context.strokeStyle = "rgba(140, 244, 214, 0.98)";
    context.shadowBlur = 14;
    context.shadowColor = "rgba(140, 244, 214, 0.42)";
    context.stroke();
    context.shadowBlur = 0;

    if (now - meterUpdatedAtRef.current > 80) {
      setInputLevel(averageLevel);
      setPeakLevel(peakLevelValue);
      meterUpdatedAtRef.current = now;
    }

    animationFrameRef.current = window.requestAnimationFrame(drawWaveformFrame);
  }

  function drawPreviewWaveformFrame() {
    const analyser = previewAnalyserRef.current;
    const canvas = previewWaveformCanvasRef.current;
    const data = previewWaveformDataRef.current;

    if (!analyser || !canvas || !data) {
      drawIdlePreviewWaveform();
      return;
    }

    const preparedCanvas = prepareCanvas(canvas);

    if (!preparedCanvas) {
      return;
    }

    const { context, width, height } = preparedCanvas;

    analyser.getByteTimeDomainData(data);
    drawWaveformBackground(context, width, height);

    let sum = 0;
    let peak = 0;

    context.beginPath();

    for (let index = 0; index < data.length; index += 1) {
      const normalized = (data[index] - 128) / 128;
      const amplitude = Math.abs(normalized);
      const x = (index / (data.length - 1)) * width;
      const y = height / 2 + normalized * (height * 0.34);

      sum += normalized * normalized;
      peak = Math.max(peak, amplitude);

      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    const rms = Math.sqrt(sum / data.length);
    const averageLevel = sampleToMeterDb(rms);
    const peakLevelValue = sampleToMeterDb(peak);
    const now = performance.now();

    context.lineWidth = Math.max(2, width * 0.0036);
    context.strokeStyle = "rgba(255, 210, 129, 0.98)";
    context.shadowBlur = 14;
    context.shadowColor = "rgba(255, 210, 129, 0.4)";
    context.stroke();
    context.shadowBlur = 0;

    if (now - previewMeterUpdatedAtRef.current > 80) {
      setPlaybackLevel(averageLevel);
      setPlaybackPeakLevel(peakLevelValue);
      previewMeterUpdatedAtRef.current = now;
    }

    previewAnimationFrameRef.current = window.requestAnimationFrame(
      drawPreviewWaveformFrame
    );
  }

  function setupVisualizer(stream) {
    teardownVisualizer(false);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      drawIdleWaveform();
      return;
    }

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();

    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.84;

    source.connect(analyser);

    audioContextRef.current = context;
    sourceNodeRef.current = source;
    analyserRef.current = analyser;
    waveformDataRef.current = new Uint8Array(analyser.fftSize);
    meterUpdatedAtRef.current = 0;

    applyAnalyserOutputRouting(
      analyser,
      context,
      listenSourceRef.current === "input"
    );

    setInputLevel(METER_FLOOR_DB);
    setPeakLevel(METER_FLOOR_DB);

    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }

    drawWaveformFrame();
  }

  function teardownVisualizer(resetMeters = true) {
    clearVisualizerFrame();

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {});
    }

    audioContextRef.current = null;
    waveformDataRef.current = null;
    meterUpdatedAtRef.current = 0;

    if (resetMeters) {
      setInputLevel(METER_FLOOR_DB);
      setPeakLevel(METER_FLOOR_DB);
      drawIdleWaveform();
    }
  }

  async function ensureInputStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access the microphone recorder APIs.");
    }

    if (streamRef.current?.active) {
      await refreshSelectedInputDevice(streamRef.current);

      if (!analyserRef.current) {
        try {
          setupVisualizer(streamRef.current);
        } catch {
          teardownVisualizer();
        }
      }

      return streamRef.current;
    }

    const stream = await navigator.mediaDevices.getUserMedia(
      getPreferredAudioConstraints()
    );
    streamRef.current = stream;
    await refreshSelectedInputDevice(stream);

    try {
      setupVisualizer(stream);
    } catch {
      teardownVisualizer();
    }

    return stream;
  }

  function setupPreviewVisualizer() {
    const audioElement = previewAudioRef.current;

    if (!audioElement) {
      drawIdlePreviewWaveform();
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      drawIdlePreviewWaveform();
      return;
    }

    if (previewSourceElementRef.current !== audioElement) {
      teardownPreviewVisualizer(false);

      const context = new AudioContextClass();
      const source = context.createMediaElementSource(audioElement);
      const analyser = context.createAnalyser();

      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.84;

      source.connect(analyser);
      applyAnalyserOutputRouting(
        analyser,
        context,
        listenSourceRef.current === "playback"
      );

      previewAudioContextRef.current = context;
      previewSourceNodeRef.current = source;
      previewAnalyserRef.current = analyser;
      previewSourceElementRef.current = audioElement;
      previewWaveformDataRef.current = new Uint8Array(analyser.fftSize);
    }

    const context = previewAudioContextRef.current;

    if (context?.state === "suspended") {
      void context.resume().catch(() => {});
    }

    clearPreviewVisualizerFrame();
    previewMeterUpdatedAtRef.current = 0;
    setPlaybackLevel(METER_FLOOR_DB);
    setPlaybackPeakLevel(METER_FLOOR_DB);
    drawPreviewWaveformFrame();
  }

  function teardownPreviewVisualizer(resetMeters = true) {
    clearPreviewVisualizerFrame();

    if (previewSourceNodeRef.current) {
      previewSourceNodeRef.current.disconnect();
      previewSourceNodeRef.current = null;
    }

    if (previewAnalyserRef.current) {
      previewAnalyserRef.current.disconnect();
      previewAnalyserRef.current = null;
    }

    if (
      previewAudioContextRef.current &&
      previewAudioContextRef.current.state !== "closed"
    ) {
      void previewAudioContextRef.current.close().catch(() => {});
    }

    previewAudioContextRef.current = null;
    previewSourceElementRef.current = null;
    previewWaveformDataRef.current = null;
    previewMeterUpdatedAtRef.current = 0;

    if (resetMeters) {
      setPlaybackLevel(METER_FLOOR_DB);
      setPlaybackPeakLevel(METER_FLOOR_DB);
      setIsPreviewPlaying(false);
      drawIdlePreviewWaveform();
    }
  }

  function stopPreviewVisualizer(resetMeters = true) {
    clearPreviewVisualizerFrame();

    if (
      previewAudioContextRef.current &&
      previewAudioContextRef.current.state === "running"
    ) {
      void previewAudioContextRef.current.suspend().catch(() => {});
    }

    if (resetMeters) {
      setPlaybackLevel(METER_FLOOR_DB);
      setPlaybackPeakLevel(METER_FLOOR_DB);
      drawIdlePreviewWaveform();
    }

    setIsPreviewPlaying(false);
  }

  function startSegmentTick() {
    clearSegmentTick();
    setTimeUntilNextSaveMs(segmentDurationMs);

    segmentTickRef.current = window.setInterval(() => {
      const elapsed = Date.now() - segmentStartedAtRef.current;
      const remaining = Math.max(0, segmentDurationMs - elapsed);
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
    setTimeUntilNextSaveMs(segmentDurationMs);

    const entry = {
      id: crypto.randomUUID(),
      name: buildFileName(createdAt),
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
      setTimeUntilNextSaveMs(segmentDurationMs);

      if (shouldContinueRecordingRef.current && streamRef.current?.active) {
        setIsRecording(true);
        startRecordingSegment(streamRef.current);
        return;
      }

      setIsRecording(false);

      if (keepMonitoringInputRef.current && streamRef.current?.active) {
        setIsInputMonitoring(true);
        return;
      }

      releaseInputStream();
    }
  }

  function handleRecorderFailure(message) {
    shouldContinueRecordingRef.current = false;
    clearSegmentStopTimeout();
    clearSegmentTick();
    segmentStartedAtRef.current = 0;
    recorderRef.current = null;
    setIsRecording(false);
    setTimeUntilNextSaveMs(segmentDurationMs);

    if (keepMonitoringInputRef.current && streamRef.current?.active) {
      setIsInputMonitoring(true);
    } else {
      releaseInputStream();
    }

    setErrorMessage(message);
  }

  function startRecordingSegment(stream) {
    const recorderConfig = createRecorder(stream);
    const recorder = recorderConfig.recorder;
    const segmentChunks = [];

    recorderRef.current = recorder;
    segmentStartedAtRef.current = Date.now();

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
    }, segmentDurationMs);
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
      const stream = await ensureInputStream();
      shouldContinueRecordingRef.current = true;
      segmentNumberRef.current = 0;
      setSegmentsThisSession(0);
      setSessionStartedAt(new Date().toISOString());
      setIsRecording(true);
      setIsInputMonitoring(true);
      startRecordingSegment(stream);
    } catch (error) {
      shouldContinueRecordingRef.current = false;
      clearSegmentStopTimeout();
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      recorderRef.current = null;
      setIsRecording(false);
      releaseInputStream();
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
      setIsRecording(false);

      if (!keepMonitoringInputRef.current) {
        releaseInputStream();
      }

      return;
    }

    if (recorder.state === "inactive") {
      clearSegmentTick();
      segmentStartedAtRef.current = 0;
      recorderRef.current = null;
      setIsRecording(false);

      if (!keepMonitoringInputRef.current) {
        releaseInputStream();
      }

      return;
    }

    recorder.stop();
  }

  function handlePreviewPlay() {
    setIsPreviewPlaying(true);

    try {
      setupPreviewVisualizer();
    } catch {
      stopPreviewVisualizer();
    }
  }

  function handlePreviewMetadata() {
    const audioElement = previewAudioRef.current;
    const durationMs =
      audioElement && Number.isFinite(audioElement.duration)
        ? audioElement.duration * 1000
        : selectedRecording?.durationMs || 0;

    setPlaybackDurationMs(durationMs);
    setPlaybackPositionMs((currentPositionMs) =>
      Math.min(currentPositionMs, durationMs)
    );
  }

  function handlePreviewTimeUpdate() {
    const audioElement = previewAudioRef.current;

    if (!audioElement) {
      return;
    }

    if (Number.isFinite(audioElement.currentTime)) {
      setPlaybackPositionMs(audioElement.currentTime * 1000);
    }
  }

  function handlePreviewPause() {
    stopPreviewVisualizer();
  }

  function handlePreviewEnded() {
    handlePreviewPause();
    setPlaybackPositionMs(selectedClipDurationMs);
  }

  async function handleSelectedClipPlayPause() {
    const audioElement = previewAudioRef.current;

    if (!audioElement || !selectedRecordingUrl || isLoadingPreview) {
      return;
    }

    if (!audioElement.paused && !audioElement.ended) {
      audioElement.pause();
      return;
    }

    if (audioElement.ended) {
      audioElement.currentTime = 0;
      setPlaybackPositionMs(0);
    }

    try {
      await audioElement.play();
    } catch (error) {
      setErrorMessage(error?.message || "Playback could not be started.");
    }
  }

  function handleSelectedClipSeek(value) {
    const nextPositionMs = Number(value);

    if (!Number.isFinite(nextPositionMs)) {
      return;
    }

    const clampedPositionMs = Math.min(
      Math.max(0, nextPositionMs),
      selectedClipDurationMs
    );
    const audioElement = previewAudioRef.current;

    setPlaybackPositionMs(clampedPositionMs);

    if (audioElement && selectedClipDurationMs > 0) {
      audioElement.currentTime = clampedPositionMs / 1000;
    }
  }

  function seekSelectedClipFromWaveform(event) {
    if (!selectedRecordingUrl || isLoadingPreview || selectedClipDurationMs <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();

    if (rect.width <= 0) {
      return;
    }

    const progress = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width)
    );

    handleSelectedClipSeek(progress * selectedClipDurationMs);
  }

  function handleWaveformPointerDown(event) {
    if (!selectedRecordingUrl || isLoadingPreview || selectedClipDurationMs <= 0) {
      return;
    }

    event.preventDefault();
    isWaveformScrubbingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekSelectedClipFromWaveform(event);
  }

  function handleWaveformPointerMove(event) {
    if (!isWaveformScrubbingRef.current) {
      return;
    }

    seekSelectedClipFromWaveform(event);
  }

  function finishWaveformScrub(event) {
    if (!isWaveformScrubbingRef.current) {
      return;
    }

    seekSelectedClipFromWaveform(event);
    isWaveformScrubbingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleWaveformKeyDown(event) {
    if (!selectedRecordingUrl || isLoadingPreview || selectedClipDurationMs <= 0) {
      return;
    }

    const stepMs = event.shiftKey ? 10_000 : 1000;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      handleSelectedClipSeek(selectedClipPositionMs - stepMs);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      handleSelectedClipSeek(selectedClipPositionMs + stepMs);
    } else if (event.key === "Home") {
      event.preventDefault();
      handleSelectedClipSeek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      handleSelectedClipSeek(selectedClipDurationMs);
    }
  }

  async function handleDelete(recordingId) {
    await deleteRecordingById(recordingId);
    await syncRecordings();
  }

  async function handleClearAll() {
    await clearAllRecordings();
    completeWaveformPeaksRef.current = null;
    setSelectedRecordingBlob(null);
    setCompleteWaveformStatus("Standby");
    drawIdleCompleteWaveform();
    setSelectedRecordingUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }

      return "";
    });
    await syncRecordings();
  }

  function handleSegmentDurationChange(value) {
    const nextDurationSeconds = clampSegmentDurationSeconds(value);
    setSegmentDurationSeconds(nextDurationSeconds);

    try {
      window.localStorage.setItem(
        SEGMENT_DURATION_STORAGE_KEY,
        String(nextDurationSeconds)
      );
    } catch {
      // Ignore storage failures and continue with the in-memory setting.
    }

    if (!isRecording) {
      setTimeUntilNextSaveMs(nextDurationSeconds * 1000);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <section className={styles.dashboard}>
          <section className={styles.recorderColumn}>
            <section className={styles.monitorPanel}>
              <div className={styles.monitorHeader}>
                <div>
                  <div className={styles.deviceIdentity}>
                    <span className={styles.metaLabel}>Input device</span>
                    <strong
                      className={styles.deviceValue}
                      title={selectedInputDeviceName}
                    >
                      {selectedInputDeviceName}
                    </strong>
                  </div>
                </div>
              </div>

              <div className={styles.monitorGrid}>
                <div className={styles.levelCard}>
                  <div className={styles.levelHeader}>
                    <div className={styles.levelTitleRow}>
                      <span className={styles.levelLabel}>
                        Input level in dBFS
                      </span>
                      <strong className={styles.levelValue}>
                        {formatDbNumber(inputLevel)}
                      </strong>
                    </div>
                  </div>

                  <div className={styles.levelTrack}>
                    <div
                      className={styles.levelFill}
                      style={{ width: `${dbToMeterPercent(inputLevel)}%` }}
                    />
                  </div>

                  <div className={styles.levelScale}>
                    <span>{formatDbNumber(METER_FLOOR_DB)}</span>
                    <span>{formatDbNumber(METER_CEILING_DB)}</span>
                  </div>
                </div>

                <div className={styles.waveformCard}>
                  <div className={styles.levelHeader}>
                    <span className={styles.levelLabel}>Waveform</span>
                    <strong className={styles.levelValue}>
                      {isInputMonitoring ? "Listening" : "Standby"}
                    </strong>
                  </div>

                  <canvas
                    ref={waveformCanvasRef}
                    className={styles.waveformCanvas}
                  />

                </div>
              </div>
            </section>

            <header className={styles.hero}>
              <div className={styles.heroGlow} />
              {isRecording ? (
                <span className={styles.badge}>Recording live</span>
              ) : null}

              <h1 className={styles.title}>Audio Off-Air Logger</h1>

              <div className={styles.statusRow}>
                <div className={styles.controls}>
                  <div
                    className={styles.listenSwitch}
                    role="group"
                    aria-label="Listen source"
                  >
                    <span className={styles.listenLabel}>Listen</span>

                    <button
                      className={`${styles.listenButton} ${
                        listenSource === "input" ? styles.listenButtonActive : ""
                      }`}
                      type="button"
                      onClick={() => setListenSource("input")}
                    >
                      Input
                    </button>

                    <button
                      className={`${styles.listenButton} ${
                        listenSource === "playback"
                          ? styles.listenButtonActive
                          : ""
                      }`}
                      type="button"
                      onClick={() => setListenSource("playback")}
                    >
                      Playback
                    </button>
                  </div>

                  <label className={styles.durationControl}>
                    <span className={styles.durationLabel}>Duration (sec)</span>
                    <input
                      className={styles.durationInput}
                      type="number"
                      min={MIN_SEGMENT_DURATION_SECONDS}
                      max={MAX_SEGMENT_DURATION_SECONDS}
                      step="1"
                      value={segmentDurationSeconds}
                      onChange={(event) =>
                        handleSegmentDurationChange(event.target.value)
                      }
                      disabled={isRecording}
                    />
                  </label>

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
                </div>

                {isRecording ? (
                  <div className={styles.liveStatus}>
                    <span className={styles.livePill}>
                      <span className={styles.liveDot} />
                      {`Next save in ${formatClock(timeUntilNextSaveMs)}`}
                    </span>

                    <span className={styles.sessionText}>
                      {sessionStartedAt
                        ? `This session saved ${segmentsThisSession} clip${
                            segmentsThisSession === 1 ? "" : "s"
                          }`
                        : ""}
                    </span>
                  </div>
                ) : !isInputMonitoring ? (
                  <div className={styles.liveStatus}>
                    <span className={styles.livePill}>
                      <span className={styles.liveDot} />
                      Waiting for microphone access
                    </span>

                    <span className={styles.sessionText}>
                      Files are saved automatically to D:\audio
                    </span>
                  </div>
                ) : null}
              </div>

              {errorMessage ? (
                <p className={styles.error}>{errorMessage}</p>
              ) : null}
            </header>

          </section>

          <section className={styles.playerColumn}>
            <article className={`${styles.panel} ${styles.filesPanel} ${styles.recordingsDock}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Saved clips</h2>
                  <p className={styles.panelSubtitle}>
                    Total clips: {recordings.length} | Search results:{" "}
                    {filteredRecordings.length}
                  </p>
                </div>
                <button
                  className={styles.deleteButtonAlt}
                  type="button"
                  onClick={() => void handleClearAll()}
                  disabled={recordings.length === 0}
                >
                  Delete all clips
                </button>
              </div>

              <input
                className={styles.searchInput}
                type="search"
                value={clipSearch}
                onChange={(event) => setClipSearch(event.target.value)}
                placeholder="Search clips"
                aria-label="Search clips"
              />

              {filteredRecordings.length > 0 ? (
                <ul className={styles.recordingList}>
                  {filteredRecordings.map((item) => {
                    const isSelected = selectedRecordingId === item.id;

                    return (
                      <li
                        key={item.id}
                        className={`${styles.recordingItem} ${
                          isSelected ? styles.recordingItemActive : ""
                        }`}
                        onClick={() => setSelectedRecordingId(item.id)}
                      >
                        <div
                          className={`${styles.recordingDetails} ${
                            isSelected ? styles.recordingDetailsActive : ""
                          }`}
                        >
                          <div className={styles.recordingSummaryStack}>
                            <button
                              className={styles.recordingNameButton}
                              type="button"
                            >
                              <span className={styles.recordingName}>
                                {item.name}
                              </span>
                            </button>

                            {isSelected ? (
                              <div className={styles.selectedClipTransport}>
                                <button
                                  className={styles.playPauseButton}
                                  type="button"
                                  onClick={() => void handleSelectedClipPlayPause()}
                                  disabled={
                                    !selectedRecordingUrl || isLoadingPreview
                                  }
                                  aria-pressed={isPreviewPlaying}
                                >
                                  {isPreviewPlaying ? "Pause" : "Play"}
                                </button>

                                <span className={styles.inlineTime}>
                                  {formatDuration(selectedClipPositionMs)} /{" "}
                                  {formatDuration(selectedClipDurationMs)}
                                </span>
                              </div>
                            ) : null}
                          </div>

                          {isSelected ? (
                            <div className={styles.inlineWaveformShell}>
                              <canvas
                                ref={completeWaveformCanvasRef}
                                className={`${styles.waveformCanvas} ${styles.inlineWaveformCanvas}`}
                                aria-label={`Complete waveform for ${item.name}`}
                                aria-valuemax={Math.round(selectedClipDurationMs)}
                                aria-valuemin={0}
                                aria-valuenow={Math.round(selectedClipPositionMs)}
                                onKeyDown={handleWaveformKeyDown}
                                onPointerCancel={finishWaveformScrub}
                                onPointerDown={handleWaveformPointerDown}
                                onPointerMove={handleWaveformPointerMove}
                                onPointerUp={finishWaveformScrub}
                                role="slider"
                                tabIndex={0}
                              />

                              {completeWaveformStatus !== "Complete" ? (
                                <span className={styles.inlineWaveformStatus}>
                                  {completeWaveformStatus}
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          <span className={styles.recordingMeta}>
                            {formatDuration(item.durationMs)}
                          </span>
                          <span className={styles.recordingMeta}>
                            {formatBytes(item.size)}
                          </span>
                        </div>

                        <div className={styles.recordingActions}>
                          <a
                            className={styles.secondaryLink}
                            href={`/api/recordings/${encodeURIComponent(item.id)}`}
                            download={item.name}
                            onClick={(event) => event.stopPropagation()}
                          >
                            Download
                          </a>

                          <button
                            className={styles.deleteButton}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDelete(item.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : recordings.length > 0 ? (
                <div className={styles.emptyState}>
                  <p>No matching clips.</p>
                </div>
              ) : null}
            </article>

            <article className={`${styles.panel} ${styles.playerPanel}`}>
              {!selectedRecording ? (
                <div className={styles.emptyState}>
                  <p>No clip selected.</p>
                  <p>
                    Choose a saved item from the list to load the preview player.
                  </p>
                </div>
              ) : (
                <div className={styles.previewStack}>
                  {selectedRecordingUrl ? (
                    <audio
                      key={selectedRecording.id}
                      ref={previewAudioRef}
                      className={styles.hiddenAudioPlayer}
                      onPlay={handlePreviewPlay}
                      onPause={handlePreviewPause}
                      onEnded={handlePreviewEnded}
                      onLoadedMetadata={handlePreviewMetadata}
                      onSeeked={handlePreviewTimeUpdate}
                      onTimeUpdate={handlePreviewTimeUpdate}
                      preload="metadata"
                      src={selectedRecordingUrl}
                    >
                      Your browser does not support audio playback.
                    </audio>
                  ) : null}

                  {isLoadingPreview ? (
                    <p className={styles.helperText}>Loading audio preview...</p>
                  ) : selectedRecordingUrl ? null : (
                    <p className={styles.helperText}>
                      Preview could not be loaded for this saved clip.
                    </p>
                  )}

                  <div className={styles.previewPlaybackRow}>
                    <div className={`${styles.levelCard} ${styles.previewStatCard}`}>
                      <div className={styles.levelHeader}>
                        <div className={styles.levelTitleRow}>
                          <span className={styles.levelLabel}>
                            Playback level in dBFS
                          </span>
                          <strong className={styles.levelValue}>
                            {formatDbNumber(playbackLevel)}
                          </strong>
                        </div>
                      </div>

                      <div className={styles.levelTrack}>
                        <div
                          className={styles.levelFillPlayback}
                          style={{
                            width: `${dbToMeterPercent(playbackLevel)}%`,
                          }}
                        />
                      </div>

                      <div className={styles.levelScale}>
                        <span>{formatDbNumber(METER_FLOOR_DB)}</span>
                        <span>{formatDbNumber(METER_CEILING_DB)}</span>
                      </div>
                    </div>

                    <div className={`${styles.waveformCard} ${styles.previewWaveformCard}`}>
                      <div className={styles.levelHeader}>
                        <span className={styles.levelLabel}>
                          Playback waveform
                        </span>
                        <strong className={styles.levelValue}>
                          {isPreviewPlaying ? "Active" : "Standby"}
                        </strong>
                      </div>

                      <canvas
                        ref={previewWaveformCanvasRef}
                        className={styles.waveformCanvas}
                      />
                    </div>
                  </div>

                </div>
              )}
            </article>
          </section>
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
        recorder: new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
        }),
        mimeType,
      };
    } catch {
      continue;
    }
  }

  return {
    recorder: new MediaRecorder(stream, {
      audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
    }),
    mimeType: "",
  };
}

function getPreferredAudioConstraints() {
  return {
    audio: {
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 24 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

function buildFileName(createdAt) {
  const timestamp = formatFileTimestamp(createdAt);
  return `${timestamp}.mp3`;
}

function formatFileTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value)
      .replace(/\D+/g, "")
      .slice(0, 14)
      .replace(/Z$/, "");
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${day}${month}${year}_${hours}${minutes}${seconds}`;
}

function clampSegmentDurationSeconds(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SEGMENT_DURATION_SECONDS;
  }

  return Math.min(
    MAX_SEGMENT_DURATION_SECONDS,
    Math.max(MIN_SEGMENT_DURATION_SECONDS, Math.round(numericValue))
  );
}

function applyAnalyserOutputRouting(analyser, context, shouldOutput) {
  if (!analyser || !context) {
    return;
  }

  try {
    analyser.disconnect();
  } catch {
    // Ignore disconnect issues and try to restore the desired state below.
  }

  if (!shouldOutput) {
    return;
  }

  try {
    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }

    analyser.connect(context.destination);
  } catch {
    // Ignore routing failures so analysis can continue without speaker output.
  }
}

function getStoredSegmentDurationSeconds() {
  if (typeof window === "undefined") {
    return DEFAULT_SEGMENT_DURATION_SECONDS;
  }

  try {
    const storedValue = window.localStorage.getItem(
      SEGMENT_DURATION_STORAGE_KEY
    );

    if (storedValue === null) {
      return DEFAULT_SEGMENT_DURATION_SECONDS;
    }

    return clampSegmentDurationSeconds(storedValue);
  } catch {
    return DEFAULT_SEGMENT_DURATION_SECONDS;
  }
}

function sampleToMeterDb(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return METER_FLOOR_DB;
  }

  const db = 20 * Math.log10(Math.max(value, 0.000001));

  return Math.round(Math.min(METER_CEILING_DB, Math.max(METER_FLOOR_DB, db)));
}

function dbToMeterPercent(value) {
  const db = Number.isFinite(value) ? value : METER_FLOOR_DB;
  const normalized = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);

  return Math.round(Math.min(1, Math.max(0, normalized)) * 100);
}

function formatDbNumber(value) {
  const db = Number.isFinite(value) ? value : METER_FLOOR_DB;

  return String(Math.round(db));
}

async function decodeAudioBlob(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Audio decoding is not available in this browser.");
  }

  const context = new AudioContextClass();

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await context.decodeAudioData(arrayBuffer);
  } finally {
    if (context.state !== "closed") {
      void context.close().catch(() => {});
    }
  }
}

function getCompleteWaveformBucketCount(width) {
  return Math.min(4096, Math.max(512, Math.ceil(width * 1.25)));
}

function buildWaveformPeaks(audioBuffer, bucketCount) {
  const sampleCount = audioBuffer.length;

  if (!sampleCount) {
    return [];
  }

  const safeBucketCount = Math.max(
    1,
    Math.min(Math.round(bucketCount), sampleCount)
  );
  const channels = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => audioBuffer.getChannelData(index)
  );
  const peaks = [];

  for (let bucketIndex = 0; bucketIndex < safeBucketCount; bucketIndex += 1) {
    const start = Math.floor((bucketIndex / safeBucketCount) * sampleCount);
    const end = Math.max(
      start + 1,
      Math.floor(((bucketIndex + 1) / safeBucketCount) * sampleCount)
    );
    const step = Math.max(1, Math.floor((end - start) / 420));
    let min = 1;
    let max = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += step) {
      for (const channelData of channels) {
        const value = channelData[sampleIndex] || 0;

        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }

    peaks.push({
      min: Math.max(-1, min === 1 ? 0 : min),
      max: Math.min(1, max === -1 ? 0 : max),
    });
  }

  return peaks;
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

function prepareCanvas(canvas) {
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  return { context, width, height };
}

function drawWaveformBackground(context, width, height) {
  const backgroundGradient = context.createLinearGradient(0, 0, width, height);
  backgroundGradient.addColorStop(0, "rgba(8, 18, 30, 0.98)");
  backgroundGradient.addColorStop(1, "rgba(13, 39, 56, 0.92)");

  context.clearRect(0, 0, width, height);
  context.fillStyle = backgroundGradient;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(255, 255, 255, 0.08)";
  context.lineWidth = 1;

  for (let line = 1; line <= 3; line += 1) {
    const y = (height / 4) * line;

    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  context.strokeStyle = "rgba(180, 227, 245, 0.16)";
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
}
