import { useState, useCallback, useEffect } from 'react';
import { GameState, OnlineConfig, GameMode } from './types';
import { createInitialState } from './logic';
import { startOnlineGame, listenToRoom } from './firebase';
import WelcomeScreen from './WelcomeScreen';
import GameScreen from './GameScreen';

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [gameMode, setGameMode] = useState<GameMode>('local');
  const [onlineConfig, setOnlineConfig] = useState<OnlineConfig | undefined>(undefined);
  const [reconnecting, setReconnecting] = useState(false);

  const hasSave = !!localStorage.getItem('magnat_save');
  const hasOnlineSession = !!localStorage.getItem('magnat_online_session');

  // Try to reconnect to online session on mount
  useEffect(() => {
    if (hasOnlineSession && !gameState) {
      // Don't auto-reconnect, show button instead
    }
  }, []);

  const handleStartLocal = useCallback((names: string[]) => {
    const state = createInitialState(names);
    setGameMode('local');
    setOnlineConfig(undefined);
    setGameState(state);
  }, []);

  const handleStartOnline = useCallback(async (names: string[], config: OnlineConfig) => {
    const state = createInitialState(names);
    setGameMode('online');
    setOnlineConfig(config);
    setGameState(state);

    if (config.isHost) {
      try {
        await startOnlineGame(config.roomCode, state);
      } catch (e) {
        console.error('Failed to start online game:', e);
      }
    }
  }, []);

  const handleContinue = useCallback(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('magnat_save')!);
      setGameMode('local');
      setOnlineConfig(undefined);
      setGameState(saved);
    } catch { /* ignore */ }
  }, []);

  const handleReconnect = useCallback(async () => {
    try {
      const session = JSON.parse(localStorage.getItem('magnat_online_session')!);
      if (!session || !session.roomCode) return;

      setReconnecting(true);

      // Listen for current room state
      const unsub = listenToRoom(session.roomCode, (room) => {
        unsub(); // Stop listening after first snapshot
        setReconnecting(false);

        if (room && room.state && room.phase === 'playing') {
          const config: OnlineConfig = {
            roomCode: session.roomCode,
            myPlayerId: session.myPlayerId,
            isHost: session.isHost,
          };
          // Restore slot index
          if (session.mySlot !== undefined) {
            localStorage.setItem('magnat_online_slot', String(session.mySlot));
          }
          setGameMode('online');
          setOnlineConfig(config);
          setGameState(room.state);
        } else {
          // Room doesn't exist or game is over
          localStorage.removeItem('magnat_online_session');
          alert('Комната больше не существует или игра завершена.');
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        setReconnecting(false);
      }, 5000);
    } catch {
      setReconnecting(false);
      localStorage.removeItem('magnat_online_session');
    }
  }, []);

  const handleExit = useCallback(() => {
    setGameState(null);
    setOnlineConfig(undefined);
  }, []);

  if (!gameState) {
    return (
      <WelcomeScreen
        onStartLocal={handleStartLocal}
        onStartOnline={handleStartOnline}
        hasSave={hasSave}
        onContinue={handleContinue}
        hasOnlineSession={hasOnlineSession}
        onReconnect={handleReconnect}
        reconnecting={reconnecting}
      />
    );
  }

  return (
    <GameScreen
      initialState={gameState}
      onExit={handleExit}
      mode={gameMode}
      onlineConfig={onlineConfig}
    />
  );
}
