import React, { useEffect, useRef, useState } from "react";
import { Platform, View, Text, Button, StyleSheet } from "react-native";

// Only available in Expo (mobile)
import { Camera } from "expo-camera";

const API_URL = "https://taichi-1.onrender.com/analyze_video/";

function formatSeconds(total) {
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = Math.floor(total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function CameraRecorder() {
  // Common state
  const [status, setStatus] = useState("idle");
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [countdown, setCountdown] = useState(5);
  const [error, setError] = useState("");
  const [accuracy, setAccuracy] = useState(null);

  // --- Web recording refs ---
  const videoRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const [blobUrl, setBlobUrl] = useState(null);
  const [recordedBlob, setRecordedBlob] = useState(null);

  // --- Mobile recording refs ---
  const cameraRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [videoUri, setVideoUri] = useState(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, []);

  const cleanup = () => {
    try {
      if (Platform.OS === "web") {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    } catch {}
  };

  // --- Web: ensure stream ---
  const ensureStream = async () => {
    if (Platform.OS !== "web") return;
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

  // --- Web: start recording ---
  const startWebRecording = async () => {
    try {
      setError("");
      setBlobUrl(null);
      setRecordedBlob(null);
      const stream = await ensureStream();
      chunksRef.current = [];

      setCountdown(5);
      setStatus("countdown");

      let remaining = 5;
      const timer = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          clearInterval(timer);
          beginWebRecording(stream);
        }
      }, 1000);
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  const beginWebRecording = (stream) => {
    const rec = new MediaRecorder(stream);
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

    setTimeout(() => stopWebRecording(), 60_000);
  };

  const stopWebRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    } catch {}
  };

  // --- Mobile: start recording ---
  const startMobileRecording = async () => {
    if (!cameraRef.current) return;
    setRecording(true);
    setError("");
    setVideoUri(null);
    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: 60,
        quality: "720p",
      });
      setVideoUri(video.uri);
    } catch (e) {
      setError(String(e));
    }
    setRecording(false);
  };

  const stopMobileRecording = () => {
    if (cameraRef.current) {
      cameraRef.current.stopRecording();
    }
  };

  // --- Send video (web or mobile) ---
  const send = async (file, sourceLabel) => {
    try {
      const fd = new FormData();
      fd.append("file", file, file.name || `${sourceLabel}.webm`);
      const res = await fetch(API_URL, { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (json && json.probabilities !== undefined) {
        setAccuracy((json.probabilities * 100).toFixed(2));
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const sendWeb = async () => {
    if (!recordedBlob) return;
    const file = new File([recordedBlob], `recorded-${Date.now()}.webm`, { type: "video/webm" });
    await send(file, "web");
  };

  // For Expo, you’ll need to fetch videoUri → blob → File before sending
  const sendMobile = async () => {
    if (!videoUri) return;
    const response = await fetch(videoUri);
    const blob = await response.blob();
    const file = new File([blob], `recorded-${Date.now()}.mp4`, { type: "video/mp4" });
    await send(file, "mobile");
  };

  // --- UI ---
  if (Platform.OS === "web") {
    return (
      <div className="p-6 flex flex-col items-center gap-4">
        <h1>🎥 Web Camera Recorder</h1>
        <video ref={videoRef} className="w-full max-w-lg bg-black" autoPlay playsInline muted />
        <div className="flex gap-2">
          <button onClick={ensureStream}>📷 Open Camera</button>
          <button onClick={startWebRecording}>▶️ Start</button>
          <button onClick={stopWebRecording}>⏹️ Stop</button>
        </div>
        {blobUrl && (
          <div>
            <video src={blobUrl} controls className="w-full max-w-lg mt-2" />
            <button onClick={sendWeb}>🚀 Send</button>
          </div>
        )}
        {accuracy && <p>Accuracy: {accuracy}%</p>}
        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    );
  }

  // --- Mobile UI (Expo) ---
  return (
    <View style={styles.container}>
      <Text style={styles.title}>🎥 Mobile Camera Recorder</Text>
      <Camera style={styles.camera} type={Camera.Constants.Type.front} ref={cameraRef} />
      <View style={styles.controls}>
        {!recording ? (
          <Button title="▶️ Start" onPress={startMobileRecording} />
        ) : (
          <Button title="⏹️ Stop" onPress={stopMobileRecording} />
        )}
      </View>
      {videoUri && (
        <View style={{ marginTop: 10 }}>
          <Text>Video saved at: {videoUri}</Text>
          <Button title="🚀 Send" onPress={sendMobile} />
        </View>
      )}
      {accuracy && <Text>Accuracy: {accuracy}%</Text>}
      {error ? <Text style={{ color: "red" }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  title: { fontSize: 20, marginBottom: 10 },
  camera: { width: 300, height: 400, borderRadius: 10, overflow: "hidden" },
  controls: { flexDirection: "row", marginTop: 10, gap: 10 },
});
