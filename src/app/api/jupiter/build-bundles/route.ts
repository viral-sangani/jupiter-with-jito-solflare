import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const JUPITER_ULTRA_BASE_URL = "https://api.jup.ag/ultra/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

const MAX_TXS_PER_BUNDLE = 5;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { branches, inputMint, amount, slippageBps, jitoTip, userPublicKey } =
      body;

    if (!branches || !Array.isArray(branches) || branches.length === 0) {
      return NextResponse.json(
        { error: "Missing or invalid branches array" },
        { status: 400 },
      );
    }

    if (!inputMint || !amount || !userPublicKey) {
      return NextResponse.json(
        {
          error: "Missing required parameters: inputMint, amount, userPublicKey",
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

    // Flatten branches to get all output tokens
    const allTokens: string[] = branches.flat();

    // Fetch all quotes in parallel
    const quotePromises = allTokens.map((outputMint) => {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        taker: userPublicKey,
      });

      if (slippageBps) {
        params.append("slippageBps", slippageBps.toString());
      }

      const url = `${JUPITER_ULTRA_BASE_URL}/order?${params.toString()}`;

      return fetch(url, {
        method: "GET",
        headers: {
          "x-api-key": JUPITER_API_KEY,
        },
        signal: AbortSignal.timeout(10000),
      });
    });

    const quoteResponses = await Promise.all(quotePromises);

    // Check for errors and parse responses
    const quotesData = [];
    for (let i = 0; i < quoteResponses.length; i++) {
      if (!quoteResponses[i].ok) {
        const error = await quoteResponses[i].text();
        return NextResponse.json(
          {
            error: `Failed to get quote for swap ${i + 1}`,
            details: error,
          },
          { status: quoteResponses[i].status },
        );
      }

      const orderData = await quoteResponses[i].json();

      if (orderData.errorCode !== undefined && orderData.errorCode !== 0) {
        return NextResponse.json(
          {
            error: `Jupiter Ultra API error for swap ${i + 1}`,
            errorCode: orderData.errorCode,
            errorMessage: orderData.errorMessage,
          },
          { status: 400 },
        );
      }

      if (!orderData.transaction || orderData.transaction === "") {
        return NextResponse.json(
          {
            error: `Jupiter Ultra returned empty transaction for swap ${i + 1}`,
          },
          { status: 400 },
        );
      }

      quotesData.push(orderData);
    }

    // Deserialize all swap transactions to get blockhash
    const swapTransactions: VersionedTransaction[] = quotesData.map(
      (quoteData) => {
        const buffer = Buffer.from(quoteData.transaction, "base64");
        return VersionedTransaction.deserialize(buffer);
      },
    );

    // Get recent blockhash from the first swap transaction
    const recentBlockhash = swapTransactions[0].message.recentBlockhash;

    // Split swaps into bundles (max 4 swaps per bundle to leave room for tip)
    const maxSwapsPerBundle = MAX_TXS_PER_BUNDLE - 1;
    const bundles: string[][] = [];

    for (let i = 0; i < swapTransactions.length; i += maxSwapsPerBundle) {
      const bundleSwaps = swapTransactions.slice(i, i + maxSwapsPerBundle);

      // Create tip transaction for this bundle
      const randomTipAccount =
        JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

      const tipInstruction = SystemProgram.transfer({
        fromPubkey: new PublicKey(userPublicKey),
        toPubkey: new PublicKey(randomTipAccount),
        lamports: Number(jitoTip || 10000),
      });

      const tipMessage = new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash,
        instructions: [tipInstruction],
      }).compileToV0Message();

      const tipTransaction = new VersionedTransaction(tipMessage);

      // Serialize bundle transactions (swaps + tip)
      const bundleTransactions = [
        ...bundleSwaps.map((tx) => Buffer.from(tx.serialize()).toString("base64")),
        Buffer.from(tipTransaction.serialize()).toString("base64"),
      ];

      bundles.push(bundleTransactions);
    }

    return NextResponse.json({
      bundles,
      totalSwaps: allTokens.length,
      totalBundles: bundles.length,
    });
  } catch (error) {
    console.error("Error in build-bundles endpoint:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
