const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "TelaFácil",
    time: new Date().toISOString()
  });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = new Map();

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except = null) {
  for (const client of room.clients) {
    if (client !== except) {
      send(client.ws, message);
    }
  }
}

function getRoom(id) {
  let room = rooms.get(id);

  if (!room) {
    room = {
      clients: new Set()
    };

    rooms.set(id, room);
  }

  return room;
}

function cleanRoom(room) {
  if (room.clients.size === 0) {
    for (const [id, r] of rooms) {
      if (r === room) {
        rooms.delete(id);
      }
    }
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      const id = String(msg.room || "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32);

      const name =
        String(msg.name || "Convidado")
          .trim()
          .slice(0, 30) || "Convidado";

      if (!id) {
        return send(ws, {
          type: "error",
          message: "Sala inválida."
        });
      }

      const room = getRoom(id);

      if (room.clients.size >= 12) {
        return send(ws, {
          type: "error",
          message: "Esta sala atingiu o limite de 12 participantes."
        });
      }

      const peerId = crypto.randomUUID();

      ws.roomId = id;
      ws.peerId = peerId;
      ws.name = name;

      const participant = {
        ws,
        peerId,
        name,
        sharing: false
      };

      room.clients.add(participant);

      send(ws, {
        type: "joined",
        peerId,
        room: id,
        participants: [...room.clients].map((p) => ({
          peerId: p.peerId,
          name: p.name,
          sharing: p.sharing
        }))
      });

      broadcast(
        room,
        {
          type: "participant-joined",
          participant: {
            peerId,
            name,
            sharing: false
          }
        },
        participant
      );

      return;
    }

    const room = ws.roomId
      ? rooms.get(ws.roomId)
      : null;

    if (!room) {
      return;
    }

    const me = [...room.clients].find(
      (p) => p.ws === ws
    );

    if (!me) {
      return;
    }

    if (msg.type === "signal") {
      const target = [...room.clients].find(
        (p) => p.peerId === msg.to
      );

      if (target) {
        send(target.ws, {
          type: "signal",
          from: me.peerId,
          fromName: me.name,
          signal: msg.signal
        });
      }
    }

    if (msg.type === "sharing") {
      me.sharing = !!msg.value;

      broadcast(room, {
        type: "participant-updated",
        participant: {
          peerId: me.peerId,
          name: me.name,
          sharing: me.sharing
        }
      });
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "")
        .trim()
        .slice(0, 500);

      if (!text) {
        return;
      }

      broadcast(room, {
        type: "chat",
        from: me.name,
        peerId: me.peerId,
        text,
        at: Date.now()
      });
    }
  });

  ws.on("close", () => {
    const room = ws.roomId
      ? rooms.get(ws.roomId)
      : null;

    if (!room) {
      return;
    }

    const me = [...room.clients].find(
      (p) => p.ws === ws
    );

    if (me) {
      room.clients.delete(me);

      broadcast(room, {
        type: "participant-left",
        peerId: me.peerId
      });
    }

    cleanRoom(room);
  });
});

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `TelaFácil rodando na porta ${PORT}`
  );
});
