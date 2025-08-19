// nuxt.config.ts
export default defineNuxtConfig({
  srcDir: 'src/',
  devtools: { enabled: true },

  // Configure Nitro for Cloudflare Pages deployment
  nitro: {
    preset: 'cloudflare-pages',
    routeRules: {
      '/api/**': { cors: true },
      '/v1/**': { cors: true },
      '/v1beta/**': { cors: true }
    }
  },
});
