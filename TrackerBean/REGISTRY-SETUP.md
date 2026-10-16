# "Friend also has TrackerBean": one-time setup (about 5 minutes, free)

Steam has no way to tell which of your friends run TrackerBean, so the app uses a tiny
lookup service. It only stores public SteamIDs (no names, hours, or IPs) and entries expire on
their own after 45 days if the app stops checking in. Everything works without it; the badge
just won't appear until you do this once.

1. Make a free account at https://dash.cloudflare.com
2. In a terminal, in the `registry-worker` folder:
   ```
   npx wrangler login
   npx wrangler kv namespace create USERS
   ```
   Copy the `id` it prints into `wrangler.toml` (replace `PASTE_KV_ID_HERE`).
3. Deploy:
   ```
   npx wrangler deploy
   ```
   It prints a URL like `https://trackerbean-registry.yourname.workers.dev`.
4. Open `src/social.js`, find `const REGISTRY_URL = '';` and paste the URL between the quotes.
5. Build and release as normal. Friends who update get the badges automatically.

Free-tier limits (100k reads and 1k writes a day) are plenty for a friend group.
Users can opt out any time in Profile > "Let friends see I use TrackerBean".
