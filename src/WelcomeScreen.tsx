import { useState, useEffect, useCallback } from 'react';
import { OnlineConfig, APP_VERSION } from './types';
import { createRoom, joinRoom, toggleReady, listenToRoom, leaveRoom, type RoomData } from './firebase';

interface Props {
  onStartLocal: (names: string[]) => void;
  onStartOnline: (names: string[], config: OnlineConfig) => void;
  hasSave: boolean;
  onContinue: () => void;
  hasOnlineSession?: boolean;
  onReconnect?: () => void;
  reconnecting?: boolean;
}

const RULES = [
  '🎯 Цель — разорить всех соперников, скупая бизнесы и собирая аренду.',
  '🎲 Бросайте две кости и двигайтесь по полю. Дубль = ещё один бросок (3 дубля подряд = тюрьма).',
  '🏪 Попав на свободный бизнес, вы можете его купить. Отказались — начнётся аукцион между всеми.',
  '💸 Попали на чужой бизнес — платите аренду владельцу.',
  '🏗️ Собрав все бизнесы одного цвета (монополия), можно строить филиалы и отели. Аренда растёт!',
  '📏 Строительство равномерное — нельзя ставить 2-й филиал, пока на остальных клетках группы нет 1-го.',
  '📉 Филиалы можно продать за 50% стоимости. Сносить тоже равномерно.',
  '🤝 Торгуйте с другими игроками — обменивайте бизнесы и деньги. Требуется подтверждение второй стороны.',
  '🏦 Не хватает средств? Возьмите кредит в банке (20% комиссия + 5% от долга за ход).',
  '🏚️ Можно заложить бизнес банку за 50% стоимости и выкупить обратно за 60%.',
  '🔒 В тюрьме: бросайте дубль, заплатите ₽50 000 или используйте карточку выхода.',
  '🅿️ Штрафы и налоги копятся в парковке — кто встанет на неё, забирает всё!',
  '💀 Не можете платить? Продайте филиалы, заложите бизнесы, возьмите кредит — или банкротство.',
  '⏰ Онлайн: на каждый ход 60 секунд. Не успел — ход пропускается.',
];

type Screen = 'menu' | 'local' | 'online-choice' | 'create-room' | 'join-room' | 'lobby';

