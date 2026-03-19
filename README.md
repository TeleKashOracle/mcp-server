# TeleKash Prediction Oracle — MCP Server

The probability oracle for the agent economy. 13 tools across 500+ live markets from Kalshi, Polymarket, and Metaculus.

> "Chainlink is the price oracle. TeleKash is the probability oracle."

[![telekash-mcp-server MCP server](https://glama.ai/mcp/servers/TeleKashOracle/mcp-server/badges/card.svg)](https://glama.ai/mcp/servers/TeleKashOracle/mcp-server)

## Installation

```bash
npx telekash-mcp-server
```

Or add to Claude Code:

```bash
claude mcp add telekash-oracle npx telekash-mcp-server
```

Or add to your MCP config:

```json
{
  "mcpServers": {
    "telekash-oracle": {
      "command": "npx",
      "args": ["telekash-mcp-server"],
      "env": {
        "SUPABASE_URL": "https://rrkjtdnxkscukexbsrue.supabase.co",
        "SUPABASE_ANON_KEY": "your-key"
      }
    }
  }
}
```

## Tools

**13 oracle tools** querying 500+ live markets from 3 sources, synced every 15 minutes.

### Intelligence

| Tool               | What It Does                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `get_probability`  | Real-time YES/NO probability with volume-weighted confidence score        |
| `list_markets`     | Browse markets by category (crypto, politics, sports, economics, weather) |
| `search_markets`   | Full-text search across all markets                                       |
| `get_history`      | Historical probability changes with trend detection                       |
| `get_sentiment`    | AI sentiment analysis — conviction, momentum, volume, noise filter        |
| `get_market_stats` | Aggregate statistics across all markets                                   |
| `get_trending`     | Markets with biggest probability swings — signal vs noise detection       |
| `compare_sources`  | Kalshi vs Polymarket vs Metaculus odds comparison                         |

### Signals

| Tool               | What It Does                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- |
| `get_signal`       | Structured TPF signal — one call for complete trade decision (STRONG_BUY → NO_SIGNAL) |
| `detect_arbitrage` | Cross-source arbitrage detection with buy/sell signals                                |
| `get_divergences`  | Consensus divergence detection — where sources disagree most                          |

### Agent Performance

| Tool               | What It Does                                            |
| ------------------ | ------------------------------------------------------- |
| `track_prediction` | Record a prediction for accuracy tracking               |
| `get_performance`  | Brier score, calibration curve, edge-vs-market analysis |

## TeleKash Probability Format (TPF)

The `get_signal` tool returns a structured signal combining all intelligence into one actionable verdict:

```
get_signal(query: "Will Bitcoin hit 100k?")
→ {
    probability: { yes: 72, confidence: { grade: "HIGH" } },
    sentiment: { recommendation: "bullish" },
    noise_filter: { signal_quality: "signal" },
    cross_source: { spread_pct: 4.2 },
    verdict: { action: "BUY", score: 28.5 }
  }
```

One call replaces `get_probability` + `get_sentiment` + `get_history` + `compare_sources`.

## Examples

See the [`examples/`](./examples) directory for complete agent scripts:

- **`portfolio-scanner.ts`** — Scan markets, find high-confidence signals, build ranked portfolio
- **`arbitrage-hunter.ts`** — Monitor cross-source spreads and alert on opportunities
- **`market-monitor.ts`** — Watch a specific market and log probability changes

### Quick prompts for your AI agent:

- **"What are the odds Trump wins 2028?"** → `get_probability`
- **"Find arbitrage opportunities"** → `detect_arbitrage`
- **"Where do prediction sources disagree most?"** → `get_divergences`
- **"Give me a trading signal for Bitcoin markets"** → `get_signal`
- **"Track my prediction: YES on Bitcoin >100k at 75%"** → `track_prediction`
- **"How accurate are my predictions?"** → `get_performance`

## Data Sources

| Source         | Type                       | Sync Frequency |
| -------------- | -------------------------- | -------------- |
| **Kalshi**     | CFTC-regulated US exchange | Every 15 min   |
| **Polymarket** | Crypto-native exchange     | Every hour     |
| **Metaculus**  | Forecaster consensus       | Every 2 hours  |

All sources aggregated, deduplicated, and categorized automatically.

## Unique Capabilities

**Noise detection** — Serial correlation reversal analysis on 15-min probability snapshots. Classifies momentum as signal/weak/noise. "58% of price moves are noise."

**Consensus divergence** — Finds where Kalshi, Polymarket, and Metaculus disagree. STRONG divergences (>15%) mean at least one source is significantly wrong — that's where alpha lives.

**Agent accuracy tracking** — Brier scores, calibration curves, and edge-vs-market analysis. Build a verifiable prediction track record.

**Volume-weighted confidence** — Every probability includes a confidence grade (HIGH/MEDIUM/LOW/VERY_LOW) based on volume, liquidity, conviction, and time decay.

**Cross-source arbitrage** — $40M+ extracted from prediction market mispricings annually. This tool finds them automatically.

## Environment Variables

Works without credentials (returns demo data). For live markets:

```env
SUPABASE_URL=https://rrkjtdnxkscukexbsrue.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

## Links

- [npm package](https://www.npmjs.com/package/telekash-mcp-server)
- [GitHub](https://github.com/TeleKashOracle/mcp-server)
- [TeleKash Bot](https://t.me/TeleKashBot)

## License

MIT