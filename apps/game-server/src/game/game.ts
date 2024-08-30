import * as db from './database';
import { EventEmitter } from 'events';
import SortedArray from './sorted_array';

import { User } from '../models/user';
import { Play } from '../models/player';
import config from './config';

const tickRate = 150; // ping the client every X milliseconds
const afterCrashTime = 3000; // how long from game_crash -> game_starting
const restartTime = 5000; // How long from game_starting -> game_started

enum GameState {
    STARTING = 'STARTING',
    BLOCKING = 'BLOCKING',
    IN_PROGRESS = 'IN_PROGRESS',
    ENDED = 'ENDED',
}

interface GameHistory {
    addCompletedGame: (gameData: any) => void;
}

class Game extends EventEmitter {
    bankroll: number;
    maxWin!: number;
    gameShuttingDown = false;
    startTime!: Date;
    crashPoint!: number;
    gameDuration!: number;
    forcePoint: number | null = null;
    state: 'STARTING' | 'BLOCKING' | 'IN_PROGRESS' | 'ENDED' = 'ENDED';
    pending: Record<string, string> = {};
    pendingCount = 0;
    joined = new SortedArray<Play>();
    players: Record<string, Play> = {};
    gameId: number;
    gameHistory: GameHistory;
    lastHash: string;
    hash: string | null = null;

    constructor(lastGameId: number, lastHash: string, bankroll: number, gameHistory: GameHistory) {
        super();
        this.bankroll = bankroll;
        this.gameId = lastGameId;
        this.gameHistory = gameHistory;
        this.lastHash = lastHash;
        this.runGame();
    }

    setState(newState: GameState) {
        this.state = newState;
        this.emit('state_change', newState);
        console.log(`State changed to: ${newState}`);
    }

    private runGame() {
        db.doCreateGame(this.gameId + 1, (err: Error | null, info: { crashPoint: number; hash: string }) => {
            if (err) {
                console.log('Could not create game', err, ' retrying in 2 sec..');
                setTimeout(() => this.runGame(), 2000);
                return;
            }

            this.setState(GameState.STARTING);
            this.crashPoint = info.crashPoint;
            console.log(' >>>>>>>>>>>>>>> Game started with crash point:', this.crashPoint);

            if (config.CRASH_AT) {
                if (!config.PRODUCTION) {
                    this.crashPoint = parseInt(config.CRASH_AT);
                }
            }

            this.hash = info.hash;
            this.gameId++;
            this.startTime = new Date(Date.now() + restartTime);
            this.players = {};
            this.gameDuration = Math.ceil(inverseGrowth(this.crashPoint + 1));
            this.maxWin = Math.round(this.bankroll * 0.03);

            this.emit('game_starting', {
                game_id: this.gameId,
                max_win: this.maxWin,
                time_till_start: restartTime
            });

            setTimeout(() => this.blockGame(), restartTime);
        });
    }

    private blockGame() {
        this.setState(GameState.BLOCKING);

        const loop = () => {
            if (this.pendingCount > 0) {
                console.log('Delaying game by 100ms for', this.pendingCount, 'joins');
                return setTimeout(loop, 100);
            }
            this.startGame();
        };

        loop();
    }

    private startGame() {
        this.setState(GameState.IN_PROGRESS);
        this.startTime = new Date();
        this.pending = {};
        this.pendingCount = 0;

        const bets: Record<string, number> = {};
        const arr = this.joined.getArray();
        for (const a of arr) {
            bets[a.user.username] = a.bet;
            this.players[a.user.username] = a;
        }

        this.joined.clear();

        this.emit('game_started', bets);

        this.setForcePoint();

        this.callTick(0);
    }

    private callTick(elapsed: number) {
        const left = this.gameDuration - elapsed;
        const nextTick = Math.max(0, Math.min(left, tickRate));

        setTimeout(() => this.runTick(), nextTick);
    }

