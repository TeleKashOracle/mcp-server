/**
 * TeleKash Arbitrage Scanner — Find mispricings between exchanges
 *
 * Scans Kalshi vs Polymarket for probability gaps > 5%.
 * These gaps represent potential arbitrage opportunities.
 *
 * Run: npx tsx examples/arbitrage-scanner.ts
 * Requires: Calibration tier ($0.01/query) — free tier can't access arbitrage tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["telekash-mcp-server"],
    env: {
      SUPABASE_URL: "https://rrkjtdnxkscukexbsrue.supabase.co",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
      TELEKASH_API_KEY: process.env.TELEKASH_API_KEY || "",
    },
  });

  const client = new Client(
    { name: "arbitrage-scanner", version: "1.0.0" },
    {},
  );
  await client.connect(transport);

  console.log("🔍 Scanning for arbitrage opportunities...\n");

  // 1. Detect cross-source arbitrage
  const arb = await client.callTool({
    name: "detect_arbitrage",
    arguments: { min_spread: 5 },
  });
  const arbData = JSON.parse((arb.content as any)[0].text);

  if (arbData.opportunities?.length > 0) {
    console.log(
      `Found ${arbData.opportunities.length} arbitrage opportunities:\n`,
    );

    for (const opp of arbData.opportunities) {
      console.log(`  📊 ${opp.title}`);
      console.log(
        `     Kalshi: ${opp.kalshi_price}% | Polymarket: ${opp.polymarket_price}%`,
      );
      console.log(`     Spread: ${opp.spread}% | Signal: ${opp.signal}`);
      console.log(
        `     Action: Buy ${opp.buy_on} at ${opp.buy_price}%, Sell ${opp.sell_on} at ${opp.sell_price}%`,
      );
      console.log();
    }
  } else {
    console.log("No arbitrage opportunities found above 5% spread.");
  }

  // 2. Check source divergences (where consensus breaks)
  console.log("\n🔀 Source Divergences (where experts disagree):\n");
  const div = await client.callTool({
    name: "get_divergences",
    arguments: { min_divergence: 10 },
  });
  const divData = JSON.parse((div.content as any)[0].text);

  if (divData.divergences?.length > 0) {
    for (const d of divData.divergences.slice(0, 5)) {
      console.log(`  ⚡ ${d.title}`);
      console.log(`     Sources disagree by ${d.max_divergence}%`);
      console.log(`     ${JSON.stringify(d.probabilities)}`);
      console.log();
    }
  }

  // 3. Compare specific market across sources
  console.log("\n📈 Cross-source comparison for trending markets:\n");
  const trending = await client.callTool({
    name: "get_trending",
    arguments: { hours: 24, limit: 3 },
  });
  const trendData = JSON.parse((trending.content as any)[0].text);

  for (const market of trendData.markets?.slice(0, 3) || []) {
    const compare = await client.callTool({
      name: "compare_sources",
      arguments: { market_id: market.id },
    });
    const compData = JSON.parse((compare.content as any)[0].text);
    console.log(`  ${market.title}`);
    console.log(`  Sources: ${JSON.stringify(compData.sources || {})}`);
    console.log();
  }

  await client.close();
  console.log("✅ Scan complete.");
}

main().catch(console.error);
