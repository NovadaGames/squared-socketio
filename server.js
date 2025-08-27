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
const rooms = new Map(); // roomId -> { players: [socketId], createdAt, isMatchmade }
let queue = [];          // matchmaking várólista (socketId-k)

// Rövid, jól olvasható room kód (nincs 0/O/1/I)
function makeRoomId(len=5){
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<len;i++) s += ABC[Math.floor(Math.random()*ABC.length)];
  return rooms.has(s) ? makeRoomId(len) : s;
}
function roomOf(socket){
  for (const [rid, r] of rooms){
    if (r.players.includes(socket.id)) return rid;
  }
  return null;
}

io.on('connection', (socket) => {
  // --- ROOM: create / join / leave
  socket.on('room:create', (_, cb) => {
    const roomId = makeRoomId();
    rooms.set(roomId, { players: [socket.id], createdAt: Date.now(), isMatchmade: false });
    socket.join(roomId);
    cb && cb({ ok:true, roomId });
  });

  socket.on('room:join', (roomId, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok:false, error:'NO_SUCH_ROOM' });
    if (room.players.length >= 2) return cb && cb({ ok:false, error:'ROOM_FULL' });
    room.players.push(socket.id);
    socket.join(roomId);
    cb && cb({ ok:true, roomId });
    io.to(roomId).emit('game:ready', { players: room.players });
  });

  socket.on('room:leave', () => {
    const rid = roomOf(socket);
    if (!rid) return;
    const room = rooms.get(rid);
    room.players = room.players.filter(id => id !== socket.id);
    socket.leave(rid);
    if (room.players.length === 0) rooms.delete(rid);
    else io.to(rid).emit('opponent:left');
  });

  // --- RANDOM MATCHMAKING (queue)
  socket.on('queue:join', () => {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    while (queue.length >= 2) {
      const a = queue.shift(), b = queue.shift();
      const roomId = makeRoomId();
      rooms.set(roomId, { players: [a,b], createdAt: Date.now(), isMatchmade: true });
      io.sockets.sockets.get(a)?.join(roomId);
      io.sockets.sockets.get(b)?.join(roomId);
      io.to(roomId).emit('match:found', { roomId });
      io.to(roomId).emit('game:ready', { players: [a,b] });
    }
  });
  socket.on('queue:leave', () => { queue = queue.filter(id => id !== socket.id); });

  // --- Játékmenet relay (a szobán belül továbbítjuk)
  socket.on('game:start', (payload) => { // { roomId, seed/layout, firstPlayerId }
    const rid = payload.roomId || roomOf(socket);
    if (!rid) return;
    socket.to(rid).emit('game:start', payload);
  });
  socket.on('game:move', (payload) => { // { roomId, start:{x,y}, byPlayerId }
    const rid = payload.roomId || roomOf(socket);
    if (!rid) return;
    socket.to(rid).emit('game:move', payload);
  });
  socket.on('game:surrender', (payload) => {
    const rid = payload.roomId || roomOf(socket);
    if (!rid) return;
    socket.to(rid).emit('game:surrender', payload);
  });
  socket.on('game:restart', (payload) => {
    const rid = payload.roomId || roomOf(socket);
    if (!rid) return;
    io.to(rid).emit('game:restart', payload);
  });

  // --- Lekapcsolódás
  socket.on('disconnect', () => {
    queue = queue.filter(id => id !== socket.id);
    const rid = roomOf(socket);
    if (!rid) return;
    const room = rooms.get(rid);
    room.players = room.players.filter(id => id !== socket.id);
    if (room.players.length === 0) rooms.delete(rid);
    else io.to(rid).emit('opponent:left');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Squared Socket.IO server on :' + PORT));
