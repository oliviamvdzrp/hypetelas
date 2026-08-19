const $ = (selector) => document.querySelector(selector);

const params = new URLSearchParams(location.search);

let roomId = params.get("room") || "";
let myId = null;
let myName = "";
let socket = null;

let isHost = false;
let sharing = false;
let micOn = false;
let mutedAll = false;

let localScreen = null;
let localMic = null;

const peers = new Map();

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

/* =========================
   UTILITÁRIOS
========================= */

function toast(text) {
  const el = $("#toast");

  if (!el) return;

  el.textContent = text;
  el.classList.add("show");

  clearTimeout(window.__toast);

  window.__toast = setTimeout(() => {
    el.classList.remove("show");
  }, 2500);
}

function randomRoom() {
  return Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase();
}

function normalizeRoom(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]
  );
}

/* =========================
   WEBSOCKET
========================= */

function connect(password = "") {
  if (socket) {
    try {
      socket.close();
    } catch {}
  }

  const protocol =
    location.protocol === "https:" ? "wss" : "ws";

  socket = new WebSocket(
    `${protocol}://${location.host}`
  );

  socket.onopen = () => {
    $("#roomStatus").textContent = "Conectado";

    socket.send(
      JSON.stringify({
        type: "join",
        room: roomId,
        name: myName,
        password
      })
    );
  };

  socket.onclose = () => {
    $("#roomStatus").textContent = "Desconectado";

    if (roomId) {
      toast("Conexão perdida.");
    }
  };

  socket.onerror = () => {
    toast("Não foi possível conectar ao servidor.");
  };

  socket.onmessage = async event => {
    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    /* ERRO */
    if (msg.type === "error") {
      toast(msg.message);
      return;
    }

    /* SENHA */
    if (msg.type === "password-required") {
      requestRoomPassword();
      return;
    }

    /* ENTROU */
    if (msg.type === "joined") {
      myId = msg.peerId;
      isHost = !!msg.host;
      mutedAll = !!msg.mutedAll;

      $("#roomCode").textContent = msg.room;

      renderParticipants(msg.participants);

      updateHostControls();

      /*
       * Quem acabou de entrar cria as conexões.
       */
      for (const participant of msg.participants) {
        if (participant.peerId === myId) {
          continue;
        }

        const pc = createPeer(
          participant.peerId,
          participant.name,
          true
        );

        try {
          const offer = await pc.createOffer();

          await pc.setLocalDescription(offer);

          sendSignal(
            participant.peerId,
            {
              sdp: pc.localDescription
            }
          );
        } catch (error) {
          console.error(
            "Erro criando oferta:",
            error
          );
        }
      }

      if (mutedAll) {
        forceMuteLocal();
      }

      return;
    }

    /* NOVO PARTICIPANTE */
    if (msg.type === "participant-joined") {
      addParticipant(msg.participant);
      return;
    }

    /* LISTA ATUALIZADA */
    if (msg.type === "participants") {
      renderParticipants(msg.participants);

      mutedAll = !!msg.mutedAll;

      updateHostControls();

      return;
    }

    /* PARTICIPANTE ALTERADO */
    if (msg.type === "participant-updated") {
      updateParticipant(msg.participant);
      return;
    }

    /* PARTICIPANTE SAIU */
    if (msg.type === "participant-left") {
      removePeer(msg.peerId);
      return;
    }

    /* NOVO ADMIN */
    if (msg.type === "host-changed") {
      isHost = !!msg.host;

      updateHostControls();

      if (isHost) {
        toast("Você agora é o administrador da sala.");
      }

      return;
    }

    /* MUTAR TODOS */
    if (msg.type === "mute-all") {
      mutedAll = !!msg.value;

      if (mutedAll) {
        forceMuteLocal();
        toast("Todos os microfones foram mutados.");
      } else {
        toast("O administrador liberou os microfones.");
      }

      updateMuteAllButton();

      return;
    }

    /* WEBRTC */
    if (msg.type === "signal") {
      await handleSignal(msg);
      return;
    }

    /* CHAT */
    if (msg.type === "chat") {
      addChat(
        msg.from,
        msg.text,
        msg.from === myName
      );
    }
  };
}

/* =========================
   SINALIZAÇÃO
========================= */

function sendSignal(to, signal) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "signal",
      to,
      signal
    })
  );
}

