import { GameState, Player, Property, AuctionState, TradeOffer, PLAYER_COLORS, PLAYER_TOKENS } from './types';
import { createBoard, CHANCE_CARDS, CHEST_CARDS } from './board';

export function createInitialState(playerNames: string[]): GameState {
  const players: Player[] = playerNames.map((name, i) => ({
    id: `p${i}`,
    name,
    color: PLAYER_COLORS[i],
    money: 1_500_000,
    position: 0,
    inJail: false,
    jailTurns: 0,
    bankrupt: false,
    debt: 0,
    debtInterest: 0,
    getOutOfJailCards: 0,
    token: PLAYER_TOKENS[i],
  }));

  return {
    players,
    board: createBoard(),
    currentPlayer: 0,
    diceValues: [1, 1],
    doublesCount: 0,
    phase: 'roll',
    auction: null,
    pendingTrade: null,
    tradePhase: 'none',
    log: [{ text: 'Игра началась! Удачи всем!', icon: '🎮', time: Date.now() }],
    winner: null,
    turnCount: 0,
    parkingPot: 0,
    chat: [],
    reactions: [],
  };
}

function addLog(state: GameState, icon: string, text: string): void {
  state.log.unshift({ text, icon, time: Date.now() });
  if (state.log.length > 80) state.log.length = 80;
}

export function rollDice(): [number, number] {
  return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
}

export function hasMonopoly(board: Property[], playerId: string, group: number): boolean {
  if (group < 0) return false;
  const groupCells = board.filter(c => c.group === group && c.type === 'property');
  return groupCells.length > 0 && groupCells.every(c => c.ownerId === playerId);
}

export function calculateRent(cell: Property, board: Property[], diceSum: number): number {
  if (cell.mortgaged) return 0;
  if (cell.type === 'property') {
    const base = cell.rent[cell.houses] || cell.rent[0];
    if (cell.houses === 0 && hasMonopoly(board, cell.ownerId!, cell.group)) {
      return base * 2;
    }
    return base;
  }
  if (cell.type === 'railroad') {
    const owned = board.filter(c => c.type === 'railroad' && c.ownerId === cell.ownerId).length;
    return cell.rent[Math.min(owned - 1, 3)] || 25_000;
  }
  if (cell.type === 'utility') {
    const owned = board.filter(c => c.type === 'utility' && c.ownerId === cell.ownerId).length;
    return (owned === 2 ? 10 : 4) * diceSum * 1_000;
  }
  return 0;
}

/** Check if building is allowed (uniform building rule) */
export function canBuildOnProperty(board: Property[], playerId: string, propertyId: number): boolean {
  const cell = board[propertyId];
  if (!cell || cell.type !== 'property') return false;
  if (cell.ownerId !== playerId) return false;
  if (cell.mortgaged) return false;
  if (cell.houses >= 5) return false;
  if (!hasMonopoly(board, playerId, cell.group)) return false;

  // Uniform building: can't build if any property in group has fewer houses
  const groupCells = board.filter(c => c.group === cell.group && c.type === 'property');
  const minHouses = Math.min(...groupCells.map(c => c.houses));
  if (cell.houses > minHouses) return false; // Must build on the one with fewer first

  return true;
}

/** Check if selling a house is allowed (uniform demolition) */
export function canSellHouseOnProperty(board: Property[], propertyId: number): boolean {
  const cell = board[propertyId];
  if (!cell || cell.type !== 'property') return false;
  if (cell.houses <= 0) return false;

  // Uniform: can't sell if any property in group has more houses
  const groupCells = board.filter(c => c.group === cell.group && c.type === 'property');
  const maxHouses = Math.max(...groupCells.map(c => c.houses));
  if (cell.houses < maxHouses) return false;

  return true;
}

export interface MoveResult {
  state: GameState;
  message: string;
  messageIcon: string;
  canBuy: boolean;
  rentPaid: number;
  rentTo: string | null;
  passedGo: boolean;
  isDouble: boolean;
  cardText: string | null;
  cardType: 'chance' | 'chest' | null;
  sentToJail: boolean;
  taxPaid: number;
  parkingCollected: number;
}

