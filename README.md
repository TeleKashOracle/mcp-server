# TeleKash MCP Server

**Prediction market probability oracle for AI agents.**

[![npm version](https://img.shields.io/npm/v/telekash-mcp-server.svg)](https://www.npmjs.com/package/telekash-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

## What is this?

TeleKash is a probability oracle that gives AI agents real-time access to 500+ live prediction markets from Kalshi (CFTC-regulated) and Polymarket. It provides structured trading signals, cross-source arbitrage detection, noise filtering, and broker execution across crypto, politics, sports, entertainment, finance, weather, tech, and science categories. One MCP server replaces polling multiple exchanges.

## Quick Install

```bash
npx telekash-mcp-server
```

### Claude Code

```bash
claude mcp add telekash-oracle npx telekash-mcp-server
```

### Claude Desktop / Cursor

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "telekash-oracle": {
      "command": "npx",
      "args": ["telekash-mcp-server"]
    }
  }
}
```

## Tools

28 tools across 4 categories. All tools work without an API key on the Free tier (100 queries/day).

### Intelligence

| Tool               | What it does                                                       | Tier        |
| ------------------ | ------------------------------------------------------------------ | ----------- |
| `get_probability`  | Real-time YES/NO probability with volume-weighted confidence score | Free        |
| `list_markets`     | Browse markets by category, source, jurisdiction, with sorting     | Free        |
| `search_markets`   | Full-text search across 500+ markets                               | Free        |
| `get_history`      | Historical probability changes over 1h, 24h, 7d, 30d               | Free        |
| `get_sentiment`    | AI sentiment analysis with conviction, momentum, and noise filter  | Free        |
| `get_market_stats` | Aggregate statistics across all markets and sources                | Free        |
| `get_trending`     | Markets with the biggest probability swings                        | Free        |
| `compare_sources`  | Kalshi vs Polymarket side-by-side odds comparison                  | Calibration |

### Analytics

| Tool               | What it does                                                            | Tier        |
| ------------------ | ----------------------------------------------------------------------- | ----------- |
| `detect_arbitrage` | Cross-source arbitrage opportunities with buy/sell signals              | Calibration |
| `get_signal`       | Structured TPF signal: probability + sentiment + noise filter + verdict | Calibration |
| `get_divergences`  | Markets where sources disagree most (STRONG/MODERATE/WEAK)              | Calibration |
| `get_edge`         | Kelly Criterion sizing, expected value, and risk classification         | Calibration |
| `track_prediction` | Record predictions for accuracy tracking                                | Calibration |
| `get_performance`  | Brier score, calibration curve, edge-vs-market analysis                 | Calibration |

### Trading

| Tool                    | What it does                                                       | Tier |
| ----------------------- | ------------------------------------------------------------------ | ---- |
| `execute_trade`         | Route trades to Kalshi, Polymarket, or native parimutuel pools     | Edge |
| `get_order_status`      | Check fill status, price, and commission on broker orders          | Edge |
| `cancel_order`          | Cancel pending or submitted broker orders                          | Edge |
| `get_pool_status`       | Native pool composition, participant counts, implied odds          | Edge |
| `get_agent_balance`     | Agent balance, P&L, win rate, and pool position count              | Edge |
| `get_resolution_status` | Multi-source resolution verification and confidence levels         | Edge |
| `create_market`         | Create custom binary prediction markets                            | Edge |
| `export_data`           | Bulk export: probability history, resolutions, catalogs, arbitrage | Edge |

### Admin

| Tool               | What it does                                                       | Tier |
| ------------------ | ------------------------------------------------------------------ | ---- |
| `generate_api_key` | Generate a free API key (no signup required)                       | Free |
| `get_usage`        | Check current API usage, rate limits, and tier status              | Free |
| `register_alert`   | Webhook alerts for probability crosses, mispricings, volume spikes | Edge |
| `list_alerts`      | List active webhook alerts with delivery stats                     | Edge |
| `delete_alert`     | Delete a webhook alert                                             | Edge |
| `get_health`       | System health: connectivity, data freshness, broker status         | Free |

## Pricing

Per-query pricing. No subscriptions. Free tier requires no API key.

| Tier            | Cost        | Queries/Day | What you get                                                                                    |
| --------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------- |
| **Free**        | $0          | 100         | Probabilities, search, trending, sentiment, stats, health                                       |
| **Calibration** | $0.01/query | 1,000       | + Cross-source comparison, arbitrage, signals, divergence, Kelly sizing, performance tracking   |
| **Edge**        | $0.05/query | Unlimited   | + Broker trading (1% commission), native pools (5% fee), webhooks, data export, market creation |

### Revenue model

| Stream               | Rate                 | Description                                         |
| -------------------- | -------------------- | --------------------------------------------------- |
| Intelligence queries | $0 - $0.05/query     | Real-time probability, sentiment, signals           |
| Broker trades        | 1% commission        | Best-price execution routed to Kalshi or Polymarket |
| Native pool trades   | 5% fee at resolution | Parimutuel pools alongside Telegram users           |

### Get an API key

```bash
# Via the MCP server itself (free tier, no signup)
# Call the generate_api_key tool

# Or via Telegram
# Message @TeleKashBot with /apikey
```

## Example

Connect to the server and query a market probability:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["telekash-mcp-server"],
});

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Get probability for a market
const result = await client.callTool({
  name: "get_probability",
  arguments: { query: "Will Bitcoin hit $200K by end of 2026?" },
});

console.log(result.content);
// => { probability: { yes: 34, no: 66 }, confidence: { grade: "HIGH", score: 82 }, ... }
```

More examples in the [`examples/`](./examples) directory:

- `quick-start.ts` -- Connect, search, get probabilities
- `arbitrage-scanner.ts` -- Find cross-source mispricings
- `portfolio-scanner.ts` -- Scan markets and build a ranked portfolio
- `market-monitor.ts` -- Watch a market and log probability changes

## Environment Variables

The server works without any credentials (returns demo data). For live market access:

```
SUPABASE_URL=https://rrkjtdnxkscukexbsrue.supabase.co
SUPABASE_ANON_KEY=your-anon-key
TELEKASH_API_KEY=your-api-key              # Optional: enables paid tiers
TELEKASH_PAYMENT_ADDRESS=0x...             # Optional: enables x402 USDC micropayments
```

## Data Sources

| Source     | Type                       | Sync Frequency   |
| ---------- | -------------------------- | ---------------- |
| Kalshi     | CFTC-regulated US exchange | Every 15 minutes |
| Polymarket | Crypto-native exchange     | Every hour       |

All sources are aggregated, deduplicated, and categorized automatically across 8 categories: crypto, politics, sports, entertainment, finance, weather, tech, science.

## Links

- [npm](https://www.npmjs.com/package/telekash-mcp-server)
- [GitHub](https://github.com/TeleKashOracle/mcp-server)
- [Agent Card](https://github.com/TeleKashOracle/mcp-server/blob/main/agent-card.json)
- [A2A Protocol](https://github.com/TeleKashOracle/mcp-server/blob/main/server.json)
- [TeleKash Bot](https://t.me/TeleKashBot)

## License

MIT
