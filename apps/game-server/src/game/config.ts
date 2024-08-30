const config = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3842,
  USE_HTTPS: process.env.USE_HTTPS ? process.env.USE_HTTPS === 'true' : true,
  HTTPS_KEY: process.env.HTTPS_KEY || './privkey.pem',
  HTTPS_CERT: process.env.HTTPS_CERT || './fullchain.pem',
  HTTPS_CA: process.env.HTTPS_CA || undefined,
  DATABASE_URL: process.env.DATABASE_URL,
  ENC_KEY: process.env.ENC_KEY || 'devkey',
  PRODUCTION: process.env.NODE_ENV === 'production',
  CRASH_AT: process.env.CRASH_AT ? process.env.CRASH_AT : undefined
};

export default config;
