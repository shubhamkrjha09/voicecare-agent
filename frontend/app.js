// VoiceCare dashboard: connects the browser to the Pipecat bot over WebRTC
// and keeps the schedule + appointments in sync with what the agent does.
import { PipecatClient } from "https://esm.sh/@pipecat-ai/client-js@1.17.0";
import { SmallWebRTCTransport } from "https://esm.sh/@pipecat-ai/small-webrtc-transport@1.11.3";

const $ = (id) => document.getElementById(id);

// Send browser-side errors and key call events to the server log (debugging aid).
function report(event, detail = "") {
  const msg = { event, detail: String(detail?.message || detail).slice(0, 500), ua: navigator.userAgent.slice(0, 80) };
  fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
}
window.addEventListener("error", (e) => report("window-error", `${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report("unhandled-rejection", e.reason));
const phone = $("phone");
const transcriptEl = $("transcript");

let client = null;
let timerHandle = null;
let callStartedAt = null;
let muted = false;
let summary = [];
let micPeak = 0;

// While a call is live, report the loudest mic level of the last 4 seconds.
setInterval(() => {
  if (phone.dataset.state === "live") report("mic-peak", micPeak.toFixed(3));
  micPeak = 0;
}, 4000);

// ---------------------------------------------------------------- formatting

const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const maskPhone = (p) => (p.length > 4 ? "•••• " + p.slice(-4) : p);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function tickClock() {
  $("clock").textContent = new Date().toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
tickClock();
setInterval(tickClock, 30_000);

// ---------------------------------------------------------------- board

async function loadDoctors() {
  const doctors = await (await fetch("/api/doctors")).json();
  let total = 0;
  $("doctors").innerHTML = doctors.map((d) => {
    total += d.free_slots.length;
    const byDay = {};
    for (const s of d.free_slots) (byDay[fmtDay(s)] ??= []).push(s);
    const slots = Object.entries(byDay).map(([day, times]) =>
      `<span class="day">${day}</span>` + times.map((s) => `<span class="slot">${fmtTime(s)}</span>`).join("")).join("");
    return `<div class="doctor">
      <div><div class="name">${esc(d.name)}</div><div class="spec">${esc(d.specialty)}</div></div>
      <div class="slots">${slots || '<span class="spec">Fully booked</span>'}</div>
    </div>`;
  }).join("");
  $("slotCount").textContent = `${total} open slots shown`;
}

async function loadAppointments(flashId = null) {
  const rows = await (await fetch("/api/appointments")).json();
  $("apptEmpty").hidden = rows.length > 0;
  $("apptCount").textContent = `${rows.filter((r) => r.status === "booked").length} booked`;
  $("appointments").innerHTML = rows.map((a) => `
    <tr class="${a.id === flashId ? "flash" : ""}">
      <td class="mono">${a.id}</td>
      <td>${esc(a.patient_name || "—")}<div class="spec mono">${maskPhone(a.phone)}</div></td>
      <td>${esc(a.doctor)}<div class="spec">${esc(a.specialty)}</div></td>
      <td class="mono">${fmtDay(a.starts_at)} · ${fmtTime(a.starts_at)}</td>
      <td><span class="pill ${a.status}">${a.status}</span></td>
    </tr>`).join("");
}

async function refreshBoard(flashId) {
  await Promise.all([loadDoctors(), loadAppointments(flashId)]);
}

// ---------------------------------------------------------------- transcript

let liveUserLine = null;
let botLine = null;

function addLine(role, text, interim = false) {
  const el = document.createElement("div");
  el.className = `line ${role}${interim ? " interim" : ""}`;
  el.textContent = text;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function onUserInput(data) {
  if (!data.text) return;
  if (!liveUserLine) liveUserLine = addLine("user", data.text, !data.final);
  liveUserLine.textContent = data.text;
  liveUserLine.classList.toggle("interim", !data.final);
  if (data.final) { liveUserLine = null; botLine = null; botSegments = new Map(); }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// The bot sends several updates per sentence (new → in-progress → completed),
// so keep one entry per segment and re-render instead of appending.
let botSegments = new Map();

function onBotOutput(data) {
  const type = data.output_type || data.aggregated_by;
  if (type && type !== "sentence") return; // only whole sentences, not word-by-word
  const text = data.text?.trim();
  if (!text) return;
  const key = data.segment_id ?? text;
  botSegments.set(key, text);
  const full = [...botSegments.values()].join(" ");
  if (!botLine) botLine = addLine("bot", full);
  else botLine.textContent = full;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Play the bot's voice. Called from several events because the audio track
// can arrive before or after the bot reports it is ready.
function attachBotAudio(track = client?.tracks()?.bot?.audio) {
  const audio = $("botAudio");
  if (!track) return;
  if (audio.srcObject?.getAudioTracks()[0] !== track) {
    audio.srcObject = new MediaStream([track]);
  }
  audio.play().catch((err) => console.warn("Audio play blocked", err));
}

function showBookingCard(msg) {
  const card = $("bookingCard");
  const cancelled = msg.event === "cancelled";
  card.className = `booking-card${cancelled ? " cancel" : ""}`;
  card.innerHTML = `<div class="tag">${cancelled ? "Cancelled" : "Booked"}</div>
    <div class="title">${esc(msg.doctor)}</div><div>${esc(msg.when)}</div>`;
  card.hidden = false;
  summary.push(`${cancelled ? "Cancelled" : "Booked"} ${msg.doctor}, ${msg.when}`);
  setTimeout(() => { card.hidden = true; }, 6000);
}

// ---------------------------------------------------------------- ringtone

let audioCtx = null;
let ringTimer = null;

function startRinging() {
  audioCtx ??= new AudioContext();
  const ring = () => {
    const t = audioCtx.currentTime;
    for (const f of [440, 480]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
      gain.gain.setValueAtTime(0.05, t + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 1.35);
    }
  };
  ring();
  ringTimer = setInterval(ring, 3000);
}

function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
}

function beep(freq = 520, ms = 180) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000);
}

// ---------------------------------------------------------------- waveform

const wave = $("wave");
const wctx = wave.getContext("2d");
let userLevel = 0, botLevel = 0, phase = 0;

function drawWave() {
  const { width: w, height: h } = wave;
  wctx.clearRect(0, 0, w, h);
  const live = phone.dataset.state === "live";
  const level = live ? Math.max(userLevel, botLevel) : 0.04;
  const color = botLevel >= userLevel ? "#8fd3b3" : "#f0c36a";
  phase += 0.12;
  const bars = 48;
  for (let i = 0; i < bars; i++) {
    const x = (i + 0.5) * (w / bars);
    const env = Math.sin((i / bars) * Math.PI);
    const amp = (0.08 + level * 2.2 * (0.6 + 0.4 * Math.sin(phase + i * 0.55))) * env;
    const bh = Math.max(4, Math.min(h, amp * h));
    wctx.fillStyle = color;
    wctx.globalAlpha = 0.35 + env * 0.65;
    wctx.beginPath();
    wctx.roundRect(x - 3, (h - bh) / 2, 6, bh, 3);
    wctx.fill();
  }
  userLevel *= 0.9;
  botLevel *= 0.9;
  requestAnimationFrame(drawWave);
}
requestAnimationFrame(drawWave);

// ---------------------------------------------------------------- call flow

function setState(state, status) {
  phone.dataset.state = state;
  if (status) $("callStatus").textContent = status;
}

function startTimer() {
  callStartedAt = Date.now();
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

function goLive() {
  if (phone.dataset.state === "live") return;
  stopRinging();
  beep(660, 120);
  setState("live", "Connected");
  startTimer();
}

function endCall(reason = "") {
  stopRinging();
  clearInterval(timerHandle);
  if (phone.dataset.state === "ended" || phone.dataset.state === "idle") return;
  beep(380, 260);
  const dur = $("timer").textContent;
  $("endedSummary").innerHTML = [`Duration ${dur}`, ...summary, reason].filter(Boolean).map(esc).join("<br>");
  setState("ended");
}

async function startCall() {
  report("call-clicked");
  transcriptEl.innerHTML = "";
  $("bookingCard").hidden = true;
  $("timer").textContent = "00:00";
  summary = [];
  liveUserLine = botLine = null;
  botSegments = new Map();
  muted = false;
  $("muteBtn").classList.remove("on");
  setState("ringing", "Ringing…");
  startRinging();

  client = new PipecatClient({
    transport: new SmallWebRTCTransport(),
    enableMic: true,
    enableCam: false,
    callbacks: {
      onBotReady: () => { attachBotAudio(); goLive(); },
      onBotStartedSpeaking: () => { attachBotAudio(); goLive(); },
      onDisconnected: () => endCall(),
      onUserInput,
      onBotOutput,
      onLocalAudioLevel: (l) => { userLevel = Math.max(userLevel, l); micPeak = Math.max(micPeak, l); },
      onRemoteAudioLevel: (l) => { botLevel = Math.max(botLevel, l); },
      onTrackStarted: (track, participant) => {
        // The WebRTC transport reports the bot's audio without a participant.
        if (track.kind === "audio" && !participant?.local) attachBotAudio(track);
      },
      onServerMessage: (msg) => {
        if (msg?.event === "booked" || msg?.event === "cancelled") {
          showBookingCard(msg);
          refreshBoard(msg.appointment_id);
        }
      },
      onError: (err) => { console.error("Pipecat error", err); report("pipecat-error", JSON.stringify(err?.data || err)); },
      onConnected: () => report("connected"),
      onTransportStateChanged: (s) => report("transport-state", s),
      onDeviceError: (err) => report("device-error", JSON.stringify(err)),
    },
  });

  window.voicecareClient = client; // handy for debugging in the browser console
  try {
    await client.connect({ webrtcRequestParams: { endpoint: "/api/offer" } });
  } catch (err) {
    console.error(err);
    report("connect-failed", err);
    endCall("Couldn't connect. Check the server and microphone permission.");
  }
}

async function hangUp() {
  try { await client?.disconnect(); } catch {}
  endCall();
}

$("callBtn").onclick = startCall;
$("againBtn").onclick = startCall;
$("endBtn").onclick = hangUp;
$("muteBtn").onclick = () => {
  muted = !muted;
  client?.enableMic(!muted);
  $("muteBtn").classList.toggle("on", muted);
  $("callStatus").textContent = muted ? "Muted" : "Connected";
};

refreshBoard();
setInterval(() => refreshBoard(), 15_000);
