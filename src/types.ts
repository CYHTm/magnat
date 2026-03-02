export interface Property {
  id: number;
  name: string;
  type: 'property' | 'railroad' | 'utility' | 'tax' | 'chance' | 'chest' | 'go' | 'jail' | 'parking' | 'goto_jail';
  price: number;
  color: string;
  group: number;
  rent: number[];
  houseCost: number;
  ownerId: string | null;
  houses: number;
  mortgaged: boolean;
  emoji: string;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  money: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  bankrupt: boolean;
  debt: number;
  debtInterest: number;
  getOutOfJailCards: number;
  token: string;
}

export interface TradeOffer {
  fromId: string;
  toId: string;
  offerProperties: number[];
  offerMoney: number;
  requestProperties: number[];
  requestMoney: number;
}

export interface AuctionState {
  propertyId: number;
  participants: string[];
  currentBidder: number;
  currentBid: number;
  highestBidderId: string | null;
  passed: string[];
}

export interface LogEntry {
  text: string;
  icon: string;
  time: number;
}

export interface GameState {
  players: Player[];
  board: Property[];
  currentPlayer: number;
  diceValues: [number, number];
  doublesCount: number;
  phase: 'roll' | 'moving' | 'landed' | 'action' | 'turnEnd';
  auction: AuctionState | null;
  pendingTrade: TradeOffer | null;
  tradePhase: 'none' | 'propose' | 'confirm';
  log: LogEntry[];
  winner: string | null;
  turnCount: number;
  parkingPot: number;
  chat: ChatMessage[];
  reactions: EmojiReaction[];
}

export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
export const PLAYER_TOKENS = ['♛', '♜', '♝', '♞', '♚', '♟'];

export const formatMoney = (n: number): string => {
  if (n < 0) return '-' + formatMoney(-n);
  return '₽' + n.toLocaleString('ru-RU');
};

export const formatMoneyShort = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'М';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'К';
  return String(n);
};

// ===== CHAT =====
export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  text: string;
  isSystem: boolean;
  time: number;
}

export interface EmojiReaction {
  playerId: string;
  emoji: string;
  time: number;
}

// ===== ONLINE MODE =====
export interface OnlineConfig {
  roomCode: string;
  myPlayerId: string;
  isHost: boolean;
}

export type GameMode = 'local' | 'online';

export const APP_VERSION = 'Beta';