    private runTick() {
        const elapsed = new Date().getTime() - this.startTime.getTime();
        const at = growthFunc(elapsed);

        this.runCashOuts(at);

        if (this.forcePoint !== null && this.forcePoint <= at && this.forcePoint <= this.crashPoint) {
            this.cashOutAll(this.forcePoint, (err) => {
                console.log('Just forced cashed out everyone at:', this.forcePoint, 'got err:', err);
                this.endGame(true);
            });
            return;
        }

        if (at > this.crashPoint) {
            this.endGame(false);
        } else {
          console.log('Tick at', at);
            this.tick(elapsed);
        }
    }

    private endGame(forced: boolean) {
        const gameId = this.gameId;
        const crashTime = Date.now();

        

        const playerInfo = this.getInfo().player_info;
        

        this.lastHash = this.hash;

        this.emit('game_crash', {
            forced: forced,
            elapsed: this.gameDuration,
            game_crash: this.crashPoint,
            hash: this.lastHash
        });

        this.gameHistory.addCompletedGame({
            game_id: gameId,
            game_crash: this.crashPoint,
            created: this.startTime,
            player_info: playerInfo,
            hash: this.lastHash
        });

        let dbTimer: NodeJS.Timeout;
        const dbTimeout = () => {
            dbTimer = setTimeout(() => {
                console.log('Game', gameId, 'is still ending... Time since crash:',
                    ((Date.now() - crashTime) / 1000).toFixed(3) + 's');
                dbTimeout();
            }, 1000);
        };

        dbTimeout();

        db.doEndGame(gameId, (err: Error | null) => {
            if (err) console.log('ERROR could not end game id:', gameId, 'got err:', err);
            clearTimeout(dbTimer);

            if (this.gameShuttingDown) {
                this.emit('shutdown');
            } else {
                setTimeout(() => this.runGame(), (crashTime + afterCrashTime) - Date.now());
            }
        });

        this.setState(GameState.ENDED);
    }

    private tick(elapsed: number) {
        this.emit('game_tick', elapsed);
        this.callTick(elapsed);
    }

    getInfo() {
        const playerInfo: Record<string, any> = {};

        for (const username in this.players) {
            const record = this.players[username];

            const info: any = {
                bet: record.bet
            };

            if (record.status === 'CASHED_OUT') {
                info['stopped_at'] = record.stoppedAt;
            }

            playerInfo[username] = info;
        }

        const res: any = {
            state: this.state,
            player_info: playerInfo,
            game_id: this.gameId,
            last_hash: this.lastHash,
            max_win: this.maxWin,
            elapsed: Date.now() - this.startTime.getTime(),
            created: this.startTime,
            joined: this.joined.getArray().map((u) => u.user.username)
        };

        if (this.state === 'ENDED') {
            res.crashed_at = this.crashPoint;
        }

        return res;
    }

    placeBet(user: User, betAmount: number, autoCashOut: number, callback: (err: string | null) => void) {
        console.log('placeBet', user.username, betAmount, autoCashOut, this.state);
        if (this.state !== 'STARTING') {
            return callback('GAME_IN_PROGRESS');
        }

        if (this.pending[user.username] || this.players[user.username]) {
            return callback('ALREADY_PLACED_BET');
        }

        this.pending[user.username] = user.username;
        this.pendingCount++;

        db.placeBet(betAmount, autoCashOut, user.id, this.gameId, (err: Error | null, playId: number) => {
            this.pendingCount--;

            if (err) {
                if ((err as any).code == '23514') {
                    return callback('NOT_ENOUGH_MONEY');
                }

                console.log('[INTERNAL_ERROR] could not play game, got error:', err);
                callback(err as any);
            } else {
                this.bankroll += betAmount;

                const index = this.joined.insert({ user, bet: betAmount, auto_cash_out: autoCashOut, id: playId, status: 'PLAYING' });

                this.emit('player_bet', {
                    username: user.username,
                    index: index
                });

                callback(null);
            }
        });
    }

