"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const MIN_RECORDING_DURATION = 500;
const MAX_RECORDING_DURATION = 60000;

export type VoiceRecorderError =
  | "permission_denied"
  | "no_microphone"
  | "browser_unsupported"
  | "unknown";

function getSupportedMimeType(): { mimeType: string; extension: string } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "audio/webm", extension: "webm" };
  }
  const types = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4", extension: "mp4" },
    { mimeType: "audio/wav", extension: "wav" },
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type.mimeType)) return type;
  }
  return { mimeType: "", extension: "webm" };
}

let sharedAudioContext: AudioContext | null = null;

function getOrCreateAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContext();
  }
  if (sharedAudioContext.state === "suspended") {
    sharedAudioContext.resume();
  }
  return sharedAudioContext;
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<VoiceRecorderError | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mimeTypeRef = useRef<{ mimeType: string; extension: string }>({
    mimeType: "",
    extension: "webm",
  });

  const cleanup = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (maxDurationTimeoutRef.current) {
      clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    setAnalyserNode(null);
    setDuration(0);
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("browser_unsupported");
      return;
    }

    // Pre-check permission state so we surface a clear "denied" error instead
    // of letting getUserMedia throw a generic NotAllowedError on the web when
    // the user previously tapped "Block".
    // Skip this check on Capacitor: the WebView's internal permission state is
    // separate from Android's OS-level permission and can incorrectly report
    // "denied" even when RECORD_AUDIO is granted in Android Settings.
    const isCapacitorWebView =
      typeof window !== "undefined" &&
      (window.location.protocol === "capacitor:" ||
        (window.location.hostname === "localhost" &&
          (window as { Capacitor?: unknown }).Capacitor != null));

    if (!isCapacitorWebView && navigator.permissions) {
      try {
        const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (perm.state === "denied") {
          setError("permission_denied");
          return;
        }
      } catch {
        // navigator.permissions.query may throw — ignore and let getUserMedia
        // surface the real error below.
      }
    }

    cleanup();
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      mimeTypeRef.current = getSupportedMimeType();

      const options: MediaRecorderOptions = {};
      if (mimeTypeRef.current.mimeType) {
        options.mimeType = mimeTypeRef.current.mimeType;
      }

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      const audioContext = getOrCreateAudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      setAnalyserNode(analyser);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      mediaRecorder.start(100);
      startTimeRef.current = Date.now();
      setIsRecording(true);

      durationIntervalRef.current = setInterval(() => {
        setDuration(Date.now() - startTimeRef.current);
      }, 100);

      maxDurationTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          stopRecording();
        }
      }, MAX_RECORDING_DURATION);
    } catch (err) {
      cleanup();
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          setError("permission_denied");
        } else if (
          err.name === "NotFoundError" ||
          err.name === "DevicesNotFoundError"
        ) {
          setError("no_microphone");
        } else {
          setError("unknown");
        }
      } else {
        setError("unknown");
      }
    }
  }, [cleanup]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const mediaRecorder = mediaRecorderRef.current;
      const recordingDuration = Date.now() - startTimeRef.current;

      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (maxDurationTimeoutRef.current) {
        clearTimeout(maxDurationTimeoutRef.current);
        maxDurationTimeoutRef.current = null;
      }

      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        cleanup();
        setIsRecording(false);
        resolve(null);
        return;
      }

      if (recordingDuration < MIN_RECORDING_DURATION) {
        cleanup();
        setIsRecording(false);
        resolve(null);
        return;
      }

      mediaRecorder.onstop = () => {
        const mimeType = mimeTypeRef.current.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        chunksRef.current = [];
        mediaRecorderRef.current = null;
        setAnalyserNode(null);
        setIsRecording(false);
        setDuration(0);
        resolve(blob);
      };

      try {
        mediaRecorder.stop();
      } catch {
        cleanup();
        setIsRecording(false);
        resolve(null);
      }
    });
  }, [cleanup]);

  const cancelRecording = useCallback(() => {
    cleanup();
    setIsRecording(false);
  }, [cleanup]);

  const clearError = useCallback(() => setError(null), []);

  return {
    isRecording,
    isTranscribing,
    setIsTranscribing,
    error,
    analyserNode,
    duration,
    startRecording,
    stopRecording,
    cancelRecording,
    clearError,
  };
}

export function getAudioExtension(): string {
  return getSupportedMimeType().extension;
}
