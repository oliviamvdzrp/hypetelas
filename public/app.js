const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
let roomId = params.get("room") || "";
let myId = null;
let myName = "";
let socket = null;
let sharing = false;
let micOn = false;
let localScreen = null;
const peers = new Map();

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.remove("show"), 2500);
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeRoom(v) {
  return v.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}`);

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "join", room: roomId, name: myName }));
    $("#roomStatus").textContent = "Conectado";
  };

  socket.onclose = () => {
    $("#roomStatus").textContent = "Desconectado";
    toast("Conexão perdida. Recarregue a página para tentar novamente.");
  };

  socket.onerror = () => toast("Não foi possível conectar ao servidor.");

  socket.onmessage = async event => {
    const msg = JSON.parse(event.data);

    if (msg.type === "error") {
      toast(msg.message);
      return;
    }

    if (msg.type === "joined") {
      myId = msg.peerId;
      $("#roomCode").textContent = msg.room;
      renderParticipants(msg.participants);
      // O novo participante cria conexões com quem já estava na sala.
      for (const p of msg.participants) {
        if (p.peerId !== myId) {
          const pc = createPeer(p.peerId, p.name, true);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal(p.peerId, { sdp: pc.localDescription });
        }
      }
      return;
    }

    if (msg.type === "participant-joined") {
      addParticipant(msg.participant);
      return;
    }

    if (msg.type === "participant-updated") {
      updateParticipant(msg.participant);
      return;
    }

    if (msg.type === "participant-left") {
      removePeer(msg.peerId);
      return;
    }

    if (msg.type === "signal") {
      await handleSignal(msg);
      return;
    }

    if (msg.type === "chat") {
      addChat(msg.from, msg.text, msg.from === myName);
    }
  };
}

function sendSignal(to, signal) {
  if (socket?.readyState === 1)
    socket.send(JSON.stringify({ type: "signal", to, signal }));
}

function createPeer(peerId, name, initiator = false) {
  if (peers.has(peerId)) return peers.get(peerId).pc;

  const pc = new RTCPeerConnection({ iceServers });
  const state = { pc, name, stream: null, candidateQueue: [] };
  peers.set(peerId, state);

  pc.onicecandidate = e => {
    if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
  };

  pc.ontrack = e => {
    const stream = e.streams[0];
    state.stream = stream;
    attachRemote(peerId, name, stream);
    hideEmpty();
  };

  pc.onconnectionstatechange = () => {
    if (["failed","closed","disconnected"].includes(pc.connectionState)) {
      if (pc.connectionState === "failed") pc.restartIce();
    }
  };

  if (localScreen) {
    for (const track of localScreen.getTracks()) pc.addTrack(track, localScreen);
  }

  return pc;
}

async function handleSignal(msg) {
  const { from, fromName, signal } = msg;
  const pc = createPeer(from, fromName, false);
  const state = peers.get(from);

  try {
    if (signal.sdp) {
      await pc.setRemoteDescription(signal.sdp);
      while (state.candidateQueue.length) {
        await pc.addIceCandidate(state.candidateQueue.shift());
      }

      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, { sdp: pc.localDescription });
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else state.candidateQueue.push(signal.candidate);
    }
  } catch (err) {
    console.error("WebRTC signal error", err);
  }
}

function attachRemote(peerId, name, stream) {
  let card = document.querySelector(`[data-peer="${peerId}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "video-card";
    card.dataset.peer = peerId;
    card.innerHTML = `<video autoplay playsinline></video><div class="video-name"></div>`;
    $("#videos").appendChild(card);
  }
  card.querySelector("video").srcObject = stream;
  card.querySelector(".video-name").textContent = name + " · transmitindo";
}

function removePeer(peerId) {
  const state = peers.get(peerId);
  if (state) {
    try { state.pc.close(); } catch {}
    peers.delete(peerId);
  }
  document.querySelector(`[data-peer="${peerId}"]`)?.remove();
  renderParticipantsFromDOM();
  if (!$("#videos").children.length) showEmpty();
}

function hideEmpty() { $("#emptyState").classList.add("hidden"); }
function showEmpty() { if (!$("#videos").children.length) $("#emptyState").classList.remove("hidden"); }

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Seu navegador não oferece compartilhamento de tela aqui.");
    return;
  }

  try {
    localScreen = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: "always",
        frameRate: { ideal: 30, max: 60 }
      },
      audio: true
    });

    sharing = true;
    $("#shareBtn").classList.add("hidden");
    $("#stopShareBtn").classList.remove("hidden");
    hideEmpty();

    for (const [peerId, state] of peers) {
      for (const sender of state.pc.getSenders()) {
        if (sender.track?.kind === "video") {
          const track = localScreen.getVideoTracks()[0];
          await sender.replaceTrack(track);
        }
      }
      // Se a conexão foi criada sem track local, adiciona o novo track.
      const hasVideo = state.pc.getSenders().some(s => s.track?.kind === "video");
      if (!hasVideo) {
        for (const track of localScreen.getTracks()) state.pc.addTrack(track, localScreen);
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        sendSignal(peerId, { sdp: state.pc.localDescription });
      }
    }

    const screenTrack = localScreen.getVideoTracks()[0];
    screenTrack.onended = stopShare;
    socket.send(JSON.stringify({ type: "sharing", value: true }));
    updateParticipant({ peerId: myId, name: myName, sharing: true });
    toast("Sua tela está sendo compartilhada.");
  } catch (err) {
    if (err.name !== "AbortError" && err.name !== "NotAllowedError")
      toast("Não foi possível iniciar o compartilhamento.");
  }
}