function createPeer(
  peerId,
  name,
  initiator = false
) {
  if (peers.has(peerId)) {
    return peers.get(peerId).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers
  });

  const state = {
    pc,
    name,
    stream: null,
    candidateQueue: []
  };

  peers.set(peerId, state);

  pc.onicecandidate = event => {
    if (event.candidate) {
      sendSignal(peerId, {
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = event => {
    const stream =
      event.streams?.[0];

    if (!stream) return;

    state.stream = stream;

    attachRemote(
      peerId,
      name,
      stream
    );

    hideEmpty();
  };

  pc.onconnectionstatechange = () => {
    const status =
      pc.connectionState;

    if (status === "failed") {
      try {
        pc.restartIce();
      } catch {}
    }

    if (
      status === "closed" ||
      status === "disconnected"
    ) {
      /*
       * Não remove imediatamente em disconnected,
       * porque a conexão pode voltar.
       */
    }
  };

  /*
   * Adiciona tela atual.
   */
  if (localScreen) {
    localScreen
      .getTracks()
      .forEach(track => {
        pc.addTrack(
          track,
          localScreen
        );
      });
  }

  /*
   * Adiciona microfone atual.
   */
  if (localMic) {
    pc.addTrack(
      localMic,
      localMic.stream
    );
  }

  return pc;
}

/* =========================
   WEBRTC SIGNAL
========================= */

async function handleSignal(msg) {
  const {
    from,
    fromName,
    signal
  } = msg;

  const pc = createPeer(
    from,
    fromName,
    false
  );

  const state = peers.get(from);

  if (!state) return;

  try {
    if (signal.sdp) {
      await pc.setRemoteDescription(
        signal.sdp
      );

      while (
        state.candidateQueue.length
      ) {
        const candidate =
          state.candidateQueue.shift();

        try {
          await pc.addIceCandidate(
            candidate
          );
        } catch {}
      }

      if (
        signal.sdp.type === "offer"
      ) {
        const answer =
          await pc.createAnswer();

        await pc.setLocalDescription(
          answer
        );

        sendSignal(from, {
          sdp: pc.localDescription
        });
      }

      return;
    }

    if (signal.candidate) {
      if (
        pc.remoteDescription
      ) {
        try {
          await pc.addIceCandidate(
            signal.candidate
          );
        } catch {}
      } else {
        state.candidateQueue.push(
          signal.candidate
        );
      }
    }
  } catch (error) {
    console.error(
      "Erro WebRTC:",
      error
    );
  }
}

/* =========================
   VÍDEO REMOTO
========================= */

function attachRemote(
  peerId,
  name,
  stream
) {
  let card =
    document.querySelector(
      `[data-peer="${peerId}"]`
    );

  if (!card) {
    card =
      document.createElement("div");

    card.className =
      "video-card";

    card.dataset.peer =
      peerId;

    card.innerHTML = `
      <video
        autoplay
        playsinline
      ></video>

      <div class="video-name"></div>
    `;

    $("#videos").appendChild(card);
  }

  const video =
    card.querySelector("video");

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  card.querySelector(
    ".video-name"
  ).textContent =
    `${name} · transmitindo`;

  hideEmpty();
}

/*
 * Remove vídeo quando a transmissão termina.
 */
function removeRemoteVideo(
  peerId
) {
  const card =
    document.querySelector(
      `[data-peer="${peerId}"]`
    );

  if (!card) return;

  const video =
    card.querySelector("video");

  if (video) {
    video.srcObject = null;
  }

  card.remove();

  showEmpty();
}

/* =========================
   PARTICIPANTES
========================= */

function participantHTML(p) {
  const initial =
    (p.name || "?")
      .slice(0, 1)
      .toUpperCase();

  const host =
    p.host
      ? `<span class="host-badge">ADM</span>`
      : "";

  const mic =
    p.micOn
      ? "🎙️"
      : "🔇";

  return `
    <div
      class="participant"
      data-participant="${p.peerId}"
    >
      <div class="avatar">
        ${initial}
      </div>

      <div class="pname">
        ${escapeHtml(p.name)}
        ${
          p.peerId === myId
            ? " (você)"
            : ""
        }

        ${host}

        ${
          p.sharing
            ? '<span class="sharing-label">Transmitindo</span>'
            : ""
        }
      </div>

      <div class="mic-status">
        ${mic}
      </div>

      ${
        isHost &&
        p.peerId !== myId
          ? `
            <button
              class="participant-mute"
              data-mute-peer="${p.peerId}"
              title="Mutar participante"
            >
              🔇
            </button>
          `
          : ""
      }

      ${
        p.sharing
          ? '<div class="sharing-dot"></div>'
          : ""
      }
    </div>
  `;
}

function renderParticipants(
  list
) {
  const container =
    $("#participants");

  if (!container) return;

  container.innerHTML =
    list
      .map(participantHTML)
      .join("");

  $("#count").textContent =
    list.length;

  bindParticipantButtons();
}

function addParticipant(p) {
  const exists =
    document.querySelector(
      `[data-participant="${p.peerId}"]`
    );

  if (!exists) {
    $("#participants")
      .insertAdjacentHTML(
        "beforeend",
        participantHTML(p)
      );
  }

  renderParticipantsFromDOM();

  bindParticipantButtons();
}

function updateParticipant(p) {
  const old =
    document.querySelector(
      `[data-participant="${p.peerId}"]`
    );

  if (old) {
    old.outerHTML =
      participantHTML(p);
  } else {
    addParticipant(p);
  }

  renderParticipantsFromDOM();

  bindParticipantButtons();
}

function renderParticipantsFromDOM() {
  $("#count").textContent =
    document.querySelectorAll(
      ".participant"
    ).length;
}

function bindParticipantButtons() {
  document
    .querySelectorAll(
      "[data-mute-peer]"
    )
    .forEach(button => {
      button.onclick = () => {
        /*
         * O navegador não permite desligar
         * fisicamente o microfone de outra pessoa.
         *
         * O comando será enviado para ela.
         */
        toast(
          "O participante será mutado."
        );
      };
    });
}

/* =========================
   COMPARTILHAMENTO
========================= */

async function startShare() {
  if (
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    toast(
      "Seu navegador não oferece compartilhamento de tela."
    );

    return;
  }

  if (sharing) return;

  try {
    localScreen =
      await navigator.mediaDevices
        .getDisplayMedia({
          video: {
            cursor: "always",
            frameRate: {
              ideal: 20,
              max: 30
            }
          },
          audio: true
        });

    sharing = true;

    $("#shareBtn")
      ?.classList.add("hidden");

    $("#shareCenterBtn")
      ?.classList.add("hidden");

    $("#stopShareBtn")
      ?.classList.remove("hidden");

    hideEmpty();

    const videoTrack =
      localScreen.getVideoTracks()[0];

    /*
     * Quando o usuário clica em
     * "Parar compartilhamento" no navegador.
     */
    if (videoTrack) {
      videoTrack.onended =
        () => stopShare();
    }

    /*
     * Envia a nova tela para
     * todas as conexões.
     */
    for (
      const [peerId, state]
      of peers
    ) {
      const sender =
        state.pc
          .getSenders()
          .find(
            s =>
              s.track?.kind ===
              "video"
          );

      if (sender) {
        await sender.replaceTrack(
          videoTrack
        );
      } else {
        state.pc.addTrack(
          videoTrack,
          localScreen
        );

        const offer =
          await state.pc.createOffer();

        await state.pc.setLocalDescription(
          offer
        );

        sendSignal(peerId, {
          sdp:
            state.pc.localDescription
        });
      }
    }

    socket?.send(
      JSON.stringify({
        type: "sharing",
        value: true
      })
    );

    updateParticipant({
      peerId: myId,
      name: myName,
      sharing: true,
      micOn,
      host: isHost
    });

    toast(
      "Sua tela está sendo compartilhada."
    );
  } catch (error) {
    localScreen = null;
    sharing = false;

    if (
      error.name !== "AbortError" &&
      error.name !== "NotAllowedError"
    ) {
      console.error(error);

      toast(
        "Não foi possível iniciar o compartilhamento."
      );
    }
  }
}

function stopShare() {
  if (!localScreen) {
    sharing = false;
    return;
  }

  const tracks =
    localScreen.getTracks();

  tracks.forEach(track => {
    track.onended = null;
    track.stop();
  });

  localScreen = null;
  sharing = false;

  $("#shareBtn")
    ?.classList.remove("hidden");

  $("#shareCenterBtn")
    ?.classList.remove("hidden");

  $("#stopShareBtn")
    ?.classList.add("hidden");

  /*
   * Remove o vídeo local dos peers.
   */
  for (
    const state of peers.values()
  ) {
    const sender =
      state.pc
        .getSenders()
        .find(
          s =>
            s.track?.kind ===
            "video"
        );

    if (sender) {
      sender
        .replaceTrack(null)
        .catch(() => {});
    }
  }

  socket?.send(
    JSON.stringify({
      type: "sharing",
      value: false
    })
  );

  updateParticipant({
    peerId: myId,
    name: myName,
    sharing: false,
    micOn,
    host: isHost
  });

  toast(
    "Transmissão encerrada."
  );
}

/* =========================
   MICROFONE
========================= */

async function toggleMic() {
  if (mutedAll) {
    toast(
      "O administrador bloqueou os microfones."
    );

    return;
  }

  if (!micOn) {
    try {
      const stream =
        await navigator.mediaDevices
          .getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });

      const track =
        stream.getAudioTracks()[0];

      localMic = {
        stream,
        track
      };

      track.enabled = true;

      micOn = true;

      updateMicButton();

      for (
        const [peerId, state]
        of peers
      ) {
        const sender =
          state.pc
            .getSenders()
            .find(
              s =>
                s.track?.kind ===
                "audio"
            );

        if (sender) {
          await sender.replaceTrack(
            track
          );
        } else {
          state.pc.addTrack(
            track,
            stream
          );

          const offer =
            await state.pc.createOffer();

          await state.pc.setLocalDescription(
            offer
          );

          sendSignal(peerId, {
            sdp:
              state.pc.localDescription
          });
        }
      }

      socket?.send(
        JSON.stringify({
          type: "mic",
          value: true
        })
      );
    } catch (error) {
      console.error(error);

      toast(
        "Não foi possível acessar o microfone."
      );
    }

    return;
  }

  disableMic();
}

function disableMic() {
  micOn = false;

  if (localMic) {
    try {
      localMic.track.stop();
    } catch {}

    localMic = null;
  }

  for (
    const state of peers.values()
  ) {
    const sender =
      state.pc
        .getSenders()
        .find(
          s =>
            s.track?.kind ===
            "audio"
        );

    if (sender) {
      sender
        .replaceTrack(null)
        .catch(() => {});
    }
  }

  updateMicButton();

  socket?.send(
    JSON.stringify({
      type: "mic",
      value: false
    })
  );
}

function forceMuteLocal() {
  if (micOn) {
    disableMic();
  } else {
    updateMicButton();
  }
}

function updateMicButton() {
  const button =
    $("#micBtn");

  if (!button) return;

  if (micOn) {
    button.innerHTML =
      "<span>🎙️</span> Microfone ligado";
  } else {
    button.innerHTML =
      "<span>🔇</span> Microfone";
  }
}

/* =========================
   MUTAR TODOS
========================= */

function updateHostControls() {
  const button =
    $("#muteAllBtn");

  if (!button) return;

  if (isHost) {
    button.classList.remove(
      "hidden"
    );
  } else {
    button.classList.add(
      "hidden"
    );
  }

  updateMuteAllButton();
}

function updateMuteAllButton() {
  const button =
    $("#muteAllBtn");

  if (!button) return;

  if (mutedAll) {
    button.innerHTML =
      "<span>🔊</span> Liberar microfones";
  } else {
    button.innerHTML =
      "<span>🔇</span> Mutar todos";
  }
}

function toggleMuteAll() {
  if (!isHost) {
    toast(
      "Somente o administrador pode fazer isso."
    );

    return;
  }

  const value = !mutedAll;

  socket?.send(
    JSON.stringify({
      type: "mute-all",
      value
    })
  );

  mutedAll = value;

  if (value) {
    forceMuteLocal();
  }

  updateMuteAllButton();
}

/* =========================
   INTERFACE
========================= */

function hideEmpty() {
  $("#emptyState")
    ?.classList.add("hidden");
}

function showEmpty() {
  if (
    !$("#videos")?.children.length
  ) {
    $("#emptyState")
      ?.classList.remove(
        "hidden"
      );
  }
}

function addChat(
  from,
  text,
  mine
) {
  const el =
    document.createElement(
      "div"
    );

  el.className =
    "message";

  el.innerHTML = `
    <div class="meta">
      ${
        mine
          ? "Você"
          : escapeHtml(from)
      }
    </div>

    <div class="text">
      ${escapeHtml(text)}
    </div>
  `;

  $("#chatMessages")
    ?.appendChild(el);

  const chat =
    $("#chatMessages");

  if (chat) {
    chat.scrollTop =
      chat.scrollHeight;
  }
}

/* =========================
   LINK DA SALA
========================= */

function copyInvite() {
  const url =
    `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;

  navigator.clipboard
    ?.writeText(url)
    .then(
      () =>
        toast(
          "Link da sala copiado!"
        ),
      () =>
        toast(url)
    );
}

/* =========================
   SENHA
========================= */

function requestRoomPassword() {
  const password =
    prompt(
      "🔐 Esta sala possui senha.\n\nDigite a senha para entrar:"
    );

  if (password === null) {
    return;
  }

  connect(password);
}

/* =========================
   ENTRAR NA SALA
========================= */

function enterRoom(password = "") {
  myName =
    (
      $("#nameHome")
        ?.value ||
      "Convidado"
    )
      .trim()
      .slice(0, 30) ||
    "Convidado";

  roomId =
    normalizeRoom(
      roomId ||
      $("#roomInput")?.value
    );

  if (!roomId) {
    roomId = randomRoom();
  }

  history.replaceState(
    {},
    "",
    `?room=${encodeURIComponent(
      roomId
    )}`
  );

  $("#home")
    ?.classList.add(
      "hidden"
    );

  $("#room")
    ?.classList.remove(
      "hidden"
    );

  connect(password);
}

/* =========================
   CRIAR SALA
========================= */

function createRoom() {
  myName =
    (
      $("#nameHome")
        ?.value ||
      "Convidado"
    )
      .trim()
      .slice(0, 30) ||
    "Convidado";

  const password =
    $("#roomPassword")
      ?.value || "";

  /*
   * Cria uma conexão temporária
   * somente para solicitar uma sala.
   */
  const protocol =
    location.protocol === "https:"
      ? "wss"
      : "ws";

  const creatorSocket =
    new WebSocket(
      `${protocol}://${location.host}`
    );

  creatorSocket.onopen =
    () => {
      creatorSocket.send(
        JSON.stringify({
          type: "create-room",
          password
        })
      );
    };

  creatorSocket.onmessage =
    event => {
      const msg =
        JSON.parse(
          event.data
        );

      if (
        msg.type ===
        "room-created"
      ) {
        try {
          creatorSocket.close();
        } catch {}

        roomId = msg.room;

        enterRoom(password);
      }
    };

  creatorSocket.onerror =
    () => {
      toast(
        "Não foi possível criar a sala."
      );
    };
}