export function processRoll(state: GameState, dice: [number, number]): MoveResult {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players[s.currentPlayer];
  const [d1, d2] = dice;
  const isDouble = d1 === d2;
  const sum = d1 + d2;

  s.diceValues = dice;

  const result: MoveResult = {
    state: s,
    message: '',
    messageIcon: '🎲',
    canBuy: false,
    rentPaid: 0,
    rentTo: null,
    passedGo: false,
    isDouble,
    cardText: null,
    cardType: null,
    sentToJail: false,
    taxPaid: 0,
    parkingCollected: 0,
  };

  // In jail
  if (player.inJail) {
    if (isDouble) {
      player.inJail = false;
      player.jailTurns = 0;
      s.doublesCount = 0;
      addLog(s, '🔓', `${player.name} выбросил дубль и вышел из тюрьмы!`);
    } else {
      player.jailTurns++;
      if (player.jailTurns >= 3) {
        player.money -= 50_000;
        player.inJail = false;
        player.jailTurns = 0;
        addLog(s, '💸', `${player.name} заплатил ₽50 000 за выход из тюрьмы`);
      } else {
        result.message = `${player.name} остаётся в тюрьме (попытка ${player.jailTurns}/3)`;
        result.messageIcon = '🔒';
        s.phase = 'landed';
        return result;
      }
    }
  }

  // Triple doubles = jail
  if (isDouble) {
    s.doublesCount++;
    if (s.doublesCount >= 3) {
      player.position = 10;
      player.inJail = true;
      player.jailTurns = 0;
      s.doublesCount = 0;
      result.message = `${player.name} бросил 3 дубля подряд — в тюрьму!`;
      result.messageIcon = '🚔';
      result.sentToJail = true;
      addLog(s, '🚔', result.message);
      s.phase = 'landed';
      return result;
    }
  } else {
    s.doublesCount = 0;
  }

  // Move
  const oldPos = player.position;
  const newPos = (oldPos + sum) % 40;
  if (newPos < oldPos) {
    player.money += 200_000;
    result.passedGo = true;
    addLog(s, '🏁', `${player.name} прошёл СТАРТ и получил ₽200 000`);
  }
  player.position = newPos;

  // Process cell
  const cell = s.board[newPos];
  addLog(s, '📍', `${player.name} попал на «${cell.name}»`);

  if (cell.type === 'goto_jail') {
    player.position = 10;
    player.inJail = true;
    player.jailTurns = 0;
    s.doublesCount = 0;
    result.message = `${player.name} отправляется в тюрьму!`;
    result.messageIcon = '🚔';
    result.sentToJail = true;
    addLog(s, '🚔', result.message);
    s.phase = 'landed';
    return result;
  }

  if (cell.type === 'tax') {
    const tax = cell.price;
    player.money -= tax;
    s.parkingPot += tax;
    result.taxPaid = tax;
    result.message = `${player.name} платит налог ₽${tax.toLocaleString('ru-RU')}`;
    result.messageIcon = '💰';
    addLog(s, '💰', result.message);
    s.phase = 'landed';
    return result;
  }

  if (cell.type === 'chance' || cell.type === 'chest') {
    const cards = cell.type === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
    const card = cards[Math.floor(Math.random() * cards.length)];
    result.cardText = card.text;
    result.cardType = cell.type;

    if ((card as any).jail) {
      player.position = 10;
      player.inJail = true;
      player.jailTurns = 0;
      s.doublesCount = 0;
      result.sentToJail = true;
      addLog(s, '🚔', `${player.name}: ${card.text}`);
    } else if ((card as any).goToStart) {
      player.position = 0;
      player.money += 200_000;
      result.passedGo = true;
      addLog(s, '🏁', `${player.name} вернулся на СТАРТ`);
    } else if ((card as any).jailCard) {
      player.getOutOfJailCards++;
      addLog(s, '🎫', `${player.name} получил карточку выхода из тюрьмы`);
    } else if ((card as any).fromEach) {
      const others = s.players.filter(p => !p.bankrupt && p.id !== player.id);
      const total = card.amount * others.length;
      others.forEach(p => { p.money -= card.amount; });
      player.money += total;
      addLog(s, '🎂', `${player.name}: ${card.text}`);
    } else {
      player.money += card.amount;
      if (card.amount < 0) {
        s.parkingPot += Math.abs(card.amount);
      }
      addLog(s, card.amount >= 0 ? '💚' : '💔', `${player.name}: ${card.text}`);
    }

    result.message = card.text;
    result.messageIcon = cell.type === 'chance' ? '❓' : '💎';
    s.phase = 'landed';
    return result;
  }

  if (cell.type === 'go' || cell.type === 'jail' || cell.type === 'parking') {
    if (cell.type === 'parking' && s.parkingPot > 0) {
      const pot = s.parkingPot;
      player.money += pot;
      s.parkingPot = 0;
      result.parkingCollected = pot;
      result.message = `${player.name} забирает копилку парковки: ₽${pot.toLocaleString('ru-RU')}!`;
      result.messageIcon = '🅿️';
      result.passedGo = false;
      addLog(s, '🅿️', result.message);
    } else {
      result.message = cell.type === 'parking' ? 'Бесплатная парковка — отдыхайте!' :
                       cell.type === 'jail' ? 'Вы просто в гостях у тюрьмы' : 'Вы на старте!';
      result.messageIcon = cell.emoji;
    }
    s.phase = 'landed';
    return result;
  }

  // Property / Railroad / Utility
  if (cell.ownerId === null) {
    if (player.money >= cell.price) {
      result.canBuy = true;
      result.message = `«${cell.name}» можно купить за ₽${cell.price.toLocaleString('ru-RU')}`;
      result.messageIcon = '🏪';
    } else {
      result.message = `Не хватает средств на «${cell.name}»`;
      result.messageIcon = '😔';
    }
  } else if (cell.ownerId !== player.id) {
    if (!cell.mortgaged) {
      const rent = calculateRent(cell, s.board, sum);
      const owner = s.players.find(p => p.id === cell.ownerId)!;
      player.money -= rent;
      owner.money += rent;
      result.rentPaid = rent;
      result.rentTo = owner.name;
      result.message = `${player.name} платит ₽${rent.toLocaleString('ru-RU')} игроку ${owner.name}`;
      result.messageIcon = '💸';
      addLog(s, '💸', result.message);
    } else {
      result.message = `«${cell.name}» заложена — аренда не взимается`;
      result.messageIcon = '🏚️';
    }
  } else {
    result.message = `Вы владеете «${cell.name}»`;
    result.messageIcon = '🏠';
  }

  s.phase = 'landed';
  return result;
}

