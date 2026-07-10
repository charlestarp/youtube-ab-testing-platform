# YouTube A/B Testing Platform

A self hosted, full stack platform for running rigorous A/B tests on YouTube video titles and thumbnails. It rotates variants on a schedule, collects real performance data server side, reconstructs per hour click through rate, and declares a winner only when the result is statistically sound.

This is a sanitized public snapshot for reference. It contains no data, credentials, cookies, database contents, or production configuration. All secrets are supplied through environment variables (see `.env.example`).

## What it does

Picking a title or thumbnail by gut feel leaves views on the table. This platform turns that decision into a measured experiment:

- Define a test with two or more title and thumbnail variants.
- The scheduler rotates the live variant on the channel every hour.
- Metrics are pulled server side for each variant window: impressions, click through rate, views, watch time, subscribers, likes, and comments.
- A winner is declared automatically once each variant has enough impressions and a clear CTR lead.
- The winner is applied to the video, and the result is re-checked as YouTube settles its trailing hours.

## Why it is interesting technically

The hard part is not the UI, it is trusting the numbers. YouTube does not expose clean per hour CTR for a rotating experiment, and its data shifts as it settles. This project handles that:

- **Server side metrics, no browser scraping for measurement.** It reads channel analytics through authenticated Studio requests, so measurement does not depend on a browser being open.
- **Per hour CTR reconstruction.** Studio only gives a daily view through rate series, so per hour CTR is reconstructed daily exact and mapped onto whichever variant was live in each real hour.
- **Settled results.** YouTube under reports the trailing couple of hours of reach data, so completed tests keep refreshing for 48 hours and the winner is re-evaluated with hysteresis so near ties do not oscillate.
- **Metric health auditing.** Every cycle checks each pipeline for the three ways data lies: stale (nothing written), zero flatlined (the source renders zeros while the pipe is dead), and impossible values.
- **Nightly deep audit.** Stored numbers are compared against Studio's own, pulled fresh, with a scorecard.
- **Winner verification.** After a winner is applied it is proven to actually be live: title via public oEmbed, thumbnail via a pixel level image comparison against the variant file.
- **AI producer.** A Claude powered assistant proposes and evaluates titles using tool calling, grounded in the channel's own historical performance rather than generic advice, with streaming responses and PDF and image inputs.

## Tech stack

- **Backend:** TypeScript, Fastify, better-sqlite3 (SQLite)
- **Frontend:** Next.js (React, TypeScript, App Router), Tailwind CSS
- **Browser extension:** Chrome Manifest v3, as a secondary metrics source
- **Automation:** Playwright driving Firefox for uploads
- **AI:** Anthropic Claude with tool calling and streaming
- **Tooling:** Python for data scripts

## Runs locally, exposed through Cloudflare

The app is designed to run on your own machine (self hosted), not on a managed cloud host. Process management is handled by PM2 (API, web, and a watchdog), and the local services are exposed to the internet through a Cloudflare Tunnel, with Cloudflare in front for TLS and access control. There is no cloud database and no third party analytics store: all state lives in a local SQLite database that never leaves the machine.

## Structure

- `src/` — Fastify API: routes, services, scheduling, the metrics and reconstruction pipeline, auditing, and the AI assistant
- `web/` — Next.js dashboard
- `extension/` — Chrome extension

## Setup

1. `npm install` at the root and inside `web/`
2. Copy `.env.example` to `.env` and fill in your own values
3. `npm run build`, then `npm start`
4. Start the Next.js app in `web/` the same way
5. Optionally put the local services behind a Cloudflare Tunnel to reach them remotely
