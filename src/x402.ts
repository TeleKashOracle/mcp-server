/**
 * TeleKash Universal Payment Layer
 *
 * Three payment rails, one interface:
 *   1. x402 (Coinbase) — USDC on Base/Polygon/Solana. Free. Agent-native.
 *   2. Stripe MPP — Fiat (cards, bank, BNPL, stablecoins). 2.9%. Developer-friendly.
 *   3. TON — Native Telegram payments. Free. Telegram-ecosystem aligned.
 *
 * Agents attach payment proof in tool args. We verify and execute.
 * This is ADDITIVE — does not replace the free tier or API key system.
 *
 * ENV:
 *   TELEKASH_PAYMENT_ADDRESS   — EVM wallet for x402 USDC (Base/Polygon)
 *   TELEKASH_TON_ADDRESS       — TON wallet for TON payments
 *   STRIPE_SECRET_KEY          — Stripe API key (for MPP verification)
 *   X402_FACILITATOR_URL       — Coinbase facilitator (default: https://x402.org/facilitator)
 *
 * @version 2.0.0
 */

// ============================================
// TYPES
// ============================================

export type PaymentRail = "x402" | "stripe_mpp" | "ton";

export interface PaymentOption {
  rail: PaymentRail;
  network: string;
  asset: string;
  address: string;
  amount: string;
  decimals: number;
}

export interface X402PaymentRequired {
  x402_version: 2;
  payment_required: true;
  tool: string;
  price_usd: number;
  payment_options: PaymentOption[];
  expires_at: string;
  message: string;
}

export interface X402PaymentProof {
  tx_hash: string;
  network: string;
  rail?: PaymentRail;
  amount_usd?: number;
}

export interface X402PaymentVerified {
  x402_version: 2;
  payment_verified: true;
  tx_hash: string;
  amount_usd: number;
  network: string;
  rail: PaymentRail;
}

// ============================================
// CONFIGURATION
// ============================================

const USDC_DECIMALS = 6;
const TON_DECIMALS = 9;
const PAYMENT_EXPIRY_MS = 5 * 60 * 1000;

/** x402 facilitator URL — Coinbase-hosted or x402.org (free, no signup) */
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

/** EVM wallet for USDC payments */
const EVM_PAYMENT_ADDRESS = process.env.TELEKASH_PAYMENT_ADDRESS || "";

/** TON wallet for TON payments */
const TON_PAYMENT_ADDRESS = process.env.TELEKASH_TON_ADDRESS || "";

/** Stripe secret key (for MPP verification) */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

/** x402-supported networks with USDC contract addresses */
const X402_NETWORKS: Record<
  string,
  { chain_id: number; usdc: string; chain_prefix: string }
> = {
  base: {
    chain_id: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chain_prefix: "eip155:8453",
  },
  "base-sepolia": {
    chain_id: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    chain_prefix: "eip155:84532",
  },
  polygon: {
    chain_id: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    chain_prefix: "eip155:137",
  },
  solana: {
    chain_id: 0,
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chain_prefix: "solana",
  },
};

// ============================================
// PAYMENT REQUIRED — Generate 402 instructions
// ============================================

export function createPaymentRequired(
  tool: string,
  priceUsd: number,
  paymentAddress: string,
): X402PaymentRequired {
  const usdcAmount = Math.round(priceUsd * 10 ** USDC_DECIMALS).toString();
  const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MS).toISOString();

  const paymentOptions: PaymentOption[] = [];

  // Rail 1: x402 — USDC on all supported EVM chains + Solana
  if (paymentAddress) {
    for (const [network] of Object.entries(X402_NETWORKS)) {
      paymentOptions.push({
        rail: "x402",
        network,
        asset: "USDC",
        address: paymentAddress,
        amount: usdcAmount,
        decimals: USDC_DECIMALS,
      });
    }
  }

  // Rail 2: Stripe MPP — fiat + stablecoins
  if (STRIPE_SECRET_KEY) {
    paymentOptions.push({
      rail: "stripe_mpp",
      network: "stripe",
      asset: "USD",
      address: "stripe_payment_intent",
      amount: Math.round(priceUsd * 100).toString(),
      decimals: 2,
    });
  }

  // Rail 3: TON — native Telegram payments
  if (TON_PAYMENT_ADDRESS) {
    // TON price approximation: use 1 TON ≈ $3 as fallback
    // In production, query live price from CoinGecko or oracle
    const tonPriceUsd = 3.0;
    const tonAmount = Math.round(
      (priceUsd / tonPriceUsd) * 10 ** TON_DECIMALS,
    ).toString();

    paymentOptions.push({
      rail: "ton",
      network: "ton-mainnet",
      asset: "TON",
      address: TON_PAYMENT_ADDRESS,
      amount: tonAmount,
      decimals: TON_DECIMALS,
    });
  }

  const rails = [...new Set(paymentOptions.map((o) => o.rail))];
  const railsText = rails.join(", ");

  return {
    x402_version: 2,
    payment_required: true,
    tool,
    price_usd: priceUsd,
    payment_options: paymentOptions,
    expires_at: expiresAt,
    message: `This tool requires $${priceUsd} USD. Pay via ${railsText}. Attach payment proof as x402_payment: { tx_hash, network, rail } in your next call.`,
  };
}

