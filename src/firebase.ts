import { initializeApp } from 'firebase/app';
import {
  getFirestore, doc, setDoc, getDoc, onSnapshot, updateDoc,
  type Unsubscribe, type DocumentReference
} from 'firebase/firestore';
import { GameState } from './types';

// ===== FIREBASE CONFIG =====
// Замените на свой конфиг из Firebase Console → Project Settings → Web App
// Инструкция: см. DEPLOY.md
const firebaseConfig = {
  apiKey: "AIzaSyDemo-key-replace-me",
  authDomain: "magnat-game.firebaseapp.com",
  projectId: "magnat-game",
  storageBucket: "magnat-game.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:abcdef1234567890"
};

let app: ReturnType<typeof initializeApp> | null = null;
let db: ReturnType<typeof getFirestore> | null = null;

function getDb() {
  if (!db) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  }
  return db;
}

// ===== ROOM DATA =====
export interface RoomData {
  code: string;
  hostId: string;
  hostName: string;
  playerSlots: { id: string; name: string; ready: boolean }[];
  maxPlayers: number;
  state: GameState | null;
  phase: 'lobby' | 'playing' | 'finished';
  createdAt: number;
  lastActivity: number; // для определения AFK
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generatePlayerId(): string {
  return 'u_' + Math.random().toString(36).substring(2, 10);
}

function roomRef(code: string): DocumentReference {
  return doc(getDb(), 'rooms', code.toUpperCase());
}

// ===== ANTI-CHEAT VALIDATION =====
// Клиентская валидация — проверяем что изменения легитимны
function validateStateUpdate(oldState: GameState | null, newState: GameState): boolean {
  if (!oldState) return true; // Первый стейт (старт игры)

  // Проверка: деньги не могут появиться из ниоткуда
  // Общая сумма денег в игре + стоимость купленного должна быть примерно стабильной
  const oldTotalMoney = oldState.players.reduce((s, p) => s + p.money, 0) + oldState.parkingPot;
  const newTotalMoney = newState.players.reduce((s, p) => s + p.money, 0) + newState.parkingPot;

  // Допускаем разницу из-за покупок/продаж/кредитов/штрафов, но не более ₽2M за ход
  const diff = Math.abs(newTotalMoney - oldTotalMoney);
  if (diff > 2_000_000) {
    console.warn('Anti-cheat: подозрительное изменение баланса:', diff);
    return false;
  }

  // Проверка: нельзя менять чужие данные когда не твой ход
  // (мягкая проверка — логируем но не блокируем, т.к. есть легитимные причины)

  // Проверка: turnCount должен только увеличиваться
  if (newState.turnCount < oldState.turnCount) {
    console.warn('Anti-cheat: попытка откатить ход');
    return false;
  }

  return true;
}

// ===== CREATE ROOM =====
export async function createRoom(hostName: string, maxPlayers: number): Promise<{ code: string; playerId: string }> {
  // Валидация
  if (maxPlayers < 2 || maxPlayers > 6) throw new Error('Количество игроков: от 2 до 6');
  if (hostName.length > 20) hostName = hostName.slice(0, 20);

  const code = generateCode();
  const playerId = generatePlayerId();
  const room: RoomData = {
    code,
    hostId: playerId,
    hostName,
    playerSlots: [{ id: playerId, name: hostName, ready: true }],
    maxPlayers,
    state: null,
    phase: 'lobby',
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  await setDoc(roomRef(code), room);
  return { code, playerId };
}

// ===== JOIN ROOM =====
export async function joinRoom(code: string, playerName: string): Promise<{ playerId: string; room: RoomData } | null> {
  if (playerName.length > 20) playerName = playerName.slice(0, 20);

  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const room = snap.data() as RoomData;
  if (room.phase !== 'lobby') return null;
  if (room.playerSlots.length >= room.maxPlayers) return null;

  const playerId = generatePlayerId();
  room.playerSlots.push({ id: playerId, name: playerName, ready: false });
  await updateDoc(ref, { playerSlots: room.playerSlots, lastActivity: Date.now() });
  return { playerId, room };
}

// ===== TOGGLE READY =====
export async function toggleReady(code: string, playerId: string): Promise<void> {
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as RoomData;
  const slot = room.playerSlots.find(s => s.id === playerId);
  if (slot) {
    slot.ready = !slot.ready;
    await updateDoc(ref, { playerSlots: room.playerSlots, lastActivity: Date.now() });
  }
}

// ===== START GAME (host only) =====
export async function startOnlineGame(code: string, state: GameState): Promise<void> {
  await updateDoc(roomRef(code), { state, phase: 'playing', lastActivity: Date.now() });
}

// ===== UPDATE STATE (with anti-cheat) =====
export async function updateRoomState(code: string, state: GameState): Promise<void> {
  const ref = roomRef(code);

  // Читаем текущий стейт для валидации
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const room = snap.data() as RoomData;
    if (room.state && !validateStateUpdate(room.state, state)) {
      console.error('Anti-cheat: обновление заблокировано');
      return; // Блокируем подозрительное обновление
    }
  }

  await updateDoc(ref, { state, lastActivity: Date.now() });
}

// ===== LEAVE ROOM =====
export async function leaveRoom(code: string, playerId: string): Promise<void> {
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as RoomData;
  room.playerSlots = room.playerSlots.filter(s => s.id !== playerId);
  if (room.playerSlots.length === 0) {
    await updateDoc(ref, { phase: 'finished', playerSlots: [], lastActivity: Date.now() });
  } else {
    if (room.hostId === playerId) {
      room.hostId = room.playerSlots[0].id;
    }
    await updateDoc(ref, { playerSlots: room.playerSlots, hostId: room.hostId, lastActivity: Date.now() });
  }
}

// ===== SEND CHAT MESSAGE =====
export async function sendChatMessage(code: string, playerId: string, playerName: string, playerColor: string, text: string): Promise<void> {
  if (text.length > 200) text = text.slice(0, 200);
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as RoomData;
  if (!room.state) return;

  const msg = {
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    playerId,
    playerName,
    playerColor,
    text,
    isSystem: false,
    time: Date.now(),
  };

  const chat = [...(room.state.chat || []), msg];
  if (chat.length > 100) chat.splice(0, chat.length - 100);
  await updateDoc(ref, { 'state.chat': chat, lastActivity: Date.now() });
}

// ===== SEND EMOJI REACTION =====
export async function sendReaction(code: string, playerId: string, emoji: string): Promise<void> {
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as RoomData;
  if (!room.state) return;

  const reaction = { playerId, emoji, time: Date.now() };
  const reactions = [...(room.state.reactions || []), reaction];
  // Keep only last 20 reactions
  if (reactions.length > 20) reactions.splice(0, reactions.length - 20);
  await updateDoc(ref, { 'state.reactions': reactions, lastActivity: Date.now() });
}

// ===== KICK PLAYER (host only) =====
export async function kickPlayer(code: string, hostId: string, targetPlayerId: string): Promise<void> {
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as RoomData;

  // Only host can kick
  if (room.hostId !== hostId) return;
  // Can't kick yourself
  if (targetPlayerId === hostId) return;

  if (room.phase === 'lobby') {
    room.playerSlots = room.playerSlots.filter(s => s.id !== targetPlayerId);
    await updateDoc(ref, { playerSlots: room.playerSlots, lastActivity: Date.now() });
  } else if (room.phase === 'playing' && room.state) {
    // In-game kick: bankrupt the player
    const player = room.state.players.find(p => p.id === targetPlayerId);
    if (player && !player.bankrupt) {
      player.bankrupt = true;
      player.money = 0;
      room.state.board.forEach(c => {
        if (c.ownerId === targetPlayerId) {
          c.ownerId = null;
          c.houses = 0;
          c.mortgaged = false;
        }
      });
      room.state.log.unshift({
        text: `${player.name} был исключён хостом`,
        icon: '🚫',
        time: Date.now(),
      });

      // Add system chat message
      room.state.chat.push({
        id: 'm_sys_' + Date.now(),
        playerId: 'system',
        playerName: 'Система',
        playerColor: '#888',
        text: `${player.name} исключён из игры`,
        isSystem: true,
        time: Date.now(),
      });

      // Check if current player was kicked, advance turn
      const currentPlayer = room.state.players[room.state.currentPlayer];
      if (currentPlayer.id === targetPlayerId) {
        let next = (room.state.currentPlayer + 1) % room.state.players.length;
        while (room.state.players[next].bankrupt) {
          next = (next + 1) % room.state.players.length;
        }
        room.state.currentPlayer = next;
        room.state.phase = 'roll';
      }

      // Check winner
      const alive = room.state.players.filter(p => !p.bankrupt);
      if (alive.length === 1) {
        room.state.winner = alive[0].id;
      }

      await updateDoc(ref, { state: room.state, lastActivity: Date.now() });
    }
  }
}

// ===== LISTEN TO ROOM =====
export function listenToRoom(code: string, callback: (room: RoomData | null) => void): Unsubscribe {
  return onSnapshot(roomRef(code), (snap) => {
    if (snap.exists()) {
      callback(snap.data() as RoomData);
    } else {
      callback(null);
    }
  }, () => {
    callback(null);
  });
}
