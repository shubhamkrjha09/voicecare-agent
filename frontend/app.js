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

const initials = (name) => (name || "?").replace(/^Dr\.?\s*/i, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
// Icon + colour per specialty (line icons, drawn with stroke="currentColor").
const ICONS = {
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  steth: '<path d="M5 3v5a5 5 0 0 0 10 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-1"/><circle cx="20" cy="13" r="2"/>',
  skin: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  child: '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
function specialtyStyle(specialty) {
  const s = specialty.toLowerCase();
  if (s.includes("cardio")) return { icon: "heart", bg: "#fff1f3", fg: "#e11d48" };
  if (s.includes("derma")) return { icon: "skin", bg: "#f5f3ff", fg: "#7c3aed" };
  if (s.includes("pediat") || s.includes("paediat")) return { icon: "child", bg: "#fffbeb", fg: "#d97706" };
  return { icon: "steth", bg: "#eff6ff", fg: "#2563eb" };
}

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  $("greeting").textContent = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("clock").textContent = now.toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const hm = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?[ap]m$/i, "");
  $("statusTime").textContent = hm;
  $("idleTime").textContent = hm;
  $("idleDate").textContent = now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
}
tickClock();
setInterval(tickClock, 15_000);

// ---------------------------------------------------------------- board

async function loadDoctors() {
  const doctors = await (await fetch("/api/doctors")).json();
  $("doctors").innerHTML = doctors.map((d) => {
    const st = specialtyStyle(d.specialty);
    const firstDay = d.free_slots.length ? fmtDay(d.free_slots[0]) : null;
    const dayTimes = d.free_slots.filter((s) => fmtDay(s) === firstDay);
    const shown = dayTimes.slice(0, 5);
    const more = d.free_slots.length - shown.length;
    const next = d.free_slots[0];
    return `<div class="doctor">
      <div class="doc-head">
        <div class="doc-avatar" style="background:${st.bg};color:${st.fg}">${svg(st.icon)}</div>
        <div><div class="doc-name">${esc(d.name)}</div><div class="doc-spec">${esc(d.specialty)}</div></div>
        <div class="doc-next"><div class="k">Next free</div><div class="v">${next ? `${fmtDay(next).split(",")[0]} ${fmtTime(next)}` : "—"}</div></div>
      </div>
      <div class="slots">${next
        ? `<span class="day">${esc(firstDay)}</span>` + shown.map((s) => `<span class="slot">${fmtTime(s)}</span>`).join("")
          + (more > 0 ? `<span class="slot more">+${more} more</span>` : "")
        : '<span class="doc-spec">Fully booked this week</span>'}</div>
    </div>`;
  }).join("");
  $("slotCount").textContent = `${doctors.length} on duty`;
}

let lastAppointments = [];

async function loadAppointments(flashId = null) {
  const rows = await (await fetch("/api/appointments")).json();
  lastAppointments = rows;
  $("apptEmpty").hidden = rows.length > 0;
  $("apptCount").textContent = `${rows.filter((r) => r.status === "booked").length} booked`;
  $("appointments").innerHTML = rows.map((a) => `
    <tr class="${a.id === flashId ? "flash" : ""}">
      <td><div class="patient"><span class="p-avatar">${esc(initials(a.patient_name || "?"))}</span>
        <div><div class="p-name">${esc(a.patient_name || "Unnamed caller")}</div><div class="sub2">${maskPhone(a.phone)}</div></div></div></td>
      <td>${esc(a.doctor)}<div class="sub2">${esc(a.specialty)}</div></td>
      <td>${fmtDay(a.starts_at)}<div class="sub2">${fmtTime(a.starts_at)}</div></td>
      <td><span class="pill ${a.status}">${a.status}</span></td>
    </tr>`).join("");
  renderActivity();
}

// Activity = call events from this browser session + bookings from the database.
const callEvents = [];

function renderActivity() {
  const items = [
    ...callEvents,
    ...lastAppointments.map((a) => ({
      at: new Date(a.created_at),
      kind: a.status,
      text: `${a.status === "cancelled" ? "Cancelled" : "Booked"} · ${a.patient_name || "Caller"} with ${a.doctor}, ${fmtDay(a.starts_at)} ${fmtTime(a.starts_at)}`,
    })),
  ].sort((x, y) => y.at - x.at).slice(0, 8);
  $("activity").innerHTML = items.length
    ? items.map((e) => `<li><span class="mark ${e.kind}">${svg(e.kind === "call" ? "phone" : e.kind === "cancelled" ? "x" : "check")}</span><div>${esc(e.text)}<div class="t">${e.at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</div></div></li>`).join("")
    : '<li class="empty">Waiting for the first call…</li>';
}

function logCall(text) {
  callEvents.push({ at: new Date(), kind: "call", text });
  renderActivity();
}

const lastStats = {};

async function loadStats() {
  const s = await (await fetch("/api/stats")).json();
  const set = (id, v) => {
    const el = $(id);
    if (lastStats[id] !== undefined && lastStats[id] !== v) {
      el.classList.add("bump");
      setTimeout(() => el.classList.remove("bump"), 1500);
    }
    lastStats[id] = v;
    el.textContent = v;
  };
  set("statCalls", s.calls_today);
  set("statBooked", s.booked_today);
  set("statCancelled", s.cancelled_today);
  set("statOpen", s.open_slots);
  $("statCallsNote").textContent = s.calls_active ? `${s.calls_active} live now` : "since opening";
}

async function refreshBoard(flashId) {
  await Promise.all([loadDoctors(), loadAppointments(flashId), loadStats()]);
}

function setAgentBusy(busy) {
  $("agentStatus").classList.toggle("busy", busy);
  $("agentStatusText").textContent = busy ? "Maya on a call" : "Maya online";
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
  const color = botLevel >= userLevel ? "#93b0d8" : "#e2e8f0";
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
  setState("live", "Maya · AI receptionist");
  startTimer();
  logCall("Call answered by Maya");
  loadStats();
}

function endCall(reason = "") {
  stopRinging();
  clearInterval(timerHandle);
  setAgentBusy(false);
  if (phone.dataset.state === "ended" || phone.dataset.state === "idle") return;
  beep(380, 260);
  const dur = $("timer").textContent;
  $("endedSummary").innerHTML = [`Duration ${dur}`, ...summary, reason].filter(Boolean).map(esc).join("<br>");
  setState("ended");
  logCall(`Call ended · ${dur}`);
  setTimeout(loadStats, 800);
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
  $("speakerBtn").classList.remove("on");
  $("botAudio").muted = false;
  setAgentBusy(true);
  setState("ringing", "calling…");
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
  $("callStatus").textContent = muted ? "muted" : "Maya · AI receptionist";
};
$("speakerBtn").onclick = () => {
  const audio = $("botAudio");
  audio.muted = !audio.muted;
  $("speakerBtn").classList.toggle("on", audio.muted);
};

refreshBoard();
setInterval(() => refreshBoard(), 15_000);

// Sidebar: highlight the section you jump to.
document.querySelectorAll(".nav a").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("active"));
    a.classList.add("active");
  });
});
