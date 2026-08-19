const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 10000;
const MAX_PARTICIPANTS = 12;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "TelaFácil",
    time: new Date().toISOString()
  });
});

const rooms = new Map();

function createRoomId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function createRoom(password = "") {
  let id = createRoomId();

  while (rooms.has(id)) {
    id = createRoomId();
  }

  const room = {
    id,
    password: String(password || ""),
    clients: new Set(),
    hostId: null,
    mutedAll: false
  };

  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  return rooms.get(id);
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except = null) {
  for (const client of room.clients) {
    if (client.ws !== except) {
      send(client.ws, message);
    }
  }
}

function participantInfo(client) {
  return {
    peerId: client.peerId,
    name: client.name,
    sharing: client.sharing,
    micOn: client.micOn,
    host: client.peerId === client.room.hostId
  };
}

function broadcastParticipants(room) {
  broadcast(room, {
    type: "participants",
    participants: [...room.clients].map(participantInfo),
    mutedAll: room.mutedAll
  });
}

function removeClient(ws) {
  const room = ws.room;

  if (!room) return;

  const client = [...room.clients].find(
    item => item.ws === ws
  );

  if (!client) return;

  room.clients.delete(client);

  broadcast(room, {
    type: "participant-left",
    peerId: client.peerId
  });

  if (room.hostId === client.peerId) {
    const next = room.clients.values().next().value;

    room.hostId = next ? next.peerId : null;

    if (next) {
      send(next.ws, {
        type: "host-changed",
        host: true
      });
    }
  }

  broadcastParticipants(room);

  if (room.clients.size === 0) {
    rooms.delete(room.id);
  }
}

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /*
     * CRIAR SALA
     */
    if (msg.type === "create-room") {
      const room = createRoom(msg.password);

      send(ws, {
        type: "room-created",
        room: room.id
      });

      return;
    }

    /*
     * ENTRAR NA SALA
     */
    if (msg.type === "join") {
      const roomId = String(msg.room || "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32);

      const name =
        String(msg.name || "Convidado")
          .trim()
          .slice(0, 30) || "Convidado";

      const password = String(msg.password || "");

      if (!roomId) {
        send(ws, {
          type: "error",
          message: "Sala inválida."
        });

        return;
      }

      const room = getRoom(roomId);

      if (!room) {
        send(ws, {
          type: "error",
          message: "Essa sala não existe ou já foi encerrada."
        });

        return;
      }

      if (room.password && room.password !== password) {
        send(ws, {
          type: "password-required",
          message: "Senha da sala incorreta."
        });

        return;
      }

      if (room.clients.size >= MAX_PARTICIPANTS) {
        send(ws, {
          type: "error",
          message: `A sala atingiu o limite de ${MAX_PARTICIPANTS} participantes.`
        });

        return;
      }

      const peerId = crypto.randomUUID();

      const client = {
        ws,
        peerId,
        name,
        room,
        sharing: false,
        micOn: false
      };

      ws.room = room;
      ws.peerId = peerId;

      room.clients.add(client);

      if (!room.hostId) {
        room.hostId = peerId;
      }

      send(ws, {
        type: "joined",
        peerId,
        room: room.id,
        host: room.hostId === peerId,
        mutedAll: room.mutedAll,
        participants: [...room.clients].map(participantInfo)
      });

      broadcast(
        room,
        {
          type: "participant-joined",
          participant: participantInfo(client)
        },
        ws
      );

      broadcastParticipants(room);

      return;
    }

    const room = ws.room;

    if (!room) {
      return;
    }

    const me = [...room.clients].find(
      client => client.ws === ws
    );

    if (!me) {
      return;
    }

    /*
     * SINALIZAÇÃO WEBRTC
     */
    if (msg.type === "signal") {
      const target = [...room.clients].find(
        client => client.peerId === msg.to
      );

      if (target) {
        send(target.ws, {
          type: "signal",
          from: me.peerId,
          fromName: me.name,
          signal: msg.signal
        });
      }

      return;
    }

    /*
     * COMPARTILHAMENTO DE TELA
     */
    if (msg.type === "sharing") {
      me.sharing = !!msg.value;

      broadcastParticipants(room);

      return;
    }

    /*
     * MICROFONE
     */
    if (msg.type === "mic") {
      me.micOn = !!msg.value;

      broadcastParticipants(room);

      return;
    }

    /*
     * MUTAR TODOS
     */
    if (msg.type === "mute-all") {
      if (me.peerId !== room.hostId) {
        send(ws, {
          type: "error",
          message: "Somente o criador da sala pode mutar todos."
        });

        return;
      }

      room.mutedAll = !!msg.value;

      broadcast(room, {
        type: "mute-all",
        value: room.mutedAll
      });

      broadcastParticipants(room);

      return;
    }

    /*
     * CHAT
     */
    if (msg.type === "chat") {
      const text = String(msg.text || "")
        .trim()
        .slice(0, 500);

      if (!text) return;

      broadcast(room, {
        type: "chat",
        from: me.name,
        peerId: me.peerId,
        text,
        at: Date.now()
      });

      return;
    }
  });

  ws.on("close", () => {
    removeClient(ws);
  });

  ws.on("error", () => {
    removeClient(ws);
  });
});

/*
 * Mantém WebSocket ativo
 */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      try {
        ws.terminate();
      } catch {}

      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/*
 * Fallback do frontend.
 * Compatível com Express 5.
 */
app.use((_req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `TelaFácil rodando na porta ${PORT}`
  );
});
