/**
 * TeleKash Quick Start — Simplest possible example
 *
 * Run: npx tsx examples/quick-start.ts
 * No API key needed — free tier gets you 100 queries/day.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  // Connect to TeleKash Oracle
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["telekash-mcp-server"],
    env: {
      SUPABASE_URL: "https://rrkjtdnxkscukexbsrue.supabase.co",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
    },
  });

  const client = new Client({ name: "quick-start", version: "1.0.0" }, {});
  await client.connect(transport);

  // 1. What's trending? (biggest probability swings)
  console.log("\n📈 Trending Markets:");
  const trending = await client.callTool({
    name: "get_trending",
    arguments: { hours: 24, limit: 5 },
  });
  console.log(JSON.parse((trending.content as any)[0].text));

  // 2. Search for a specific topic
  console.log("\n🔍 Bitcoin Markets:");
  const search = await client.callTool({
    name: "search_markets",
    arguments: { query: "bitcoin", limit: 3 },
  });
  console.log(JSON.parse((search.content as any)[0].text));

  // 3. Get detailed probability for first result
  const markets = JSON.parse((search.content as any)[0].text);
  if (markets.markets?.length > 0) {
    console.log("\n📊 Detailed Probability:");
    const prob = await client.callTool({
      name: "get_probability",
      arguments: { market_id: markets.markets[0].id },
    });
    console.log(JSON.parse((prob.content as any)[0].text));
  }

  // 4. Check market stats
  console.log("\n📉 Market Stats:");
  const stats = await client.callTool({
    name: "get_market_stats",
    arguments: {},
  });
  console.log(JSON.parse((stats.content as any)[0].text));

  await client.close();
  console.log("\n✅ Done! Free tier: 96 queries remaining today.");
}

main().catch(console.error);
