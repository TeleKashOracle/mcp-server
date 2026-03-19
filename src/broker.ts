/**
 * TeleKash Broker Layer
 *
 * Routes agent trades to Polymarket CLOB or Kalshi REST API.
 * Smart router picks the best price across sources.
 * 1% commission on every filled trade — zero liquidity risk.
 *
 * "Chainlink is the price oracle. TeleKash is the probability oracle AND broker."
 *
 * Exchange Auth:
 * - Kalshi: RSA-signed requests (KALSHI_API_KEY + KALSHI_PRIVATE_KEY)
 * - Polymarket: HMAC-signed requests (POLY_API_KEY + POLY_API_SECRET + POLY_API_PASSPHRASE)
 */

import { createHmac, createSign } from "crypto";

// ============================================
// TYPES
// ============================================

export interface BrokerOrder {
  agent_id: string;
  market_id: string; // TeleKash market UUID or external_id
  side: "yes" | "no";
  amount_usd: number;
  order_type: "market" | "limit";
  limit_price?: number; // 0-1 probability (e.g. 0.65 = 65 cents)
  routing_preference?: "kalshi" | "polymarket" | "best_price" | "native_pool";
}

export interface BrokerResult {
  success: boolean;
  order_id?: string;
  exchange_order_id?: string;
  routed_to?: string;
  routing_reason?: string;
  fill_price?: number;
  fill_amount_usd?: number;
  commission_usd?: number;
  status: string;
  error?: string;
  market_title?: string;
}

export interface OrderStatus {
  order_id: string;
  status: string;
  routed_to: string;
  exchange_order_id?: string;
  fill_price?: number;
  fill_amount_usd?: number;
  commission_usd?: number;
  created_at: string;
  filled_at?: string;
}

interface ExchangeCredentials {
  kalshi: {
    apiKey: string;
    privateKey: string;
    baseUrl: string;
  } | null;
  polymarket: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    baseUrl: string;
  } | null;
}

interface MarketInfo {
  id: string;
  external_id: string;
  source: string;
  title: string;
  external_odds: { yes?: number; no?: number; prices?: number[] };
  status: string;
  raw_data?: Record<string, unknown>;
}

// ============================================
// EXCHANGE CLIENTS
// ============================================

/**
 * Kalshi Trading API Client
 *
 * Auth: RSA signature of timestamp + method + path
 * Docs: https://trading-api.kalshi.com/v2
 */
class KalshiClient {
  private apiKey: string;
  private privateKey: string;
  private baseUrl: string;

  constructor(apiKey: string, privateKey: string) {
    this.apiKey = apiKey;
    // Handle escaped newlines in env vars
    this.privateKey = privateKey.replace(/\\n/g, "\n");
    this.baseUrl = "https://trading-api.kalshi.com/trade-api/v2";
  }

  /**
   * Sign a request with RSA-PSS (Kalshi's required auth method)
   */
  private sign(timestamp: number, method: string, path: string): string {
    const message = `${timestamp}${method}${path}`;
    const signer = createSign("RSA-SHA256");
    signer.update(message);
    return signer.sign(
      { key: this.privateKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */ },
      "base64",
    );
  }

