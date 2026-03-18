/**
 * Market Monitor — TeleKash MCP Example
 *
 * Watches a specific prediction market and logs its current probability,
 * historical trend, and AI sentiment analysis.
 *
 * Flow: get_probability -> get_history -> get_sentiment
 *
 * Usage: npx tsx examples/market-monitor.ts [market_id_or_query]
 * Example: npx tsx examples/market-monitor.ts "Bitcoin 200K"
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_QUERY = "Bitcoin price";

async function main() {
  const query = process.argv[2] || DEFAULT_QUERY;

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["telekash-mcp"],
  });
  const client = new Client({ name: "market-monitor", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to TeleKash Oracle\n");

  // Step 1: Find the market and get current probability
  console.log(`Searching for: "${query}"\n`);
  const probResult = await client.callTool({
    name: "get_probability",
    arguments: { query },
  });

  const prob = JSON.parse(probResult.content[0].text);
  if (prob.error) {
    console.log("Market not found:", prob.error);
    await client.close();
    return;
  }

  const marketId = prob.market_id;
  console.log("=== Current State ===");
  console.log(`Market: ${prob.title}`);
  console.log(`Source: ${prob.source}`);
  console.log(`Status: ${prob.status}`);
  console.log(`YES: ${prob.yes_probability}% | NO: ${prob.no_probability}%`);
  console.log(`Volume (24h): $${(prob.volume_24h || 0).toLocaleString()}`);
  console.log(`Closes: ${prob.closes_at}`);
  console.log(`Last updated: ${prob.last_updated}\n`);

  // Step 2: Get probability history across timeframes
  console.log("=== Trend History ===");
  for (const timeframe of ["1h", "24h", "7d"] as const) {
    const history = await client.callTool({
      name: "get_history",
      arguments: { market_id: marketId, timeframe },
    });

    const hist = JSON.parse(history.content[0].text);
    const snapshots = hist.snapshots || hist.history || [];
    if (snapshots.length === 0) {
      console.log(`  ${timeframe}: No data available`);
      continue;
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const startProb = first.yes_probability || first.probability;
    const endProb = last.yes_probability || last.probability;
    const delta = endProb - startProb;
    const arrow = delta > 0 ? "+" : "";

    console.log(
      `  ${timeframe}: ${startProb}% -> ${endProb}% (${arrow}${delta.toFixed(1)}%) [${snapshots.length} snapshots]`,
    );
  }
  console.log();

  // Step 3: Get AI sentiment analysis
  console.log("=== AI Sentiment ===");
  const sentResult = await client.callTool({
    name: "get_sentiment",
    arguments: { market_id: marketId },
  });

  const sent = JSON.parse(sentResult.content[0].text);
  console.log(
    `Sentiment score: ${sent.sentiment_score} (range: -1 bearish to +1 bullish)`,
  );
  console.log(`Recommendation: ${sent.recommendation}`);
  console.log(`Confidence: ${sent.confidence || "N/A"}`);

  if (sent.reasoning) {
    console.log(`Reasoning: ${sent.reasoning}`);
  }
  console.log();

  // Summary verdict
  const bullish = (sent.sentiment_score || 0) > 0.2;
  const bearish = (sent.sentiment_score || 0) < -0.2;
  const direction = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";
  console.log(`=== Summary: ${prob.title} ===`);
  console.log(
    `Probability: ${prob.yes_probability}% YES | Sentiment: ${direction}`,
  );
  console.log(`Recommendation: ${sent.recommendation || "N/A"}`);

  await client.close();
}

main().catch(console.error);
