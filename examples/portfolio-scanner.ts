/**
 * Portfolio Scanner — TeleKash MCP Example
 *
 * Scans all prediction markets, gets structured signals for each,
 * and builds a ranked portfolio sorted by verdict strength.
 *
 * Flow: list_markets -> get_signal (loop) -> rank by verdict
 *
 * Usage: npx tsx examples/portfolio-scanner.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CATEGORIES = ["crypto", "politics", "economics"] as const;
const MARKETS_PER_CATEGORY = 5;

async function main() {
  // Connect to TeleKash MCP server via stdio
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["telekash-mcp"],
  });
  const client = new Client({ name: "portfolio-scanner", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to TeleKash Oracle\n");

  // Step 1: Get market stats overview
  const stats = await client.callTool({
    name: "get_market_stats",
    arguments: {},
  });
  console.log("=== Market Overview ===");
  console.log(stats.content[0].text);
  console.log();

  // Step 2: Scan each category for top markets by volume
  const allSignals: Array<{
    title: string;
    category: string;
    verdict: string;
    signal: any;
  }> = [];

  for (const category of CATEGORIES) {
    console.log(`--- Scanning ${category} markets ---`);
    const markets = await client.callTool({
      name: "list_markets",
      arguments: { category, sort_by: "volume", limit: MARKETS_PER_CATEGORY },
    });

    const parsed = JSON.parse(markets.content[0].text);
    if (!parsed.markets?.length) {
      console.log(`  No active ${category} markets found.\n`);
      continue;
    }

    // Step 3: Get structured signal for each market
    for (const market of parsed.markets) {
      const signal = await client.callTool({
        name: "get_signal",
        arguments: { market_id: market.id },
      });

      const sig = JSON.parse(signal.content[0].text);
      const verdict = sig.verdict || "NO_SIGNAL";

      console.log(
        `  [${verdict}] ${market.title} (${Math.round(market.yes_probability)}% YES)`,
      );
      allSignals.push({ title: market.title, category, verdict, signal: sig });
    }
    console.log();
  }

  // Step 4: Rank by verdict strength
  const verdictRank: Record<string, number> = {
    STRONG_BUY: 6,
    STRONG_SELL: 5,
    BUY: 4,
    SELL: 3,
    HOLD: 2,
    NO_SIGNAL: 1,
  };

  allSignals.sort(
    (a, b) => (verdictRank[b.verdict] || 0) - (verdictRank[a.verdict] || 0),
  );

  console.log("=== Ranked Portfolio ===");
  console.log("Rank | Verdict     | Confidence | Market");
  console.log("-----|-------------|------------|-------");
  allSignals.forEach((s, i) => {
    const conf = s.signal.confidence?.grade || "N/A";
    console.log(
      `  ${i + 1}  | ${s.verdict.padEnd(11)} | ${conf.padEnd(10)} | ${s.title}`,
    );
  });

  // Summary
  const actionable = allSignals.filter((s) =>
    ["STRONG_BUY", "STRONG_SELL", "BUY", "SELL"].includes(s.verdict),
  );
  console.log(
    `\nActionable signals: ${actionable.length}/${allSignals.length}`,
  );
  console.log("Categories scanned:", CATEGORIES.join(", "));

  await client.close();
}

main().catch(console.error);
