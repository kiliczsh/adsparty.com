# AdsParty

An endless, chat-directed AI television station running on Cloudflare. Viewers
submit scene ideas; a Durable Object coordinates selection and playback, an
asynchronous video provider generates each clip, and the station continuously
mixes fresh clips with reruns.

Production: [adsparty.com](https://adsparty.com)

## Sponsors

Video generation is sponsored by
[Wiro](https://wiro.ai/models/fastvideo/fast-h3?utm_source=adsparty.com), which
provides the FastVideo/Fast-H3 integration used by the production station.
Thanks to Wiro for supporting the project and its continuous AI television
experiment.

The fal.ai adapter remains available as an optional video provider.

## Architecture

- Cloudflare Worker: HTTP APIs, static assets and application routing
- Durable Object: authoritative station clock, live window and rate state
- D1: messages, generation jobs, clips, likes and settings
- R2: immutable MPEG-TS archive segments
- Queue: idempotent video generation and media packaging work
- Container: authenticated ffmpeg/ffprobe media packaging
- Vanilla JavaScript frontend with hls.js fallback playback

Stripe plumbing is disabled by default and rejects live secret keys. Watching
and chat do not depend on billing.

## Requirements

- Node.js 22+
- A Cloudflare account with Workers, D1, R2, Queues, Durable Objects and
  Containers enabled
- Wrangler authenticated for the target account
- Wiro API credentials, or fal.ai credentials when using the optional adapter
- Cloudflare Turnstile credentials for chat

## Configuration

Install dependencies and create local secret placeholders:

```sh
npm ci
cp .env.example .dev.vars
```

Application secrets:

- `WIRO_API_KEY` and `WIRO_API_SECRET` for the default Wiro provider
- `FAL_KEY` only when `VIDEO_PROVIDER` is set to `fal`
- `TURNSTILE_SECRET_KEY`
- `VIEWER_SIGNING_KEY`
- `ADMIN_TOKEN`
- `PACKAGER_TOKEN`
- `DIRECTOR_API_KEY` when using an OpenAI-compatible director
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` only for Stripe test mode

Non-secret model, director, Turnstile site key, analytics, Stripe price and
Cloudflare binding configuration lives in `wrangler.jsonc`. Forks must replace
the account ID, database ID, resource names, routes and public site keys with
resources owned by their Cloudflare account. Cloudflare account and resource
IDs are identifiers, not credentials.

Never commit `.dev.vars`, API tokens or provider keys. Production secrets can
be set with:

```sh
npx wrangler secret put WIRO_API_KEY
npx wrangler secret put WIRO_API_SECRET
```

Repeat that command for each configured production secret.

## Development and validation

```sh
npm run dev
npm run lint
npm test
npm run build
```

Apply remote D1 migrations before the first deploy:

```sh
npx wrangler d1 migrations apply televole-db --remote
```

Deploy the main Worker:

```sh
npm run deploy
```

The checked-in production bindings intentionally retain their existing
`televole-*` Cloudflare resource names so the live station keeps its current D1,
R2 and Queue data. The viewer-facing brand remains independently configurable.

## Operations

The operator console is available at `/admin.html`. On a new installation,
`ADMIN_TOKEN` authorizes creation of the first administrator account; after
bootstrap, administrators sign in with username and password using a secure,
HTTP-only session cookie. The console can add administrators, pause/resume
generation, inspect prompt and video queues, change clip duration and moderation
policy, retry provider jobs, and disable or remove content.

Useful commands:

```sh
npx wrangler tail televole-live
npm run ingest:clip -- --url https://example/video.mp4 --chat "nick: idea" --prompt "video prompt"
```

Manual ingestion defaults to the same `televole-db` and `televole-media`
resources used by the production Worker. Use `--database` and `--bucket` when
targeting a fork or another environment.

## Security

Public inputs are bounded and rendered as text, chat requires server-side
Turnstile verification, viewer cookies are signed, administrative routes fail
closed behind server-side sessions, and the media container accepts only
authenticated packaging requests from allowlisted Wiro and fal.ai media hosts.
See [SECURITY.md](SECURITY.md) for reporting.

## License

MIT