export function buyProperty(state: GameState): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players[s.currentPlayer];
  const cell = s.board[player.position];
  if (cell.ownerId === null && player.money >= cell.price) {
    player.money -= cell.price;
    cell.ownerId = player.id;
    addLog(s, '🛒', `${player.name} купил «${cell.name}» за ₽${cell.price.toLocaleString('ru-RU')}`);
  }
  return s;
}

export function startAuction(state: GameState, propertyId: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const activePlayers = s.players.filter(p => !p.bankrupt).map(p => p.id);
  s.auction = {
    propertyId,
    participants: activePlayers,
    currentBidder: 0,
    currentBid: 0,
    highestBidderId: null,
    passed: [],
  };
  addLog(s, '🔨', `Начался аукцион за «${s.board[propertyId].name}»!`);
  return s;
}

export function placeBid(state: GameState, amount: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  if (!s.auction) return s;
  const bidderId = s.auction.participants[s.auction.currentBidder];
  s.auction.currentBid = amount;
  s.auction.highestBidderId = bidderId;
  const bidder = s.players.find(p => p.id === bidderId)!;
  addLog(s, '💵', `${bidder.name} ставит ₽${amount.toLocaleString('ru-RU')}`);
  s.auction.currentBidder = getNextAuctionBidder(s.auction);
  return s;
}

