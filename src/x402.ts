/**
 * x402 Payment Integration for TeleKash MCP Server
 *
 * HTTP 402 Payment Required — the internet's native paywall protocol.
 * Coinbase/Cloudflare standard for machine-to-machine micropayments.
 *
 * Two modes:
 * 1. STDIO mode (current): Return payment instructions in tool responses.
 *    Agent's x402-aware client sees the 402 pattern and handles payment.
 * 2. HTTP mode (future Cloudflare Workers): Use paymentMiddleware directly.
 *
 * Payment address: loaded from TELEKASH_PAYMENT_ADDRESS env var.
 * Supported: USDC on Base (default), extensible to other chains.
 *
 * This is ADDITIVE — does not replace the tier system. Agents can either:
 *   (a) Use API keys + tiers (existing flow)
 *   (b) Pay per-call with USDC via x402 (new flow)
 *
 * @version 1.0.0
 */

// ============================================
// TYPES
// ============================================

export interface X402PaymentOption {
  /** Blockchain network — "base" for mainnet, "base-sepolia" for testnet */
  network: string;
  /** Token symbol */
  asset: string;
  /** Recipient wallet address (TeleKash treasury) */
  address: string;
  /** Amount in smallest unit (e.g. "10000" = $0.01 USDC with 6 decimals) */
  amount: string;
}

export interface X402PaymentRequired {
  x402_version: 1;
  payment_required: true;
  /** Tool that requires payment */
  tool: string;
  /** Price in USD */
  price_usd: number;
  /** Accepted payment methods */
  payment_options: X402PaymentOption[];
  /** ISO timestamp — payment instructions expire after this time */
  expires_at: string;
  /** Human-readable message for the agent */
  message: string;
}

export interface X402PaymentProof {
  /** Transaction hash on the payment network */
  tx_hash: string;
  /** Network the payment was made on */
  network: string;
  /** Amount paid in USD */
  amount_usd?: number;
}

export interface X402PaymentVerified {
  x402_version: 1;
  payment_verified: true;
  tx_hash: string;
  amount_usd: number;
  network: string;
}

// ============================================
// CONFIGURATION
// ============================================

/** USDC has 6 decimal places */
const USDC_DECIMALS = 6;

/** Payment instructions expire after 5 minutes */
const PAYMENT_EXPIRY_MS = 5 * 60 * 1000;

/** Default network for payments */
const DEFAULT_NETWORK = "base";

