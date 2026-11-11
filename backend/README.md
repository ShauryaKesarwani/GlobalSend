To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

Open http://localhost:4000/health to check that the backend is running.

## Optional: Cloudflare TURN

Direct connections use Cloudflare STUN by default. TURN is a fallback for
networks where a direct connection fails. To enable it, add these to the
backend `.env`:

```env
CLOUDFLARE_TURN_KEY_ID=your_key_id
CLOUDFLARE_TURN_KEY_API_TOKEN=your_api_token
```

Cloudflare supplies the TURN addresses and temporary credentials automatically.
Without these settings, the app uses STUN only. Keep the API token private.

The backend limits anonymous requests by IP. These limits are stored in memory
and reset on restart. For production, use shared or edge rate limits; behind a
proxy, configure trusted client IP handling first. Guest sessions are not user
authentication.