export default function WelcomeScreen({ onStartLocal, onStartOnline, hasSave, onContinue, hasOnlineSession, onReconnect, reconnecting }: Props) {
  const [screen, setScreen] = useState<Screen>('menu');
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(['', '', '', '', '', '']);
  const [showRules, setShowRules] = useState(false);

  // Online state
  const [myName, setMyName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [roomCode, setRoomCode] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [room, setRoom] = useState<RoomData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!roomCode || screen !== 'lobby') return;
    const unsub = listenToRoom(roomCode, (data) => {
      if (data) {
        setRoom(data);
        if (data.phase === 'playing' && data.state) {
          const myIdx = data.playerSlots.findIndex(s => s.id === myPlayerId);
          localStorage.setItem('magnat_online_slot', String(myIdx));
          const config: OnlineConfig = { roomCode, myPlayerId, isHost: data.hostId === myPlayerId };
          const playerNames = data.playerSlots.map(s => s.name);
          onStartOnline(playerNames, config);
        }
      } else {
        setError('Комната была удалена');
        setScreen('online-choice');
      }
    });
    return unsub;
  }, [roomCode, screen, myPlayerId, onStartOnline]);

  const handleStartLocal = () => {
    const playerNames = names.slice(0, count).map((n, i) => n.trim() || `Игрок ${i + 1}`);
    onStartLocal(playerNames);
  };

  const handleCreateRoom = useCallback(async () => {
    const name = myName.trim() || 'Хост';
    setLoading(true); setError('');
    try {
      const { code, playerId } = await createRoom(name, maxPlayers);
      setRoomCode(code); setMyPlayerId(playerId); setScreen('lobby');
    } catch (e) { setError('Ошибка создания комнаты. Проверьте Firebase.'); console.error(e); }
    setLoading(false);
  }, [myName, maxPlayers]);

  const handleJoinRoom = useCallback(async () => {
    const name = myName.trim() || 'Игрок';
    const code = roomCode.trim().toUpperCase();
    if (!code) { setError('Введите код комнаты'); return; }
    setLoading(true); setError('');
    try {
      const result = await joinRoom(code, name);
      if (!result) { setError('Комната не найдена, полная или уже играют'); setLoading(false); return; }
      setRoomCode(code); setMyPlayerId(result.playerId); setRoom(result.room); setScreen('lobby');
    } catch (e) { setError('Ошибка подключения. Проверьте Firebase.'); console.error(e); }
    setLoading(false);
  }, [myName, roomCode]);

  const handleToggleReady = async () => { if (roomCode && myPlayerId) await toggleReady(roomCode, myPlayerId); };

  const handleLeaveRoom = async () => {
    if (roomCode && myPlayerId) await leaveRoom(roomCode, myPlayerId);
    setRoom(null); setRoomCode(''); setMyPlayerId(''); setScreen('online-choice');
  };

  const isHost = room?.hostId === myPlayerId;
  const allReady = room ? room.playerSlots.length >= 2 && room.playerSlots.every(s => s.ready) : false;

  // ===== RULES MODAL (separate from page, always accessible) =====
  const rulesModal = showRules ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowRules(false)} />
      <div className="relative w-full max-w-lg max-h-[85vh] flex flex-col glass-strong rounded-2xl overflow-hidden card-flip">
        <div className="flex items-center justify-between p-5 border-b border-white/10 shrink-0">
          <h3 className="font-display font-bold text-lg">📖 Правила игры</h3>
          <button onClick={() => setShowRules(false)} className="w-8 h-8 rounded-full glass flex items-center justify-center hover:bg-white/10 text-white/60 hover:text-white">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">
          <div className="space-y-3">
            {RULES.map((r, i) => (
              <p key={i} className="text-sm text-white/75 leading-relaxed">{r}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const rulesButton = (
    <button onClick={() => setShowRules(true)}
      className="w-full glass rounded-xl py-3 text-sm font-semibold hover:bg-white/10 transition-all mt-4">
      📖 Правила игры
    </button>
  );

  const header = (
    <div className="text-center mb-6 shrink-0">
      <div className="text-5xl mb-3">👑</div>
      <h1 className="font-display text-4xl sm:text-5xl font-black tracking-tight mb-2"
        style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        МАГНАТ
      </h1>
      <div className="flex items-center justify-center gap-2 mb-1">
        <p className="text-base text-white/50 font-medium">Бизнес-Империя</p>
        <span className="beta-badge">{APP_VERSION}</span>
      </div>
      <p className="text-xs text-white/30">Бета-версия. Возможны ошибки.</p>
    </div>
  );

  const errorBlock = error ? (
    <div className="bg-red-500/20 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-300 mb-3">⚠️ {error}</div>
  ) : null;

  // ===== MENU =====
  if (screen === 'menu') {
    return (
      <div className="min-h-screen min-h-dvh flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="w-full max-w-lg fade-up">
          {header}
          <div className="glass-strong rounded-2xl p-6 space-y-3">
            <h2 className="font-display text-lg font-bold text-center mb-2">Выберите режим</h2>
            <button onClick={() => setScreen('local')}
              className="w-full py-4 rounded-xl font-display font-bold text-base btn-glow text-black flex items-center justify-center gap-3"
              style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
              <span className="text-2xl">🎮</span>
              <div className="text-left"><div>Локальная игра</div><div className="text-xs font-normal opacity-70">На одном устройстве</div></div>
            </button>
            <button onClick={() => setScreen('online-choice')}
              className="w-full py-4 rounded-xl font-display font-bold text-base btn-glow text-white flex items-center justify-center gap-3"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
              <span className="text-2xl">🌐</span>
              <div className="text-left"><div>По сети</div><div className="text-xs font-normal opacity-70">Каждый со своего устройства</div></div>
            </button>
            {hasSave && (
              <button onClick={onContinue} className="w-full py-3.5 rounded-xl font-display font-bold text-sm glass hover:bg-white/10 transition-all">
                ▶️ Продолжить сохранённую игру
              </button>
            )}
            {hasOnlineSession && onReconnect && (
              <button onClick={onReconnect} disabled={reconnecting}
                className="w-full py-3.5 rounded-xl font-display font-bold text-sm glass hover:bg-white/10 transition-all border border-indigo-500/30 disabled:opacity-50">
                {reconnecting ? '⏳ Переподключение...' : '🔄 Вернуться в онлайн-игру'}
              </button>
            )}
          </div>
          {rulesButton}
        </div>
        {rulesModal}
      </div>
    );
  }

  // ===== LOCAL SETUP =====
  if (screen === 'local') {
    return (
      <div className="min-h-dvh flex flex-col overflow-y-auto" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="flex-1 flex flex-col items-center justify-center p-3 sm:p-4">
          <div className="w-full max-w-md fade-up">
            <div className="text-center mb-3 shrink-0">
              <div className="text-3xl mb-1">👑</div>
              <h1 className="font-display text-2xl sm:text-3xl font-black tracking-tight"
                style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                МАГНАТ
              </h1>
            </div>
            <div className="glass-strong rounded-2xl p-4 sm:p-5">
              <div className="flex items-center gap-3 mb-3">
                <button onClick={() => setScreen('menu')} className="text-white/50 hover:text-white text-lg">←</button>
                <h2 className="font-display text-base font-bold">🎮 Локальная игра</h2>
              </div>

              <div className="mb-3">
                <label className="text-xs text-white/60 mb-1.5 block">Количество игроков</label>
                <div className="flex gap-1.5">
                  {[2, 3, 4, 5, 6].map(n => (
                    <button key={n} onClick={() => setCount(n)}
                      className={`flex-1 py-2 rounded-lg font-display font-bold text-sm transition-all ${n === count ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/30' : 'glass hover:bg-white/10'}`}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-4">
                {Array.from({ length: count }).map((_, i) => (
                  <div key={i} className="flex items-center gap-1.5 glass rounded-lg px-2 py-2">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{ background: ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'][i] }}>
                      {['♛', '♜', '♝', '♞', '♚', '♟'][i]}
                    </div>
                    <input
                      className="flex-1 min-w-0 bg-transparent border-b border-white/10 px-1 py-1 text-sm outline-none focus:border-amber-500/50 transition-colors placeholder:text-white/25"
                      placeholder={`Игрок ${i + 1}`}
                      value={names[i]}
                      onChange={e => { const n = [...names]; n[i] = e.target.value; setNames(n); }}
                    />
                  </div>
                ))}
              </div>

              <button onClick={handleStartLocal}
                className="w-full py-3 rounded-xl font-display font-bold text-sm btn-glow text-black"
                style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
                🎮 Начать игру
              </button>
            </div>
            <button onClick={() => setShowRules(true)}
              className="w-full glass rounded-xl py-2.5 text-xs font-semibold hover:bg-white/10 transition-all mt-3">
              📖 Правила игры
            </button>
          </div>
        </div>
        {rulesModal}
      </div>
    );
  }

  // ===== ONLINE CHOICE =====
  if (screen === 'online-choice') {
    return (
      <div className="min-h-screen min-h-dvh flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="w-full max-w-lg fade-up">
          {header}
          <div className="glass-strong rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => setScreen('menu')} className="text-white/50 hover:text-white text-lg">←</button>
              <h2 className="font-display text-lg font-bold">🌐 Игра по сети</h2>
            </div>
            {errorBlock}
            <div>
              <label className="text-sm text-white/60 mb-2 block">Ваше имя</label>
              <input className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-base outline-none focus:border-indigo-500/50 transition-colors placeholder:text-white/25"
                placeholder="Введите ваше имя" value={myName} onChange={e => setMyName(e.target.value)} />
            </div>
            <button onClick={() => { setError(''); setScreen('create-room'); }}
              className="w-full py-4 rounded-xl font-display font-bold text-base btn-glow text-white flex items-center justify-center gap-3"
              style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>
              <span className="text-2xl">➕</span>
              <div className="text-left"><div>Создать комнату</div><div className="text-xs font-normal opacity-70">Пригласите друзей по коду</div></div>
            </button>
            <button onClick={() => { setError(''); setScreen('join-room'); }}
              className="w-full py-4 rounded-xl font-display font-bold text-base btn-glow text-white flex items-center justify-center gap-3"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)' }}>
              <span className="text-2xl">🔗</span>
              <div className="text-left"><div>Присоединиться</div><div className="text-xs font-normal opacity-70">Введите код комнаты</div></div>
            </button>
          </div>
          {rulesButton}
        </div>
        {rulesModal}
      </div>
    );
  }

  // ===== CREATE ROOM =====
  if (screen === 'create-room') {
    return (
      <div className="min-h-screen min-h-dvh flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="w-full max-w-lg fade-up">
          {header}
          <div className="glass-strong rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => setScreen('online-choice')} className="text-white/50 hover:text-white text-lg">←</button>
              <h2 className="font-display text-lg font-bold">➕ Создать комнату</h2>
            </div>
            {errorBlock}
            <div>
              <label className="text-sm text-white/60 mb-2 block">Максимум игроков</label>
              <div className="flex gap-2">
                {[2, 3, 4, 5, 6].map(n => (
                  <button key={n} onClick={() => setMaxPlayers(n)}
                    className={`flex-1 py-2.5 rounded-lg font-display font-bold text-base transition-all ${n === maxPlayers ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30' : 'glass hover:bg-white/10'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={handleCreateRoom} disabled={loading}
              className="w-full py-3.5 rounded-xl font-display font-bold text-base btn-glow text-black disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
              {loading ? '⏳ Создание...' : '🚀 Создать'}
            </button>
          </div>
        </div>
        {rulesModal}
      </div>
    );
  }

  // ===== JOIN ROOM =====
  if (screen === 'join-room') {
    return (
      <div className="min-h-screen min-h-dvh flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="w-full max-w-lg fade-up">
          {header}
          <div className="glass-strong rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => setScreen('online-choice')} className="text-white/50 hover:text-white text-lg">←</button>
              <h2 className="font-display text-lg font-bold">🔗 Присоединиться</h2>
            </div>
            {errorBlock}
            <div>
              <label className="text-sm text-white/60 mb-2 block">Код комнаты</label>
              <input className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-center text-2xl font-display font-bold tracking-[0.3em] uppercase outline-none focus:border-indigo-500/50 transition-colors placeholder:text-white/20 placeholder:tracking-normal placeholder:text-base placeholder:font-normal"
                placeholder="Введите код" value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase().slice(0, 5))} maxLength={5} />
            </div>
            <button onClick={handleJoinRoom} disabled={loading || roomCode.length < 5}
              className="w-full py-3.5 rounded-xl font-display font-bold text-base btn-glow text-black disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
              {loading ? '⏳ Подключение...' : '🎮 Войти'}
            </button>
          </div>
        </div>
        {rulesModal}
      </div>
    );
  }

  // ===== LOBBY =====
  if (screen === 'lobby' && room) {
    return (
      <div className="min-h-screen min-h-dvh flex flex-col items-center justify-start sm:justify-center overflow-y-auto p-4 py-6" style={{ background: 'linear-gradient(135deg, #111114 0%, #1a1a22 50%, #111118 100%)' }}>
        <div className="w-full max-w-lg fade-up">
          {header}
          <div className="glass-strong rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-display text-lg font-bold">🏠 Комната</h2>
              <button onClick={handleLeaveRoom} className="text-sm text-red-400 hover:text-red-300">Покинуть</button>
            </div>

            <div className="text-center py-4 glass rounded-xl">
              <p className="text-xs text-white/50 mb-2">Код комнаты — отправьте друзьям</p>
              <div className="font-display text-4xl font-black tracking-[0.4em] text-amber-400">{room.code}</div>
            </div>

            <div>
              <p className="text-sm text-white/60 mb-2">Игроки ({room.playerSlots.length}/{room.maxPlayers})</p>
              <div className="space-y-2">
                {room.playerSlots.map((slot, i) => {
                  const isMe = slot.id === myPlayerId;
                  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
                  const tokens = ['♛', '♜', '♝', '♞', '♚', '♟'];
                  return (
                    <div key={slot.id} className={`flex items-center gap-3 p-3 rounded-xl transition-all ${isMe ? 'ring-1 ring-amber-400/50' : ''}`}
                      style={{ background: isMe ? `${colors[i]}20` : 'rgba(255,255,255,0.03)' }}>
                      <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
                        style={{ background: colors[i] }}>{tokens[i]}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {slot.name}{isMe && <span className="text-xs text-white/40 ml-2">(вы)</span>}
                          {slot.id === room.hostId && <span className="text-xs text-amber-400 ml-2">👑 хост</span>}
                        </p>
                        <p className={`text-xs ${slot.ready ? 'text-green-400' : 'text-white/40'}`}>{slot.ready ? '✅ Готов' : '⏳ Не готов'}</p>
                      </div>
                    </div>
                  );
                })}
                {Array.from({ length: room.maxPlayers - room.playerSlots.length }).map((_, i) => (
                  <div key={`empty-${i}`} className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-white/10">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg bg-white/5 text-white/20">?</div>
                    <p className="text-sm text-white/30">Ожидание игрока...</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {!isHost && (
                <button onClick={handleToggleReady}
                  className={`w-full py-3.5 rounded-xl font-display font-bold text-base btn-glow ${room.playerSlots.find(s => s.id === myPlayerId)?.ready ? 'bg-white/10 text-white' : 'text-black'}`}
                  style={room.playerSlots.find(s => s.id === myPlayerId)?.ready ? {} : { background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>
                  {room.playerSlots.find(s => s.id === myPlayerId)?.ready ? '⏳ Ожидание хоста...' : '✅ Готов!'}
                </button>
              )}
              {isHost && (
                <>
                  <button onClick={handleToggleReady}
                    className={`w-full py-3 rounded-xl font-bold text-sm ${room.playerSlots.find(s => s.id === myPlayerId)?.ready ? 'glass text-green-400' : 'glass text-white/60'}`}>
                    {room.playerSlots.find(s => s.id === myPlayerId)?.ready ? '✅ Вы готовы' : 'Нажмите, чтобы отметить готовность'}
                  </button>
                  <button disabled={!allReady}
                    onClick={() => {
                      const playerNames = room.playerSlots.map(s => s.name);
                      const myIdx = room.playerSlots.findIndex(s => s.id === myPlayerId);
                      localStorage.setItem('magnat_online_slot', String(myIdx));
                      const config: OnlineConfig = { roomCode, myPlayerId, isHost: true };
                      onStartOnline(playerNames, config);
                    }}
                    className="w-full py-3.5 rounded-xl font-display font-bold text-base btn-glow text-black disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg, #ffd700, #ffaa00)' }}>
                    {allReady ? '🚀 Начать игру!' : `⏳ Ожидание (${room.playerSlots.filter(s => s.ready).length}/${room.playerSlots.length})`}
                  </button>
                </>
              )}
            </div>

            <div className="glass rounded-xl p-3 text-xs text-white/40 leading-relaxed">
              <p>💡 Отправьте код <strong className="text-amber-400">{room.code}</strong> вашим друзьям.</p>
              <p className="mt-1">Они должны выбрать «По сети» → «Присоединиться» и ввести код.</p>
              {isHost && <p className="mt-1">Когда все будут готовы — нажмите «Начать игру».</p>}
            </div>
          </div>
          {rulesButton}
        </div>
        {rulesModal}
      </div>
    );
  }

  return null;
}
