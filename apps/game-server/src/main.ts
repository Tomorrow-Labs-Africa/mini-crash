import express, { Request, Response } from 'express';
import config from './game/config';
import * as database from './game/database';
import Game from './game/game';
import GameHistory from './game/game_history';
import { User } from './models/user';

const app = express();
app.use(express.json());

const port = config.PORT || 3000;
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

function getGameHistory(): Promise<any[]> {
    return new Promise((resolve, reject) => {
        database.getGameHistory((err, gameHistory) => {
            if (err) return reject(err);
            resolve(gameHistory);
        });
    });
}

function getLastGameInfo(): Promise<{ id: number; hash: string } | undefined> {
    return new Promise((resolve, reject) => {
        database.getLastGameInfo((err, gameInfo) => {
            if (err) return reject(err);
            resolve(gameInfo);
        });
    });
}

async function initializeGame() {
    try {
        const [gameHistoryData, lastGameInfo, bankroll] = await Promise.all([
            getGameHistory(),
            getLastGameInfo(),
            database.getBankroll(),
        ]);

        const gameHistory = new GameHistory(gameHistoryData);
        let { id: lastGameId, hash: lastHash } = lastGameInfo;

        if (typeof lastGameId !== 'number') {
            lastGameId = parseInt(lastGameId);
        }

        console.log('Bankroll:', bankroll / 1e8, 'BTC');
        console.log('Game started with ID:', lastGameId);
        console.log('Game hash:', lastHash);
        //console.log('Game history:', gameHistoryData);

        const game = new Game(lastGameId, lastHash, bankroll, gameHistory);

        // Set up event listeners immediately after creating the game instance
        game.on('game_starting', () => {
            // Simulate dummy user actions
              const dummyUser: User = { id: 1, username: 'jeffie' };

              game.placeBet(dummyUser, 100, 150, (err) => {
                if (err) {
                    console.log('Error placing bet:', err);
                } else {
                    console.log('Dummy player placed a bet');

                    // Simulate cashing out at a specific point after the bet is placed
                    setTimeout(() => {
                        game.cashOut(dummyUser, (err) => {
                            if (err) {
                                console.log('Error cashing out:', err);
                            } else {
                                console.log('Dummy player cashed out successfully');
                            }
                        });
                    }, 2000); // Dummy player cashes out after 2 seconds
                }
            });
            console.log('Event: game_starting');
        });

        game.on('game_started', (bets) => {
            console.log('Event: game_started', bets);
        });

        game.on('game_tick', (elapsed) => {
            console.log('Event: game_tick', elapsed);
        });

        game.on('game_crash', (crashData) => {
            console.log('Event: game_crash', crashData);
        });

        game.on('player_bet', (betInfo) => {
            console.log('Event: player_bet', betInfo);
        });

        game.on('cashed_out', (cashOutInfo) => {
            console.log('Event: cashed_out', cashOutInfo);
        });

        game.on('shutdown', () => {
            console.log('Event: shutdown');
        });

        console.log('Game initialized successfully.');

        
        


    } catch (error) {
        console.error('[INTERNAL_ERROR] Error during initialization:', error);
    }
}

// Initialize the game
initializeGame();

// Add a simple route to confirm the server is running
app.get('/', (req: Request, res: Response) => {
    res.send('Server is running');
});