  /**
   * Make an authenticated request to Kalshi
   */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const fullPath = `/trade-api/v2${path}`;
    const signature = this.sign(timestamp, method, fullPath);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": this.apiKey,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp.toString(),
    };

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Place an order on Kalshi
   *
   * Kalshi prices are in cents (1-99).
   * "count" = number of contracts (each contract is $1 notional).
   */
  async placeOrder(params: {
    ticker: string;
    side: "yes" | "no";
    amount_usd: number;
    order_type: "market" | "limit";
    limit_price?: number; // 0-1 probability
  }): Promise<{
    order_id: string;
    status: string;
    fill_price?: number;
    filled_count?: number;
  }> {
    // Convert amount to contract count
    // Each contract = $1 notional. Price determines cost per contract.
    const priceInCents = params.limit_price
      ? Math.round(params.limit_price * 100)
      : undefined;

    // For market orders, estimate contracts from amount
    // For limit orders, contracts = amount / price
    const count = params.limit_price
      ? Math.floor(params.amount_usd / params.limit_price)
      : Math.floor(params.amount_usd); // market order: ~$1 per contract at worst

    const orderBody: Record<string, unknown> = {
      ticker: params.ticker,
      action: "buy",
      side: params.side,
      type: params.order_type === "limit" ? "limit" : "market",
      count: Math.max(1, count),
    };

    if (priceInCents && params.order_type === "limit") {
      orderBody[params.side === "yes" ? "yes_price" : "no_price"] =
        priceInCents;
    }

    const result = await this.request("POST", "/portfolio/orders", orderBody);

    const order = result.order as Record<string, unknown> | undefined;
    return {
      order_id: (order?.order_id as string) || "",
      status: (order?.status as string) || "unknown",
      fill_price: order?.avg_price
        ? (order.avg_price as number) / 100
        : undefined,
      filled_count: order?.filled_count as number | undefined,
    };
  }

  /**
   * Get order status
   */
  async getOrder(orderId: string): Promise<{
    order_id: string;
    status: string;
    fill_price?: number;
    filled_count?: number;
  }> {
    const result = await this.request("GET", `/portfolio/orders/${orderId}`);
    const order = result.order as Record<string, unknown> | undefined;
    return {
      order_id: (order?.order_id as string) || orderId,
      status: (order?.status as string) || "unknown",
      fill_price: order?.avg_price
        ? (order.avg_price as number) / 100
        : undefined,
      filled_count: order?.filled_count as number | undefined,
    };
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean }> {
    try {
      await this.request("DELETE", `/portfolio/orders/${orderId}`);
      return { success: true };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * Get the best available price for a ticker
   */
  async getOrderbook(ticker: string): Promise<{
    yes_bid: number;
    yes_ask: number;
    no_bid: number;
    no_ask: number;
  }> {
    const result = await this.request("GET", `/orderbook/${ticker}`);
    const orderbook = result.orderbook as Record<string, unknown> | undefined;
    return {
      yes_bid: ((orderbook?.yes_bid as number) || 0) / 100,
      yes_ask: ((orderbook?.yes_ask as number) || 0) / 100,
      no_bid: ((orderbook?.no_bid as number) || 0) / 100,
      no_ask: ((orderbook?.no_ask as number) || 0) / 100,
    };
  }
}

/**
 * Polymarket CLOB Client
 *
 * Auth: HMAC-SHA256 signature with API key/secret/passphrase
 * Docs: https://docs.polymarket.com/#clob-api
 */
class PolymarketClient {
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;
  private baseUrl: string;

  constructor(apiKey: string, apiSecret: string, apiPassphrase: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.baseUrl = "https://clob.polymarket.com";
  }

  /**
   * Sign a request with HMAC-SHA256
   */
  private sign(
    timestamp: string,
    method: string,
    path: string,
    body: string = "",
  ): string {
    const message = timestamp + method + path + body;
    return createHmac("sha256", Buffer.from(this.apiSecret, "base64"))
      .update(message)
      .digest("base64");
  }

  /**
   * Make an authenticated request to Polymarket CLOB
   */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const timestamp = (Date.now() / 1000).toFixed(0);
    const bodyStr = body ? JSON.stringify(body) : "";
    const signature = this.sign(timestamp, method.toUpperCase(), path, bodyStr);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "POLY-ADDRESS": this.apiKey,
      "POLY-SIGNATURE": signature,
      "POLY-TIMESTAMP": timestamp,
      "POLY-NONCE": Date.now().toString(),
      "POLY-API-KEY": this.apiKey,
      "POLY-PASSPHRASE": this.apiPassphrase,
    };

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Polymarket API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Place an order on Polymarket CLOB
   *
   * Polymarket uses token_id (from condition_id + outcome_index).
   * Prices are 0-1 (probability).
   * Size is in USDC (Polygon).
   */
  async placeOrder(params: {
    token_id: string; // The YES or NO token ID
    side: "BUY" | "SELL";
    price: number; // 0-1
    size: number; // USDC amount
    order_type: "GTC" | "FOK" | "GTD";
  }): Promise<{
    order_id: string;
    status: string;
    fill_price?: number;
    filled_size?: number;
  }> {
    const orderBody = {
      tokenID: params.token_id,
      price: params.price.toString(),
      size: params.size.toFixed(2),
      side: params.side,
      type: params.order_type,
      feeRateBps: 0, // Polymarket handles fees
    };

    const result = await this.request("POST", "/order", orderBody);

    return {
      order_id: (result.orderID as string) || (result.id as string) || "",
      status: (result.status as string) || "unknown",
      fill_price: result.matchedPrice
        ? parseFloat(result.matchedPrice as string)
        : undefined,
      filled_size: result.matchedSize
        ? parseFloat(result.matchedSize as string)
        : undefined,
    };
  }

  /**
   * Get order status
   */
  async getOrder(orderId: string): Promise<{
    order_id: string;
    status: string;
    fill_price?: number;
    filled_size?: number;
  }> {
    const result = await this.request("GET", `/order/${orderId}`);
    return {
      order_id: orderId,
      status: (result.status as string) || "unknown",
      fill_price: result.matchedPrice
        ? parseFloat(result.matchedPrice as string)
        : undefined,
      filled_size: result.matchedSize
        ? parseFloat(result.matchedSize as string)
        : undefined,
    };
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean }> {
    try {
      await this.request("DELETE", `/order/${orderId}`);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  /**
   * Get orderbook for a token
   */
  async getOrderbook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    best_bid: number;
    best_ask: number;
  }> {
    const result = await this.request("GET", `/book?token_id=${tokenId}`);

    const bids = (
      (result.bids as Array<{ price: string; size: string }>) || []
    ).map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = (
      (result.asks as Array<{ price: string; size: string }>) || []
    ).map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    return {
      bids,
      asks,
      best_bid: bids.length > 0 ? bids[0].price : 0,
      best_ask: asks.length > 0 ? asks[0].price : 0,
    };
  }
}

// ============================================
// SMART ROUTER
// ============================================

export interface NativePoolResult {
  position_id: string;
  stars_amount: number;
  usd_amount: number;
  exchange_rate: number;
  effective_price: number;
  potential_payout: number;
  status: string;
  pool_composition: {
    yes_count: number;
    no_count: number;
    total_volume: number;
    is_two_sided: boolean;
  };
}

export class TeleKashBroker {
  private kalshi: KalshiClient | null = null;
  private polymarket: PolymarketClient | null = null;
  private credentials: ExchangeCredentials;

  constructor() {
    this.credentials = {
      kalshi: null,
      polymarket: null,
    };

    // Initialize Kalshi if credentials available
    const kalshiKey = process.env.KALSHI_API_KEY;
    const kalshiPrivateKey = process.env.KALSHI_PRIVATE_KEY;
    if (kalshiKey && kalshiPrivateKey) {
      this.kalshi = new KalshiClient(kalshiKey, kalshiPrivateKey);
      this.credentials.kalshi = {
        apiKey: kalshiKey,
        privateKey: kalshiPrivateKey,
        baseUrl: "https://trading-api.kalshi.com/trade-api/v2",
      };
    }

    // Initialize Polymarket if credentials available
    const polyKey = process.env.POLY_API_KEY;
    const polySecret = process.env.POLY_API_SECRET;
    const polyPassphrase = process.env.POLY_API_PASSPHRASE;
    if (polyKey && polySecret && polyPassphrase) {
      this.polymarket = new PolymarketClient(
        polyKey,
        polySecret,
        polyPassphrase,
      );
      this.credentials.polymarket = {
        apiKey: polyKey,
        apiSecret: polySecret,
        apiPassphrase: polyPassphrase,
        baseUrl: "https://clob.polymarket.com",
      };
    }
  }

  /**
   * Check which exchanges are connected
   */
  getConnectedExchanges(): string[] {
    const connected: string[] = [];
    if (this.kalshi) connected.push("kalshi");
    if (this.polymarket) connected.push("polymarket");
    return connected;
  }

  /**
   * Smart route: find best execution venue for a trade
   *
   * Routing logic:
   * 1. If market exists on only one source → route there
   * 2. If market exists on both → compare prices → route to better price
   * 3. If routing_preference set → respect it
   * 4. If no exchange credentials → return error
   */
  async routeOrder(
    order: BrokerOrder,
    market: MarketInfo,
  ): Promise<BrokerResult> {
    const connected = this.getConnectedExchanges();

    if (connected.length === 0) {
      return {
        success: false,
        status: "failed",
        error:
          "No exchange credentials configured. Set KALSHI_API_KEY + KALSHI_PRIVATE_KEY or POLY_API_KEY + POLY_API_SECRET + POLY_API_PASSPHRASE environment variables.",
      };
    }

    const source = market.source;

    // Determine routing
    let routeTo: string;
    let routingReason: string;

    if (order.routing_preference && order.routing_preference !== "best_price") {
      // Agent explicitly chose an exchange
      if (!connected.includes(order.routing_preference)) {
        return {
          success: false,
          status: "failed",
          error: `${order.routing_preference} credentials not configured`,
        };
      }
      routeTo = order.routing_preference;
      routingReason = "agent_preference";
    } else if (source === "kalshi" && this.kalshi) {
      routeTo = "kalshi";
      routingReason = "only_source";
    } else if (source === "polymarket" && this.polymarket) {
      routeTo = "polymarket";
      routingReason = "only_source";
    } else if (this.kalshi && !this.polymarket) {
      routeTo = "kalshi";
      routingReason = "only_connected_exchange";
    } else if (this.polymarket && !this.kalshi) {
      routeTo = "polymarket";
      routingReason = "only_connected_exchange";
    } else {
      // Both connected — route to source of market data
      routeTo = source;
      routingReason = "source_match";
    }

    // Execute on the chosen exchange
    try {
      if (routeTo === "kalshi" && this.kalshi) {
        return await this.executeKalshi(order, market, routingReason);
      } else if (routeTo === "polymarket" && this.polymarket) {
        return await this.executePolymarket(order, market, routingReason);
      } else {
        return {
          success: false,
          status: "failed",
          error: `Cannot route to ${routeTo} — credentials not configured`,
        };
      }
    } catch (error) {
      return {
        success: false,
        status: "failed",
        error: `Exchange error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Execute a trade on Kalshi
   */
  private async executeKalshi(
    order: BrokerOrder,
    market: MarketInfo,
    routingReason: string,
  ): Promise<BrokerResult> {
    if (!this.kalshi) {
      return {
        success: false,
        status: "failed",
        error: "Kalshi not connected",
      };
    }

    // Extract Kalshi ticker from external_id or raw_data
    const ticker =
      market.source === "kalshi"
        ? market.external_id
        : (market.raw_data?.ticker as string) || market.external_id;

    const result = await this.kalshi.placeOrder({
      ticker,
      side: order.side,
      amount_usd: order.amount_usd,
      order_type: order.order_type,
      limit_price: order.limit_price,
    });

    const fillAmount = result.filled_count
      ? result.filled_count * (result.fill_price || order.limit_price || 0.5)
      : order.amount_usd;

    const commission = fillAmount * 0.01; // 1% commission

    return {
      success: result.status !== "rejected" && result.status !== "failed",
      order_id: undefined, // Set by caller after DB insert
      exchange_order_id: result.order_id,
      routed_to: "kalshi",
      routing_reason: routingReason,
      fill_price: result.fill_price,
      fill_amount_usd:
        result.status === "filled" || result.status === "resting"
          ? fillAmount
          : undefined,
      commission_usd: commission,
      status: mapExchangeStatus(result.status),
      market_title: market.title,
    };
  }

  /**
   * Execute a trade on Polymarket
   */
  private async executePolymarket(
    order: BrokerOrder,
    market: MarketInfo,
    routingReason: string,
  ): Promise<BrokerResult> {
    if (!this.polymarket) {
      return {
        success: false,
        status: "failed",
        error: "Polymarket not connected",
      };
    }

    // Extract token ID from raw_data
    // Polymarket uses condition_id + outcome tokens
    const rawData = market.raw_data || {};
    let tokenId: string;

    // Try to get the specific YES/NO token ID
    const tokens = rawData.tokens as
      | Array<{ token_id: string; outcome: string }>
      | undefined;
    if (tokens && tokens.length > 0) {
      const targetOutcome = order.side === "yes" ? "Yes" : "No";
      const token = tokens.find(
        (t) => t.outcome?.toLowerCase() === targetOutcome.toLowerCase(),
      );
      tokenId = token?.token_id || tokens[0].token_id;
    } else {
      // Fallback: use the market's condition_id or external_id
      tokenId = (rawData.condition_id as string) || market.external_id;
    }

    // Determine price
    const price =
      order.limit_price ||
      (order.side === "yes"
        ? market.external_odds?.yes ||
          (market.external_odds?.prices as number[])?.[0] ||
          0.5
        : market.external_odds?.no ||
          (market.external_odds?.prices as number[])?.[1] ||
          0.5);

    const result = await this.polymarket.placeOrder({
      token_id: tokenId,
      side: "BUY", // Buying YES or NO tokens
      price,
      size: order.amount_usd,
      order_type: order.order_type === "limit" ? "GTC" : "FOK",
    });

    const fillAmount = result.filled_size || order.amount_usd;
    const commission = fillAmount * 0.01;

    return {
      success: result.status !== "rejected" && result.status !== "failed",
      exchange_order_id: result.order_id,
      routed_to: "polymarket",
      routing_reason: routingReason,
      fill_price: result.fill_price,
      fill_amount_usd: result.filled_size,
      commission_usd: commission,
      status: mapExchangeStatus(result.status),
      market_title: market.title,
    };
  }

  /**
   * Get order status from the original exchange
   */
  async getOrderStatus(
    exchangeOrderId: string,
    exchange: string,
  ): Promise<OrderStatus | null> {
    try {
      if (exchange === "kalshi" && this.kalshi) {
        const result = await this.kalshi.getOrder(exchangeOrderId);
        return {
          order_id: exchangeOrderId,
          status: mapExchangeStatus(result.status),
          routed_to: "kalshi",
          exchange_order_id: result.order_id,
          fill_price: result.fill_price,
          fill_amount_usd: result.filled_count
            ? result.filled_count * (result.fill_price || 0.5)
            : undefined,
          created_at: new Date().toISOString(),
        };
      } else if (exchange === "polymarket" && this.polymarket) {
        const result = await this.polymarket.getOrder(exchangeOrderId);
        return {
          order_id: exchangeOrderId,
          status: mapExchangeStatus(result.status),
          routed_to: "polymarket",
          exchange_order_id: result.order_id,
          fill_price: result.fill_price,
          fill_amount_usd: result.filled_size,
          created_at: new Date().toISOString(),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Cancel an order on the original exchange
   */
  async cancelOrder(
    exchangeOrderId: string,
    exchange: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (exchange === "kalshi" && this.kalshi) {
        return await this.kalshi.cancelOrder(exchangeOrderId);
      } else if (exchange === "polymarket" && this.polymarket) {
        return await this.polymarket.cancelOrder(exchangeOrderId);
      }
      return { success: false, error: `Exchange ${exchange} not connected` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a market should route to native TeleKash pool instead of external exchange.
   *
   * Native pool routing happens when:
   * 1. Market has an active pool with existing positions (human liquidity)
   * 2. Agent explicitly requests native pool routing
   * 3. No external exchange credentials available (fallback)
   *
   * This creates dual-sided liquidity: human Stars + agent USD in the SAME pool.
   */
  shouldRouteToNativePool(
    market: MarketInfo,
    order: BrokerOrder,
    hasNativePool: boolean,
  ): boolean {
    // Agent explicitly chose native pool
    if (order.routing_preference === ("native_pool" as string)) {
      return true;
    }

    // If no external exchanges connected, native pool is the only option
    if (this.getConnectedExchanges().length === 0 && hasNativePool) {
      return true;
    }

    return false;
  }
}

/**
 * Map exchange-specific status to our unified status
 */
function mapExchangeStatus(status: string): string {
  const statusMap: Record<string, string> = {
    // Kalshi statuses
    resting: "submitted",
    pending: "pending",
    executed: "filled",
    canceled: "cancelled",
    // Polymarket statuses
    MATCHED: "filled",
    OPEN: "submitted",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
    // Generic
    filled: "filled",
    cancelled: "cancelled",
    rejected: "rejected",
    failed: "failed",
    partial: "partial",
  };

  return statusMap[status] || status;
}
