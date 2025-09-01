import React, { useEffect, useRef, useState } from "react";
import './App.css';


/**
 * CameraRecorder
 * - Opens the camera + mic
 * - 5s countdown before recording starts
 * - Records exactly 60s (auto-stops)
 * - Lets you upload the recorded file OR a user-selected file
 * - Validates ~60s duration on chosen files
 * - Sends video via multipart/form-data to a FastAPI endpoint
 */

const API_URL = "https://taichi-1.onrender.com/analyze_video/"; // updated endpoint

function pickSupportedMime() {
  const options = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4", // some browsers may allow this, most will not via MediaRecorder
  ];
  for (const type of options) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return { mimeType: type };
    }
  }
  return undefined; // let browser choose
}

function formatSeconds(total) {
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(total % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

export default function CameraRecorder() {
  const videoRef = useRef(null);
  const previewRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const stopTimerRef = useRef(null);

  const [status, setStatus] = useState("idle"); 
  const [countdown, setCountdown] = useState(5);
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [blobUrl, setBlobUrl] = useState(null);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedDuration, setSelectedDuration] = useState(null);
  const [accuracy, setAccuracy] = useState(null); // NEW state

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const ensureStream = async () => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setStatus("ready");
    return stream;
  };

  const start = async () => {
    setError("");
    setBlobUrl(null);
    setRecordedBlob(null);
    setAccuracy(null);

    try {
      const stream = await ensureStream();
      chunksRef.current = [];

      setCountdown(5);
      setStatus("countdown");

      let remaining = 5;
      countdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          clearInterval(countdownTimerRef.current);
          beginRecording(stream);
        }
      }, 1000);
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  const beginRecording = (stream) => {
    try {
      const opts = pickSupportedMime();
      const rec = new MediaRecorder(stream, opts);
      recorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setBlobUrl(url);
        setStatus("finished");
        setSecondsLeft(60);
      };

      rec.start();
      setStatus("recording");
      setSecondsLeft(60);

      const startedAt = Date.now();
      const tick = () => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const left = Math.max(0, 60 - elapsed);
        setSecondsLeft(left);
        if (left <= 0 || rec.state !== "recording") return;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      stopTimerRef.current = setTimeout(() => stop(), 60_000);
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  const stop = () => {
    try {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    } catch {}
  };

  const cleanup = () => {
    try {
      stop();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    } catch {}
  };

  const validateDurationApprox60 = async (file) => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = document.createElement("video");
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        const d = el.duration;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(NaN);
      };
      el.src = url;
    });
  };

  const handleFilePick = async (e) => {
    const f = e.target.files?.[0];
    setSelectedFile(null);
    setSelectedDuration(null);
    setError("");
    if (!f) return;
    const dur = await validateDurationApprox60(f);
    setSelectedDuration(dur);
    if (!isFinite(dur) || Math.abs(dur - 60) > 3) {
      setError(`Selected video must be ~60s. Detected ${isFinite(dur) ? dur.toFixed(2) : "unknown"}s.`);
      return;
    }
    setSelectedFile(f);
  };

  const send = async (file, sourceLabel) => {
    try {
      setIsSending(true);
      setError("");
      const fd = new FormData();
      fd.append("file", file, file.name || `${sourceLabel || "video"}.webm`);
      fd.append("source", sourceLabel || "unknown");

      const res = await fetch(API_URL, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      const json = await res.json().catch(() => ({}));

      if (json && json.probabilities !== undefined) {
        setAccuracy((json.probabilities * 100).toFixed(2)); // convert to %
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsSending(false);
    }
  };

  const sendRecorded = async () => {
    if (!recordedBlob) return;
    const named = new File([recordedBlob], `recorded-${Date.now()}.webm`, { type: recordedBlob.type || "video/webm" });
    await send(named, "recorded");
  };

  const sendSelected = async () => {
    if (!selectedFile) return;
    await send(selectedFile, "uploaded");
  };

  return (
  <div className="flex flex-col lg:flex-row gap-8 max-w-6xl mx-auto items-center justify-center">


    <div className="flex flex-col items-center gap-8">
      <h1 className="">🎥 Camera Recorder</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto">
        {/* Camera Section */}
        <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800 flex flex-col items-center">
          <div className="relative w-full">
            <video ref={videoRef} className="w-full aspect-video bg-black rounded-xl" muted playsInline autoPlay />
            {status === "countdown" && (
              <div className="absolute inset-0 flex items-center justify-center text-6xl font-bold text-white bg-black/40">
                {countdown}
              </div>
            )}
            {status === "recording" && (
              <span className="absolute top-3 left-3 px-3 py-1 rounded-full bg-red-600 text-xs font-bold animate-pulse">
                ● Recording {formatSeconds(secondsLeft)}
              </span>
            )}
          </div>

          <div className="flex gap-4 mt-6">
            <button onClick={ensureStream} disabled={status!=="idle"&&status!=="ready"} 
              className="p-4 rounded-full bg-slate-700 hover:bg-slate-600 disabled:opacity-40">
              📷
            </button>
            <button onClick={start} disabled={status!=="ready"&&status!=="finished"} 
              className="p-4 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40">
              ▶️
            </button>
            <button onClick={stop} disabled={status!=="recording"&&status!=="countdown"} 
              className="p-4 rounded-full bg-red-700 hover:bg-red-600 disabled:opacity-40">
              ⏹️
            </button>
          </div>

          {error && <div className="mt-4 text-sm text-red-400">{error}</div>}
        </div>

        {/* Preview & Upload */}
        <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800">
          <h2 className="text-lg font-semibold mb-3">Preview & Upload</h2>
          
          <video ref={previewRef} className="w-full aspect-video bg-black rounded-xl mb-4" controls src={blobUrl || undefined} />

          <div className="flex gap-3 mb-4">
            <button onClick={sendRecorded} disabled={!recordedBlob || isSending}
              className="flex-1 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
              🚀 Send Recorded
            </button>
            <a download href={blobUrl || undefined}
              className={`flex-1 px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 ${!blobUrl ? "opacity-40 pointer-events-none" : ""}`}>
              💾 Download
            </a>
          </div>

          <label className="block text-sm mb-2">Or upload a 1-minute video:</label>
          <input type="file" accept="video/*" onChange={handleFilePick}
            className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white hover:file:bg-blue-500" />
          
          {selectedFile && (
            <p className="mt-2 text-sm text-slate-300">
              {selectedFile.name} — ~{selectedDuration?.toFixed(2)}s
            </p>
          )}
          <button onClick={sendSelected} disabled={!selectedFile || isSending}
            className="mt-3 w-full px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
            📤 Send Uploaded
          </button>

          {accuracy !== null && (
          <div className="mt-6 flex justify-center">
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* Percentage text in center */}
              <span className="absolute text-lg font-bold text-white">{accuracy}%</span>
              
              {/* Circle background + foreground */}
              <svg className="w-full h-full -rotate-90">
                {/* Background circle (gray track) */}
                <circle
                  cx="50%" cy="50%" r="45%"
                  stroke="gray"
                  strokeWidth="8"
                  fill="none"
                />
                {/* Foreground circle (progress ring) */}
                <circle
                  cx="50%" cy="50%" r="45%"
                  stroke="lime"
                  strokeWidth="8"
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray="282.6"             // full circumference
                  strokeDashoffset={286.6-(accuracy / 100) * 282.6}
                />
              </svg>
            </div>
          </div>
          
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
