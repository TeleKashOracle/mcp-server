# TeleKash Prediction Oracle — MCP Server

The probability oracle for the agent economy. Aggregates prediction markets from Kalshi (CFTC-regulated) and Polymarket into one API.

> "Chainlink is the price oracle. TeleKash is the probability oracle."

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

## What You Get

**9 oracle tools** querying 480+ live markets from Kalshi and Polymarket, synced every 15 minutes.

| Tool               | What It Does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `get_probability`  | Real-time YES/NO probability with volume-weighted confidence score                                |
| `list_markets`     | Browse markets by category (crypto, politics, sports, economics, entertainment, science, weather) |
| `search_markets`   | Full-text search across all markets                                                               |
| `get_history`      | Historical probability changes with trend detection                                               |
| `get_sentiment`    | AI sentiment analysis — conviction, momentum, volume signals, recommendation                      |
| `get_market_stats` | Aggregate statistics across all markets                                                           |
| `get_trending`     | Markets with biggest probability swings — momentum detection                                      |
| `compare_sources`  | Kalshi vs Polymarket odds comparison — find pricing discrepancies                                 |
| `detect_arbitrage` | Cross-source arbitrage detection with buy/sell signals and spread analysis                        |

## Examples

Ask your AI agent:

- **"What are the odds Trump wins 2028?"** → `get_probability` → returns YES/NO percentages with confidence score
- **"Find arbitrage opportunities in crypto markets"** → `detect_arbitrage` → cross-source mispricings with buy/sell signals
- **"Show me trending crypto predictions"** → `get_trending` → markets with biggest swings
- **"Compare Fed rate cut odds across sources"** → `compare_sources` → Kalshi vs Polymarket side-by-side
- **"What's the sentiment on Bitcoin markets?"** → `get_sentiment` → bullish/bearish/neutral with confidence
- **"Show me high-volume political markets"** → `list_markets(category: "politics", sort_by: "volume")`

## Data Sources

- **Kalshi** — CFTC-regulated US prediction markets (synced every 15 min)
- **Polymarket** — Crypto-native prediction markets (synced every hour)

Both sources are aggregated, deduplicated, and categorized automatically.

## Environment Variables

Works without credentials (returns demo data). For live markets:

```env
SUPABASE_URL=https://rrkjtdnxkscukexbsrue.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

## Unique Capabilities

**Arbitrage detection** — Scans all markets to find events priced differently across Kalshi and Polymarket. Academic research shows $40M+ extracted from prediction market mispricings annually.

**Volume-weighted confidence scores** — Every probability comes with a confidence grade (HIGH/MEDIUM/LOW) based on volume, liquidity, probability conviction, and time decay. "Prices on thin markets are lies."

**Cross-source comparison** — The only prediction market MCP that aggregates both Kalshi and Polymarket in one API. Compare how regulated vs unregulated markets price the same event.

**Live sentiment analysis** — Computed from probability conviction, trading volume, momentum, and time-to-close. Not a static score — recalculated on every query.

**Momentum detection** — Surface markets where consensus is shifting. Find breaking events before they're priced in.

## Links

- [npm package](https://www.npmjs.com/package/telekash-mcp-server)
- [TeleKash Bot](https://t.me/TeleKashBot)

## License

MIT