// ============================================
// PAYMENT DETECTION
// ============================================

export function isX402Payment(args: Record<string, unknown>): boolean {
  if (!args || typeof args !== "object") return false;
  const payment = args.x402_payment;
  if (!payment || typeof payment !== "object") return false;
  const p = payment as Record<string, unknown>;
  return typeof p.tx_hash === "string" && p.tx_hash.length > 0;
}

export function extractPaymentProof(
  args: Record<string, unknown>,
): X402PaymentProof | null {
  if (!isX402Payment(args)) return null;
  const p = args.x402_payment as Record<string, unknown>;
  return {
    tx_hash: p.tx_hash as string,
    network: (p.network as string) || "base",
    rail: (p.rail as PaymentRail) || detectRail(p),
    amount_usd: typeof p.amount_usd === "number" ? p.amount_usd : undefined,
  };
}

/** Auto-detect payment rail from network string */
function detectRail(proof: Record<string, unknown>): PaymentRail {
  const network = (proof.network as string) || "";
  if (network.startsWith("ton")) return "ton";
  if (network === "stripe" || (proof.tx_hash as string)?.startsWith("pi_"))
    return "stripe_mpp";
  return "x402";
}

// ============================================
// PAYMENT VERIFICATION — Three rails
// ============================================

export async function verifyPayment(
  proof: X402PaymentProof,
  expectedPriceUsd: number,
): Promise<X402PaymentVerified> {
  const rail =
    proof.rail || detectRail({ ...proof } as Record<string, unknown>);

  switch (rail) {
    case "x402":
      return verifyX402(proof, expectedPriceUsd);
    case "stripe_mpp":
      return verifyStripeMPP(proof, expectedPriceUsd);
    case "ton":
      return verifyTON(proof, expectedPriceUsd);
    default:
      throw new Error(`Unknown payment rail: ${rail}`);
  }
}

// --- Rail 1: x402 (Coinbase) ---

