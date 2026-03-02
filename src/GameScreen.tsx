import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GameState, Property, TradeOffer, OnlineConfig, formatMoney, formatMoneyShort } from './types';
import {
  processRoll, rollDice, buyProperty, startAuction, placeBid, passAuction,
  buildHouse, sellHouse, mortgageProperty, nextTurn, executeTrade, takeLoan, payDebt,
  useJailCard, payJailFine, hasMonopoly, getPlayerProperties, getPlayerTotalWorth,
  canBuildOnProperty, canSellHouseOnProperty, bankruptPlayer,
  MoveResult
} from './logic';
import { updateRoomState, listenToRoom, sendChatMessage, sendReaction, kickPlayer } from './firebase';
import { APP_VERSION, ChatMessage, EmojiReaction } from './types';

interface Props {
  initialState: GameState;
  onExit: () => void;
  mode: 'local' | 'online';
  onlineConfig?: OnlineConfig;
}

// ===== SOUND SYSTEM (Web Audio API) =====
let audioCtx: AudioContext | null = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
function playTone(freq: number, duration: number, type: OscillatorType = 'sine', vol = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {}
}
const SFX = {
  roll: () => { for (let i = 0; i < 6; i++) setTimeout(() => playTone(200 + Math.random() * 400, 0.05, 'square', 0.08), i * 15); },
  buy: () => { playTone(523, 0.15, 'sine', 0.12); setTimeout(() => playTone(659, 0.15, 'sine', 0.12), 100); setTimeout(() => playTone(784, 0.2, 'sine', 0.12), 200); },
  rent: () => { playTone(440, 0.15, 'sine', 0.1); setTimeout(() => playTone(349, 0.2, 'sine', 0.1), 120); },
  build: () => { playTone(392, 0.1, 'triangle', 0.1); setTimeout(() => playTone(523, 0.15, 'triangle', 0.1), 100); },
  bankrupt: () => { [440, 392, 349, 294].forEach((f, i) => setTimeout(() => playTone(f, 0.3, 'sawtooth', 0.08), i * 150)); },
  win: () => { [523, 587, 659, 698, 784, 880].forEach((f, i) => setTimeout(() => playTone(f, 0.2, 'sine', 0.12), i * 120)); },
  notify: () => playTone(880, 0.1, 'sine', 0.08),
  loan: () => { playTone(349, 0.15, 'triangle', 0.08); setTimeout(() => playTone(294, 0.2, 'triangle', 0.08), 100); },
};

function DiceFace({ value, cls }: { value: number; cls: string }) {
  return (
    <div className={`dice-face ${cls} f${value}`}>
      {Array.from({ length: value }).map((_, i) => <div key={i} className="dice-dot" />)}
    </div>
  );
}

function getCellGridPosition(id: number): { col: number; row: number; side: string } {
  if (id === 0) return { col: 11, row: 11, side: 'corner' };
  if (id <= 9) return { col: 11 - id, row: 11, side: 'bottom' };
  if (id === 10) return { col: 1, row: 11, side: 'corner' };
  if (id <= 19) return { col: 1, row: 11 - (id - 10), side: 'left' };
  if (id === 20) return { col: 1, row: 1, side: 'corner' };
  if (id <= 29) return { col: 1 + (id - 20), row: 1, side: 'top' };
  if (id === 30) return { col: 11, row: 1, side: 'corner' };
  if (id <= 39) return { col: 11, row: 1 + (id - 30), side: 'right' };
  return { col: 1, row: 1, side: 'corner' };
}

// Online turn timer constant
const ONLINE_TURN_TIMEOUT = 60; // seconds

