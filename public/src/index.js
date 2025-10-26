const { h, render } = preact;
const { useState, useEffect, useRef } = preactHooks;
const html = htm.bind(h);



const INITIAL_CASH = 1200;

const ws = new WebSocket(`wss://${window.location.host}`);
let messageQueue = [];

ws.onopen = () => {
  messageQueue.forEach(msg => ws.send(msg));
  messageQueue = [];
};

const sendWsMessage = (type, payload) => {
  const message = JSON.stringify({ type, payload });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  } else {
    messageQueue.push(message);
  }
};

const App = () => {
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', handlePopState);

    const handleDisconnect = () => {
      //alert("Connection lost! Returning to homepage.");
      window.location.href = '/';
    };
    ws.addEventListener('close', handleDisconnect);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      ws.removeEventListener('close', handleDisconnect);
    };
  }, []);

  const navigate = (path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  };

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'gameCreated') {
      navigate(`/game/${data.gameId}/player/${encodeURIComponent(window.currentPlayerName)}`);
    }
    if (data.type === 'playAudio') {
      const audio = document.getElementById(data.sound + 'Sound');
      if (audio) audio.play().catch(e => console.error('Failed to play sound:', e));
    }
    if (data.type === 'gameDeleted') {
      navigate('/');
    }
  });

  let page;
  const gamePlayerRoute = /^\/game\/([a-zA-Z0-9-]+)\/player\/(.+)$/;
  const gameRoute = /^\/game\/([a-zA-Z0-9-]+)$/;
  const homeRoute = /^\/$/;

  const gamePlayerMatch = route.match(gamePlayerRoute);
  const gameMatch = route.match(gameRoute);

  if (gamePlayerMatch) {
    const id = gamePlayerMatch[1];
    const playerName = decodeURIComponent(gamePlayerMatch[2]);
    page = html`<${PlayerPage} gameId=${id} playerName=${playerName} navigate=${navigate} />`;
  } else if (gameMatch) {
    const id = gameMatch[1];
    page = html`<${GamePage} gameId=${id} navigate=${navigate} />`;
  } else if (homeRoute.test(route)) {
    page = html`<${HomePage} navigate=${navigate} />`;
  } else {
    // 404 - redirect to home
    navigate('/');
    page = null; // Render nothing while redirecting
  }

  return html`
    <div style=\"background:white; padding: 20px;\">
      <a href="/" onClick=${(e) => { e.preventDefault(); navigate('/'); }} class="home-shortcut">🏠</a>
      ${page}
    </div>
  `;
};

const HomePage = ({ navigate }) => {
  const [games, setGames] = useState([]);

  useEffect(() => {
    sendWsMessage('GET_GAMES');
    const listener = (event) => {
      const data = JSON.parse(event.data);
      if (data.gamesList) {
        setGames(data.gamesList);
      }
    };
    ws.addEventListener('message', listener);
    return () => ws.removeEventListener('message', listener);
  }, []);

  const createGame = (e) => {
    e.preventDefault();
    const playerName = e.target.elements.playerName.value;
    window.currentPlayerName = playerName;
    sendWsMessage('CREATE_GAME', { playerName });
  };


  return html`
    <div style=\"height: 100%;\ background:white; padding: 20px;">
      <h1>Shamo</h1>
      <h2>Create a New Game</h2>
      <form onSubmit=${createGame}>
      <input name="playerName" placeholder="Your Name" required />
      <button type="submit">Create Game</button>
      </form>
      <h2>Open Games</h2>
      <div>
        ${(!games || !Array.isArray(games) || games.length === 0)
          ? html`<p>No open games. Start one!</p>`
          : games.map(game => html`
          <div key=${game.id} style="position: relative; border: 1px solid #000000ff; padding: 10px; margin-bottom: 10px;shadow: 0 0 10px rgba(0, 0, 0, 0.1); border-radius: 20px; background: white; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);">
          <p>Game ${game.id} (${game.players}/${game.maxPlayers})</p>
          <button onClick=${() => navigate(`/game/${game.id}`)}>View</button>
            <button onClick=${() => sendWsMessage('DELETE_GAME', { gameId: game.id })} style="position: absolute; top: 0; right: 0; background: red; color: white; border: none; cursor: pointer;">X</button>
            </div>
        `)}
      </div>
    </div>
  `;
};