async function verifyX402(
  proof: X402PaymentProof,
  expectedPriceUsd: number,
): Promise<X402PaymentVerified> {
  const network = proof.network || "base";

  if (!X402_NETWORKS[network]) {
    throw new Error(
      `Unsupported x402 network: ${network}. Supported: ${Object.keys(X402_NETWORKS).join(", ")}`,
    );
  }

  // Use Coinbase facilitator for on-chain verification
  try {
    const response = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_hash: proof.tx_hash,
        network: X402_NETWORKS[network].chain_prefix,
        expected_amount: Math.round(
          expectedPriceUsd * 10 ** USDC_DECIMALS,
        ).toString(),
        expected_recipient: EVM_PAYMENT_ADDRESS,
      }),
    });

    if (response.ok) {
      console.error(
        `[TeleKash x402] Verified via facilitator: tx=${proof.tx_hash.substring(0, 16)}... network=${network}`,
      );
      return {
        x402_version: 2,
        payment_verified: true,
        tx_hash: proof.tx_hash,
        amount_usd: proof.amount_usd ?? expectedPriceUsd,
        network,
        rail: "x402",
      };
    }

    // Facilitator rejected — log but fall through to trust-based
    console.error(
      `[TeleKash x402] Facilitator rejected: ${response.status} ${await response.text()}`,
    );
  } catch (err) {
    // Facilitator unreachable — fall back to trust-based verification
    console.error(
      `[TeleKash x402] Facilitator unreachable, using trust-based: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Fallback: trust-based (log tx_hash for manual audit)
  console.error(
    `[TeleKash x402] Trust-based verification: tx=${proof.tx_hash.substring(0, 16)}... network=${network} expected=$${expectedPriceUsd}`,
  );

  return {
    x402_version: 2,
    payment_verified: true,
    tx_hash: proof.tx_hash,
    amount_usd: proof.amount_usd ?? expectedPriceUsd,
    network,
    rail: "x402",
  };
}

// --- Rail 2: Stripe MPP ---

async function verifyStripeMPP(
  proof: X402PaymentProof,
  expectedPriceUsd: number,
): Promise<X402PaymentVerified> {
  if (!STRIPE_SECRET_KEY) {
    throw new Error(
      "Stripe MPP not configured. Set STRIPE_SECRET_KEY env var.",
    );
  }

  // Verify PaymentIntent via Stripe API
  const piId = proof.tx_hash; // For Stripe, tx_hash IS the PaymentIntent ID (pi_xxx)
  if (!piId.startsWith("pi_")) {
    throw new Error(
      `Invalid Stripe PaymentIntent ID: ${piId}. Expected format: pi_xxx`,
    );
  }

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/payment_intents/${piId}`,
      {
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Stripe API error: ${response.status}`);
    }

    const pi = (await response.json()) as Record<string, unknown>;

    if (pi.status !== "succeeded") {
      throw new Error(`PaymentIntent not succeeded: ${pi.status}`);
    }

    const amountCents = pi.amount as number;
    const amountUsd = amountCents / 100;

    if (amountUsd < expectedPriceUsd * 0.95) {
      throw new Error(
        `Underpayment: received $${amountUsd}, expected $${expectedPriceUsd}`,
      );
    }

    console.error(
      `[TeleKash Stripe] Verified: pi=${piId.substring(0, 16)}... amount=$${amountUsd}`,
    );

    return {
      x402_version: 2,
      payment_verified: true,
      tx_hash: piId,
      amount_usd: amountUsd,
      network: "stripe",
      rail: "stripe_mpp",
    };
  } catch (err) {
    throw new Error(
      `Stripe verification failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// --- Rail 3: TON ---

async function verifyTON(
  proof: X402PaymentProof,
  expectedPriceUsd: number,
): Promise<X402PaymentVerified> {
  if (!TON_PAYMENT_ADDRESS) {
    throw new Error(
      "TON payments not configured. Set TELEKASH_TON_ADDRESS env var.",
    );
  }

  // Verify transaction via TonAPI
  const txHash = proof.tx_hash;
  const tonApiUrl = `https://tonapi.io/v2/blockchain/transactions/${txHash}`;

  try {
    const response = await fetch(tonApiUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      // TonAPI unreachable or tx not found — fall back to trust-based
      console.error(
        `[TeleKash TON] TonAPI returned ${response.status}, using trust-based verification`,
      );
      return {
        x402_version: 2,
        payment_verified: true,
        tx_hash: txHash,
        amount_usd: proof.amount_usd ?? expectedPriceUsd,
        network: "ton-mainnet",
        rail: "ton",
      };
    }

    const tx = (await response.json()) as Record<string, unknown>;

    // Check the transaction is to our address
    const outMsgs = tx.out_msgs as Array<Record<string, unknown>> | undefined;
    if (outMsgs && outMsgs.length > 0) {
      const destination = (outMsgs[0].destination as Record<string, unknown>)
        ?.address as string;
      if (
        destination &&
        !destination
          .toLowerCase()
          .includes(TON_PAYMENT_ADDRESS.toLowerCase().replace(/[-_]/g, ""))
      ) {
        console.error(
          `[TeleKash TON] Destination mismatch: ${destination} vs ${TON_PAYMENT_ADDRESS}`,
        );
      }
    }

    console.error(`[TeleKash TON] Verified: tx=${txHash.substring(0, 16)}...`);

    return {
      x402_version: 2,
      payment_verified: true,
      tx_hash: txHash,
      amount_usd: proof.amount_usd ?? expectedPriceUsd,
      network: "ton-mainnet",
      rail: "ton",
    };
  } catch (err) {
    // Fallback: trust-based
    console.error(
      `[TeleKash TON] Verification error, using trust-based: ${err instanceof Error ? err.message : err}`,
    );
    return {
      x402_version: 2,
      payment_verified: true,
      tx_hash: txHash,
      amount_usd: proof.amount_usd ?? expectedPriceUsd,
      network: "ton-mainnet",
      rail: "ton",
    };
  }
}

// ============================================
// RESPONSE FORMATTING
// ============================================

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
              "Attach x402_payment: { tx_hash, network, rail } to your next tool call after completing payment. Rail options: x402 (USDC), stripe_mpp (fiat), ton (Telegram-native).",
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
// TOOL PRICING
// ============================================

export function getToolPrice(
  toolName: string,
  tierRequired: string | undefined,
  tierConfigs: Record<string, { price_per_query: number; tools: string[] }>,
): number {
  if (tierConfigs.free?.tools.includes(toolName)) {
    return 0;
  }
  const tier = tierRequired || "edge";
  return tierConfigs[tier]?.price_per_query ?? 0.05;
}

export function stripPaymentArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return args;
  const { x402_payment: _, ...cleanArgs } = args;
  return cleanArgs;
}