/** Supported networks and their USDC contract addresses (for reference) */
const SUPPORTED_NETWORKS: Record<string, { chain_id: number; usdc: string }> = {
  base: {
    chain_id: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  "base-sepolia": {
    chain_id: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

// ============================================
// PAYMENT REQUIRED — Generate 402 instructions
// ============================================

/**
 * Create x402 payment-required instructions for a tool call.
 *
 * The agent's x402-aware client will parse this, execute the USDC transfer,
 * and retry the tool call with the payment proof attached.
 *
 * @param tool - Tool name that requires payment
 * @param priceUsd - Price in USD (e.g. 0.01, 0.05)
 * @param paymentAddress - Wallet address to receive payment
 * @returns X402PaymentRequired object
 */
export function createPaymentRequired(
  tool: string,
  priceUsd: number,
  paymentAddress: string,
): X402PaymentRequired {
  const amountSmallestUnit = Math.round(
    priceUsd * 10 ** USDC_DECIMALS,
  ).toString();
  const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MS).toISOString();

  const paymentOptions: X402PaymentOption[] = [];

  // Add all supported networks as payment options
  for (const [network] of Object.entries(SUPPORTED_NETWORKS)) {
    paymentOptions.push({
      network,
      asset: "USDC",
      address: paymentAddress,
      amount: amountSmallestUnit,
    });
  }

  return {
    x402_version: 1,
    payment_required: true,
    tool,
    price_usd: priceUsd,
    payment_options: paymentOptions,
    expires_at: expiresAt,
    message: `This tool requires payment of $${priceUsd} USD. Send ${amountSmallestUnit} USDC (${USDC_DECIMALS} decimals) to ${paymentAddress} on Base network, then retry with x402_payment: { tx_hash, network }.`,
  };
}

// ============================================
// PAYMENT DETECTION — Check if args contain payment proof
// ============================================

/**
 * Check if tool call arguments contain x402 payment proof.
 *
 * Agents attach payment proof as `x402_payment` in the tool args:
 * ```json
 * {
 *   "market_id": "...",
 *   "x402_payment": {
 *     "tx_hash": "0xabc...",
 *     "network": "base"
 *   }
 * }
 * ```
 */
export function isX402Payment(args: Record<string, unknown>): boolean {
  if (!args || typeof args !== "object") return false;
  const payment = args.x402_payment;
  if (!payment || typeof payment !== "object") return false;
  const p = payment as Record<string, unknown>;
  return typeof p.tx_hash === "string" && p.tx_hash.length > 0;
}

/**
 * Extract x402 payment proof from tool call arguments.
 * Call isX402Payment() first to verify presence.
 */
export function extractPaymentProof(
  args: Record<string, unknown>,
): X402PaymentProof | null {
  if (!isX402Payment(args)) return null;
  const p = args.x402_payment as Record<string, unknown>;
  return {
    tx_hash: p.tx_hash as string,
    network: (p.network as string) || DEFAULT_NETWORK,
    amount_usd: typeof p.amount_usd === "number" ? p.amount_usd : undefined,
  };
}

// ============================================
// PAYMENT VERIFICATION — MVP: trust + log
// ============================================

/**
 * Verify x402 payment proof.
 *
 * MVP strategy: Trust the payment signature from args.
 * The tx_hash is logged for audit. Full on-chain verification is v2
 * (would use Base RPC to confirm the USDC transfer).
 *
 * @param proof - Payment proof from agent
 * @param expectedPriceUsd - Expected price for this tool call
 * @returns Verification result
 */
export function verifyPayment(
  proof: X402PaymentProof,
  expectedPriceUsd: number,
): X402PaymentVerified {
  // MVP: Trust the proof, log tx_hash for audit trail.
  // v2: Query Base RPC to confirm:
  //   1. tx_hash exists and is confirmed
  //   2. Transfer is to our payment address
  //   3. Amount >= expectedPriceUsd in USDC
  //   4. Transaction is recent (within PAYMENT_EXPIRY_MS)

  const network = proof.network || DEFAULT_NETWORK;
  if (!SUPPORTED_NETWORKS[network]) {
    throw new Error(
      `Unsupported payment network: ${network}. Supported: ${Object.keys(SUPPORTED_NETWORKS).join(", ")}`,
    );
  }

  console.error(
    `[TeleKash x402] Payment verified (MVP): tx=${proof.tx_hash.substring(0, 16)}... network=${network} expected=$${expectedPriceUsd}`,
  );

  return {
    x402_version: 1,
    payment_verified: true,
    tx_hash: proof.tx_hash,
    amount_usd: proof.amount_usd ?? expectedPriceUsd,
    network,
  };
}

// ============================================
// RESPONSE FORMATTING — For MCP tool responses
// ============================================

/**
 * Format x402 payment-required info as an MCP tool response.
 *
 * Returns the standard MCP content array format with the 402 payment
 * instructions as structured JSON. x402-aware clients parse this
 * and handle payment automatically.
 */
export function formatX402Response(paymentInfo: X402PaymentRequired): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "payment_required",
            status: 402,
            ...paymentInfo,
            _hint:
              "Attach x402_payment: { tx_hash, network } to your next tool call after completing payment.",
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

// ============================================
// TOOL PRICING — Maps tools to per-call USDC price
// ============================================

/**
 * Get the x402 per-call price for a tool.
 *
 * Uses the same pricing as TIER_CONFIGS:
 * - Free tools: $0 (no payment needed)
 * - Calibration tools: $0.01/call
 * - Edge tools: $0.05/call
 *
 * @param toolName - Name of the tool
 * @param tierRequired - The tier this tool belongs to (from TIER_REQUIRED map)
 * @param tierConfigs - The TIER_CONFIGS object for price lookup
 * @returns Price in USD, or 0 if free
 */
export function getToolPrice(
  toolName: string,
  tierRequired: string | undefined,
  tierConfigs: Record<string, { price_per_query: number; tools: string[] }>,
): number {
  // Check if tool is in free tier
  if (tierConfigs.free?.tools.includes(toolName)) {
    return 0;
  }

  // Use the tier's price_per_query
  const tier = tierRequired || "edge";
  return tierConfigs[tier]?.price_per_query ?? 0.05;
}

/**
 * Strip x402_payment from args before passing to tool handler.
 * Prevents payment metadata from interfering with tool logic.
 */
export function stripPaymentArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return args;
  const { x402_payment: _, ...cleanArgs } = args;
  return cleanArgs;
}
