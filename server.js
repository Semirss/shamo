const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all routes to support SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory storage for games
let games = {};

// Broadcasts the list of open games to every client
const broadcastOpenGames = () => {
  const openGames = Object.values(games)
    .filter(g => g.state === 'waiting' || g.state === 'inprogress')
    .map(g => ({ id: g.id, players: g.players.length, maxPlayers: g.maxPlayers }));

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ gamesList: openGames }));
    }
  });
};

// Broadcasts a message to all clients
const broadcastMessage = (msg) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
};

// Returns a version of the game state safe to send to clients
const getSanitizedGame = (gameId) => {
  const game = games[gameId];
  if (!game) return null;
  const sanitizedPlayers = game.players && Array.isArray(game.players) ? game.players.map(p => ({ name: p.name, cash: p.cash, bankrupt: p.bankrupt, jailed: p.jailed, actionTaken: p.actionTaken, netGain: p.cash - (p.roundStartCash || 1200), accusationSent: p.accusationSent })) : [];
  return {
    id: game.id,
    maxPlayers: game.maxPlayers,
    players: sanitizedPlayers,
    state: game.state,
    round: game.round,
    actionsReceived: game.actionsReceived,
    bank: game.bank,
    temporaryShowBalance: game.temporaryShowBalance,
    pendingActions: game.pendingActions && Array.isArray(game.pendingActions) ? game.pendingActions : null,
    accusationResult: game.accusationResult,
  };
};

// Broadcasts the current game state to all clients
const broadcastGameState = (gameId) => {
  const sanitizedGame = getSanitizedGame(gameId);
  if (sanitizedGame) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ gameState: sanitizedGame }));
      }
    });
  }
};

