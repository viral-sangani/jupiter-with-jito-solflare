import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const JUPITER_ULTRA_BASE_URL = "https://api.jup.ag/ultra/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      userPublicKey,
      excludeRouters,
    } = body;

    if (!inputMint || !outputMint || !amount || !userPublicKey) {
      return NextResponse.json(
        {
          error:
            "Missing required parameters: inputMint, outputMint, amount, userPublicKey",
        },
        { status: 400 },
      );
    }

    if (!JUPITER_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Jupiter API key not configured. Please set JUPITER_API_KEY environment variable.",
        },
        { status: 500 },
      );
    }

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      taker: userPublicKey,
    });

    if (slippageBps) {
      params.append("slippageBps", slippageBps.toString());
    }

    if (excludeRouters) {
      params.append("excludeRouters", excludeRouters);
    }

    const url = `${JUPITER_ULTRA_BASE_URL}/order?${params.toString()}`;

    const ultraResponse = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": JUPITER_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!ultraResponse.ok) {
      const error = await ultraResponse.text();
      return NextResponse.json(
        {
          error: "Failed to get order from Jupiter Ultra",
          details: error,
        },
        { status: ultraResponse.status },
      );
    }

    const orderData = await ultraResponse.json();

    if (orderData.errorCode !== undefined && orderData.errorCode !== 0) {
      return NextResponse.json(
        {
          error: "Jupiter Ultra API error",
          errorCode: orderData.errorCode,
          errorMessage: orderData.errorMessage,
          details: orderData.error,
        },
        { status: 400 },
      );
    }

    if (orderData.error) {
      return NextResponse.json(
        {
          error: "Jupiter Ultra API error",
          details: orderData.error,
        },
        { status: 400 },
      );
    }

    if (!orderData.transaction || orderData.transaction === "") {
      return NextResponse.json(
        {
          error:
            "Jupiter Ultra API returned empty transaction. This may indicate insufficient funds or other error.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      transaction: orderData.transaction,
      requestId: orderData.requestId,
      inAmount: orderData.inAmount,
      outAmount: orderData.outAmount,
      otherAmountThreshold: orderData.otherAmountThreshold,
      slippageBps: orderData.slippageBps,
      priceImpactPct: orderData.priceImpactPct,
      prioritizationFeeLamports: orderData.prioritizationFeeLamports,
      routePlan: orderData.routePlan,
      platformFee: orderData.platformFee,
    });
  } catch (error) {
    console.error("Error in Jupiter Ultra endpoint:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
