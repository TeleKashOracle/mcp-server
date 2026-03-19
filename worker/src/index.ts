/**
 * TeleKash MCP — Remote Streamable HTTP Endpoint
 *
 * Cloudflare Worker that serves the TeleKash Oracle as a remote MCP server.
 * Implements MCP Streamable HTTP transport (JSON-RPC 2.0 over POST).
 *
 * Endpoint: POST /mcp
 * Auth: Authorization: Bearer <api-key>
 * Session: Mcp-Session-Id header
 *
 * "Local npx = friction. One URL = everywhere." — Magician's Playbook #12
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { handleToolCall } from "./tools.js";
import { TOOLS, TIER_CONFIGS, TIER_REQUIRED, type Tier } from "./schema.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

// Session store (in-memory, per-isolate — Workers are stateless across requests
// but session headers provide continuity for multi-turn conversations)
const sessions = new Map<
  string,
  { tier: Tier; keyHash: string; created: number }
>();

// ─── JSON-RPC Types ──────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── CORS ────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsResponse(
  status: number,
  body?: string,
  extra?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extra },
  });
}

// ─── Auth ────────────────────────────────────────────────────

async function authenticateRequest(
  request: Request,
  supabase: SupabaseClient,
): Promise<{ tier: Tier; keyHash: string; callsRemaining: number } | Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    // No key = free tier
    return { tier: "free" as Tier, keyHash: "anonymous", callsRemaining: 100 };
  }

  const apiKey = authHeader.slice(7).trim();

  // Hash the key for lookup (same as main server)
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Check rate limit via Supabase RPC
  const { data: rateData, error } = await supabase.rpc("check_rate_limit", {
    p_key_hash: keyHash,
  });

  if (error || !rateData) {
    return corsResponse(
      401,
      JSON.stringify({
        error: "invalid_api_key",
        message:
          "API key not found or invalid. Get one free at https://t.me/TeleKashBot",
      }),
    );
  }

  return {
    tier: (rateData.tier || "free") as Tier,
    keyHash,
    callsRemaining: rateData.calls_remaining ?? 100,
  };
}

// ─── MCP Protocol Handlers ───────────────────────────────────

function handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id ?? null,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "telekash-oracle",
        version: "0.8.0",
      },
    },
  };
}

function handleListTools(req: JsonRpcRequest, tier: Tier): JsonRpcResponse {
  const tierConfig = TIER_CONFIGS[tier];
  const visibleTools = TOOLS.filter((t) => tierConfig.tools.includes(t.name));

  return {
    jsonrpc: "2.0",
    id: req.id ?? null,
    result: { tools: visibleTools },
  };
}

async function handleCallTool(
  req: JsonRpcRequest,
  tier: Tier,
  callsRemaining: number,
  supabase: SupabaseClient,
  keyHash: string,
): Promise<JsonRpcResponse> {
  const params = req.params as
    | { name: string; arguments?: Record<string, unknown> }
    | undefined;
  if (!params?.name) {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: -32602, message: "Missing tool name in params" },
    };
  }

  const { name, arguments: args } = params;

  // Check tier access
  const tierConfig = TIER_CONFIGS[tier];
  if (!tierConfig.tools.includes(name)) {
    const requiredTier = TIER_REQUIRED[name] || "edge";
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "tier_restricted",
                tool: name,
                your_tier: tier,
                required_tier: requiredTier,
                upgrade: "Contact @TeleKashBot for tier upgrade",
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      },
    };
  }

  // Execute tool
  const startTime = Date.now();
  try {
    const result = await handleToolCall(name, args || {}, supabase, tier);

    // Inject citation
    for (const item of result.content) {
      if (item.type === "text") {
        try {
          const parsed = JSON.parse(item.text);
          if (typeof parsed === "object" && parsed !== null) {
            parsed._source = "According to TeleKash Oracle (remote-mcp)";
            parsed._tier = tier;
            parsed._transport = "streamable-http";
            if (callsRemaining < 20) {
              parsed._rate_limit_warning = `${callsRemaining} calls remaining today (${tier} tier)`;
            }
            item.text = JSON.stringify(parsed, null, 2);
          }
        } catch {
          // Not JSON — leave as-is
        }
      }
    }

    // Log usage async (fire and forget)
    const responseTimeMs = Date.now() - startTime;
    Promise.resolve(
      supabase.from("telekash_usage_logs").insert({
        api_key_id: keyHash.substring(0, 16),
        tool_name: name,
        tier,
        response_time_ms: responseTimeMs,
        transport: "streamable-http",
      }),
    ).catch(() => {});

    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      },
    };
  }
}

// ─── Main Handler ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(204);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return corsResponse(
        200,
        JSON.stringify({
          status: "ok",
          server: "telekash-oracle",
          version: "0.8.0",
          transport: "streamable-http",
          tools: TOOLS.length,
          endpoint: "/mcp",
          docs: "https://github.com/TeleKashOracle/mcp-server",
        }),
      );
    }

    // Discovery endpoint — returns server info for clients that GET /mcp
    if (url.pathname === "/mcp" && request.method === "GET") {
      return corsResponse(
        200,
        JSON.stringify({
          name: "telekash-oracle",
          version: "0.8.0",
          protocol: "mcp-streamable-http",
          protocolVersion: "2025-03-26",
          tools: TOOLS.length,
          tiers: {
            free: { tools: TIER_CONFIGS.free.tools.length, calls_per_day: 100 },
            calibration: {
              tools: TIER_CONFIGS.calibration.tools.length,
              calls_per_day: 1000,
              price: "$99/mo",
            },
            edge: {
              tools: TIER_CONFIGS.edge.tools.length,
              calls_per_day: "unlimited",
              price: "$499/mo",
            },
          },
          auth: "Bearer <api-key> (optional, free tier without key)",
          endpoint: "POST /mcp",
        }),
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      // Initialize Supabase
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

      // Authenticate
      const authResult = await authenticateRequest(request, supabase);
      if (authResult instanceof Response) return authResult;
      const { tier, keyHash, callsRemaining } = authResult;

      // Session management
      let sessionId = request.headers.get("Mcp-Session-Id");
      if (!sessionId) {
        sessionId = crypto.randomUUID();
      }
      sessions.set(sessionId, { tier, keyHash, created: Date.now() });

      // Parse JSON-RPC
      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        return corsResponse(
          400,
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error — invalid JSON" },
          }),
        );
      }

      // Handle batch requests
      const requests = Array.isArray(body) ? body : [body];
      const responses: JsonRpcResponse[] = [];

      for (const req of requests) {
        // Validate JSON-RPC
        if (req.jsonrpc !== "2.0" || !req.method) {
          responses.push({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32600, message: "Invalid JSON-RPC request" },
          });
          continue;
        }

        let response: JsonRpcResponse;

        switch (req.method) {
          case "initialize":
            response = handleInitialize(req);
            break;

          case "notifications/initialized":
            // Client acknowledgement — no response needed for notifications
            continue;

          case "tools/list":
            response = handleListTools(req, tier);
            break;

          case "tools/call":
            response = await handleCallTool(
              req,
              tier,
              callsRemaining,
              supabase,
              keyHash,
            );
            break;

          case "ping":
            response = { jsonrpc: "2.0", id: req.id ?? null, result: {} };
            break;

          default:
            response = {
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: {
                code: -32601,
                message: `Method not found: ${req.method}`,
              },
            };
        }

        // Only include responses for requests (not notifications)
        if (req.id !== undefined) {
          responses.push(response);
        }
      }

      // Return single response or batch
      const responseBody = Array.isArray(body)
        ? JSON.stringify(responses)
        : JSON.stringify(
            responses[0] || { jsonrpc: "2.0", id: null, result: {} },
          );

      return corsResponse(200, responseBody, {
        "Mcp-Session-Id": sessionId,
      });
    }

    // DELETE /mcp — close session
    if (url.pathname === "/mcp" && request.method === "DELETE") {
      const sessionId = request.headers.get("Mcp-Session-Id");
      if (sessionId) sessions.delete(sessionId);
      return corsResponse(200, JSON.stringify({ status: "session_closed" }));
    }

    return corsResponse(
      404,
      JSON.stringify({ error: "Not found. Use POST /mcp for MCP protocol." }),
    );
  },
};
