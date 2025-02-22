// realtime.js
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { handlePrompt } = require('./handleAiInteractions');

const channels = new Map(); // { channelName: { users: { userUuid: { displayName, color } }, sockets: { userUuid: socket } } }
const realTimeClients = {}; // { userUuid: socket }
const messageLog = []; // Simple in-memory log for debugging

function createRealTimeServers(server, corsOptions) {
  const io = new Server(server, {
    cors: corsOptions,
    pingInterval: 5000,
    pingTimeout: 10000,
    maxHttpBufferSize: 1e8, // 100MB for large documents
  });

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('join-channel', (data) => {
      if (!validateJoinData(data)) {
        socket.emit('message', { type: 'error', message: 'Invalid join data', timestamp: Date.now() });
        return;
      }

      const { userUuid, displayName, channelName } = data;
      socket.join(channelName);
      socket.userUuid = userUuid; // Store for disconnect handling

      if (!channels.has(channelName)) {
        channels.set(channelName, { users: {}, sockets: {} });
      }

      const channel = channels.get(channelName);
      const color = getRandomColor();
      channel.users[userUuid] = { displayName, color };
      channel.sockets[userUuid] = socket;
      realTimeClients[userUuid] = socket;

      console.log(`${displayName} (${userUuid}) joined channel ${channelName}`);
      broadcastToChannel(channelName, 'user-list', { users: channel.users });
    });

    socket.on('leave-channel', (data) => {
      if (!validateLeaveData(data)) return;
      cleanupUser(data.channelName, data.userUuid, socket);
    });

    socket.on('disconnect', () => {
      for (const [channelName, channel] of channels) {
        if (channel.sockets[socket.userUuid]) {
          cleanupUser(channelName, socket.userUuid, socket);
          break;
        }
      }
      console.log(`Client disconnected: ${socket.id}`);
    });

    socket.on('message', (data) => {
      handleMessage(data, socket);
    });
  });
}

function handleMessage(data, socket) {
  if (!validateMessage(data)) {
    socket.emit('message', { type: 'error', message: 'Invalid message format', timestamp: Date.now() });
    return;
  }

  const { userUuid, channelName, type, timestamp } = data;
  if (!channels.has(channelName) || !channels.get(channelName).users[userUuid]) {
    socket.emit('message', { type: 'error', message: 'Invalid channel or user', timestamp: Date.now() });
    return;
  }

  messageLog.push({ type, userUuid, channelName, timestamp }); // Log for debugging
  if (messageLog.length > 1000) messageLog.shift(); // Limit log size

  switch (type) {
    case 'heartbeat':
      if (data.type === 'ping') {
        socket.emit('message', { type: 'pong', timestamp: Date.now() });
      }
      break;
    case 'add-document':
    case 'remove-document':
    case 'add-clip':
    case 'remove-clip':
    case 'vote-clip':
    case 'transcription-update':
    case 'flag-sentence':
    case 'remove-synthesis':
    case 'chat-draft':
    case 'chat-message':
      broadcastToChannel(channelName, type, data);
      break;
    case 'add-synthesis':
      handleSynthesis(data, channelName);
      break;
    case 'agent-message':
      handleAgentMessage(data, channelName); // Stub for AI chat
      break;
    default:
      console.warn(`Unknown message type: ${type}`);
      socket.emit('message', { type: 'error', message: `Unknown message type: ${type}`, timestamp: Date.now() });
  }
}

function broadcastToChannel(channelName, type, data) {
  if (channels.has(channelName)) {
    const channel = channels.get(channelName);
    const payload = { type, timestamp: data.timestamp, ...data };
    for (const userUuid in channel.sockets) {
      channel.sockets[userUuid].emit('message', payload);
    }
  }
}

function sendToClient(userUuid, type, message = null) {
  const socket = realTimeClients[userUuid];
  if (socket) {
    socket.emit('message', { type, message, timestamp: Date.now() });
  } else {
    console.error(`No client found for UUID: ${userUuid}`);
  }
}

function cleanupUser(channelName, userUuid, socket) {
  if (channels.has(channelName)) {
    const channel = channels.get(channelName);
    delete channel.users[userUuid];
    delete channel.sockets[userUuid];
    delete realTimeClients[userUuid];
    socket.leave(channelName);

    if (Object.keys(channel.users).length === 0) {
      channels.delete(channelName);
      console.log(`Channel ${channelName} deleted (empty)`);
    } else {
      broadcastToChannel(channelName, 'user-list', { users: channel.users });
    }
    console.log(`${userUuid} left channel ${channelName}`);
  }
}

// Validation functions
function validateJoinData(data) {
  return data && data.userUuid && data.displayName && data.channelName;
}

function validateLeaveData(data) {
  return data && data.userUuid && data.channelName;
}

function validateMessage(data) {
  return data && data.userUuid && data.channelName && data.type && data.timestamp;
}

// AI synthesis handler
async function handleSynthesis(data, channelName) {
  const { userUuid, synthesis } = data;
  const promptConfig = {
    uuid: userUuid,
    session: synthesis.id,
    model: { provider: 'openai', model: 'gpt-4' }, // Placeholder
    temperature: 0.7,
    systemPrompt: 'Summarize the provided clips concisely',
    userPrompt: synthesis.prompt,
    messageHistory: synthesis.clips.map(clip => ({ role: 'user', content: clip.content })),
  };

  await handlePrompt(promptConfig, (uuid, session, type, message) => {
    if (type === 'message') {
      synthesis.output = (synthesis.output || '') + message;
    } else if (type === 'EOM') {
      broadcastToChannel(channelName, 'add-synthesis', { userUuid, synthesis });
    } else if (type === 'ERROR') {
      console.error('Synthesis error:', message);
      sendToClient(userUuid, 'error', message);
    }
  });
}

// AI agent chat handler (stub)
function handleAgentMessage(data, channelName) {
  // TODO: Integrate with AI logic for chat participation
  broadcastToChannel(channelName, 'agent-message', data);
}

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

module.exports = { createRealTimeServers, sendToClient };