    doCashOut(play: Play, at: number, callback: (err: Error | null) => void) {
        const username = play.user.username;

        this.players[username].status = 'CASHED_OUT';
        this.players[username].stoppedAt = at;

        const won = (this.players[username].bet / 100) * at;

        this.emit('cashed_out', {
            username: username,
            stopped_at: at
        });

        db.cashOut(play.user.id, play.id, won, (err: Error | null) => {
            if (err) {
                console.log('[INTERNAL_ERROR] could not cash out:', username, 'at', at, 'in', play, 'because:', err);
                return callback(err);
            }

            callback(null);
        });
    }

    runCashOuts(at: number) {
        let update = false;

        for (const playerUserName in this.players) {
            const play = this.players[playerUserName];

            if (play.status === 'CASHED_OUT') return;

            if (play.auto_cash_out <= at && play.auto_cash_out <= this.crashPoint && play.auto_cash_out <= this.forcePoint!) {
                this.doCashOut(play, play.auto_cash_out, (err) => {
                    if (err) console.log('[INTERNAL_ERROR] could not auto cashout', playerUserName, 'at', play.auto_cash_out);
                });
                update = true;
            }
        }

        if (update) this.setForcePoint();
    }

    setForcePoint() {
        let totalBet = 0;
        let totalCashedOut = 0;

        for (const playerName in this.players) {
            const play = this.players[playerName];

            if (play.status === 'CASHED_OUT') {
                const amount = play.bet * (play.stoppedAt! - 100) / 100;
                totalCashedOut += amount;
            } else {
                totalBet += play.bet;
            }
        }

        if (totalBet === 0) {
            this.forcePoint = Infinity;
        } else {
            const left = this.maxWin - totalCashedOut - (totalBet * 0.01);

            const ratio = (left + totalBet) / totalBet;

            this.forcePoint = Math.max(Math.floor(ratio * 100), 101);
        }
    }

    cashOut(user: User, callback: (err: string | null) => void) {
        if (this.state !== 'IN_PROGRESS') return callback('GAME_NOT_IN_PROGRESS');

        const elapsed = new Date().getTime() - this.startTime.getTime();
        let at = growthFunc(elapsed);
        const play = this.players[user.username];

        if (!play) return callback('NO_BET_PLACED');

        if (play.auto_cash_out <= at) at = play.auto_cash_out;

        if (this.forcePoint! <= at) at = this.forcePoint!;

        if (at > this.crashPoint) return callback('GAME_ALREADY_CRASHED');

        if (play.status === 'CASHED_OUT') return callback('ALREADY_CASHED_OUT');

        this.doCashOut(play, at, callback as any);
        this.setForcePoint();
    }

    cashOutAll(at: number, callback: (err?: Error | null) => void) {
        if (this.state !== 'IN_PROGRESS') return callback();

        console.log('Cashing everyone out at:', at);

        this.runCashOuts(at);

        if (at > this.crashPoint) return callback();

        const tasks: Array<Promise<void>> = [];

        for (const playerName in this.players) {
            const play = this.players[playerName];

            if (play.status === 'PLAYING') {
                tasks.push(new Promise<void>((resolve) => {
                    if (play.status === 'PLAYING') {
                        this.doCashOut(play, at, (err) => {
                            if (err) console.error('[INTERNAL_ERROR] unable to cash out player:', playerName);
                            resolve();
                        });
                    } else {
                        resolve();
                    }
                }));
            }
        }

        console.log('Needing to force cash out:', tasks.length, 'players');

        Promise.all(tasks).then(() => {
            console.log('Emergency cashed out all players in gameId:', this.gameId);
            callback();
        }).catch((err) => {
            console.error('[INTERNAL_ERROR] unable to cash out all players in', this.gameId, 'at', at);
            callback(err);
        });
    }

    shutDown() {
        this.gameShuttingDown = true;
        this.emit('shuttingdown');

        if (this.state === 'ENDED') {
            this.emit('shutdown');
        }
    }
}


function growthFunc(ms: number): number {
    const r = 0.00006;
    return Math.floor(100 * Math.pow(Math.E, r * ms));
}

function inverseGrowth(result: number): number {
    const c = 16666.666667;
    return c * Math.log(0.01 * result);
}

export default Game;