const GamePage = ({ gameId, navigate }) => {
  const [gameState, setGameState] = useState(null);
  const [joinError, setJoinError] = useState('');
  const [attemptedName, setAttemptedName] = useState('');
  const [emojis, setEmojis] = useState({});
  const loadingRef = useRef(true);
  const prevGameState = useRef(null);
  const animationTimeoutRef = useRef(null);
  const [displayedBank, setDisplayedBank] = useState(0);
  const [playerName, setPlayerName] = useState('');

  useEffect(() => {
    if (gameState) {
      const player = gameState.players.find(p => p.name === window.currentPlayerName);
      if (player) {
        setPlayerName(player.name);
      }
    }
  }, [gameState]);

  useEffect(() => {
    sendWsMessage('GET_GAME_STATE', { gameId });
    const timeout = setTimeout(() => {
      if (loadingRef.current) navigate('/');
    }, 2000);
    const listener = (event) => {
      const data = JSON.parse(event.data);
      if (data.gameState && data.gameState.id === gameId) {
        console.log('Game state update received for game', gameId);
        console.log('Old players:', gameState ? gameState.players.length : 'none', 'New players:', data.gameState.players.length);

        // Play sounds for accusation results
        if (data.gameState.state === 'final_processing' && data.gameState.accusationResult) {
          const soundId = data.gameState.accusationResult.guilty ? 'jailSound' : 'arrestSound';
          const audio = document.getElementById(soundId);
          if (audio) {
            console.log('Playing', soundId, 'for accusation result');
            audio.play().catch(e => console.error('Failed to play accusation sound:', e));
          }
        }

        // Handle animations done
        if (data.gameState.state === 'processing' && data.gameState.pendingActions && data.gameState.pendingActions.length > 0) {
          if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
          const num = data.gameState.pendingActions.length;
          const duration = (num - 1) * 0.5 + 2 + 5; // seconds, plus 5s pause
          animationTimeoutRef.current = setTimeout(() => {
            sendWsMessage('ANIMATIONS_DONE', { gameId });
          }, duration * 1000);
        } else if (data.gameState.state === 'processing' && (!data.gameState.pendingActions || data.gameState.pendingActions.length === 0)) {
          if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
          sendWsMessage('ANIMATIONS_DONE', { gameId });
        } else if (data.gameState.state !== 'processing') {
          if (animationTimeoutRef.current) {
            clearTimeout(animationTimeoutRef.current);
            animationTimeoutRef.current = null;
          }
        }

        setGameState(data.gameState);
        loadingRef.current = false;
        if (attemptedName && data.gameState.players && Array.isArray(data.gameState.players) && data.gameState.players.some(p => p.name === attemptedName)) {
          navigate(`/game/${gameId}/player/${encodeURIComponent(attemptedName)}`);
          setAttemptedName('');
        }
      } else if (data.type === 'emoji') {
        const { playerName: pName, emoji } = data;
        setEmojis(prev => ({ ...prev, [pName]: emoji }));
        setTimeout(() => {
          setEmojis(prev => {
            const newEmojis = { ...prev };
            delete newEmojis[pName];
            return newEmojis;
          });
        }, 3000);
      } else if (data.type === 'error') {
        setJoinError(data.message);
        setAttemptedName('');
      }
    };
    ws.addEventListener('message', listener);
    return () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
    };
  }, [gameId, navigate, attemptedName]);

  const joinGame = (e) => {
    e.preventDefault();
    const name = e.target.elements.playerName.value;
    setJoinError('');
    setAttemptedName(name);
    sendWsMessage('JOIN_GAME', { gameId, playerName: name });
  };

  const startGame = () => {
    sendWsMessage('START_GAME', { gameId });
  };

  if (!gameState) return html`<p>Loading game...</p>`;


  const formatCurrency = (amount) => amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const playersList = gameState.players && Array.isArray(gameState.players) ? h('ul', { style: { fontSize: '1.5rem' } }, gameState.players.map(p => {
    const showBalance = gameState.temporaryShowBalance && gameState.temporaryShowBalance.playerName === p.name;
    let styleObj = {};
    if (p.accusationSent || (gameState.state == 'inprogress' && p.actionTaken)) {
      styleObj.backgroundColor = 'rgba(0, 255, 0, 0.1)';
    }
    if (p.bankrupt) {
      styleObj.textDecoration = 'line-through';
      styleObj.color = 'red';
    } else if (p.jailed) {
      styleObj.color = 'grey';
    }
    let text = (p.jailed ? '🏠 ' : '') + p.name + (p.jailed ? ' 🏠' : '') + (showBalance ? ' - ' + formatCurrency(gameState.temporaryShowBalance.cash) : '');
    if (emojis[p.name]) {
      text += ' ' + emojis[p.name];
      styleObj.fontSize = '4em';
    }
    if (gameState.accusationResult && gameState.accusationResult.accused === p.name) {
      if (gameState.accusationResult.guilty) {
        styleObj.color = 'red';
        styleObj.fontWeight = 'bold';
        text = '🔥 ' + text + ' 👹';
      } else {
        styleObj.color = 'purple';
        styleObj.fontWeight = 'bold';
        text = '👼 ' + text + ' 👼';
      }
    }
    return h('li', { style: styleObj }, text);
  })) : h('ul', { style: { fontSize: '1.5rem' } });

  const pendingBars = gameState.pendingActions && Array.isArray(gameState.pendingActions) ? (() => {
    const num = gameState.pendingActions.length;
    if (num === 0) return [h('h3', { style: { textAlign: 'center' } }, 'No transactions')];
    const maxAbs = Math.max(...gameState.pendingActions.map(pa => Math.abs(pa.amount)));
    if (maxAbs === 0) return [h('h3', { style: { textAlign: 'center' } }, 'No transactions')];
    return [
      h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${num}, 10px)`, gridTemplateRows: '10px 10px', width: `${num * 10}px`, margin: '0 auto', background: 'transparent', borderRadius: '0', padding: '0', boxShadow: 'none' } },
        gameState.pendingActions.map((pa, i) => {
          const absHeight = (Math.abs(pa.amount) / maxAbs) * 60;
          const isPositive = pa.amount >= 0;
          const height = absHeight + 'px';
          const background = isPositive ? 'green' : 'red';
          return h('div', { style: { gridColumn: i + 1, gridRow: isPositive ? 2 : 1, position: 'relative', height: '60px', width: '10px', background: 'transparent', borderRadius: '0', padding: '0', boxShadow: 'none' } }, [
            h('div', { style: { width: '10px', height: '0', background: background, '--bar-height': height, position: 'absolute', [isPositive ? 'bottom' : 'top']: '0', animationDelay: `${i * 2.1}s`, borderRadius: '0', boxShadow: 'none' , overflow: 'hidden'}, class: 'bar-grow' })
          ]);
        })
      )
    ];
  })() : [];

  const gameContent = (() => {
    switch (gameState.state) {
      case 'waiting':
        if (playerName) return h('div', {}, [
          h('h2', {}, 'Waiting for players to start'),
          h('p', {}, (gameState.maxPlayers - gameState.players.length) + ' more player(s) can join.'),
          h('button', { onClick: startGame }, 'Start Game')
        ]);
        if (gameState.players.length < gameState.maxPlayers) return h('div', {}, [
          h('h2', {}, 'Join Game'),
          h('form', { onSubmit: joinGame }, [
            h('input', { name: 'playerName', placeholder: 'Your Name', required: true }),
            h('button', { type: 'submit' }, 'Join'),
            joinError && h('p', { style: { color: 'red' } }, joinError)
          ])
        ]);
        break;
      case 'accusing':
        return h('div', {}, [
          h('div', { style: { height: '200px', width: '500px', border: '1px solid #ccc', position: 'relative', margin: '20px auto', background: 'transparent', backdropFilter: 'none', borderRadius: '0', padding: '0', boxShadow: 'none' } }, [
            h('div', { style: { position: 'absolute', top: '60px', left: 0, right: 0, } }),
            ...pendingBars
          ])
        ]);
  case 'processing':
  return h('div', {}, [
  h('div', { style: { height: '200px', width: '500px', border: '1px solid #ccc', position: 'relative', margin: '20px auto', background: 'transparent', backdropFilter: 'none', borderRadius: '0', padding: '0', boxShadow: 'none' } }, [
  h('div', { style: { position: 'absolute', top: '60px', left: 0, right: 0,  } }),
  ...pendingBars
  ])
  ]);
  case 'final_processing':
    return h('div', {}, [
      h('h2', {}, 'Accusation Results'),
      gameState.accusationResult && h('div', { style: { textAlign: 'center', margin: '20px 0', fontSize: '2em', fontWeight: 'bold' } }, [
        gameState.accusationResult.guilty ?
          h('div', { style: { color: 'red' } }, `🔥 ${gameState.accusationResult.accused} was correctly accused! They pay out $${gameState.accusationResult.amount} 👹`) :
          h('div', { style: { color: 'green' } }, `👼 ${gameState.accusationResult.accused} was falsely accused! They receive $${gameState.accusationResult.amount} 👼`)
      ]),
      h('p', {}, 'Finalizing round...')
    ]);
  case 'inprogress':
    return h('div', {}, [
      h('h2', {}, 'Round ' + gameState.round),
        h('div', { style: { height: '200px', width: '500px', border: '1px solid #ccc', position: 'relative', margin: '20px auto', background: 'transparent', backdropFilter: 'none', borderRadius: '0', padding: '0', boxShadow: 'none' } }, [
          h('div', { style: { position: 'absolute', top: '60px', left: 0, right: 0, } }),
            ...pendingBars
          ]),
          h('p', {}, 'Players, please submit your transactions!'),
          h('h3', {}, 'Transactions: ' + gameState.actionsReceived + ' / ' + (gameState.players && Array.isArray(gameState.players) ? gameState.players.filter(p => !p.jailed && !p.bankrupt).length : 0))
        ]);
      default:
        return '';
    }
  })();

  return h('div', { style: { height: '100%' } }, [
    h('h2', {}, 'Bank: ' + formatCurrency(displayedBank)),
    gameContent,
    h('h3', {}, 'Players:'),
    playersList
  ]);
};



const PlayerPage = ({ gameId, playerName, navigate }) => {
  const [pressed, setPressed] = useState(false);
  const [round, setRound] = useState(1);
  const [gameState, setGameState] = useState(null);
  const [sliderValue, setSliderValue] = useState(0);
  const [accusationSent, setAccusationSent] = useState(false);

  useEffect(() => {
    sendWsMessage('GET_GAME_STATE', { gameId });
    const listener = (event) => {
      const data = JSON.parse(event.data);
      if (data.gameState && data.gameState.id === gameId) {
      setGameState(data.gameState);
      if (data.gameState.round > round) {
      setPressed(false);
      setAccusationSent(false);
      setSliderValue(0);
        setRound(data.gameState.round);
          }
      }
    };
    ws.addEventListener('message', listener);
    return () => ws.removeEventListener('message', listener);
  }, [gameId, round]);

  const handleAction = () => {
    if (!pressed && gameState && gameState.state === 'inprogress') {
      sendWsMessage('PLAYER_ACTION', { gameId, playerName, amount: sliderValue });
      setPressed(true);
    }
  };

  const handleMoney = () => {
    sendWsMessage('SHOW_BALANCE', { gameId, playerName });
  };

  const handleSmiling = () => {
    sendWsMessage('EMOJI', { emoji: '😊' });
  };

  const handleCrying = () => {
    sendWsMessage('EMOJI', { emoji: '😢' });
  };

  const sendAccuse = (accused) => {
    sendWsMessage('ACCUSE', { gameId, playerName, accused });
    setAccusationSent(true);
  };

  const buttonClass = pressed ? `button-pressed-${round % 5 + 1}` : '';

  if (!gameState) return html`<p>Loading...</p>`;

  const player = gameState.players && Array.isArray(gameState.players) ? gameState.players.find(p => p.name === playerName) : null;
  const cash = player ? player.cash : 0;
  const bankrupt = player ? player.bankrupt : false;
  const jailed = player ? player.jailed : false;

  const formatCurrency = (amount) => amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  if (bankrupt) {
    return html`<div style=\"height: 100%;  display: flex; align-items: center; justify-content: center;\"><p style=\"font-size: 2rem; color: red;\">Bankrupt</p></div>`;
  }

  return html`
  <div style="display: flex; flex-direction: column; height: 100%; background: white; padding: 20px;">
  <div style="color: green; font-size: 2rem; text-align: left; padding: 10px;">${formatCurrency(cash)}</div>
  <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
  ${(() => {
    switch (gameState.state) {
      case 'waiting':
        if (playerName) return h('div', {}, [
          h('h2', {}, 'Waiting for players to start'),
          h('button', { onClick: () => sendWsMessage('START_GAME', { gameId: gameState.id }) }, 'Start Game')
        ]);
      case 'accusing':
        if (accusationSent) return html`<p>Waiting for other accusations...</p>`;
        const _player = gameState.players.find(p => p.name === playerName);
        const _netGain = _player ? _player.netGain : 0;

        return html`
          <div style="text-align: center;">
          <div style="color: ${_netGain < 0 ? 'red' : _netGain > 0 ? 'green' : 'grey'}; font-size: 1.5rem; margin-bottom: 10px;">Net Gain: ${formatCurrency(_netGain)}</div>
          <h2>Accuse a player</h2>
        ${gameState.players.filter(p => !p.jailed && !p.bankrupt).map(p => html`<button onClick=${() => sendAccuse(p.name)} style="margin: 5px;">Accuse ${p.name}</button>`)}
      <button onClick=${() => sendAccuse(null)} style="margin: 5px;">Pass</button>
      </div>
    `;
    case 'processing':
      return html`<p>Processing accusations and actions...</p>`;
    case 'inprogress':
    const player = gameState.players.find(p => p.name === playerName);
    const netGain = player ? player.netGain : 0;
    return html`
    <div style="text-align: center;">
    <div style="color: ${sliderValue < 0 ? 'red' : sliderValue > 0 ? 'green' : 'grey'}; font-size: 2rem; margin-bottom: 10px;">${formatCurrency(sliderValue)}</div>
      <div style="color: ${netGain < 0 ? 'red' : netGain > 0 ? 'green' : 'grey'}; font-size: 1.5rem; margin-bottom: 10px;">Net Gain: ${formatCurrency(netGain)}</div>
        <input type="range" min="-1200" max="${cash}" step="${10 * (gameState.players && Array.isArray(gameState.players) ? gameState.players.filter(p => !p.jailed && !p.bankrupt).length : 1)}" value="${sliderValue}" onInput=${(e) => setSliderValue(parseInt(e.target.value))} style="width: 80%; margin-bottom: 10px;" />
            ${pressed ? html`<div class="spinner"></div>` : html`<button class=${buttonClass} onClick=${handleAction}>Submit</button>`}
          </div>
        `;
      default:
      if (jailed) return html`<h1 style="text-align: center; color: grey;">Jailed</h1>`;
      return '';
    }
  })()}
  </div>
  <div style="display: flex; margin: 20px;">
  <button onClick=${handleMoney} style="flex: 1; font-size: 2rem; margin: 0 5px;">💰</button>

      </div>
    </div>
  `;
};


render(html`<${App} />`, document.getElementById('app'));
