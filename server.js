const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// rooms: { roomCode: { host, participants: Map<id, peerInfo>, chat, breakoutRooms, settings } }
const rooms = new Map();
// peers: { ws, id, roomCode, name, role, invisible, cameras, breakoutRoom }
const peers = new Map();

function generateRoomCode() {
  let code;
  do { code = crypto.randomInt(100000000000, 999999999999).toString(); }
  while (rooms.has(code));
  return code;
}

function generateId() { return crypto.randomBytes(8).toString('hex'); }

function broadcast(roomCode, data, excludeId = null, targetRole = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.participants.forEach((peer, id) => {
    if (id === excludeId) return;
    if (targetRole && peer.role !== targetRole) return;
    const ws = peer.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

function broadcastToVisible(roomCode, data, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.participants.forEach((peer, id) => {
    if (id === excludeId) return;
    if (peer.invisible && peer.id !== excludeId) return; // invisible users not visible to others
    const ws = peer.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

function getRoomParticipants(roomCode, requesterId) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  const requester = room.participants.get(requesterId);
  const isHostOrMod = requester && (requester.role === 'host' || requester.role === 'moderator');

  return Array.from(room.participants.values()).map(p => ({
    id: p.id,
    name: isHostOrMod ? p.name : (p.invisible ? 'Unknown' : p.name),
    role: p.role,
    invisible: p.invisible,
    cameras: p.cameras || [],
    muted: p.muted,
    videoOff: p.videoOff,
    breakoutRoom: p.breakoutRoom,
    handRaised: p.handRaised,
    // Host-only camera feeds
    hiddenCameras: isHostOrMod ? (p.hiddenCameras || []) : [],
  }));
}

wss.on('connection', (ws) => {
  const id = generateId();
  peers.set(id, { ws, id, roomCode: null, name: 'Guest', role: 'participant', invisible: false, cameras: [], hiddenCameras: [], muted: false, videoOff: false });

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const peer = peers.get(id);
    if (!peer) return;

    switch (msg.type) {

      case 'create-room': {
        const code = generateRoomCode();
        rooms.set(code, {
          host: id,
          participants: new Map(),
          chat: [],
          breakoutRooms: new Map(),
          settings: {
            chatMode: 'public', // public | host-only | disabled | slow | moderated | anonymous
            slowModeSeconds: 10,
            recordingEnabled: false,
            breakoutActive: false,
          }
        });
        peer.roomCode = code;
        peer.name = msg.name || 'Host';
        peer.role = 'host';
        peer.invisible = false;
        rooms.get(code).participants.set(id, peer);
        ws.send(JSON.stringify({ type: 'room-created', roomCode: code, id }));
        break;
      }

      case 'join-room': {
        const { roomCode, name, invisibleToken } = msg;
        const room = rooms.get(roomCode);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }

        // Invisible mode requires a valid one-time token issued by host — cannot be self-requested
        const invisible = !!(invisibleToken && room.invisibleTokens && room.invisibleTokens.has(invisibleToken));
        if (invisible) room.invisibleTokens.delete(invisibleToken);

        peer.roomCode = roomCode;
        peer.name = name || 'Guest';
        // SECURITY: never grant host role on join — only creator or explicit promotion
        peer.role = 'participant';
        peer.invisible = invisible;
        room.participants.set(id, peer);

        ws.send(JSON.stringify({
          type: 'joined-room',
          roomCode,
          id,
          role: peer.role,
          invisible,
          participants: getRoomParticipants(roomCode, id),
          settings: room.settings,
        }));

        if (invisible) {
          room.participants.forEach((p, pid) => {
            if (pid === id) return;
            if (p.role === 'host' || p.role === 'moderator') {
              p.ws.send(JSON.stringify({ type: 'peer-joined', peer: { id, name: peer.name, role: 'participant', invisible: true }, isInvisible: true }));
            }
          });
        } else {
          broadcast(roomCode, { type: 'peer-joined', peer: { id, name: peer.name, role: 'participant', invisible: false } }, id);
        }
        break;
      }

      case 'invite-invisible': {
        // Host generates a one-time token for an invisible join link
        const room = rooms.get(peer.roomCode);
        if (!room || peer.role !== 'host') return;
        if (!room.invisibleTokens) room.invisibleTokens = new Set();
        const token = crypto.randomBytes(16).toString('hex');
        room.invisibleTokens.add(token);
        setTimeout(() => room.invisibleTokens?.delete(token), 10 * 60 * 1000);
        ws.send(JSON.stringify({ type: 'invisible-token', token, roomCode: peer.roomCode }));
        break;
      }

      case 'leave-room': {
        handleLeave(id);
        break;
      }

      // WebRTC signaling
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        const target = room.participants.get(msg.targetId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({ ...msg, fromId: id }));
        }
        break;
      }

      case 'camera-request': {
        // User requests to view someone's camera
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        const target = room.participants.get(msg.targetId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({ type: 'camera-request', fromId: id, fromName: peer.name, cameraId: msg.cameraId }));
        }
        break;
      }

      case 'camera-request-response': {
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        const requester = room.participants.get(msg.toId);
        if (requester && requester.ws.readyState === WebSocket.OPEN) {
          requester.ws.send(JSON.stringify({ type: 'camera-request-response', fromId: id, accepted: msg.accepted, cameraId: msg.cameraId }));
        }
        break;
      }

      case 'chat-message': {
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        const { chatMode } = room.settings;
        if (chatMode === 'disabled') return;

        const senderName = chatMode === 'anonymous' ? 'Anonymous' : peer.name;
        const chatMsg = {
          type: 'chat-message',
          fromId: chatMode === 'anonymous' ? null : id,
          fromName: senderName,
          text: msg.text,
          timestamp: Date.now(),
          dm: msg.dm || null,
          pendingApproval: chatMode === 'moderated',
        };

        if (chatMode === 'host-only') {
          // Only goes to host
          const host = room.participants.get(room.host);
          if (host) host.ws.send(JSON.stringify(chatMsg));
          ws.send(JSON.stringify({ ...chatMsg, toHostOnly: true }));
        } else if (chatMode === 'moderated') {
          // Goes to host for approval
          const host = room.participants.get(room.host);
          if (host) host.ws.send(JSON.stringify({ ...chatMsg, type: 'chat-pending', originalSenderId: id }));
          ws.send(JSON.stringify({ type: 'chat-pending-confirm' }));
        } else if (msg.dm) {
          // DM
          const dmTarget = room.participants.get(msg.dm);
          if (dmTarget) dmTarget.ws.send(JSON.stringify({ ...chatMsg, isDM: true }));
          ws.send(JSON.stringify({ ...chatMsg, isDM: true }));
        } else {
          // Slow mode check
          if (chatMode === 'slow') {
            const now = Date.now();
            if (peer.lastChat && now - peer.lastChat < room.settings.slowModeSeconds * 1000) {
              ws.send(JSON.stringify({ type: 'chat-slow-mode', waitMs: (room.settings.slowModeSeconds * 1000) - (now - peer.lastChat) }));
              return;
            }
            peer.lastChat = now;
          }
          broadcast(peer.roomCode, chatMsg);
          room.chat.push(chatMsg);
        }
        break;
      }

      case 'approve-chat': {
        // Host approves a moderated message
        const room = rooms.get(peer.roomCode);
        if (!room || peer.role !== 'host') return;
        const approvedMsg = { ...msg.message, type: 'chat-message', pendingApproval: false };
        broadcast(peer.roomCode, approvedMsg);
        break;
      }

      case 'host-control': {
        const room = rooms.get(peer.roomCode);
        if (!room || (peer.role !== 'host' && peer.role !== 'moderator')) return;

        switch (msg.action) {
          case 'mute-all':
            broadcast(peer.roomCode, { type: 'force-mute', all: true }, id);
            break;
          case 'mute-user': {
            const t = room.participants.get(msg.targetId);
            if (t) t.ws.send(JSON.stringify({ type: 'force-mute', userId: msg.targetId }));
            break;
          }
          case 'kick-user': {
            const t = room.participants.get(msg.targetId);
            if (t) { t.ws.send(JSON.stringify({ type: 'kicked' })); handleLeave(msg.targetId); }
            break;
          }
          case 'spotlight': {
            broadcast(peer.roomCode, { type: 'spotlight', userId: msg.targetId, cameraId: msg.cameraId });
            break;
          }
          case 'freeze-screens': {
            broadcast(peer.roomCode, { type: 'freeze-screens', frozen: msg.frozen }, id);
            break;
          }
          case 'set-chat-mode': {
            room.settings.chatMode = msg.mode;
            broadcast(peer.roomCode, { type: 'settings-update', settings: room.settings });
            break;
          }
          case 'promote': {
            const t = room.participants.get(msg.targetId);
            if (t) { t.role = msg.role; t.ws.send(JSON.stringify({ type: 'role-changed', role: msg.role })); broadcast(peer.roomCode, { type: 'peer-updated', peerId: msg.targetId, role: msg.role }); }
            break;
          }
          case 'force-layout': {
            broadcast(peer.roomCode, { type: 'force-layout', layout: msg.layout }, id);
            break;
          }
          case 'bring-back-all': {
            broadcast(peer.roomCode, { type: 'end-breakout' });
            room.settings.breakoutActive = false;
            room.breakoutRooms.clear();
            break;
          }
        }
        break;
      }

      case 'update-cameras': {
        peer.cameras = msg.cameras || [];
        peer.hiddenCameras = msg.hiddenCameras || [];
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        // Broadcast camera update (hidden cameras only to host/mods)
        room.participants.forEach((p, pid) => {
          if (pid === id) return;
          const visibleCameras = peer.cameras;
          const hidden = (p.role === 'host' || p.role === 'moderator') ? peer.hiddenCameras : [];
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'peer-cameras-updated', peerId: id, cameras: visibleCameras, hiddenCameras: hidden }));
          }
        });
        break;
      }

      case 'update-status': {
        peer.muted = msg.muted;
        peer.videoOff = msg.videoOff;
        peer.handRaised = msg.handRaised;
        broadcast(peer.roomCode, { type: 'peer-updated', peerId: id, muted: peer.muted, videoOff: peer.videoOff, handRaised: peer.handRaised }, id);
        break;
      }

      // Breakout rooms
      case 'create-breakout-rooms': {
        const room = rooms.get(peer.roomCode);
        if (!room || peer.role !== 'host') return;
        const { count, mode, timeLimit } = msg; // mode: random | self-select
        room.breakoutRooms.clear();
        for (let i = 0; i < count; i++) {
          room.breakoutRooms.set(`breakout-${i+1}`, { name: `Room ${i+1}`, participants: [] });
        }
        room.settings.breakoutActive = true;
        room.settings.breakoutTimeLimit = timeLimit || null;
        room.settings.breakoutMode = mode;

        if (mode === 'random') {
          // Auto-assign participants
          const parts = Array.from(room.participants.values()).filter(p => p.role !== 'host');
          const shuffled = parts.sort(() => Math.random() - 0.5);
          const rooms2 = Array.from(room.breakoutRooms.keys());
          shuffled.forEach((p, i) => {
            const bRoom = rooms2[i % rooms2.length];
            p.breakoutRoom = bRoom;
            room.breakoutRooms.get(bRoom).participants.push(p.id);
            p.ws.send(JSON.stringify({ type: 'assigned-breakout', breakoutRoom: bRoom, timeLimit }));
          });
        }

        broadcast(peer.roomCode, {
          type: 'breakout-created',
          breakoutRooms: Array.from(room.breakoutRooms.entries()).map(([k, v]) => ({ id: k, name: v.name, count: v.participants.length })),
          mode,
          timeLimit,
        });
        break;
      }

      case 'join-breakout': {
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        const br = room.breakoutRooms.get(msg.breakoutRoomId);
        if (!br) return;
        // Remove from old breakout
        if (peer.breakoutRoom) {
          const old = room.breakoutRooms.get(peer.breakoutRoom);
          if (old) old.participants = old.participants.filter(pid => pid !== id);
        }
        peer.breakoutRoom = msg.breakoutRoomId;
        br.participants.push(id);
        ws.send(JSON.stringify({ type: 'joined-breakout', breakoutRoom: msg.breakoutRoomId }));
        break;
      }

      case 'broadcast-to-breakout': {
        const room = rooms.get(peer.roomCode);
        if (!room || peer.role !== 'host') return;
        const { targetBreakout, text } = msg;
        if (targetBreakout === 'all') {
          broadcast(peer.roomCode, { type: 'host-broadcast', text, fromName: peer.name }, id);
        } else {
          const br = room.breakoutRooms.get(targetBreakout);
          if (!br) return;
          br.participants.forEach(pid => {
            const p = room.participants.get(pid);
            if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ type: 'host-broadcast', text, fromName: peer.name }));
          });
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => { handleLeave(id); peers.delete(id); });
  ws.on('error', () => { handleLeave(id); peers.delete(id); });
});

function handleLeave(id) {
  const peer = peers.get(id);
  if (!peer || !peer.roomCode) return;
  const room = rooms.get(peer.roomCode);
  if (!room) return;
  room.participants.delete(id);
  broadcast(peer.roomCode, { type: 'peer-left', peerId: id });

  // Transfer host if needed
  if (peer.role === 'host' && room.participants.size > 0) {
    const newHost = room.participants.values().next().value;
    newHost.role = 'host';
    room.host = newHost.id;
    newHost.ws.send(JSON.stringify({ type: 'promoted-to-host' }));
    broadcast(peer.roomCode, { type: 'peer-updated', peerId: newHost.id, role: 'host' });
  }
  if (room.participants.size === 0) rooms.delete(peer.roomCode);
  peer.roomCode = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NexMeet running on port ${PORT}`));
