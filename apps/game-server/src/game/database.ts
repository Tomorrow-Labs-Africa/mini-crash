import { Pool, PoolClient, QueryResult } from 'pg';
import * as lib from './lib';
import config from './config';

import { User } from '../models/user';
import { Game } from '../models/game';

if (!config.DATABASE_URL) throw new Error('must set DATABASE_URL environment var');

type Callback<T> = (err: Error | null, result?: T) => void;


console.log('DATABASE_URL: ', config.DATABASE_URL);

// Increase the client pool size and adjust pool settings
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20, // Pool size
  idleTimeoutMillis: 120000 // Timeout for idle connections
});

pool.on('connect', () => {
  console.log('==== DB connected successfully ====');
});

pool.on('error', (err) => {
  console.error('POSTGRES EMITTED AN ERROR', err);
});

const query = (queryText: string, params: any[] = []): Promise<QueryResult> => {
  return new Promise((resolve, reject) => {
    const retry = () => {
      pool.connect((err, client, done) => {
        if (err) return reject(err);

        client.query(queryText, params, (err, result) => {
          done();
          if (err) {
            if (err.code === '40P01') {
              console.log('Warning: Retrying deadlocked transaction: ', queryText, params);
              return retry();
            }
            return reject(err);
          }
          resolve(result);
        });
      });
    };
    retry();
  });
};

const getClient = (runner: (client: PoolClient) => Promise<any>): Promise<any> => {
  return new Promise((resolve, reject) => {
    const retry = () => {
      pool.connect((err, client, done) => {
        if (err) return reject(err);

        const rollback = (err: Error) => {
          client.query('ROLLBACK', (rollbackErr) => {
            done();
            if (rollbackErr) {
              if (rollbackErr.code === '40P01') {
                console.log('Warning: Retrying deadlocked transaction..');
                return retry();
              }
              return reject(rollbackErr);
            }
            reject(err);
          });
        };

        client.query('BEGIN', (beginErr) => {
          if (beginErr) return rollback(beginErr);

          runner(client)
            .then((data) => {
              client.query('COMMIT', (commitErr) => {
                if (commitErr) return rollback(commitErr);
                done();
                resolve(data);
              });
            })
            .catch((err) => rollback(err));
        });
      });
    };
    retry();
  });
};