export default function GameScreen({ initialState, onExit, mode, onlineConfig }: Props) {
  const [gs, setGs] = useState<GameState>(initialState);
  const [rolling, setRolling] = useState(false);
  const [highlightCell, setHighlightCell] = useState<number | null>(null);
  const [animating, setAnimating] = useState(false);
  const [moveResult, setMoveResult] = useState<MoveResult | null>(null);
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [selectedProp, setSelectedProp] = useState<number | null>(null);
  const [cardInfo, setCardInfo] = useState<{ text: string; type: 'chance' | 'chest' } | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; icon: string }[]>([]);
  const [moneyFly, setMoneyFly] = useState<{ amount: number; id: number } | null>(null);
  const [showPlayersDrawer, setShowPlayersDrawer] = useState(false);
  const [showControlDrawer, setShowControlDrawer] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [slideX, setSlideX] = useState(0);
  const [showTrade, setShowTrade] = useState(false);
  const [tradeTarget, setTradeTarget] = useState<string | null>(null);
  const [tradeOfferProps, setTradeOfferProps] = useState<number[]>([]);
  const [tradeOfferMoney, setTradeOfferMoney] = useState(0);
  const [tradeRequestProps, setTradeRequestProps] = useState<number[]>([]);
  const [tradeRequestMoney, setTradeRequestMoney] = useState(0);
  const [tradeConfirm, setTradeConfirm] = useState<TradeOffer | null>(null);
  const [showBank, setShowBank] = useState(false);
  const [bankAmount, setBankAmount] = useState(100_000);
  const [showLog, setShowLog] = useState(false);
  const [showSellHouses, setShowSellHouses] = useState(false);
  // Sound
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('magnat_sound') !== 'off');
  // Hints
  const [shownHints, setShownHints] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('magnat_hints') || '[]')); } catch { return new Set(); }
  });
  const [currentHint, setCurrentHint] = useState<{ id: string; text: string } | null>(null);
  // Big event overlay
  const [bigEvent, setBigEvent] = useState<{ icon: string; text: string; color: string } | null>(null);
  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatUnread, setChatUnread] = useState(0);
  const lastChatCount = useRef(0);
  // Floating reactions
  const [floatingReactions, setFloatingReactions] = useState<{ id: number; emoji: string; x: number; y: number }[]>([]);
  const lastReactionsCount = useRef(0);
  // Online turn timer
  const [turnTimer, setTurnTimer] = useState(ONLINE_TURN_TIMEOUT);
  const toastId = useRef(0);
  const slideRef = useRef<HTMLDivElement>(null);

  // Sound helper
  const sfx = useCallback((name: keyof typeof SFX) => {
    if (soundOn) SFX[name]();
  }, [soundOn]);

  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = !prev;
      localStorage.setItem('magnat_sound', next ? 'on' : 'off');
      return next;
    });
  }, []);

  // Hint helper
  const showHint = useCallback((id: string, text: string) => {
    if (shownHints.has(id)) return;
    setCurrentHint({ id, text });
    setShownHints(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem('magnat_hints', JSON.stringify([...next]));
      return next;
    });
    setTimeout(() => setCurrentHint(c => c?.id === id ? null : c), 6000);
  }, [shownHints]);

  // Big event helper
  const showBigEvent = useCallback((icon: string, text: string, color: string) => {
    setBigEvent({ icon, text, color });
    setTimeout(() => setBigEvent(null), 3500);
  }, []);

  const cp = gs.players[gs.currentPlayer];
  const isCorner = (id: number) => [0, 10, 20, 30].includes(id);

  // My slot index for online mode
  const mySlotIndexRef = useRef<number>(-1);

  useEffect(() => {
    if (mode === 'online' && onlineConfig) {
      const stored = localStorage.getItem('magnat_online_slot');
      if (stored !== null) {
        mySlotIndexRef.current = parseInt(stored);
      }
    }
  }, [mode, onlineConfig]);

  const amICurrentPlayer = mode === 'local' ? true : (mySlotIndexRef.current === gs.currentPlayer);

  // ===== ONLINE: Sync state to Firebase =====
  const syncToFirebase = useCallback(async (state: GameState) => {
    if (mode === 'online' && onlineConfig) {
      try {
        await updateRoomState(onlineConfig.roomCode, state);
      } catch (e) {
        console.error('Firebase sync error:', e);
      }
    }
  }, [mode, onlineConfig]);

  // ===== ONLINE: Listen for state changes =====
  useEffect(() => {
    if (mode !== 'online' || !onlineConfig) return;
    const unsub = listenToRoom(onlineConfig.roomCode, (room) => {
      if (room && room.state && room.phase === 'playing') {
        setGs(prev => {
          const r = room.state!;
          // Accept remote state if something meaningful changed
          if (r.turnCount !== prev.turnCount || r.currentPlayer !== prev.currentPlayer ||
              r.phase !== prev.phase ||
              JSON.stringify(r.pendingTrade) !== JSON.stringify(prev.pendingTrade) ||
              JSON.stringify(r.auction) !== JSON.stringify(prev.auction)) {
            return r;
          }
          const boardChanged = r.board.some((c, i) => c.ownerId !== prev.board[i].ownerId || c.houses !== prev.board[i].houses);
          const moneyChanged = r.players.some((p, i) => p.money !== prev.players[i].money);
          if (boardChanged || moneyChanged) return r;
          return prev;
        });
      }
    });
    return unsub;
  }, [mode, onlineConfig]);

  // ===== ONLINE: Track incoming chat + reactions =====
  useEffect(() => {
    if (mode !== 'online') return;
    const chatLen = gs.chat?.length || 0;
    if (chatLen > lastChatCount.current) {
      if (!chatOpen) setChatUnread(prev => prev + (chatLen - lastChatCount.current));
      // Browser notification for inactive tab
      if (document.hidden && chatLen > 0) {
        const lastMsg = gs.chat[chatLen - 1];
        if (lastMsg && !lastMsg.isSystem && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`${lastMsg.playerName}: ${lastMsg.text}`);
        }
      }
    }
    lastChatCount.current = chatLen;
  }, [gs.chat?.length, mode, chatOpen]);

  useEffect(() => {
    if (mode !== 'online') return;
    const reactLen = gs.reactions?.length || 0;
    if (reactLen > lastReactionsCount.current) {
      const newReactions = gs.reactions.slice(lastReactionsCount.current);
      newReactions.forEach((r: EmojiReaction) => {
        const id = Date.now() + Math.random();
        const x = 30 + Math.random() * 40;
        const y = 20 + Math.random() * 40;
        setFloatingReactions(prev => [...prev, { id, emoji: r.emoji, x, y }]);
        setTimeout(() => setFloatingReactions(prev => prev.filter(f => f.id !== id)), 1600);
      });
    }
    lastReactionsCount.current = reactLen;
  }, [gs.reactions?.length, mode]);

  // Request notification permission on mount (online)
  useEffect(() => {
    if (mode === 'online' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [mode]);

  // Browser notification when it's my turn (tab inactive)
  useEffect(() => {
    if (mode === 'online' && amICurrentPlayer && document.hidden && gs.phase === 'roll') {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('МАГНАТ — Ваш ход!', { body: 'Бросайте кости 🎲' });
      }
    }
  }, [gs.currentPlayer, mode, amICurrentPlayer, gs.phase]);

  // Chat send handler
  const handleSendChat = useCallback(() => {
    if (!chatInput.trim() || mode !== 'online' || !onlineConfig) return;
    const me = gs.players.find((_p, i) => i === mySlotIndexRef.current);
    if (!me) return;
    sendChatMessage(onlineConfig.roomCode, me.id, me.name, me.color, chatInput.trim());
    setChatInput('');
  }, [chatInput, mode, onlineConfig, gs.players]);

  // Reaction send handler
  const handleSendReaction = useCallback((emoji: string) => {
    if (mode !== 'online' || !onlineConfig) return;
    const me = gs.players.find((_p, i) => i === mySlotIndexRef.current);
    if (!me) return;
    sendReaction(onlineConfig.roomCode, me.id, emoji);
  }, [mode, onlineConfig, gs.players]);

  // Kick handler (host only)
  const handleKick = useCallback((targetId: string) => {
    if (mode !== 'online' || !onlineConfig || !onlineConfig.isHost) return;
    if (window.confirm('Исключить этого игрока?')) {
      kickPlayer(onlineConfig.roomCode, onlineConfig.myPlayerId, targetId);
    }
  }, [mode, onlineConfig]);

  // ===== ONLINE TURN TIMER =====
  useEffect(() => {
    if (mode !== 'online') return;
    // Reset timer when current player changes
    setTurnTimer(ONLINE_TURN_TIMEOUT);
  }, [gs.currentPlayer, gs.turnCount, mode]);

  useEffect(() => {
    if (mode !== 'online') return;
    if (gs.phase !== 'roll') return;
    if (gs.winner) return;

    const interval = setInterval(() => {
      setTurnTimer(prev => {
        if (prev <= 1) {
          // Time's up — auto-skip turn (only the current player's client does this)
          if (amICurrentPlayer) {
            const ns = nextTurn(gs);
            updateState(ns);
            toast('⏰', `Время хода истекло!`);
          }
          return ONLINE_TURN_TIMEOUT;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [mode, gs.phase, gs.currentPlayer, gs.winner, amICurrentPlayer]);

  // Wrapper: update state locally AND sync to Firebase
  const updateState = useCallback((newState: GameState) => {
    setGs(newState);
    if (mode === 'local') {
      localStorage.setItem('magnat_save', JSON.stringify(newState));
    } else {
      syncToFirebase(newState);
    }
  }, [mode, syncToFirebase]);

  // Save online session for reconnect
  useEffect(() => {
    if (mode === 'online' && onlineConfig) {
      localStorage.setItem('magnat_online_session', JSON.stringify({
        roomCode: onlineConfig.roomCode,
        myPlayerId: onlineConfig.myPlayerId,
        isHost: onlineConfig.isHost,
        mySlot: mySlotIndexRef.current,
      }));
    }
  }, [mode, onlineConfig]);

  // Save to localStorage (local mode only)
  useEffect(() => {
    if (mode === 'local') {
      localStorage.setItem('magnat_save', JSON.stringify(gs));
    }
  }, [gs, mode]);

  // First turn hint on mount
  useEffect(() => {
    if (gs.turnCount === 0 && gs.phase === 'roll') {
      showHint('first_turn', '🎲 Бросьте кости кнопкой или нажмите пробел для начала хода.');
    }
  }, []);

  // Toast helper
  const toast = useCallback((icon: string, text: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, icon, text }].slice(-4));
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);

  // Money fly animation
  const showMoneyFly = useCallback((amount: number) => {
    const id = Date.now();
    setMoneyFly({ amount, id });
    setTimeout(() => setMoneyFly(null), 1500);
  }, []);

  // Auto-end turn
  useEffect(() => {
    if (gs.phase === 'landed' && !showBuyDialog && !cardInfo && !gs.auction && gs.tradePhase === 'none' && !tradeConfirm && !animating && !showSellHouses) {
      const timer = setTimeout(() => {
        if (moveResult?.isDouble && !moveResult.sentToJail && !gs.players[gs.currentPlayer].inJail) {
          const ns = { ...gs, phase: 'roll' as const };
          updateState(ns);
          toast('🎲', 'Дубль! Бросайте ещё раз');
        } else {
          updateState(nextTurn(gs));
          setMoveResult(null);
        }
      }, 2200);
      return () => clearTimeout(timer);
    }
  }, [gs, showBuyDialog, cardInfo, moveResult, animating, tradeConfirm, showSellHouses, toast, updateState]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && gs.phase === 'roll' && !rolling && !animating && amICurrentPlayer) { e.preventDefault(); handleRoll(); }
      if (e.code === 'Escape') { setShowRules(false); setSelectedProp(null); setShowBank(false); setShowLog(false); setShowPlayersDrawer(false); setShowControlDrawer(false); setShowSellHouses(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Step-by-step movement animation
  const animateMovement = useCallback(async (startPos: number, steps: number) => {
    setAnimating(true);
    const delay = Math.max(80, Math.min(200, 600 / steps));
    for (let i = 1; i <= steps; i++) {
      const pos = (startPos + i) % 40;
      await new Promise<void>(resolve => {
        setTimeout(() => {
          setGs(prev => {
            const ns: GameState = JSON.parse(JSON.stringify(prev));
            ns.players[ns.currentPlayer].position = pos;
            return ns;
          });
          setHighlightCell(pos);
          resolve();
        }, delay);
      });
    }
    setAnimating(false);
  }, []);

  // ROLL DICE
  const handleRoll = useCallback(async () => {
    if (gs.phase !== 'roll' || rolling || animating) return;
    if (!amICurrentPlayer) return;
    setRolling(true);
    sfx('roll');
    const dice = rollDice();
    const oldPos = cp.position;
    const sum = dice[0] + dice[1];

    const result = processRoll(gs, dice);

    setGs(prev => ({ ...prev, diceValues: dice }));
    await new Promise(r => setTimeout(r, 900));
    setRolling(false);

    const newPos = result.state.players[result.state.currentPlayer].position;
    if (newPos !== oldPos && !cp.inJail) {
      const steps = result.sentToJail ? 0 : sum;
      if (steps > 0) {
        await animateMovement(oldPos, steps);
      }
    }

    updateState(result.state);
    setMoveResult(result);
    setHighlightCell(result.state.players[result.state.currentPlayer].position);

    if (result.passedGo) { toast('🏁', 'Прошли СТАРТ: +₽200 000'); showMoneyFly(200_000); sfx('notify'); }
    if (result.rentPaid > 0) { toast('💸', `Аренда: −${formatMoney(result.rentPaid)} → ${result.rentTo}`); showMoneyFly(-result.rentPaid); sfx('rent'); }
    if (result.taxPaid > 0) { toast('💰', `Налог: −${formatMoney(result.taxPaid)}`); showMoneyFly(-result.taxPaid); sfx('rent'); }
    if (result.sentToJail) { toast('🚔', 'Отправлены в тюрьму!'); sfx('rent'); }
    if (result.parkingCollected > 0) { showMoneyFly(result.parkingCollected); sfx('buy'); showBigEvent('🅿️', `Копилка парковки: +${formatMoney(result.parkingCollected)}!`, '#22c55e'); }
    if (result.cardText && result.cardType) { setCardInfo({ text: result.cardText, type: result.cardType }); sfx('notify'); }
    if (result.canBuy) { setShowBuyDialog(true); showHint('first_buy', '🏪 Вы можете купить этот бизнес! Или отказаться — тогда начнётся аукцион.'); }

    // Check for monopoly hint
    const landedCell = result.state.board[result.state.players[result.state.currentPlayer].position];
    if (landedCell.ownerId === cp.id && landedCell.type === 'property') {
      if (hasMonopoly(result.state.board, cp.id, landedCell.group)) {
        showHint('monopoly', '🏗️ У вас монополия! Стройте филиалы, чтобы увеличить аренду.');
      }
    }

    // First turn hint
    if (gs.turnCount === 0 && gs.currentPlayer === 0) {
      showHint('first_turn', '🎲 Бросьте кости кнопкой или нажмите пробел.');
    }

    // Jail hint
    if (result.sentToJail) {
      showHint('jail', '🔒 Вы в тюрьме! Бросьте дубль, заплатите ₽50 000 или используйте карточку.');
    }
  }, [gs, cp, rolling, animating, amICurrentPlayer, animateMovement, toast, showMoneyFly, updateState, sfx, showHint, showBigEvent]);

  const handleBuy = () => {
    const ns = buyProperty(gs);
    updateState(ns);
    setShowBuyDialog(false);
    const boughtCell = ns.board[cp.position];
    toast('🛒', `Куплено: ${boughtCell.name}`);
    showMoneyFly(-boughtCell.price);
    sfx('buy');
    // Check if player now has a monopoly
    if (boughtCell.type === 'property' && hasMonopoly(ns.board, cp.id, boughtCell.group)) {
      setTimeout(() => {
        showBigEvent('🏗️', `${cp.name} получил монополию!`, '#fbbf24');
        sfx('win');
      }, 500);
    }
  };

  const handleDecline = () => {
    setShowBuyDialog(false);
    const ns = startAuction(gs, cp.position);
    updateState(ns);
    toast('🔨', 'Начался аукцион!');
  };

  const handleAuctionBid = (amount: number) => {
    if (!gs.auction) return;
    const ns = placeBid(gs, amount);
    updateState(ns);
  };

  const handleAuctionPass = () => {
    if (!gs.auction) return;
    const ns = passAuction(gs);
    updateState(ns);
    if (!ns.auction) toast('🔨', 'Аукцион завершён');
  };

  const handleBuild = (propId: number) => {
    updateState(buildHouse(gs, propId));
    toast('🏗️', 'Филиал построен!');
    sfx('build');
  };

  const handleSellHouse = (propId: number) => {
    const ns = sellHouse(gs, propId);
    updateState(ns);
    const cell = gs.board[propId];
    toast('🏚️', `Продан филиал: +${formatMoney(Math.floor(cell.houseCost / 2))}`);
    showMoneyFly(Math.floor(cell.houseCost / 2));
  };

  const handleMortgage = (propId: number) => {
    updateState(mortgageProperty(gs, propId));
  };

  const handleBankrupt = () => {
    const ns = bankruptPlayer(gs, cp.id);
    updateState(nextTurn(ns));
    toast('💀', `${cp.name} обанкротился`);
    sfx('bankrupt');
    showBigEvent('💀', `${cp.name} обанкротился!`, '#ef4444');
  };

  const handlePayJail = () => { updateState(payJailFine(gs)); toast('💸', 'Оплатили выход из тюрьмы'); };
  const handleUseJailCard = () => { updateState(useJailCard(gs)); toast('🎫', 'Использована карточка'); };

  // TRADE
  const handleProposeTrade = () => {
    if (!tradeTarget) return;
    const offer: TradeOffer = {
      fromId: cp.id,
      toId: tradeTarget,
      offerProperties: tradeOfferProps,
      offerMoney: tradeOfferMoney,
      requestProperties: tradeRequestProps,
      requestMoney: tradeRequestMoney,
    };
    setShowTrade(false);

    if (mode === 'online') {
      const ns: GameState = { ...JSON.parse(JSON.stringify(gs)), pendingTrade: offer, tradePhase: 'confirm' as const };
      updateState(ns);
      toast('🤝', 'Предложение отправлено!');
    } else {
      setTradeConfirm(offer);
      toast('🤝', 'Передайте устройство для подтверждения сделки');
    }
  };

  const handleAcceptTrade = () => {
    const trade = mode === 'online' ? gs.pendingTrade : tradeConfirm;
    if (!trade) return;
    let ns = executeTrade(gs, trade);
    ns = { ...ns, pendingTrade: null, tradePhase: 'none' as const };
    updateState(ns);
    setTradeConfirm(null);
    toast('✅', 'Сделка завершена!');
  };

  const handleDeclineTrade = () => {
    if (mode === 'online') {
      const ns: GameState = { ...JSON.parse(JSON.stringify(gs)), pendingTrade: null, tradePhase: 'none' as const };
      updateState(ns);
    }
    setTradeConfirm(null);
    toast('❌', 'Сделка отклонена');
  };

  // BANK
  const handleTakeLoan = () => {
    updateState(takeLoan(gs, cp.id, bankAmount));
    setShowBank(false);
    toast('🏦', `Кредит: +${formatMoney(bankAmount)}`);
    showMoneyFly(bankAmount);
  };
  const handlePayDebt = () => {
    const amount = Math.min(cp.debt, cp.money);
    if (amount <= 0) return;
    updateState(payDebt(gs, cp.id, amount));
    toast('💳', `Погашено: ${formatMoney(amount)}`);
  };

  // SLIDE TO EXIT
  const handleSlideMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (!slideRef.current) return;
    const rect = slideRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left - 22, rect.width - 48));
    setSlideX(x);
    if (x >= rect.width - 60) {
      setExitConfirm(false); setSlideX(0);
      if (mode === 'online') localStorage.removeItem('magnat_online_session');
      onExit();
    }
  };
  const handleSlideEnd = () => setSlideX(0);

  // Online: check if there's a pending trade for me
  const pendingTradeForMe = mode === 'online' && gs.pendingTrade && gs.tradePhase === 'confirm'
    ? gs.pendingTrade.toId === `p${mySlotIndexRef.current}`
    : false;

  // Online status
  const onlineStatusText = mode === 'online'
    ? (amICurrentPlayer ? '🟢 Ваш ход' : `⏳ Ход: ${cp.name}`)
    : null;

  // ===== RENDER CELL =====
  const renderCell = (cell: Property) => {
    const pos = getCellGridPosition(cell.id);
    const corner = isCorner(cell.id);
    const owner = cell.ownerId ? gs.players.find(p => p.id === cell.ownerId) : null;
    const playersHere = gs.players.filter(p => !p.bankrupt && p.position === cell.id);
    const isHighlighted = highlightCell === cell.id;

    const cellBg = owner
      ? `${owner.color}18`
      : cell.type === 'chance' ? 'rgba(255,200,0,0.06)'
      : cell.type === 'chest' ? 'rgba(160,80,255,0.06)'
      : cell.type === 'tax' ? 'rgba(255,60,60,0.06)'
      : cell.type === 'jail' || cell.type === 'goto_jail' ? 'rgba(255,160,0,0.06)'
      : '#1c1c22';

    return (
      <div key={cell.id}
        className={`cell ${corner ? 'corner' : ''} side-${pos.side} ${isHighlighted ? 'highlighted' : ''} ${owner ? 'owned' : ''}`}
        style={{ gridColumn: pos.col, gridRow: pos.row, background: cellBg, borderColor: owner ? `${owner.color}40` : 'transparent' }}
        onClick={() => setSelectedProp(cell.id)}>
        {cell.color && !corner && (
          <div className="color-strip" style={{ background: `linear-gradient(90deg, ${cell.color}, ${cell.color}aa)`, boxShadow: `0 0 6px ${cell.color}60` }} />
        )}
        {cell.houses > 0 && (
          <div className="cell-houses">
            {cell.houses === 5 ? <div className="hotel-dot" /> :
              Array.from({ length: cell.houses }).map((_, i) => <div key={i} className="house-dot" />)}
          </div>
        )}
        <div className="cell-emoji">{cell.emoji}</div>
        {!corner && <div className="cell-name">{cell.name.split(' ')[0]}</div>}
        {corner && <div className="cell-name">{cell.name}</div>}
        {cell.price > 0 && cell.type !== 'tax' && !corner && (
          <div className="cell-price">{formatMoneyShort(cell.price)}</div>
        )}
        {owner && <div className="owner-bar" style={{ background: `linear-gradient(90deg, ${owner.color}, ${owner.color}80)` }} />}
        {playersHere.length > 0 && (
          <div className="cell-tokens">
            {playersHere.map(p => (
              <div key={p.id}
                className={`token ${p.id === cp.id ? 'active-token' : ''} ${animating && p.id === cp.id ? 'step-move' : ''}`}
                style={{ background: p.color, color: '#fff' }}>
                {p.token}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ===== PROPERTY DETAIL =====
  const renderPropDetail = () => {
    if (selectedProp === null) return null;
    const cell = gs.board[selectedProp];
    const owner = cell.ownerId ? gs.players.find(p => p.id === cell.ownerId) : null;
    const canBuild = canBuildOnProperty(gs.board, cp.id, cell.id) && cp.money >= cell.houseCost && amICurrentPlayer;
    const canSell = cell.ownerId === cp.id && canSellHouseOnProperty(gs.board, cell.id) && amICurrentPlayer;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setSelectedProp(null)}>
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative glass-strong rounded-2xl p-5 max-w-sm w-full card-flip" onClick={e => e.stopPropagation()}>
          {cell.color && <div className="h-2 rounded-t-2xl -mt-5 -mx-5 mb-4" style={{ background: cell.color }} />}
          <div className="text-center mb-4">
            <div className="text-3xl mb-1">{cell.emoji}</div>
            <h3 className="font-display font-bold text-lg">{cell.name}</h3>
            {owner && <p className="text-sm mt-1" style={{ color: owner.color }}>Владелец: {owner.name}</p>}
            {cell.mortgaged && <p className="text-xs text-red-400 mt-1">🏚️ Заложено</p>}
          </div>
          {cell.type === 'property' && (
            <div className="glass rounded-xl p-3 mb-3">
              <p className="text-xs text-white/50 mb-2 font-semibold">Доходность по уровням:</p>
              <table className="w-full text-sm">
                <tbody>
                  {['Базовая аренда', 'Филиал ×1', 'Филиал ×2', 'Филиал ×3', 'Филиал ×4', 'Отель'].map((label, i) => (
                    <tr key={i} className={cell.houses === i ? 'text-amber-400 font-bold' : 'text-white/60'}>
                      <td className="py-0.5">{cell.houses === i ? '▸ ' : ''}{label}</td>
                      <td className="text-right">{formatMoney(cell.rent[i])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cell.houseCost > 0 && <p className="text-xs text-white/40 mt-2">Стоимость филиала: {formatMoney(cell.houseCost)}</p>}
              {hasMonopoly(gs.board, cell.ownerId || '', cell.group) && cell.houses === 0 && (
                <p className="text-xs text-green-400 mt-1">✦ Монополия: аренда ×2</p>
              )}
            </div>
          )}
          {cell.type === 'railroad' && (
            <div className="glass rounded-xl p-3 mb-3">
              <p className="text-xs text-white/50 mb-2 font-semibold">Аренда по количеству:</p>
              <table className="w-full text-sm"><tbody>
                {['1 авиалиния', '2 авиалинии', '3 авиалинии', '4 авиалинии'].map((label, i) => (
                  <tr key={i} className="text-white/60"><td className="py-0.5">{label}</td><td className="text-right">{formatMoney(cell.rent[i])}</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
          {cell.type === 'utility' && (
            <div className="glass rounded-xl p-3 mb-3">
              <p className="text-xs text-white/50 mb-2 font-semibold">Расчёт аренды:</p>
              <p className="text-sm text-white/60">1 предприятие: бросок × ₽4 000</p>
              <p className="text-sm text-white/60">2 предприятия: бросок × ₽10 000</p>
            </div>
          )}
          <div className="text-center text-xl font-display font-bold mb-3">{formatMoney(cell.price)}</div>
          <div className="flex gap-2 flex-wrap">
            {canBuild && (
              <button onClick={() => { handleBuild(cell.id); setSelectedProp(null); }}
                className="flex-1 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-sm font-bold btn-glow">
                🏗️ Построить ({formatMoney(cell.houseCost)})
              </button>
            )}
            {canSell && (
              <button onClick={() => { handleSellHouse(cell.id); setSelectedProp(null); }}
                className="flex-1 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-sm font-bold btn-glow">
                📉 Продать (+{formatMoney(Math.floor(cell.houseCost / 2))})
              </button>
            )}
            {cell.ownerId === cp.id && cell.houses === 0 && amICurrentPlayer && (
              <button onClick={() => { handleMortgage(cell.id); setSelectedProp(null); }}
                className="flex-1 py-2 rounded-lg glass hover:bg-white/10 text-sm font-bold">
                {cell.mortgaged ? '🔓 Выкупить (60%)' : '🏚️ Заложить (50%)'}
              </button>
            )}
          </div>
          <button onClick={() => setSelectedProp(null)} className="w-full mt-2 py-2 text-sm text-white/50 hover:text-white/80">Закрыть [esc]</button>
        </div>
      </div>
    );
  };

  // ===== SELL HOUSES DIALOG =====
  const renderSellHouses = () => {
    if (!showSellHouses) return null;
    const myProps = getPlayerProperties(gs.board, cp.id).filter(p => p.houses > 0);
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60" onClick={() => setShowSellHouses(false)} />
        <div className="relative glass-strong rounded-2xl p-5 max-w-sm w-full max-h-[80vh] overflow-y-auto">
          <h3 className="font-display font-bold text-lg text-center mb-3">📉 Продать филиалы</h3>
          <p className="text-xs text-white/50 mb-3 text-center">Продажа за 50% стоимости строительства</p>
          {myProps.length === 0 ? (
            <p className="text-sm text-white/40 text-center py-4">Нет построенных филиалов</p>
          ) : (
            <div className="space-y-2">
              {myProps.map(p => {
                const canSell = canSellHouseOnProperty(gs.board, p.id);
                const refund = Math.floor(p.houseCost / 2);
                return (
                  <div key={p.id} className="flex items-center gap-2 glass rounded-lg p-2">
                    <span className="text-lg">{p.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate">{p.name}</p>
                      <p className="text-[10px] text-white/40">
                        {p.houses === 5 ? '🏨 Отель' : `🏠 ×${p.houses}`} | Возврат: {formatMoney(refund)}
                      </p>
                    </div>
                    <button disabled={!canSell} onClick={() => handleSellHouse(p.id)}
                      className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-30 text-xs font-bold btn-glow">
                      Продать
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <button onClick={() => setShowSellHouses(false)} className="w-full mt-3 py-2 text-sm text-white/50 hover:text-white/80">Закрыть</button>
        </div>
      </div>
    );
  };

  // ===== AUCTION =====
  const renderAuction = () => {
    if (!gs.auction) return null;
    const auc = gs.auction;
    const prop = gs.board[auc.propertyId];
    const bidderId = auc.participants[auc.currentBidder];
    const bidder = gs.players.find(p => p.id === bidderId)!;
    const minBid = auc.currentBid + 10_000;
    const canBid = mode === 'local' ? true : (bidderId === `p${mySlotIndexRef.current}`);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70" />
        <div className="relative glass-strong rounded-2xl p-5 max-w-sm w-full card-flip">
          <h3 className="font-display font-bold text-lg text-center mb-1">🔨 Аукцион</h3>
          <p className="text-center text-sm text-white/60 mb-3">«{prop.name}» — {formatMoney(prop.price)}</p>
          {auc.currentBid > 0 && (
            <div className="text-center mb-3">
              <p className="text-xs text-white/50">Текущая ставка</p>
              <p className="font-display font-bold text-2xl text-amber-400">{formatMoney(auc.currentBid)}</p>
              {auc.highestBidderId && <p className="text-xs" style={{ color: gs.players.find(p => p.id === auc.highestBidderId)?.color }}>
                {gs.players.find(p => p.id === auc.highestBidderId)?.name}
              </p>}
            </div>
          )}
          <div className="glass rounded-xl p-3 mb-3">
            <p className="text-sm font-semibold mb-2" style={{ color: bidder.color }}>
              {bidder.token} Ход: {bidder.name} ({formatMoney(bidder.money)})
            </p>
            {canBid ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {[minBid, minBid + 40_000, minBid + 90_000, minBid + 190_000].map(amount => (
                    <button key={amount} disabled={amount > bidder.money}
                      onClick={() => handleAuctionBid(amount)}
                      className="py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-bold btn-glow">
                      {formatMoney(amount)}
                    </button>
                  ))}
                </div>
                <button onClick={handleAuctionPass}
                  className="w-full mt-2 py-2 rounded-lg glass hover:bg-white/10 text-sm font-bold">
                  🙅 Пас
                </button>
              </>
            ) : (
              <p className="text-center text-sm text-white/50 py-4">⏳ Ожидание ставки от {bidder.name}...</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ===== TRADE =====
  const renderTrade = () => {
    if (!showTrade) return null;
    const myProps = getPlayerProperties(gs.board, cp.id).filter(p => !p.mortgaged);
    const otherPlayers = gs.players.filter(p => !p.bankrupt && p.id !== cp.id);
    const targetPlayer = tradeTarget ? gs.players.find(p => p.id === tradeTarget) : null;
    const targetProps = tradeTarget ? getPlayerProperties(gs.board, tradeTarget).filter(p => !p.mortgaged) : [];

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70" onClick={() => setShowTrade(false)} />
        <div className="relative glass-strong rounded-2xl p-5 max-w-md w-full max-h-[90vh] overflow-y-auto">
          <h3 className="font-display font-bold text-lg text-center mb-3">🤝 Торговля</h3>
          <p className="text-xs text-white/50 mb-2">Торговать с:</p>
          <div className="flex gap-2 mb-4 flex-wrap">
            {otherPlayers.map(p => (
              <button key={p.id} onClick={() => { setTradeTarget(p.id); setTradeRequestProps([]); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold ${tradeTarget === p.id ? 'ring-2 ring-amber-400' : 'glass'}`}
                style={{ background: tradeTarget === p.id ? `${p.color}40` : undefined }}>
                {p.token} {p.name}
              </button>
            ))}
          </div>
          {targetPlayer && (
            <>
              <div className="glass rounded-xl p-3 mb-3">
                <p className="text-xs text-white/50 mb-2">Вы отдаёте:</p>
                <div className="flex flex-wrap gap-1 mb-2">
                  {myProps.map(p => (
                    <button key={p.id} onClick={() => setTradeOfferProps(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                      className={`px-2 py-1 rounded text-xs ${tradeOfferProps.includes(p.id) ? 'bg-amber-600' : 'glass'}`}>
                      {p.emoji} {p.name.split(' ')[0]}
                    </button>
                  ))}
                  {myProps.length === 0 && <p className="text-xs text-white/30">Нет бизнесов</p>}
                </div>
                <input type="number" value={tradeOfferMoney || ''} onChange={e => setTradeOfferMoney(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-500/50" placeholder="Сумма ₽" />
              </div>
              <div className="glass rounded-xl p-3 mb-3">
                <p className="text-xs text-white/50 mb-2">Вы получаете от {targetPlayer.name}:</p>
                <div className="flex flex-wrap gap-1 mb-2">
                  {targetProps.map(p => (
                    <button key={p.id} onClick={() => setTradeRequestProps(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                      className={`px-2 py-1 rounded text-xs ${tradeRequestProps.includes(p.id) ? 'bg-green-600' : 'glass'}`}>
                      {p.emoji} {p.name.split(' ')[0]}
                    </button>
                  ))}
                  {targetProps.length === 0 && <p className="text-xs text-white/30">Нет бизнесов</p>}
                </div>
                <input type="number" value={tradeRequestMoney || ''} onChange={e => setTradeRequestMoney(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-500/50" placeholder="Сумма ₽" />
              </div>
              <button onClick={handleProposeTrade}
                disabled={tradeOfferProps.length === 0 && tradeOfferMoney === 0 && tradeRequestProps.length === 0 && tradeRequestMoney === 0}
                className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-30 font-bold text-sm btn-glow">
                📤 Предложить сделку
              </button>
            </>
          )}
          <button onClick={() => setShowTrade(false)} className="w-full mt-2 py-2 text-sm text-white/50 hover:text-white/80">Отмена</button>
        </div>
      </div>
    );
  };

  // ===== TRADE CONFIRM =====
  const renderTradeConfirm = () => {
    if (!tradeConfirm && !pendingTradeForMe) return null;
    const trade = tradeConfirm || gs.pendingTrade;
    if (!trade) return null;
    const from = gs.players.find(p => p.id === trade.fromId)!;
    const to = gs.players.find(p => p.id === trade.toId)!;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70" />
        <div className="relative glass-strong rounded-2xl p-5 max-w-sm w-full card-flip">
          <h3 className="font-display font-bold text-lg text-center mb-1">🤝 Предложение сделки</h3>
          {mode === 'local' && (
            <p className="text-center text-sm text-white/60 mb-4">Передайте устройство игроку <strong style={{ color: to.color }}>{to.name}</strong></p>
          )}
          {mode === 'online' && (
            <p className="text-center text-sm text-white/60 mb-4"><strong style={{ color: from.color }}>{from.name}</strong> предлагает вам сделку</p>
          )}
          <div className="glass rounded-xl p-3 mb-3">
            <p className="text-xs text-white/50 mb-1">{from.name} отдаёт:</p>
            {trade.offerProperties.map(pid => <p key={pid} className="text-sm">• {gs.board[pid].emoji} {gs.board[pid].name}</p>)}
            {trade.offerMoney > 0 && <p className="text-sm">• {formatMoney(trade.offerMoney)}</p>}
            {trade.offerProperties.length === 0 && trade.offerMoney === 0 && <p className="text-sm text-white/30">Ничего</p>}
          </div>
          <div className="glass rounded-xl p-3 mb-4">
            <p className="text-xs text-white/50 mb-1">{from.name} просит:</p>
            {trade.requestProperties.map(pid => <p key={pid} className="text-sm">• {gs.board[pid].emoji} {gs.board[pid].name}</p>)}
            {trade.requestMoney > 0 && <p className="text-sm">• {formatMoney(trade.requestMoney)}</p>}
            {trade.requestProperties.length === 0 && trade.requestMoney === 0 && <p className="text-sm text-white/30">Ничего</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleAcceptTrade} className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 font-bold text-sm btn-glow">✅ Принять</button>
            <button onClick={handleDeclineTrade} className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 font-bold text-sm btn-glow">❌ Отклонить</button>
          </div>
        </div>
      </div>
    );
  };

  // ===== PLAYER CARD =====
  const renderPlayerCard = (p: typeof cp, compact = false) => {
    const props = getPlayerProperties(gs.board, p.id);
    const worth = getPlayerTotalWorth(p, gs.board);
    const isCurrent = p.id === cp.id;
    const isMe = mode === 'online' && mySlotIndexRef.current === gs.players.indexOf(p);

    if (compact) {
      return (
        <div key={p.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isCurrent ? 'ring-1 ring-amber-400/50' : ''} ${p.bankrupt ? 'opacity-30' : ''}`}
          style={{ background: isCurrent ? `${p.color}20` : 'rgba(255,255,255,0.03)' }}>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
            style={{ background: p.color }}>{p.token}</div>
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold truncate block">{p.name}{isMe ? ' (вы)' : ''}{p.bankrupt ? ' 💀' : ''}</span>
          </div>
          <span className="text-xs font-display font-bold shrink-0" style={{ color: p.money < 0 ? '#ef4444' : '#fbbf24' }}>{formatMoney(p.money)}</span>
        </div>
      );
    }

    return (
      <div key={p.id} className={`glass rounded-xl p-3 ${isCurrent ? 'ring-1 ring-amber-400/50' : ''} ${p.bankrupt ? 'opacity-30' : ''}`}
        style={{ background: isCurrent ? `${p.color}15` : undefined }}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ background: p.color, boxShadow: isCurrent ? `0 0 12px ${p.color}60` : 'none' }}>
            {p.token}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold truncate">
              {p.name} {isMe ? <span className="text-xs text-white/40">(вы)</span> : ''} {p.bankrupt ? '💀' : ''} {p.inJail ? '🔒' : ''}
            </p>
            <p className="font-display text-base font-bold" style={{ color: p.money < 0 ? '#ef4444' : '#fbbf24' }}>{formatMoney(p.money)}</p>
          </div>
          {isCurrent && !p.bankrupt && amICurrentPlayer && (
            <button onClick={() => { setShowTrade(true); setTradeTarget(null); setTradeOfferProps([]); setTradeRequestProps([]); setTradeOfferMoney(0); setTradeRequestMoney(0); }}
              className="p-1.5 rounded-lg glass hover:bg-white/10 text-xs" title="Торговля">🤝</button>
          )}
          {mode === 'online' && onlineConfig?.isHost && !isMe && !p.bankrupt && (
            <button onClick={() => handleKick(p.id)}
              className="p-1.5 rounded-lg glass hover:bg-red-900/30 text-xs" title="Исключить">🚫</button>
          )}
        </div>
        {p.debt > 0 && <p className="text-xs text-red-400 mb-1">⚠️ Долг: {formatMoney(p.debt)}</p>}
        {p.getOutOfJailCards > 0 && <p className="text-xs text-blue-400 mb-1">🎫 Карточек выхода: {p.getOutOfJailCards}</p>}
        {props.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {props.map(prop => (
              <div key={prop.id} className="px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer hover:scale-110 transition-transform"
                style={{ background: `${prop.color || p.color}30`, color: prop.color || p.color, border: `1px solid ${prop.color || p.color}40` }}
                onClick={() => setSelectedProp(prop.id)}>
                {prop.emoji}
                {prop.houses > 0 && <span className="ml-0.5">{prop.houses === 5 ? '🏨' : `×${prop.houses}`}</span>}
                {prop.mortgaged && <span className="ml-0.5 opacity-50">⊘</span>}
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-white/30 mt-1">Активы: {formatMoney(worth)}</p>
      </div>
    );
  };

  // ===== CONTROLS =====
  const renderControls = () => {
    const myProps = getPlayerProperties(gs.board, cp.id);
    const buildableProps = myProps.filter(p => canBuildOnProperty(gs.board, cp.id, p.id) && cp.money >= p.houseCost);
    const sellableProps = myProps.filter(p => p.houses > 0);

    return (
      <div className="space-y-3">
        {/* Online status + timer */}
        {mode === 'online' && (
          <div className={`glass rounded-xl p-3 text-center ${amICurrentPlayer ? 'ring-1 ring-green-400/30' : ''}`}>
            <p className={`text-sm font-bold ${amICurrentPlayer ? 'text-green-400' : 'text-white/50'}`}>
              {onlineStatusText}
            </p>
            {gs.phase === 'roll' && (
              <div className="mt-1 flex items-center justify-center gap-2">
                <div className="w-full max-w-[120px] h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-1000"
                    style={{ width: `${(turnTimer / ONLINE_TURN_TIMEOUT) * 100}%`, background: turnTimer > 15 ? '#22c55e' : turnTimer > 5 ? '#f59e0b' : '#ef4444' }} />
                </div>
                <span className={`text-xs font-mono font-bold ${turnTimer <= 10 ? 'text-red-400' : 'text-white/40'}`}>
                  {turnTimer}с
                </span>
              </div>
            )}
          </div>
        )}

        {/* Current player info */}
        <div className="glass rounded-xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ background: cp.color, boxShadow: `0 0 12px ${cp.color}60` }}>{cp.token}</div>
            <div>
              <p className="text-sm font-bold">{cp.name}</p>
              <p className="font-display text-lg font-bold text-amber-400">{formatMoney(cp.money)}</p>
            </div>
          </div>
        </div>

        {/* Dice */}
        <div className="flex justify-center gap-4 py-2">
          <div className="dice-scene">
            <div className={`dice-cube ${rolling ? 'rolling' : `dice-show-${gs.diceValues[0]}`}`}>
              {[1,2,3,4,5,6].map(v => <DiceFace key={v} value={v} cls={`face-${v}`} />)}
            </div>
          </div>
          <div className="dice-scene">
            <div className={`dice-cube ${rolling ? 'rolling' : `dice-show-${gs.diceValues[1]}`}`}>
              {[1,2,3,4,5,6].map(v => <DiceFace key={v} value={v} cls={`face-${v}`} />)}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        {gs.phase === 'roll' && !animating && (
          <div className="space-y-2">
            {!amICurrentPlayer ? (
              <div className="text-center text-sm text-white/40 py-3">
                ⏳ Ожидание хода: {cp.name}
              </div>
            ) : cp.inJail ? (
              <>
                <button onClick={handleRoll} disabled={rolling}
                  className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 font-display font-bold text-sm btn-glow disabled:opacity-50">
                  🎲 Бросить на дубль {mode === 'local' ? '[пробел]' : ''}
                </button>
                {cp.money >= 50_000 && (
                  <button onClick={handlePayJail} className="w-full py-2.5 rounded-xl glass hover:bg-white/10 text-sm font-bold">
                    💸 Заплатить ₽50 000
                  </button>
                )}
                {cp.getOutOfJailCards > 0 && (
                  <button onClick={handleUseJailCard} className="w-full py-2.5 rounded-xl glass hover:bg-white/10 text-sm font-bold">
                    🎫 Карточка выхода ({cp.getOutOfJailCards})
                  </button>
                )}
              </>
            ) : (
              <button onClick={handleRoll} disabled={rolling}
                className="w-full py-3 rounded-xl font-display font-bold text-sm btn-glow disabled:opacity-50 text-black"
                style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
                🎲 Бросить кости {mode === 'local' ? '[пробел]' : ''}
              </button>
            )}
          </div>
        )}

        {/* Phase message */}
        {gs.phase === 'landed' && moveResult && (
          <div className="glass rounded-xl p-3 text-center">
            <p className="text-2xl mb-1">{moveResult.messageIcon}</p>
            <p className="text-sm">{moveResult.message}</p>
            <p className="text-xs text-white/40 mt-1">Ход переходит автоматически...</p>
          </div>
        )}

        {/* Build section */}
        {amICurrentPlayer && buildableProps.length > 0 && (
          <div className="glass rounded-xl p-3">
            <p className="text-xs text-white/50 mb-2 font-semibold">🏗️ Строительство</p>
            <div className="space-y-1">
              {buildableProps.map(p => (
                <button key={p.id} onClick={() => handleBuild(p.id)}
                  className="w-full text-left px-2 py-1.5 rounded-lg glass hover:bg-white/10 text-xs flex items-center gap-1">
                  <span>{p.emoji}</span>
                  <span className="flex-1 truncate">{p.name.split('«')[1]?.replace('»', '') || p.name}</span>
                  <span className="text-amber-400 shrink-0">{formatMoney(p.houseCost)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sell houses + Bank + Bankruptcy */}
        {amICurrentPlayer && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <button onClick={() => setShowBank(true)} className="flex-1 py-2 rounded-lg glass hover:bg-white/10 text-xs font-bold">🏦 Банк</button>
              {sellableProps.length > 0 && (
                <button onClick={() => setShowSellHouses(true)} className="flex-1 py-2 rounded-lg glass hover:bg-white/10 text-xs font-bold">
                  📉 Продать ({sellableProps.length})
                </button>
              )}
            </div>
            {cp.debt > 0 && cp.money > 0 && (
              <button onClick={handlePayDebt} className="w-full py-2 rounded-lg bg-green-700 hover:bg-green-600 text-xs font-bold btn-glow">
                💳 Погасить долг ({formatMoney(Math.min(cp.debt, cp.money))})
              </button>
            )}
            {cp.money < 0 && (
              <div className="glass rounded-xl p-3 border border-red-500/30">
                <p className="text-sm text-red-400 font-bold mb-2">⚠️ Отрицательный баланс!</p>
                <p className="text-xs text-white/50 mb-2">Продайте филиалы, заложите бизнесы или возьмите кредит. Иначе — банкротство.</p>
                <button onClick={handleBankrupt} className="w-full py-2 rounded-lg bg-red-700 hover:bg-red-600 text-xs font-bold btn-glow">
                  💀 Объявить банкротство
                </button>
              </div>
            )}
          </div>
        )}

        {/* Extra actions */}
        <div className="flex gap-2">
          <button onClick={() => setShowRules(true)} className="flex-1 py-2 rounded-lg glass hover:bg-white/10 text-xs font-bold">📖 Правила</button>
          <button onClick={() => setShowLog(!showLog)} className="flex-1 py-2 rounded-lg glass hover:bg-white/10 text-xs font-bold">📋 Журнал</button>
          <button onClick={() => setExitConfirm(true)} className="flex-1 py-2 rounded-lg glass hover:bg-red-900/30 text-xs font-bold">🚪 Выход</button>
        </div>
      </div>
    );
  };

  // ===== WINNER =====
  // Play win sound when winner is first detected  
  const winnerSoundPlayed = useRef(false);
  useEffect(() => {
    if (gs.winner && !winnerSoundPlayed.current) {
      winnerSoundPlayed.current = true;
      sfx('win');
    }
  }, [gs.winner, sfx]);

  if (gs.winner) {
    const winner = gs.players.find(p => p.id === gs.winner)!;
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#151518' }}>
        <div className="text-center fade-up">
          <div className="text-7xl mb-4">🏆</div>
          <h1 className="font-display text-4xl font-black mb-2" style={{ color: winner.color }}>{winner.name}</h1>
          <p className="text-xl text-white/60 mb-2">ПОБЕДИТЕЛЬ!</p>
          <p className="font-display text-2xl font-bold text-amber-400 mb-4">{formatMoney(getPlayerTotalWorth(winner, gs.board))}</p>
          <div className="glass rounded-xl p-4 mb-6 max-w-sm mx-auto text-left">
            <p className="text-xs text-white/50 mb-2 font-semibold">Итоги игры:</p>
            {gs.players.map(p => (
              <div key={p.id} className="flex items-center gap-2 py-1 text-sm">
                <span style={{ color: p.color }}>{p.token}</span>
                <span className={`flex-1 ${p.bankrupt ? 'text-white/30 line-through' : ''}`}>{p.name}</span>
                <span className="font-display font-bold text-xs">{p.bankrupt ? '💀' : formatMoney(getPlayerTotalWorth(p, gs.board))}</span>
              </div>
            ))}
            <p className="text-xs text-white/30 mt-2">Ходов сыграно: {gs.turnCount}</p>
          </div>
          <button onClick={() => { if (mode === 'online') localStorage.removeItem('magnat_online_session'); onExit(); }}
            className="px-8 py-3 rounded-xl font-display font-bold btn-glow text-black"
            style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
            В главное меню
          </button>
        </div>
      </div>
    );
  }

  // ===== MAIN LAYOUT =====
  return (
    <div className="h-screen flex flex-col" style={{ background: '#151518' }}>
      {/* Header */}
      <div className="h-11 shrink-0 flex items-center justify-between px-3 border-b border-white/5" style={{ background: '#1a1a20' }}>
        <div className="flex items-center gap-2">
          <span className="font-display font-bold text-sm text-amber-400">👑 МАГНАТ</span>
          <span className="beta-badge">{APP_VERSION}</span>
          <span className="text-xs text-white/30 hidden sm:inline">Ход {gs.turnCount + 1}</span>
          {mode === 'online' && <span className="text-xs text-indigo-400 ml-1">🌐</span>}
        </div>
        <div className="flex items-center gap-2">
          {mode === 'online' && (
            <button onClick={() => { setChatOpen(!chatOpen); if (!chatOpen) setChatUnread(0); }}
              className={`sound-btn relative ${chatUnread > 0 ? 'tab-unread' : ''}`} title="Чат">
              💬
              {chatUnread > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-[9px] text-white rounded-full flex items-center justify-center font-bold">
                  {chatUnread > 9 ? '9+' : chatUnread}
                </span>
              )}
            </button>
          )}
          <button onClick={toggleSound} className="sound-btn" title={soundOn ? 'Выключить звук' : 'Включить звук'}>
            {soundOn ? '🔊' : '🔇'}
          </button>
          {mode === 'online' && (
            <span className={`text-xs font-bold ${amICurrentPlayer ? 'text-green-400' : 'text-white/40'}`}>
              {amICurrentPlayer ? '🟢' : '⏳'}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: cp.color }}>{cp.token}</div>
            <span className="text-xs font-bold hidden sm:inline">{cp.name}</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* LEFT: Players (desktop) */}
        <div className="hidden xl:flex flex-col w-64 shrink-0 border-r border-white/5 overflow-y-auto p-3 space-y-2" style={{ background: '#18181e' }}>
          <p className="text-xs text-white/40 font-semibold mb-1">👥 Игроки</p>
          {gs.players.map(p => renderPlayerCard(p))}
        </div>

        {/* CENTER: Board */}
        <div className="flex-1 flex items-center justify-center p-2 min-w-0 min-h-0 overflow-hidden">
          <div className="board-container">
            <div className="board-grid">
              {gs.board.map(cell => renderCell(cell))}
              <div className="board-center">
                <div className="font-display font-black text-xl sm:text-2xl text-amber-400/80 tracking-tight">МАГНАТ</div>
                <div className="text-[10px] text-white/25 mt-0.5">Бизнес-Империя</div>
                <div className="mt-2 flex items-center gap-1.5 glass rounded-full px-3 py-1">
                  <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px]" style={{ background: cp.color }}>{cp.token}</div>
                  <span className="text-[10px] font-bold">{cp.name}</span>
                  <span className="text-[10px] font-display font-bold text-amber-400">{formatMoney(cp.money)}</span>
                </div>
                {gs.parkingPot > 0 && (
                  <div className="mt-2 glass rounded-full px-3 py-1">
                    <span className="text-[10px] text-white/50">🅿️ Копилка: </span>
                    <span className="text-[11px] font-display font-bold text-green-400">{formatMoney(gs.parkingPot)}</span>
                  </div>
                )}
                {gs.phase === 'landed' && (
                  <div className="mt-1 text-xs text-white/40">
                    🎲 {gs.diceValues[0]} + {gs.diceValues[1]} = {gs.diceValues[0] + gs.diceValues[1]}
                    {gs.diceValues[0] === gs.diceValues[1] && <span className="text-amber-400 ml-1">Дубль!</span>}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Controls (desktop) */}
        <div className="hidden xl:flex flex-col w-72 shrink-0 border-l border-white/5 overflow-y-auto p-3" style={{ background: '#18181e' }}>
          {showLog ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-white/40 font-semibold">📋 Журнал</p>
                <button onClick={() => setShowLog(false)} className="text-xs text-white/40 hover:text-white/70">✕</button>
              </div>
              <div className="space-y-1">
                {gs.log.slice(0, 40).map((entry, i) => (
                  <div key={i} className="text-xs text-white/50 py-1 border-b border-white/5">
                    <span className="mr-1">{entry.icon}</span>{entry.text}
                  </div>
                ))}
              </div>
            </div>
          ) : renderControls()}
        </div>
      </div>

      {/* MOBILE TOP INFO BAR */}
      <div className="xl:hidden shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/5" style={{ background: '#1a1a20' }}>
        <button onClick={() => { setShowPlayersDrawer(true); setShowControlDrawer(false); }}
          className="flex items-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/10 active:scale-95 transition-transform">
          <span className="text-base">👥</span>
          <span className="text-xs font-bold text-white/70">Игроки</span>
        </button>
        <div className="flex items-center gap-2">
          {mode === 'online' && (
            <span className={`text-xs font-bold ${amICurrentPlayer ? 'text-green-400' : 'text-white/40'}`}>
              {amICurrentPlayer ? '🟢 Ваш ход' : `⏳ ${cp.name}`}
            </span>
          )}
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shadow-lg"
            style={{ background: cp.color, boxShadow: `0 0 10px ${cp.color}60` }}>{cp.token}</div>
          <div className="text-right">
            <p className="text-xs font-bold leading-none">{cp.name}</p>
            <p className="text-sm font-display font-bold text-amber-400 leading-tight">{formatMoney(cp.money)}</p>
          </div>
        </div>
        <button onClick={() => { setShowControlDrawer(true); setShowPlayersDrawer(false); }}
          className="flex items-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/10 active:scale-95 transition-transform">
          <span className="text-base">⚙️</span>
          <span className="text-xs font-bold text-white/70">Меню</span>
        </button>
      </div>

      {/* MOBILE BOTTOM ACTION BAR */}
      <div className="xl:hidden shrink-0 px-3 py-2 border-t border-white/5 space-y-2" style={{ background: '#1a1a20' }}>
        {gs.phase === 'roll' && !animating && amICurrentPlayer && !cp.inJail && (
          <button onClick={handleRoll} disabled={rolling}
            className="w-full py-3.5 rounded-xl font-display font-bold text-base btn-glow disabled:opacity-50 text-black active:scale-95 transition-transform"
            style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
            🎲 Бросить кости
          </button>
        )}
        {gs.phase === 'roll' && !animating && amICurrentPlayer && cp.inJail && (
          <div className="flex gap-2">
            <button onClick={handleRoll} disabled={rolling}
              className="flex-1 py-3 rounded-xl bg-amber-600 hover:bg-amber-500 font-bold text-sm btn-glow disabled:opacity-50 active:scale-95 transition-transform">
              🎲 Дубль
            </button>
            {cp.money >= 50_000 && (
              <button onClick={handlePayJail}
                className="flex-1 py-3 rounded-xl glass hover:bg-white/10 font-bold text-sm active:scale-95 transition-transform">
                💸 ₽50К
              </button>
            )}
            {cp.getOutOfJailCards > 0 && (
              <button onClick={handleUseJailCard}
                className="flex-1 py-3 rounded-xl glass hover:bg-white/10 font-bold text-sm active:scale-95 transition-transform">
                🎫 Карточка
              </button>
            )}
          </div>
        )}
        {gs.phase === 'roll' && !animating && !amICurrentPlayer && (
          <div className="text-center py-3 text-sm text-white/40 font-bold">
            ⏳ Ожидание хода: {cp.name}
          </div>
        )}
        {gs.phase === 'landed' && moveResult && (
          <div className="text-center py-2">
            <p className="text-sm">{moveResult.messageIcon} {moveResult.message}</p>
            <p className="text-xs text-white/30 mt-1">Ход переходит автоматически...</p>
          </div>
        )}
        {animating && (
          <div className="text-center py-3 text-sm text-white/40">
            🎲 Перемещение...
          </div>
        )}
        {/* Dice display */}
        <div className="flex justify-center gap-3">
          <div className="dice-scene" style={{ width: '36px', height: '36px' }}>
            <div className={`dice-cube ${rolling ? 'rolling' : `dice-show-${gs.diceValues[0]}`}`}>
              {[1,2,3,4,5,6].map(v => <DiceFace key={v} value={v} cls={`face-${v}`} />)}
            </div>
          </div>
          <div className="dice-scene" style={{ width: '36px', height: '36px' }}>
            <div className={`dice-cube ${rolling ? 'rolling' : `dice-show-${gs.diceValues[1]}`}`}>
              {[1,2,3,4,5,6].map(v => <DiceFace key={v} value={v} cls={`face-${v}`} />)}
            </div>
          </div>
        </div>
      </div>

      {/* MOBILE DRAWERS */}
      {showPlayersDrawer && (
        <>
          <div className="drawer-overlay" onClick={() => setShowPlayersDrawer(false)} />
          <div className="drawer drawer-left">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <p className="font-display font-bold text-sm">👥 Игроки</p>
              <button onClick={() => setShowPlayersDrawer(false)} className="text-white/50 hover:text-white text-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {gs.players.map(p => renderPlayerCard(p))}
            </div>
          </div>
        </>
      )}

      {showControlDrawer && (
        <>
          <div className="drawer-overlay" onClick={() => setShowControlDrawer(false)} />
          <div className="drawer drawer-right">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <p className="font-display font-bold text-sm">🎮 Управление</p>
              <button onClick={() => setShowControlDrawer(false)} className="text-white/50 hover:text-white text-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {renderControls()}
            </div>
          </div>
        </>
      )}

      {/* TOASTS */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className="toast"><span>{t.icon}</span><span>{t.text}</span></div>
        ))}
      </div>

      {/* MONEY FLY */}
      {moneyFly && (
        <div className="money-fly" style={{ color: moneyFly.amount >= 0 ? '#22c55e' : '#ef4444' }}>
          {moneyFly.amount >= 0 ? '+' : ''}{formatMoney(moneyFly.amount)}
        </div>
      )}

      {/* BUY DIALOG */}
      {showBuyDialog && amICurrentPlayer && (() => {
        const cell = gs.board[cp.position];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60" />
            <div className="relative glass-strong rounded-2xl p-5 max-w-xs w-full card-flip">
              <div className="text-center mb-3">
                <div className="text-3xl mb-1">{cell.emoji}</div>
                <h3 className="font-display font-bold text-base">{cell.name}</h3>
                <p className="font-display text-2xl font-bold text-amber-400 mt-1">{formatMoney(cell.price)}</p>
                {cell.type === 'property' && <p className="text-xs text-white/50 mt-1">Аренда: {formatMoney(cell.rent[0])}</p>}
              </div>
              <div className="flex gap-2">
                <button onClick={handleBuy}
                  className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 font-bold text-sm btn-glow">
                  ✅ Купить
                </button>
                <button onClick={handleDecline}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 font-bold text-sm btn-glow">
                  🔨 Аукцион
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* CARD INFO */}
      {cardInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setCardInfo(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative glass-strong rounded-2xl p-6 max-w-xs w-full card-flip" onClick={e => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-4xl mb-2">{cardInfo.type === 'chance' ? '❓' : '💎'}</div>
              <h3 className="font-display font-bold text-base mb-2">{cardInfo.type === 'chance' ? 'Шанс' : 'Казна'}</h3>
              <p className="text-sm text-white/80 leading-relaxed">{cardInfo.text}</p>
              <button onClick={() => setCardInfo(null)} className="mt-4 px-6 py-2 rounded-xl glass hover:bg-white/10 text-sm font-bold">OK</button>
            </div>
          </div>
        </div>
      )}

      {/* BANK DIALOG */}
      {showBank && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowBank(false)} />
          <div className="relative glass-strong rounded-2xl p-5 max-w-xs w-full card-flip">
            <h3 className="font-display font-bold text-lg text-center mb-3">🏦 Банк</h3>
            <div className="glass rounded-xl p-3 mb-3 text-sm">
              <p>Баланс: <span className="font-bold text-amber-400">{formatMoney(cp.money)}</span></p>
              {cp.debt > 0 && <p className="text-red-400">Долг: {formatMoney(cp.debt)} (5% за ход)</p>}
            </div>
            <p className="text-xs text-white/50 mb-2">Сумма кредита (20% комиссия):</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[100_000, 200_000, 500_000, 1_000_000].map(a => (
                <button key={a} onClick={() => setBankAmount(a)}
                  className={`py-2 rounded-lg text-sm font-bold ${bankAmount === a ? 'bg-amber-600' : 'glass'}`}>
                  {formatMoney(a)}
                </button>
              ))}
            </div>
            <p className="text-xs text-white/40 mb-3 text-center">
              Получите: {formatMoney(bankAmount)} | Долг: +{formatMoney(Math.floor(bankAmount * 1.2))}
            </p>
            <button onClick={handleTakeLoan}
              className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 font-bold text-sm btn-glow">
              💰 Взять кредит
            </button>
            <button onClick={() => setShowBank(false)} className="w-full mt-2 py-2 text-sm text-white/50">Закрыть</button>
          </div>
        </div>
      )}

      {/* RULES */}
      {showRules && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowRules(false)} />
          <div className="relative glass-strong rounded-2xl p-5 max-w-md w-full max-h-[80vh] overflow-y-auto">
            <h3 className="font-display font-bold text-lg mb-3">📖 Правила игры</h3>
            <div className="space-y-2.5 text-sm text-white/70 leading-relaxed">
              <p>🎯 Цель — разорить всех соперников, скупая бизнесы и собирая аренду.</p>
              <p>🎲 Бросайте две кости и двигайтесь по полю. Дубль = ещё один бросок.</p>
              <p>🏪 Попав на свободный бизнес, можно купить. Отказались — аукцион.</p>
              <p>💸 На чужом бизнесе — платите аренду. Монополия = двойная аренда.</p>
              <p>🏗️ Монополия позволяет строить филиалы (до 4) и отель. Строить равномерно — нельзя поставить 2-й на одну клетку, пока на остальных нет 1-го.</p>
              <p>📉 Филиалы можно продать обратно за 50% стоимости. Продавать тоже равномерно.</p>
              <p>🤝 Торгуйте бизнесами и деньгами с другими игроками.</p>
              <p>🏦 Кредит в банке: 20% комиссия + 5% долга за ход.</p>
              <p>🏚️ Заложить бизнес за 50%, выкупить за 60%. Заложенный не приносит аренду.</p>
              <p>🔒 Тюрьма: дубль, ₽50 000 или карточка для выхода.</p>
              <p>💀 Не можете платить? Продайте филиалы, заложите бизнесы, возьмите кредит — или объявите банкротство.</p>
              {mode === 'online' && <p>⏰ Онлайн: на ход даётся {ONLINE_TURN_TIMEOUT} секунд. Если не успел — ход пропускается.</p>}
            </div>
            <button onClick={() => setShowRules(false)} className="w-full mt-4 py-2 rounded-xl glass hover:bg-white/10 text-sm font-bold">Закрыть [esc]</button>
          </div>
        </div>
      )}

      {/* EXIT CONFIRM */}
      {exitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => { setExitConfirm(false); setSlideX(0); }} />
          <div className="relative glass-strong rounded-2xl p-5 max-w-xs w-full card-flip">
            <h3 className="font-display font-bold text-lg text-center mb-1">🚪 Выход</h3>
            <p className="text-sm text-white/60 text-center mb-4">
              {mode === 'local' ? 'Игра будет сохранена автоматически' : 'Вы покинете онлайн-игру'}
            </p>
            <div className="slide-track" ref={slideRef}
              onMouseMove={slideX > 0 ? handleSlideMove : undefined}
              onMouseUp={handleSlideEnd}
              onMouseLeave={handleSlideEnd}
              onTouchMove={handleSlideMove}
              onTouchEnd={handleSlideEnd}>
              <div className="slide-fill" style={{ width: slideX + 48 }} />
              <div className="slide-track-text">Сдвиньте для выхода →</div>
              <div className="slide-thumb" style={{ left: 4 + slideX }}
                onMouseDown={() => setSlideX(1)}
                onTouchStart={() => setSlideX(1)}>🔓</div>
            </div>
            <button onClick={() => { setExitConfirm(false); setSlideX(0); }}
              className="w-full mt-3 py-2 text-sm text-white/50 hover:text-white/80">Отмена</button>
          </div>
        </div>
      )}

      {/* PROPERTY DETAIL */}
      {selectedProp !== null && renderPropDetail()}

      {/* AUCTION */}
      {renderAuction()}

      {/* TRADE */}
      {renderTrade()}

      {/* TRADE CONFIRM */}
      {renderTradeConfirm()}

      {/* SELL HOUSES */}
      {renderSellHouses()}

      {/* BIG EVENT OVERLAY */}
      {bigEvent && (
        <div className="big-event" onClick={() => setBigEvent(null)}>
          <div className="big-event-content">
            <div className="text-7xl mb-4">{bigEvent.icon}</div>
            <p className="font-display text-2xl sm:text-3xl font-black" style={{ color: bigEvent.color }}>{bigEvent.text}</p>
          </div>
        </div>
      )}

      {/* HINT BUBBLE */}
      {currentHint && (
        <div className="hint-bubble">
          <span className="text-xl shrink-0">💡</span>
          <p className="text-sm text-amber-200/90 flex-1">{currentHint.text}</p>
          <button onClick={() => setCurrentHint(null)} className="text-white/40 hover:text-white shrink-0 text-lg leading-none">✕</button>
        </div>
      )}

      {/* FLOATING REACTIONS */}
      {floatingReactions.map(r => (
        <div key={r.id} className="floating-reaction" style={{ left: `${r.x}%`, top: `${r.y}%` }}>
          {r.emoji}
        </div>
      ))}

      {/* CHAT DRAWER (online only) */}
      {mode === 'online' && chatOpen && (
        <>
          <div className="drawer-overlay" onClick={() => { setChatOpen(false); setChatUnread(0); }} />
          <div className="drawer drawer-right" style={{ width: '320px', maxWidth: '85vw' }}>
            <div className="flex items-center justify-between p-3 border-b border-white/10 shrink-0">
              <p className="font-display font-bold text-sm">💬 Чат</p>
              <button onClick={() => { setChatOpen(false); setChatUnread(0); }} className="text-white/50 hover:text-white text-lg">✕</button>
            </div>
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1" id="chat-messages-scroll">
                {(!gs.chat || gs.chat.length === 0) && (
                  <p className="text-center text-xs text-white/30 py-8">Сообщений пока нет.<br/>Начните общение!</p>
                )}
                {(gs.chat || []).map((msg: ChatMessage) => (
                  <div key={msg.id} className={`chat-msg ${msg.isSystem ? 'system' : msg.playerId === `p${mySlotIndexRef.current}` ? 'mine' : 'other'}`}>
                    {!msg.isSystem && msg.playerId !== `p${mySlotIndexRef.current}` && (
                      <div className="chat-name" style={{ color: msg.playerColor }}>{msg.playerName}</div>
                    )}
                    <div>{msg.text}</div>
                  </div>
                ))}
              </div>
              {/* Quick reactions */}
              <div className="reaction-bar">
                {['👍', '👎', '😂', '😡', '🤝', '🎉', '😢', '🔥'].map(emoji => (
                  <button key={emoji} className="reaction-btn" onClick={() => handleSendReaction(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
              {/* Input */}
              <div className="chat-input-bar">
                <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSendChat(); }}
                  placeholder="Сообщение..." maxLength={200} />
                <button onClick={handleSendChat} disabled={!chatInput.trim()}>↑</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