export function passAuction(state: GameState): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  if (!s.auction) return s;
  const passerId = s.auction.participants[s.auction.currentBidder];
  s.auction.passed.push(passerId);
  const passer = s.players.find(p => p.id === passerId)!;
  addLog(s, '🙅', `${passer.name} пасует`);

  const remaining = s.auction.participants.filter(id => !s.auction!.passed.includes(id));

  if (remaining.length <= 1) {
    if (s.auction.highestBidderId) {
      const winner = s.players.find(p => p.id === s.auction!.highestBidderId)!;
      winner.money -= s.auction.currentBid;
      s.board[s.auction.propertyId].ownerId = winner.id;
      addLog(s, '🔨', `${winner.name} выиграл аукцион за ₽${s.auction.currentBid.toLocaleString('ru-RU')}!`);
    } else {
      addLog(s, '🔨', `Аукцион завершён без ставок`);
    }
    s.auction = null;
  } else {
    s.auction.currentBidder = getNextAuctionBidder(s.auction);
  }
  return s;
}

function getNextAuctionBidder(auction: AuctionState): number {
  let next = (auction.currentBidder + 1) % auction.participants.length;
  while (auction.passed.includes(auction.participants[next])) {
    next = (next + 1) % auction.participants.length;
  }
  return next;
}

export function isAuctionOver(state: GameState): boolean {
  return state.auction === null;
}

/** Build a house/hotel with uniform building rule */
export function buildHouse(state: GameState, propertyId: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const cell = s.board[propertyId];
  const player = s.players[s.currentPlayer];
  if (
    canBuildOnProperty(s.board, player.id, propertyId) &&
    player.money >= cell.houseCost
  ) {
    player.money -= cell.houseCost;
    cell.houses++;
    const label = cell.houses === 5 ? 'отель' : `филиал №${cell.houses}`;
    addLog(s, '🏗️', `${player.name} построил ${label} на «${cell.name}»`);
  }
  return s;
}

/** Sell a house for 50% of cost (uniform demolition) */
export function sellHouse(state: GameState, propertyId: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const cell = s.board[propertyId];
  const player = s.players.find(p => p.id === cell.ownerId);
  if (!player) return s;
  if (!canSellHouseOnProperty(s.board, propertyId)) return s;

  const refund = Math.floor(cell.houseCost / 2);
  cell.houses--;
  player.money += refund;
  addLog(s, '🏚️', `${player.name} продал филиал на «${cell.name}» за ₽${refund.toLocaleString('ru-RU')}`);
  return s;
}

export function mortgageProperty(state: GameState, propertyId: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const cell = s.board[propertyId];
  const player = s.players.find(p => p.id === cell.ownerId);
  if (!player || cell.houses > 0) return s;

  if (!cell.mortgaged) {
    cell.mortgaged = true;
    const value = Math.floor(cell.price * 0.5);
    player.money += value;
    addLog(s, '🏚️', `${player.name} заложил «${cell.name}» за ₽${value.toLocaleString('ru-RU')}`);
  } else {
    const cost = Math.floor(cell.price * 0.6);
    if (player.money >= cost) {
      cell.mortgaged = false;
      player.money -= cost;
      addLog(s, '🏠', `${player.name} выкупил «${cell.name}» за ₽${cost.toLocaleString('ru-RU')}`);
    }
  }
  return s;
}

export function takeLoan(state: GameState, playerId: string, amount: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players.find(p => p.id === playerId)!;
  const interest = Math.floor(amount * 0.2);
  player.money += amount;
  player.debt += amount + interest;
  player.debtInterest = 5;
  addLog(s, '🏦', `${player.name} взял кредит ₽${amount.toLocaleString('ru-RU')} (долг: ₽${player.debt.toLocaleString('ru-RU')})`);
  return s;
}

export function payDebt(state: GameState, playerId: string, amount: number): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players.find(p => p.id === playerId)!;
  const payment = Math.min(amount, player.debt, player.money);
  player.money -= payment;
  player.debt -= payment;
  if (player.debt <= 0) {
    player.debt = 0;
    player.debtInterest = 0;
  }
  addLog(s, '💳', `${player.name} погасил ₽${payment.toLocaleString('ru-RU')} долга`);
  return s;
}

