require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- HELPER: Generate Board ---
const generateFairBoard = (boardNumber) => {
  const columns = [
    { min: 1, max: 15 }, { min: 16, max: 30 }, { min: 31, max: 45 }, 
    { min: 46, max: 60 }, { min: 61, max: 75 }
  ];
  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };
  const matrix = Array.from({ length: 5 }, () => Array(5).fill(0));
  columns.forEach((col, colIdx) => {
    const pool = Array.from({ length: 15 }, (_, i) => col.min + i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(boardNumber + colIdx * 543 + i) * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let r = 0; r < 5; r++) matrix[r][colIdx] = (colIdx === 2 && r === 2) ? "*" : pool[r];
  });
  return matrix;
};

// --- HELPER: Check Win ---
const checkWin = (boardNum, calledNumbers) => {
  const matrix = generateFairBoard(boardNum);
  const isMarked = (val) => val === '*' || calledNumbers.includes(val);
  
  // Rows
  for (let r = 0; r < 5; r++) if (matrix[r].every(val => isMarked(val))) return { type: 'ROW', index: r };
  // Cols
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => isMarked(matrix[r][c]))) return { type: 'COL', index: c };
  // Diagonals
  if ([0,1,2,3,4].every(i => isMarked(matrix[i][i]))) return { type: 'DIAG', index: 1 };
  if ([0,1,2,3,4].every(i => isMarked(matrix[i][4-i]))) return { type: 'DIAG', index: 2 };
  // Corners
  if (isMarked(matrix[0][0]) && isMarked(matrix[0][4]) && isMarked(matrix[4][0]) && isMarked(matrix[4][4])) return { type: 'CORNER', index: 0 };

  return null;
};

// --- GAME STATE ---
let rooms = {
  'R1': { id: 'R1', stake: 10, timer: 30, status: 'WAITING', calledNumbers: [], players: [] },
  'R2': { id: 'R2', stake: 50, timer: 60, status: 'WAITING', calledNumbers: [], players: [] }
};

// --- GAME LOOP (1 Second Tick) ---
setInterval(() => {
  Object.values(rooms).forEach(room => {
    // 1. Waiting Phase
    if (room.status === 'WAITING') {
      if (room.timer > 0) {
        room.timer--;
      } else {
        if(room.players.length > 0) { // Only start if players exist
            room.status = 'PLAYING';
            room.calledNumbers = [];
            io.to(room.id).emit('game_start', { roomId: room.id });
        } else {
            room.timer = 30; // Reset timer if no players
        }
      }
      io.emit('lobby_update', { 
        roomId: room.id, 
        timer: room.timer, 
        status: room.status, 
        playerCount: room.players.length 
      });
    } 
    // 2. Playing Phase
    else if (room.status === 'PLAYING') {
      if (room.timer <= 0) {
        if (room.calledNumbers.length >= 75) {
          room.status = 'WAITING';
          room.timer = 30;
          io.to(room.id).emit('game_over', { winner: null });
          room.players = [];
          io.in(room.id).socketsLeave(room.id);
        } else {
          let nextNum;
          do { nextNum = Math.floor(Math.random() * 75) + 1; } while (room.calledNumbers.includes(nextNum));
          room.calledNumbers.push(nextNum);
          io.to(room.id).emit('number_called', nextNum);
          room.timer = 4; // Call speed (4 seconds)
        }
      } else {
        room.timer--;
      }
    }
  });
}, 1000);

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  // 1. Login/Auth
  socket.on('login', async (userData) => {
    try {
        let user = await User.findOne({ telegramId: userData.id.toString() });
        if (!user) {
            user = await User.create({
                telegramId: userData.id.toString(),
                firstName: userData.first_name,
                username: userData.username,
                balance: 50 // Free 50 ETB Bonus
            });
        }
        socket.data.user = user;
        socket.emit('login_success', { balance: user.balance, userId: user.telegramId });
    } catch (e) {
        console.error(e);
    }
  });

  // 2. Join Room
  socket.on('join_game', async ({ roomId, boardNumber }) => {
    const user = socket.data.user;
    if (!user) return;
    
    const room = rooms[roomId];
    if (room.status !== 'WAITING') return socket.emit('error', 'Game already started');

    const dbUser = await User.findById(user._id);
    if (dbUser.balance < room.stake) return socket.emit('error', 'Insufficient Funds');

    dbUser.balance -= room.stake;
    await dbUser.save();
    
    // Refresh User Data
    socket.data.user = dbUser;
    socket.data.boardNumber = boardNumber;
    socket.join(roomId);
    room.players.push(socket.id);
    
    socket.emit('joined_success', { balance: dbUser.balance });
    io.to(roomId).emit('player_count', room.players.length);
  });

  // 3. Claim Bingo
  socket.on('bingo_claim', async ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'PLAYING') return;

    const win = checkWin(socket.data.boardNumber, room.calledNumbers);
    if (win) {
        const pot = room.stake * room.players.length * 0.8; // 80% to winner
        await User.updateOne({ _id: socket.data.user._id }, { $inc: { balance: pot } });
        
        io.to(roomId).emit('game_over', { 
            winner: socket.data.user.firstName, 
            amount: pot, 
            winInfo: win 
        });
        
        room.status = 'WAITING';
        room.timer = 30;
        room.players = [];
        io.in(roomId).socketsLeave(roomId);
    }
  });
});

// --- API FOR BOT ---
app.post('/api/deposit', async (req, res) => {
    const { telegramId, amount } = req.body;
    await User.updateOne({ telegramId }, { $inc: { balance: amount } });
    
    // Notify connected client
    const sockets = await io.fetchSockets();
    const s = sockets.find(s => s.data.user?.telegramId === telegramId);
    if(s) {
        const u = await User.findOne({ telegramId });
        s.emit('balance_update', u.balance);
    }
    res.json({ success: true });
});

server.listen(3001, () => console.log('🚀 Server running on port 3001'));