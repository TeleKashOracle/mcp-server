"""
TeleKash + AutoGen — Multi-Agent Prediction Market Discussion

Uses Microsoft AutoGen to create agents that debate prediction
market positions using TeleKash oracle data.

Requirements:
  pip install autogen-agentchat autogen-ext[mcp]

Usage:
  export OPENAI_API_KEY="your-key"
  python autogen-agent.py
"""

import asyncio
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.conditions import TextMentionTermination
from autogen_ext.tools.mcp import StdioMCPToolAdapter, StdioServerParams


async def main():
    # Connect to TeleKash MCP server
    server_params = StdioServerParams(
        command="npx",
        args=["telekash-mcp-server"],
        env={
            "SUPABASE_URL": "https://rrkjtdnxkscukexbsrue.supabase.co",
            "SUPABASE_ANON_KEY": "",  # Set your key
        },
    )

    # Load MCP tools
    adapter = StdioMCPToolAdapter(server_params)
    tools = await adapter.get_tools()

    # Bull agent — looks for buying opportunities
    bull = AssistantAgent(
        name="Bull_Analyst",
        system_message="""You are a bullish prediction market analyst.
You look for markets where the YES probability seems too low based on
available evidence. Use TeleKash tools to find undervalued YES positions.
Focus on high-confidence markets with strong volume. Present your case
with data.""",
        tools=tools,
    )

    # Bear agent — looks for selling opportunities
    bear = AssistantAgent(
        name="Bear_Analyst",
        system_message="""You are a skeptical prediction market analyst.
You challenge bullish assumptions and look for overpriced markets.
Use TeleKash tools to check if high-probability markets are backed by
real volume or just noise. Flag thin markets and overconfident pricing.""",
        tools=tools,
    )

    # Arbiter — makes the final call
    arbiter = AssistantAgent(
        name="Portfolio_Arbiter",
        system_message="""You are the final decision maker. After hearing
from both the Bull and Bear analysts, you decide which positions to take.
Use get_edge to compute Kelly-optimal sizing for approved positions.
Your output should be a final portfolio recommendation.
When done, say APPROVED to end the discussion.""",
        tools=tools,
    )

    # Group chat — agents take turns
    termination = TextMentionTermination("APPROVED")
    team = RoundRobinGroupChat(
        participants=[bull, bear, arbiter],
        termination_condition=termination,
        max_turns=6,
    )

    # Run the discussion
    result = await team.run(
        task="""Analyze the current crypto prediction market landscape.
The Bull should find the best buying opportunity, the Bear should
challenge it, and the Arbiter should make the final allocation
decision with a $5,000 bankroll."""
    )

    print("\n" + "=" * 60)
    print("TEAM RESULT:")
    print("=" * 60)
    for msg in result.messages:
        print(f"\n[{msg.source}]: {msg.content[:500]}")


if __name__ == "__main__":
    asyncio.run(main())
