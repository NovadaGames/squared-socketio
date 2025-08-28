// server.js (Squared – Socket.IO backend)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// --- Állapot
// roomId -> { players:[socketId], names:{socketId:name}, createdAt, isMatchmade }
const rooms = new Map();
let queue = []; // matchmaking várólista (socketId-k)

// Rövid, jól olvasható room kód (nincs 0/O/1/I)
function makeRoomId(len=5){
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<len;i++) s += ABC[Math.floor(Math.random()*ABC.length)];
  return rooms.has(s) ? makeRoomId(len) : s;
}

function getRoomAndDataBySocket(socket) {
  for (const [rid, r] of rooms) {
    if (r.players.includes(socket.id)) return { rid, room: r };
  }
  return { rid:null, room:null };
}

// --- ÚJ: determinisztikus players lista adott szobához
function sortedPlayers(roomId) {
  const r = rooms.get(roomId);
  return r ? [...r.players].sort() : [];
}

io.on('connection', (socket) => {
  // --- név beállítás (belső állapot + opcionális room broadcast)
  socket.on('name:set', (nameRaw) => {
    const name = String(nameRaw || '').trim().slice(0,24) || 'Player';
    socket.data.name = name;
    const { rid, room } = getRoomAndDataBySocket(socket);
    if (rid && room) {
      room.names[socket.id] = name;
      io.to(rid).emit('room:names', { names: room.names });
    }
  });

  // --- ÚJ: kliens által használt név-announce csatorna
  // A te frontended az 'player:name' eseményt küldi → ezt broadcastoljuk a szobába,
  // hogy a másik kliens megkapja és frissíthesse az OPP_NAME-et.
  socket.on('player:name', ({ roomId, name, from }) => {
    const rid = roomId || getRoomAndDataBySocket(socket).rid;
    if (!rid) return;
    const n = String(name || '').trim().slice(0,24) || 'Player';
    // belső állapot frissítés
    const room = rooms.get(rid);
    if (room) room.names[socket.id] = n;
    // broadcast mindenkinek (a feladó is megkapja; a kliensed saját magát kiszűri)
    io.to(rid).emit('player:name', { roomId: rid, name: n, from: socket.id });
  });

  // --- ROOM: create / join / leave
  socket.on('room:create', (_, cb) => {
    const roomId = makeRoomId();
    rooms.set(roomId, {
      players: [socket.id],
      names: { [socket.id]: socket.data.name || 'Player' },
      createdAt: Date.now(),
      isMatchmade: false
    });
    socket.join(roomId);
    cb && cb({ ok:true, roomId });
    io.to(roomId).emit('room:names', { names: rooms.get(roomId).names });
    // (game:ready-t itt még nem muszáj küldeni, egy játékosnál nincs jelentősége)
  });

  socket.on('room:join', (roomId, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok:false, error:'NO_SUCH_ROOM' });
    if (room.players.length >= 2) return cb && cb({ ok:false, error:'ROOM_FULL' });
    room.players.push(socket.id);
    room.names[socket.id] = socket.data.name || 'Player';
    socket.join(roomId);
    cb && cb({ ok:true, roomId });
    io.to(roomId).emit('room:names', { names: room.names });
    // FIX: game:ready determinisztikus sorrendben
    io.to(roomId).emit('game:ready', { players: sortedPlayers(roomId), names: room.names });
  });

  socket.on('room:leave', () => {
    const { rid, room } = getRoomAndDataBySocket(socket);
    if (!rid) return;
    room.players = room.players.filter(id => id !== socket.id);
    delete room.names[socket.id];
    socket.leave(rid);
    if (room.players.length === 0) rooms.delete(rid);
    else {
      io.to(rid).emit('room:names', { names: room.names });
      io.to(rid).emit('opponent:left');
      // opcionális: újraküldhető a game:ready is, ha szeretnéd
      // io.to(rid).emit('game:ready', { players: sortedPlayers(rid), names: room.names });
    }
  });

  // --- RANDOM MATCHMAKING (queue)
  socket.on('queue:join', () => {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    while (queue.length >= 2) {
      const a = queue.shift(), b = queue.shift();
      const roomId = makeRoomId();
      rooms.set(roomId, {
        players: [a,b],
        names: {
          [a]: io.sockets.sockets.get(a)?.data?.name || 'Player A',
          [b]: io.sockets.sockets.get(b)?.data?.name || 'Player B',
        },
        createdAt: Date.now(),
        isMatchmade: true
      });
      io.sockets.sockets.get(a)?.join(roomId);
      io.sockets.sockets.get(b)?.join(roomId);
      io.to(roomId).emit('match:found', { roomId });
      io.to(roomId).emit('room:names', { names: rooms.get(roomId).names });
      // FIX: game:ready determinisztikus sorrendben
      io.to(roomId).emit('game:ready', { players: sortedPlayers(roomId), names: rooms.get(roomId).names });
    }
  });

  socket.on('queue:leave', () => {
    queue = queue.filter(id => id !== socket.id);
  });

  // --- Játékmenet relay
  socket.on('game:start', (payload) => {
    const rid = payload?.roomId || getRoomAndDataBySocket(socket).rid;
    if (!rid) return;
    // FONTOS: payload pass-through (benne hagyjuk a host által küldött 'names'-t)
    socket.to(rid).emit('game:start', payload);
  });

  socket.on('game:move', (payload) => {
    const rid = payload?.roomId || getRoomAndDataBySocket(socket).rid;
    if (!rid) return;
    socket.to(rid).emit('game:move', payload);
  });

  socket.on('game:surrender', (payload) => {
    const rid = payload?.roomId || getRoomAndDataBySocket(socket).rid;
    if (!rid) return;
    socket.to(rid).emit('game:surrender', payload);
  });

  socket.on('game:restart', (payload) => {
    const rid = payload?.roomId || getRoomAndDataBySocket(socket).rid;
    if (!rid) return;
    io.to(rid).emit('game:restart', payload);
  });

  // --- Lekapcsolódás
  socket.on('disconnect', () => {
    queue = queue.filter(id => id !== socket.id);
    const { rid, room } = getRoomAndDataBySocket(socket);
    if (!rid) return;
    room.players = room.players.filter(id => id !== socket.id);
    delete room.names[socket.id];
    if (room.players.length === 0) rooms.delete(rid);
    else {
      io.to(rid).emit('room:names', { names: room.names });
      io.to(rid).emit('opponent:left');
      // opcionális: io.to(rid).emit('game:ready', { players: sortedPlayers(rid), names: room.names });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Squared Socket.IO server on :' + PORT));
