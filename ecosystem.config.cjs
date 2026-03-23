/**
 * PM2 process definition for production deployment.
 */
export default {
  apps: [
    {
      name: 'deaton-outreach',
      script: 'dist/main.js',
      cwd: '.',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
