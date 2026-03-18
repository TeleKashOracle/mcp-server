"""
TeleKash + OpenBB — Prediction Market Data for Quants

Wraps TeleKash MCP tools as an OpenBB-compatible data source.
Use alongside traditional market data for sentiment-augmented analysis.

Requirements:
  pip install openbb subprocess json

Usage:
  from openbb_connector import TeleKashProvider
  provider = TeleKashProvider()
  data = provider.get_market_probabilities(category="crypto")
  data = provider.get_arbitrage_opportunities(min_spread=5)
  data = provider.get_market_sentiment(market_id="...")
"""

import subprocess
import json
from typing import Optional


class TeleKashProvider:
    """OpenBB-compatible prediction market data provider using TeleKash MCP server."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self._server_cmd = ["npx", "telekash-mcp-server"]

    def _call_tool(self, tool_name: str, args: dict) -> dict:
        """Call a TeleKash MCP tool via stdio and return parsed JSON."""
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": args},
        }

        env = {
            "SUPABASE_URL": "https://rrkjtdnxkscukexbsrue.supabase.co",
            "SUPABASE_ANON_KEY": "",  # Set your key
            "PATH": "/usr/local/bin:/usr/bin:/bin",
        }
        if self.api_key:
            env["TELEKASH_API_KEY"] = self.api_key

        # Initialize MCP connection
        init_request = {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "openbb-telekash", "version": "1.0.0"},
            },
        }

        proc = subprocess.Popen(
            self._server_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        # Send init + tool call
        stdin_data = (
            json.dumps(init_request) + "\n" + json.dumps(request) + "\n"
        )
        stdout, stderr = proc.communicate(input=stdin_data.encode(), timeout=30)

        # Parse responses (skip init response, get tool response)
        lines = stdout.decode().strip().split("\n")
        for line in reversed(lines):
            try:
                resp = json.loads(line)
                if resp.get("id") == 1 and "result" in resp:
                    content = resp["result"].get("content", [])
                    if content and content[0].get("text"):
                        return json.loads(content[0]["text"])
            except (json.JSONDecodeError, KeyError):
                continue

        return {"error": "No response from TeleKash server"}

    # ===== OpenBB-Compatible Data Methods =====

    def get_market_probabilities(
        self,
        category: str = "all",
        sort_by: str = "volume",
        limit: int = 20,
        jurisdiction: str = "all",
    ) -> list[dict]:
        """Get prediction market probabilities (like get_quotes for prediction markets).

        Returns list of markets with probability, volume, source, and jurisdiction.
        """
        result = self._call_tool(
            "list_markets",
            {
                "category": category,
                "sort_by": sort_by,
                "limit": limit,
                "jurisdiction": jurisdiction,
            },
        )
        return result.get("markets", [])

    def get_market_detail(self, market_id: str) -> dict:
        """Get detailed probability data for a single market (like get_quote)."""
        return self._call_tool("get_probability", {"market_id": market_id})

    def get_historical_probabilities(
        self, market_id: str, timeframe: str = "7d"
    ) -> dict:
        """Get probability time series (like get_historical for prediction markets)."""
        return self._call_tool(
            "get_history", {"market_id": market_id, "timeframe": timeframe}
        )

    def get_arbitrage_opportunities(
        self, min_spread: float = 5.0, category: str = "all", limit: int = 10
    ) -> list[dict]:
        """Find cross-source arbitrage opportunities."""
        result = self._call_tool(
            "detect_arbitrage",
            {"min_spread": min_spread, "category": category, "limit": limit},
        )
        return result.get("opportunities", [])

    def get_market_sentiment(self, market_id: str) -> dict:
        """Get AI sentiment analysis for a prediction market."""
        return self._call_tool("get_sentiment", {"market_id": market_id})

    def get_market_statistics(self) -> dict:
        """Get aggregate prediction market statistics."""
        return self._call_tool("get_market_stats", {})

    def get_divergences(
        self, min_spread: float = 5.0, limit: int = 10
    ) -> list[dict]:
        """Find consensus divergences across prediction sources."""
        result = self._call_tool(
            "get_divergences", {"min_spread": min_spread, "limit": limit}
        )
        return result.get("divergences", [])

    def get_trending_markets(
        self, timeframe: str = "24h", limit: int = 10
    ) -> list[dict]:
        """Get markets with biggest probability swings."""
        result = self._call_tool(
            "get_trending", {"timeframe": timeframe, "limit": limit}
        )
        return result.get("trending", [])


# Example usage
if __name__ == "__main__":
    provider = TeleKashProvider()

    print("=== Crypto Prediction Markets ===")
    markets = provider.get_market_probabilities(category="crypto", limit=5)
    for m in markets:
        print(
            f"  {m.get('title', 'N/A')}: {m.get('yes_probability', '?')}% YES "
            f"({m.get('jurisdiction', 'N/A')})"
        )

    print("\n=== Arbitrage Opportunities ===")
    arbs = provider.get_arbitrage_opportunities(min_spread=3)
    for a in arbs:
        print(f"  {a.get('title', 'N/A')}: {a.get('spread', '?')}% spread")

    print("\n=== Market Statistics ===")
    stats = provider.get_market_statistics()
    print(f"  {json.dumps(stats, indent=2)}")