wss.on('connection', ws => {
  // Send the initial list of games on connection
  ws.on('open', () => broadcastOpenGames());

  ws.on('message', message => {
    const data = JSON.parse(message);
    const { type, payload } = data;

    switch (type) {
      case 'CREATE_GAME': {
        const gameId = uuidv4().substring(0, 5);
        const { playerName } = payload;
        games[gameId] = {
          id: gameId,
          maxPlayers: 10,
          players: [],
          state: 'waiting',
          round: 1,
          actionsReceived: 0,
          bank: 0,
          accusationsReceived: 0,
          accusationVotes: {}
        };
        // First player, name is unique
        games[gameId].players.push({ name: playerName, ws, actionTaken: false, cash: 1200, bankrupt: false, jailed: false });
        ws.gameId = gameId;

        ws.send(JSON.stringify({ type: 'gameCreated', gameId }));
        broadcastGameState(gameId);
        broadcastOpenGames(); // Update everyone
        break;
      }
      case 'JOIN_GAME': {
        const { gameId, playerName } = payload;
        const game = games[gameId];
        if (game && game.state === 'waiting' && !game.players.some(p => p.name === playerName)) {
          game.players.push({ name: playerName, ws, actionTaken: false, cash: 1200, bankrupt: false, jailed: false });
          ws.gameId = gameId;
          if (game.players.length === game.maxPlayers) {
            game.state = 'inprogress';
          }
          broadcastGameState(gameId);
          broadcastOpenGames(); // Update everyone
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot join game.' }));
        }
        break;
      }
      case 'START_GAME': {
        const { gameId } = payload;
        if (games[gameId] && games[gameId].players.length >= 2) {
          games[gameId].state = 'inprogress';
          broadcastGameState(gameId);
          broadcastOpenGames(); // Update everyone
        }
        break;
      }
      case 'PLAYER_ACTION': {
        const { gameId, playerName, amount } = payload;
        const game = games[gameId];
        if (game && game.state === 'inprogress') {
          // Find the player and mark that they have performed an action
          const player = game.players.find(p => p.name === playerName);
          if (player && !player.jailed && !player.bankrupt && !player.actionTaken) {
            if (!player.ws) {
              player.ws = ws;
              ws.gameId = gameId;
            }
            player.actionTaken = true;
            player.pendingAmount = amount;
            game.actionsReceived++;
            broadcastGameState(gameId);

            const activeCount = game.players.filter(p => !p.jailed && !p.bankrupt && p.ws).length;
            if (game.actionsReceived >= activeCount) {
            // Set round start cash before updating
            game.players.forEach(p => p.roundStartCash = p.cash);
            // Update balances with transactions
            const positives = game.players.filter(p => p.pendingAmount > 0).sort((a, b) => a.pendingAmount - b.pendingAmount);
            for (const p of positives) {
              p.cash -= p.pendingAmount;
              game.bank += p.pendingAmount;
            }
              const negatives = game.players.filter(p => p.pendingAmount < 0).sort((a, b) => a.pendingAmount - b.pendingAmount);
              for (const p of negatives) {
                const amount = p.pendingAmount;
                const absAmount = Math.abs(amount);
                const tempBank = game.bank + amount;
                if (tempBank >= 0) {
                  p.cash -= amount;
                  game.bank = tempBank;
                } else {
                  const charge = Math.min(absAmount, p.cash);
                  p.cash -= charge;
                  game.bank += charge;
                  p.jailed = true;
                  if (p.cash == 0) {
                    p.bankrupt = true;
                  }
                }
              }
              // Divide bank equally among unjailed and non-bankrupt players
              const activePlayers = game.players.filter(p => !p.jailed && !p.bankrupt);
              if (activePlayers.length > 0) {
                const share = Math.floor(game.bank / activePlayers.length);
                //activePlayers.forEach(p => p.cash += share*2);
                //game.bank = 0;
              }
              // Unjail all players for the next round
              game.players.forEach(p => p.jailed = false);
              game.pendingActions = [...positives, ...negatives].map(p => ({ name: p.name, amount: p.pendingAmount }));
              game.state = 'processing';
              broadcastGameState(gameId);
            }
          }
        }
        break;
      }
      case 'EMOJI': {
        const { emoji } = payload;
        const game = games[ws.gameId];
        const player = game ? game.players.find(p => p.ws === ws) : null;
        const playerName = player ? player.name : '';
        // Broadcast to all clients in the game
        wss.clients.forEach(client => {
          if (client.gameId === ws.gameId) {
            client.send(JSON.stringify({ type: 'emoji', playerName, emoji }));
          }
        });
        break;
      }
      case 'ACCUSE': {
        const { gameId, playerName, accused } = payload;
        const game = games[gameId];
        if (game && game.state === 'accusing') {
          const player = game.players.find(p => p.name === playerName);
          if (player && !player.jailed && !player.bankrupt && !player.accusationSent) {
            if (!player.ws) {
              player.ws = ws;
              ws.gameId = gameId;
            }
            player.accusationSent = true;
            game.accusationVotes[accused || false] = (game.accusationVotes[accused || false] || 0) + 1;
            game.accusationsReceived++;
            const activeCount = game.players.filter(p => !p.jailed && !p.bankrupt && p.ws).length;
            if (game.accusationsReceived >= activeCount) {
              // process accusation
              const votes = Object.entries(game.accusationVotes);
              let accusedPlayer = null;
              const passes = activeCount - votes.reduce((sum, [, count]) => sum + count, 0);
              if (passes === activeCount || (votes.length > 1 && votes[0][1] === votes[1][1])) {
                // Everyone passed or tie, skip accusation UI
                game.state = 'inprogress';
                broadcastGameState(gameId);
              } else if (votes.length > 0) {
                votes.sort((a, b) => b[1] - a[1]);
                const maxVotes = votes[0][1];
                const secondVotes = votes[1]?.[1] || 0;
                if (maxVotes > secondVotes && votes[0][0]) {
                  const accusedName = votes[0][0];
                  accusedPlayer = game.players.find(p => p.name === accusedName);
                  if (accusedPlayer && !accusedPlayer.jailed && !accusedPlayer.bankrupt) {
                    const amount = accusedPlayer.pendingAmount;
                    const activePlayers = game.players.filter(p => !p.jailed && !p.bankrupt);
                    const others = activePlayers.filter(p => p !== accusedPlayer);
                    let totalAmount = 0;
                    if (amount < 0) {
                      // stole
                      const payout = -amount;
                      totalAmount = payout * others.length;
                      const actualPayout = Math.min(accusedPlayer.cash, totalAmount);
                      accusedPlayer.cash -= actualPayout;
                      const share = actualPayout / others.length;
                      others.forEach(p => p.cash += share);
                      if (actualPayout < totalAmount) {
                        accusedPlayer.bankrupt = true;
                      }
                      game.accusationResult = { accused: accusedName, guilty: true, amount: totalAmount };
                    } else {
                      // innocent
                      const tax = Math.abs(amount);
                      console.log('Amount:', amount, tax)
                      others.forEach(p => {
                        if (p.cash >= tax) {
                          p.cash -= tax;
                          totalAmount += tax;
                          accusedPlayer.cash += tax;
                        } else {
                          totalAmount += p.cash;
                          accusedPlayer.cash += p.cash;
                          p.cash = 0;
                          p.bankrupt = true;
                        }
                      });
                      game.accusationResult = { accused: accusedName, guilty: false, amount: totalAmount };
                    }
                  }
                }
              }
              // Increment round and reset
              game.round++;
              game.actionsReceived = 0;
              game.players.forEach(p => {
                p.actionTaken = false;
                delete p.pendingAmount;
                delete p.accusationSent;
              });
              // proceed to final processing
              game.state = 'final_processing';
              broadcastGameState(gameId);
              setTimeout(() => {
                delete game.accusationResult;
                game.state = 'inprogress';
                broadcastGameState(gameId);
              }, 5000);
            }
          }
        }
        break;
      }
      case 'ANIMATIONS_DONE': {
        const { gameId } = payload;
        const game = games[gameId];
        if (game && game.state === 'processing') {
          game.state = 'accusing';
          game.accusationsReceived = 0;
          game.accusationVotes = {};
          game.players.forEach(p => p.accusationSent = false);
          broadcastGameState(gameId);
        }
        break;
      }
      case 'GET_GAMES': {
        broadcastOpenGames();
        break;
      }
      case 'SHOW_BALANCE': {
        const { gameId, playerName } = payload;
        const game = games[gameId];
        if (game) {
          const player = game.players.find(p => p.name === playerName);
          if (player) {
            game.temporaryShowBalance = { playerName, cash: player.cash };
            broadcastGameState(gameId);
            setTimeout(() => {
              game.temporaryShowBalance = null;
              broadcastGameState(gameId);
            }, 1000);
          }
        }
        break;
      }
      case 'GET_GAME_STATE': {
        const { gameId } = payload;
        const sanitizedGame = getSanitizedGame(gameId);
        if (sanitizedGame) {
          ws.send(JSON.stringify({ gameState: sanitizedGame }));
        }
        break;
      }
      case 'DELETE_GAME': {
        const { gameId } = payload;
        const game = games[gameId];
        if (game) {
          game.players.forEach(p => {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'gameDeleted' }));
            }
          });
          delete games[gameId];
          broadcastOpenGames();
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const gameId = ws.gameId;
    if (gameId && games[gameId]) {
      const player = games[gameId].players.find(p => p.ws === ws);
      if (player) {
        player.ws = null;
      }
      broadcastGameState(gameId);
      broadcastOpenGames(); // Update everyone
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