export function executeTrade(state: GameState, trade: TradeOffer): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const from = s.players.find(p => p.id === trade.fromId)!;
  const to = s.players.find(p => p.id === trade.toId)!;

  trade.offerProperties.forEach(pid => { s.board[pid].ownerId = to.id; });
  trade.requestProperties.forEach(pid => { s.board[pid].ownerId = from.id; });
  from.money -= trade.offerMoney;
  to.money += trade.offerMoney;
  from.money += trade.requestMoney;
  to.money -= trade.requestMoney;

  addLog(s, '🤝', `${from.name} и ${to.name} заключили сделку!`);
  return s;
}

export function useJailCard(state: GameState): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players[s.currentPlayer];
  if (player.inJail && player.getOutOfJailCards > 0) {
    player.getOutOfJailCards--;
    player.inJail = false;
    player.jailTurns = 0;
    addLog(s, '🎫', `${player.name} использовал карточку выхода из тюрьмы`);
  }
  return s;
}

export function payJailFine(state: GameState): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players[s.currentPlayer];
  if (player.inJail && player.money >= 50_000) {
    player.money -= 50_000;
    player.inJail = false;
    player.jailTurns = 0;
    addLog(s, '💸', `${player.name} заплатил ₽50 000 за выход из тюрьмы`);
  }
  return s;
}

/** Bankrupt a player — sells all houses first, then releases properties */
export function bankruptPlayer(state: GameState, playerId: string, creditorId?: string): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const player = s.players.find(p => p.id === playerId)!;
  
  // Sell all houses first
  s.board.forEach(c => {
    if (c.ownerId === playerId && c.houses > 0) {
      const refund = c.houses * Math.floor(c.houseCost / 2);
      player.money += refund;
      c.houses = 0;
    }
  });

  // If there's a creditor, transfer properties to them
  if (creditorId) {
    s.board.forEach(c => {
      if (c.ownerId === playerId) {
        c.ownerId = creditorId;
      }
    });
    // Transfer remaining money
    const creditor = s.players.find(p => p.id === creditorId);
    if (creditor && player.money > 0) {
      creditor.money += player.money;
    }
  } else {
    // Release all properties to bank
    s.board.forEach(c => {
      if (c.ownerId === playerId) {
        c.ownerId = null;
        c.houses = 0;
        c.mortgaged = false;
      }
    });
  }
  
  player.money = 0;
  player.bankrupt = true;
  player.debt = 0;
  addLog(s, '💀', `${player.name} обанкротился!`);
  return s;
}

export function nextTurn(state: GameState): GameState {
  const s: GameState = JSON.parse(JSON.stringify(state));
  
  // Apply debt interest
  const player = s.players[s.currentPlayer];
  if (player.debt > 0) {
    const interest = Math.floor(player.debt * player.debtInterest / 100);
    player.debt += interest;
  }

  // Check bankruptcy — if money < 0 and can't cover with assets
  s.players.forEach(p => {
    if (p.money < 0 && !p.bankrupt) {
      const totalAssetValue = s.board
        .filter(c => c.ownerId === p.id)
        .reduce((sum, c) => sum + c.price + c.houses * Math.floor(c.houseCost / 2), 0);
      if (p.money + totalAssetValue < 0) {
        // Truly bankrupt — can't recover
        p.bankrupt = true;
        s.board.forEach(c => { if (c.ownerId === p.id) { c.ownerId = null; c.houses = 0; c.mortgaged = false; } });
        addLog(s, '💀', `${p.name} обанкротился!`);
      }
    }
  });

  // Check winner
  const alive = s.players.filter(p => !p.bankrupt);
  if (alive.length === 1) {
    s.winner = alive[0].id;
    addLog(s, '🏆', `${alive[0].name} победил!`);
    return s;
  }

  // Next player
  s.doublesCount = 0;
  let next = (s.currentPlayer + 1) % s.players.length;
  while (s.players[next].bankrupt) {
    next = (next + 1) % s.players.length;
  }
  s.currentPlayer = next;
  s.phase = 'roll';
  s.turnCount++;

  return s;
}

export function getPlayerProperties(board: Property[], playerId: string): Property[] {
  return board.filter(c => c.ownerId === playerId);
}

export function getPlayerTotalWorth(player: Player, board: Property[]): number {
  const props = getPlayerProperties(board, player.id);
  const propValue = props.reduce((sum, c) => sum + c.price + c.houses * c.houseCost, 0);
  return player.money + propValue - player.debt;
}
