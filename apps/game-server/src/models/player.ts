import { User } from './user';

export interface Play {
  id: number
  user: User;
  cash_out?: number;
  auto_cash_out?: number;
  game_id?: number;
  bet: number;
  status?: 'PLAYING' | 'CASHED_OUT';
  stoppedAt?: number;
  createdAt?: Date;
}