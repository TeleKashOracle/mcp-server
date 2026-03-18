"""
TeleKash + CrewAI — Prediction Market Analysis Crew

Three AI agents collaborate using TeleKash oracle data:
- Market Analyst: Scans markets and identifies opportunities
- Risk Assessor: Evaluates confidence and noise levels
- Portfolio Manager: Sizes positions using Kelly Criterion

Requirements:
  pip install crewai crewai-tools

Usage:
  export OPENAI_API_KEY="your-key"
  export TELEKASH_API_KEY="your-telekash-key"  # optional
  python crewai-team.py
"""

from crewai import Agent, Task, Crew, Process
from crewai_tools import MCPTool

# Connect to TeleKash MCP server
telekash_tools = MCPTool(
    command="npx",
    args=["telekash-mcp-server"],
    env={
        "SUPABASE_URL": "https://rrkjtdnxkscukexbsrue.supabase.co",
        "SUPABASE_ANON_KEY": "",  # Set your key
        "TELEKASH_API_KEY": "",   # Optional
    },
)

# Agent 1: Market Analyst
analyst = Agent(
    role="Prediction Market Analyst",
    goal="Find the highest-value prediction market opportunities",
    backstory="""You are an expert at analyzing prediction markets.
You use TeleKash Oracle to scan 500+ markets across Kalshi, Polymarket,
and Metaculus. You focus on markets with high volume, strong divergences
between sources, and clear catalysts.""",
    tools=telekash_tools.get_tools(),
    verbose=True,
)

# Agent 2: Risk Assessor
risk_assessor = Agent(
    role="Risk & Confidence Assessor",
    goal="Evaluate signal quality and filter out noise",
    backstory="""You specialize in distinguishing real market signals
from noise. You check confidence grades, analyze serial correlation
in probability movements, and flag thin markets. You never recommend
acting on VERY_LOW confidence data.""",
    tools=telekash_tools.get_tools(),
    verbose=True,
)

# Agent 3: Portfolio Manager
portfolio_mgr = Agent(
    role="Portfolio Manager",
    goal="Optimize position sizing for maximum expected value",
    backstory="""You use Kelly Criterion to size positions optimally.
You consider the agent's historical accuracy, current bankroll, and
risk tolerance. You never allocate more than quarter-Kelly to any
single position.""",
    tools=telekash_tools.get_tools(),
    verbose=True,
)

# Tasks
scan_task = Task(
    description="""Scan all prediction market categories for opportunities:
1. Use get_trending to find markets with big moves
2. Use detect_arbitrage to find cross-source mispricings
3. Use get_divergences to find where sources disagree
4. Return top 5 opportunities with reasoning""",
    expected_output="List of 5 market opportunities with probability, source, and reasoning",
    agent=analyst,
)

risk_task = Task(
    description="""For each opportunity identified by the analyst:
1. Check confidence grade using get_probability
2. Analyze momentum using get_history (is it signal or noise?)
3. Flag any markets with VERY_LOW confidence or thin volume
4. Rate each opportunity: GREEN (act) / YELLOW (watch) / RED (avoid)""",
    expected_output="Risk assessment for each opportunity with GREEN/YELLOW/RED rating",
    agent=risk_assessor,
    context=[scan_task],
)

sizing_task = Task(
    description="""For GREEN-rated opportunities only:
1. Use get_edge to compute Kelly-optimal position sizes
2. Apply quarter-Kelly constraint (max 25% of full Kelly)
3. Ensure total portfolio allocation doesn't exceed 50% of bankroll
4. Output final portfolio with position sizes and expected value

Assume a $10,000 bankroll.""",
    expected_output="Portfolio allocation with position sizes, expected returns, and risk metrics",
    agent=portfolio_mgr,
    context=[scan_task, risk_task],
)

# Create and run the crew
crew = Crew(
    agents=[analyst, risk_assessor, portfolio_mgr],
    tasks=[scan_task, risk_task, sizing_task],
    process=Process.sequential,
    verbose=True,
)

if __name__ == "__main__":
    result = crew.kickoff()
    print("\n" + "="*60)
    print("CREW RESULT:")
    print("="*60)
    print(result)