function stopShare() {
  if (!localScreen) return;
  localScreen.getTracks().forEach(t => t.stop());
  localScreen = null;
  sharing = false;
  $("#shareBtn").classList.remove("hidden");
  $("#stopShareBtn").classList.add("hidden");
  socket?.send(JSON.stringify({ type: "sharing", value: false }));

  for (const state of peers.values()) {
    for (const sender of state.pc.getSenders()) {
      if (sender.track?.kind === "video") sender.replaceTrack(null).catch(()=>{});
    }
  }

  toast("Transmissão encerrada.");
}

async function toggleMic() {
  if (!micOn) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      track.enabled = true;
      micOn = true;
      $("#micBtn").innerHTML = "<span>🎙️</span> Microfone ligado";
      for (const [peerId, state] of peers) {
        const old = state.pc.getSenders().find(s => s.track?.kind === "audio");
        if (old) await old.replaceTrack(track);
        else {
          state.pc.addTrack(track, stream);
          const offer = await state.pc.createOffer();
          await state.pc.setLocalDescription(offer);
          sendSignal(peerId, { sdp: state.pc.localDescription });
        }
      }
    } catch {
      toast("Não foi possível acessar o microfone.");
    }
  } else {
    micOn = false;
    $("#micBtn").innerHTML = "<span>🎙️</span> Microfone";
    for (const state of peers.values()) {
      const sender = state.pc.getSenders().find(s => s.track?.kind === "audio");
      if (sender) sender.replaceTrack(null).catch(()=>{});
    }
  }
}

function participantHTML(p) {
  const initial = (p.name || "?").slice(0,1).toUpperCase();
  return `<div class="participant" data-participant="${p.peerId}">
    <div class="avatar">${initial}</div>
    <div class="pname">${escapeHtml(p.name)}${p.peerId === myId ? " (você)" : ""}</div>
    ${p.sharing ? '<div class="sharing-dot" title="Transmitindo"></div>' : ""}
  </div>`;
}

function renderParticipants(list) {
  $("#participants").innerHTML = list.map(participantHTML).join("");
  $("#count").textContent = list.length;
}

function addParticipant(p) {
  const exists = document.querySelector(`[data-participant="${p.peerId}"]`);
  if (!exists) $("#participants").insertAdjacentHTML("beforeend", participantHTML(p));
  renderParticipantsFromDOM();
}

function updateParticipant(p) {
  const old = document.querySelector(`[data-participant="${p.peerId}"]`);
  if (old) old.outerHTML = participantHTML(p);
  else addParticipant(p);
  renderParticipantsFromDOM();
}

function renderParticipantsFromDOM() {
  $("#count").textContent = document.querySelectorAll(".participant").length;
}

function addChat(from, text, mine) {
  const el = document.createElement("div");
  el.className = "message";
  el.innerHTML = `<div class="meta">${mine ? "Você" : escapeHtml(from)}</div><div class="text">${escapeHtml(text)}</div>`;
  $("#chatMessages").appendChild(el);
  $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard?.writeText(url).then(
    () => toast("Link da sala copiado!"),
    () => toast(url)
  );
}

function enterRoom() {
  myName = ($("#nameHome").value || "Convidado").trim().slice(0,30) || "Convidado";
  roomId = normalizeRoom(roomId || $("#roomInput").value);
  if (!roomId) roomId = randomRoom();

  history.replaceState({}, "", `?room=${encodeURIComponent(roomId)}`);
  $("#home").classList.add("hidden");
  $("#room").classList.remove("hidden");
  connect();
}

$("#createBtn").onclick = () => { roomId = randomRoom(); enterRoom(); };
$("#joinBtn").onclick = () => { roomId = normalizeRoom($("#roomInput").value); if (!roomId) return toast("Digite o código da sala."); enterRoom(); };
$("#shareBtn").onclick = startShare;
$("#shareCenterBtn").onclick = startShare;
$("#stopShareBtn").onclick = stopShare;
$("#micBtn").onclick = toggleMic;
$("#copyBtn").onclick = copyInvite;
$("#inviteBtn").onclick = copyInvite;
$("#leaveBtn").onclick = () => { try { socket?.close(); } catch {} location.href = location.pathname; };

$("#chatForm").onsubmit = e => {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text || socket?.readyState !== 1) return;
  socket.send(JSON.stringify({ type: "chat", text }));
  input.value = "";
};

$("#roomInput").addEventListener("keydown", e => {
  if (e.key === "Enter") $("#joinBtn").click();
});

if (roomId) {
  // Se o link já vier com uma sala, pede apenas o nome.
  $("#home").classList.remove("hidden");
  $("#roomInput").value = roomId;
}