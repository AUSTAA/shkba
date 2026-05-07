const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 🔥 مهم جدًا: حفظ البيانات حتى مع إعادة تشغيل خفيفة
global.rooms = global.rooms || {};
const rooms = global.rooms;

// ===================== GAME LOGIC =====================

function createDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["A", "2", "3", "4", "5", "6", "7", "Q", "J", "K"];
  const deck = [];

  for (let s = 0; s < suits.length; s++) {
    for (let v = 0; v < values.length; v++) {
      deck.push({ value: values[v], suit: suits[s] });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardVal(v) {
  if (v === "A") return 1;
  if (v === "Q") return 8;
  if (v === "J") return 9;
  if (v === "K") return 10;
  return parseInt(v);
}

function findCombos(cards, target) {
  const result = [];

  function find(cur, remaining, sum) {
    if (sum === target) {
      result.push(cur.slice());
      return;
    }
    if (sum > target || !remaining.length) return;

    find(cur.concat([remaining[0]]), remaining.slice(1), sum + cardVal(remaining[0].value));
    find(cur, remaining.slice(1), sum);
  }

  find([], cards, 0);
  return result;
}

function initGame() {
  const deck = shuffle(createDeck());

  const p1Hand = [];
  const p2Hand = [];
  const middle = [];

  for (let i = 0; i < 3; i++) {
    p1Hand.push(deck.pop());
    p2Hand.push(deck.pop());
  }

  for (let i = 0; i < 4; i++) {
    middle.push(deck.pop());
  }

  return {
    deck,
    p1Hand,
    p2Hand,
    middle,
    p1Collected: [],
    p2Collected: [],
    p1Score: 0,
    p2Score: 0,
    currentPlayer: 1,
    lastTaker: null,
    lastAction: null
  };
}

function dealNext(g) {
  for (let i = 0; i < 3; i++) {
    if (g.deck.length) g.p1Hand.push(g.deck.pop());
    if (g.deck.length) g.p2Hand.push(g.deck.pop());
  }
}

// ===================== ROUND RESULT =====================

function calcRound(g) {
  if (g.lastTaker === 1) g.p1Collected = g.p1Collected.concat(g.middle);
  else if (g.lastTaker === 2) g.p2Collected = g.p2Collected.concat(g.middle);

  g.middle = [];

  const p1d = g.p1Collected.filter(c => c.suit === "diamonds").length;
  const p2d = g.p2Collected.filter(c => c.suit === "diamonds").length;

  const p1s7 = g.p1Collected.filter(c => c.value === "7").length;
  const p2s7 = g.p2Collected.filter(c => c.value === "7").length;

  const p1s6 = g.p1Collected.filter(c => c.value === "6").length;
  const p2s6 = g.p2Collected.filter(c => c.value === "6").length;

  let p1pts = 0, p2pts = 0;
  let p1det = [], p2det = [];

  const p1sh = g.p1Collected.filter(c => c.shkba)
    .reduce((s, c) => s + cardVal(c.value), 0);

  const p2sh = g.p2Collected.filter(c => c.shkba)
    .reduce((s, c) => s + cardVal(c.value), 0);

  if (p1sh) { p1pts += p1sh; p1det.push("shkba " + p1sh); }
  if (p2sh) { p2pts += p2sh; p2det.push("shkba " + p2sh); }

  if (p1d > p2d) { p1pts++; p1det.push("diamonds"); }
  else if (p2d > p1d) { p2pts++; p2det.push("diamonds"); }

  if (p1s7 > p2s7) { p1pts++; p1det.push("7s"); }
  else if (p2s7 > p1s7) { p2pts++; p2det.push("7s"); }

  g.p1Score += p1pts;
  g.p2Score += p2pts;

  return {
    player1Details: p1det.join(", ") || "nothing",
    player2Details: p2det.join(", ") || "nothing",
    player1Score: g.p1Score,
    player2Score: g.p2Score,
    winner: null
  };
}

// ===================== BROADCAST =====================

function broadcast(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const g = room.game;

  room.players.forEach(p => {
    const me = p.number === 1;

    io.to(p.id).emit("game_state", {
      myHand: me ? g.p1Hand : g.p2Hand,
      opponentHandCount: me ? g.p2Hand.length : g.p1Hand.length,
      middleCards: g.middle,
      player1Score: g.p1Score,
      player2Score: g.p2Score,
      myCollectedCount: me ? g.p1Collected.length : g.p2Collected.length,
      opponentCollectedCount: me ? g.p2Collected.length : g.p1Collected.length,
      currentPlayer: g.currentPlayer,
      myNumber: p.number,
      deckCount: g.deck.length,
      lastAction: g.lastAction
    });
  });
}

// ===================== SOCKET =====================

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("create_room", (data) => {
    const roomId = data.roomId;

    rooms[roomId] = {
      players: [{ id: socket.id, name: data.playerName, number: 1 }],
      game: null,
      started: false
    };

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerNumber = 1;

    socket.emit("room_created", { roomId });
  });

  socket.on("join_room", (data) => {
    const room = rooms[data.roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found!" });
      return;
    }

    room.players.push({
      id: socket.id,
      name: data.playerName,
      number: 2
    });

    socket.join(data.roomId);
    socket.roomId = data.roomId;
    socket.playerNumber = 2;

    socket.emit("room_joined", {
      roomId: data.roomId,
      opponentName: room.players[0].name
    });

    io.to(room.players[0].id).emit("opponent_joined", {
      opponentName: data.playerName
    });

    room.started = true;
    room.game = initGame();

    broadcast(data.roomId);
  });

  socket.on("play_card", (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.game) return;

    const g = room.game;
    const pn = socket.playerNumber;

    if (g.currentPlayer !== pn) return;

    const hand = pn === 1 ? g.p1Hand : g.p2Hand;
    const collected = pn === 1 ? g.p1Collected : g.p2Collected;

    const card = hand[data.cardIndex];
    if (!card) return;

    g.middle.push(card);
    hand.splice(data.cardIndex, 1);

    g.lastAction = { player: pn, message: "played" };
    g.currentPlayer = g.currentPlayer === 1 ? 2 : 1;

    broadcast(socket.roomId);
  });

  socket.on("disconnect", () => {
    if (socket.roomId && rooms[socket.roomId]) {
      io.to(socket.roomId).emit("opponent_disconnected");
      delete rooms[socket.roomId];
    }
  });
});

// ===================== START =====================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