const addSatoshis = (client: PoolClient, userId: number, amount: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    client.query(
      'UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2',
      [amount, userId],
      (err, res) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
};

export const placeBet = (amount: number, autoCashOut: number, userId: number, gameId: number, callback: Callback<any>): Promise<number> => {

  return getClient((client) => {
    return Promise.all([
      new Promise<void>((resolve, reject) => {
        client.query(
          'UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2',
          [amount, userId],
          (err) => {
            if (err) {
               console.log('Error: ', err);
               return reject(err);
            }
            resolve();
          }
        );
      }),
      new Promise<QueryResult>((resolve, reject) => {
        client.query(
          'INSERT INTO plays(user_id, game_id, bet, auto_cash_out) VALUES($1, $2, $3, $4) RETURNING id',
          [userId, gameId, amount, autoCashOut],
          (err, result) => {
            if (err){
              console.log('Error: ', err);
               return reject(err);
            }
            resolve(result);
          }
        );
      })
    ]).then(([_, result]) => {
      const playId = result.rows[0].id;
      return callback(null, playId);
    });
  });
};

const endGameQuery = `
  WITH vals AS (
    SELECT
      unnest($1::bigint[]) as user_id,
      unnest($2::bigint[]) as play_id,
      unnest($3::bigint[]) as bonus
  ), p AS (
    UPDATE plays SET bonus = vals.bonus FROM vals WHERE id = vals.play_id RETURNING vals.user_id
  ), u AS (
    UPDATE users SET balance_satoshis = balance_satoshis + vals.bonus
    FROM vals WHERE id = vals.user_id RETURNING vals.user_id
  )
  SELECT COUNT(*) count FROM p JOIN u ON p.user_id = u.user_id
`;

export const doEndGame = (gameId: number, callback: any): Promise<void> => {

  return getClient(async (client) => {
    await new Promise<void>((resolve, reject) => {
      client.query(
        'UPDATE games SET ended = true WHERE id = $1',
        [gameId],
        (err) => {
          if (err) return reject(new Error('Could not end game, got: ' + err));
          resolve();
        }
      );
    });

    const userIds: number[] = [];
    const playIds: number[] = [];
    const bonusesAmounts: number[] = [];


    if (userIds.length === 0) return callback();

    const result = await query(endGameQuery, [userIds, playIds, bonusesAmounts]);
    if (result.rows[0].count !== userIds.length) {
      throw new Error('Mismatch row count: ' + result.rows[0].count + ' and ' + userIds.length);
    }
    callback();
  });
};

export const cashOut = (userId: number, playId: number, amount: number, callback: Callback<any>): Promise<void> => {

  return getClient(async (client) => {
    await addSatoshis(client, userId, amount);
    const result = await new Promise<QueryResult>((resolve, reject) => {
      client.query(
        'UPDATE plays SET cash_out = $1 WHERE id = $2 AND cash_out IS NULL',
        [amount, playId],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });

    if (result.rowCount !== 1) {
      console.error('[INTERNAL_ERROR] Double cashout? User:', userId, 'play:', playId, 'amount:', amount, 'got:', result.rowCount);
      throw new Error('Double cashout');
    }
  });
};

// callback called with (err, { crashPoint: , hash: })
export const doCreateGame = async (gameId: number, callback: Callback<any>): Promise<any> => {

  const results = await query('SELECT hash FROM game_hashes WHERE game_id = $1', [gameId]);
  if (results.rows.length !== 1) {
    console.error('[INTERNAL_ERROR] Could not find hash for game ', gameId);
    throw new Error('NO_GAME_HASH');
  }
  const hash = results.rows[0].hash;
  const gameCrash = lib.crashPointFromHash(hash);
  await query('INSERT INTO games(id, game_crash) VALUES($1, $2)', [gameId, gameCrash]);
  console.log('Created game:', gameId, 'crash:', gameCrash, 'hash:', hash);
  callback(null, { crashPoint: gameCrash, hash: hash });
};

export const getBankroll = async (): Promise<number> => {
  const results = await query(`
    SELECT (
      (SELECT COALESCE(SUM(amount),0) FROM fundings) - 
      (SELECT COALESCE(SUM(balance_satoshis), 0) FROM users)
    ) AS profit
  `);
  const profit = results.rows[0].profit - 100e8;
  const min = 1e8;
  return Math.max(min, profit);
};




export function getGameHistory(callback: (err: Error | null, data?: any[]) => any): any {
    const sql =
    'SELECT games.id game_id, game_crash, created, ' +
    '     (SELECT hash FROM game_hashes WHERE game_id = games.id), ' +
    '     (SELECT to_json(array_agg(to_json(pv))) ' +
    '        FROM (SELECT username, bet, (100 * cash_out / bet) AS stopped_at, bonus ' +
    '              FROM plays JOIN users ON user_id = users.id WHERE game_id = games.id) pv) player_info ' +
    'FROM games ' +
    'WHERE games.ended = true ' +
    'ORDER BY games.id DESC LIMIT 10';

    pool.query(sql, (err, result) => {
        if (err) {
            callback(err);
            return;
        }

        const data: any[] = result.rows.map(row => {
            const oldInfo: any = row.player_info || [];
            const newInfo: Record<string, any> = {};

            oldInfo.forEach(play => {
                newInfo[play.username] = {
                    bet: play.bet,
                    stopped_at: play.stopped_at,
                    bonus: play.bonus
                };
            });

            return {
                game_id: row.game_id,
                game_crash: row.game_crash,
                created: row.created,
                player_info: newInfo
            };
        });

        return callback(null, data);
    });
}


interface GameInfo {
    id: number;
    hash: string;
}

export function getLastGameInfo(callback: (err: Error | null, gameInfo?: GameInfo) => void): any{
    pool.query('SELECT MAX(id) AS id FROM games', (err, results) => {
        if (err) return callback(err);
      

        const id: number = results.rows[0].id;

        if (!id || id < 1e6) {
            return callback(null, {
                id: 1e6 - 1,
                hash: 'c1cfa8e28fc38999eaa888487e443bad50a65e0b710f649affa6718cfbfada4d'
            });
        }

        pool.query('SELECT hash FROM game_hashes WHERE game_id = $1', [id], (err, results: any) => {
            if (err) return callback(err);
            return callback(null, {
                id: id,
                hash: results.rows[0].hash
            });
        });
    });
}

