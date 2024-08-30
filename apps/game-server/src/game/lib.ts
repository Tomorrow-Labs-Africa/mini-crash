import * as crypto from 'crypto';

// Helper function to check if a number is divisible
const isDivisible = (value: string, divisor: number): boolean => {
  const num = parseInt(value, 16);
  return num % divisor === 0;
};


export const crashPointFromHash = (serverSeed: string, clientSeed: string = '000000000000000007a9a31ff7f07463d91af6b5454241d5faf282e5e0fe1b3a'): number => {
  // Generate hash using HMAC with SHA-256
  const hash = crypto.createHmac('sha256', serverSeed)
                     .update(clientSeed)
                     .digest('hex');

  // In 1 of 101 games the game crashes instantly.
  if (isDivisible(hash, 101)) {
    return 0;
  }

  // Use the most significant 52-bit from the hash to calculate the crash point
  const h = parseInt(hash.slice(0, 52 / 4), 16);
  const e = Math.pow(2, 52);

  return Math.floor((100 * e - h) / (e - h));
};
