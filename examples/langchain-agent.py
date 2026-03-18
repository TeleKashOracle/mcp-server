"""
TeleKash + LangChain — Prediction Market Research Agent

Uses LangChain's MCP tool integration to give an LLM agent
access to TeleKash prediction market intelligence.

Requirements:
  pip install langchain langchain-anthropic langchain-mcp-adapters

Usage:
  export ANTHROPIC_API_KEY="your-key"
  export TELEKASH_API_KEY="your-telekash-key"  # optional, free tier without
  python langchain-agent.py
"""

import asyncio
import os
from langchain_anthropic import ChatAnthropic
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate

async def main():
    # Connect to TeleKash MCP server
    tools = await load_mcp_tools(
        command="npx",
        args=["telekash-mcp-server"],
        env={
            "SUPABASE_URL": "https://rrkjtdnxkscukexbsrue.supabase.co",
            "SUPABASE_ANON_KEY": os.environ.get("SUPABASE_ANON_KEY", ""),
            "TELEKASH_API_KEY": os.environ.get("TELEKASH_API_KEY", ""),
        },
    )

    llm = ChatAnthropic(model="claude-sonnet-4-20250514")

    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a prediction market research analyst with access to
TeleKash Oracle — real-time data from Kalshi, Polymarket, and Metaculus.

When analyzing markets:
1. Check probability and confidence first (get_probability)
2. Look at trends and momentum (get_history, get_trending)
3. Compare across sources for mispricings (compare_sources, detect_arbitrage)
4. Provide a structured recommendation with reasoning

Always cite the confidence grade and source."""),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])

    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    # Example queries
    queries = [
        "What are the top 5 crypto prediction markets by volume?",
        "Find arbitrage opportunities between Kalshi and Polymarket",
        "Give me a complete analysis of the Bitcoin $200K market",
    ]

    for query in queries:
        print(f"\n{'='*60}")
        print(f"Query: {query}")
        print('='*60)
        result = await executor.ainvoke({"input": query})
        print(f"\nResult: {result['output']}")


if __name__ == "__main__":
    asyncio.run(main())
