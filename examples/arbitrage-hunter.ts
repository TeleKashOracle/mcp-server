/**
 * Arbitrage Hunter — TeleKash MCP Example
 *
 * Monitors cross-source pricing spreads between Kalshi and Polymarket,
 * then gets full signals for the best opportunities.
 *
 * Flow: detect_arbitrage -> get_signal (top opportunities) -> alert
 *
 * Usage: npx tsx examples/arbitrage-hunter.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MIN_SPREAD = 3; // Minimum spread % to flag
const SCAN_INTERVAL_MS = 60_000; // Re-scan every 60 seconds
const MAX_SCANS = 5; // Stop after N scans (remove for continuous monitoring)

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["telekash-mcp"],
  });
  const client = new Client({ name: "arbitrage-hunter", version: "1.0.0" });
  await client.connect(transport);
  console.log("Arbitrage Hunter connected to TeleKash Oracle");
  console.log(`Minimum spread threshold: ${MIN_SPREAD}%\n`);

  let scanCount = 0;

  while (scanCount < MAX_SCANS) {
    scanCount++;
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`\n=== Scan #${scanCount} at ${timestamp} ===`);

    // Step 1: Detect arbitrage opportunities across all categories
    const result = await client.callTool({
      name: "detect_arbitrage",
      arguments: { min_spread: MIN_SPREAD, limit: 10 },
    });

    const data = JSON.parse(result.content[0].text);
    const opportunities = data.opportunities || [];

    if (opportunities.length === 0) {
      console.log(`No arbitrage opportunities above ${MIN_SPREAD}% spread.`);
    } else {
      console.log(`Found ${opportunities.length} opportunities:\n`);

      // Step 2: For top 3 opportunities, get full signal analysis
      const topOpps = opportunities.slice(0, 3);

      for (const opp of topOpps) {
        console.log(`  ${opp.title || opp.query}`);
        console.log(
          `    Kalshi: ${opp.kalshi_probability}% | Polymarket: ${opp.polymarket_probability}%`,
        );
        console.log(`    Spread: ${opp.spread}% | Direction: ${opp.direction}`);

        // Get structured signal for deeper analysis
        if (opp.kalshi_id || opp.polymarket_id) {
          const signal = await client.callTool({
            name: "get_signal",
            arguments: { market_id: opp.kalshi_id || opp.polymarket_id },
          });
          const sig = JSON.parse(signal.content[0].text);
          console.log(
            `    Signal verdict: ${sig.verdict} | Confidence: ${sig.confidence?.grade || "N/A"}`,
          );
          console.log(`    Noise filter: ${sig.noise_filter || "N/A"}`);
        }
        console.log();
      }

      // Alert summary
      const bigSpreads = opportunities.filter((o: any) => o.spread >= 10);
      if (bigSpreads.length > 0) {
        console.log(
          `** ALERT: ${bigSpreads.length} opportunities with 10%+ spread **`,
        );
        bigSpreads.forEach((o: any) => {
          console.log(`   -> ${o.title}: ${o.spread}% spread`);
        });
      }
    }

    // Wait before next scan (skip wait on last scan)
    if (scanCount < MAX_SCANS) {
      console.log(`\nNext scan in ${SCAN_INTERVAL_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
    }
  }

  console.log("\nArbitrage Hunter finished. Scans completed:", scanCount);
  await client.close();
}

main().catch(console.error);