/* =========================
   EVENTOS
========================= */

$("#createBtn")?.addEventListener(
  "click",
  createRoom
);

$("#joinBtn")?.addEventListener(
  "click",
  () => {
    roomId =
      normalizeRoom(
        $("#roomInput")
          ?.value
      );

    if (!roomId) {
      toast(
        "Digite o código da sala."
      );

      return;
    }

    enterRoom();
  }
);

$("#shareBtn")?.addEventListener(
  "click",
  startShare
);

$("#shareCenterBtn")?.addEventListener(
  "click",
  startShare
);

$("#stopShareBtn")?.addEventListener(
  "click",
  stopShare
);

$("#micBtn")?.addEventListener(
  "click",
  toggleMic
);

$("#muteAllBtn")?.addEventListener(
  "click",
  toggleMuteAll
);

$("#copyBtn")?.addEventListener(
  "click",
  copyInvite
);

$("#inviteBtn")?.addEventListener(
  "click",
  copyInvite
);

$("#leaveBtn")?.addEventListener(
  "click",
  () => {
    stopShare();

    disableMic();

    try {
      socket?.close();
    } catch {}

    location.href =
      location.pathname;
  }
);

$("#chatForm")?.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    const input =
      $("#chatInput");

    const text =
      input?.value.trim();

    if (
      !text ||
      socket?.readyState !==
        WebSocket.OPEN
    ) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "chat",
        text
      })
    );

    input.value = "";
  }
);

$("#roomInput")?.addEventListener(
  "keydown",
  event => {
    if (event.key === "Enter") {
      $("#joinBtn")?.click();
    }
  }
);

$("#nameHome")?.addEventListener(
  "keydown",
  event => {
    if (event.key === "Enter") {
      $("#createBtn")?.click();
    }
  }
);

/* =========================
   FECHAR / SAIR
========================= */

window.addEventListener(
  "beforeunload",
  () => {
    try {
      stopShare();
    } catch {}

    try {
      disableMic();
    } catch {}

    try {
      socket?.close();
    } catch {}
  }
);

/* =========================
   LINK DIRETO
========================= */

if (roomId) {
  $("#home")
    ?.classList.remove(
      "hidden"
    );

  $("#roomInput").value =
    roomId;

  const label =
    $("#directRoomLabel");

  if (label) {
    label.textContent =
      `Sala ${roomId}`;
  }
}
