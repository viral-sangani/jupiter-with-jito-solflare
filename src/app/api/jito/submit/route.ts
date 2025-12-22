import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { JitoJsonRpcClient } from "jito-js-rpc";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const JITO_RELAY_URL =
  process.env.JITO_RELAY_URL || "https://ny.mainnet.block-engine.jito.wtf";
const JITO_UUID = process.env.JITO_UUID || "";
const CONFIRMATION_TIMEOUT_MS = 30000; // 30 seconds

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { transactions, userAddress } = body;

    if (
      !transactions ||
      !Array.isArray(transactions) ||
      transactions.length === 0
    ) {
      return NextResponse.json(
        { error: "Missing or invalid transactions array" },
        { status: 400 },
      );
    }

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing userAddress parameter" },
        { status: 400 },
      );
    }

    console.log("[Jito] Configuration:", {
      relayUrl: JITO_RELAY_URL,
      hasUuid: !!JITO_UUID,
      transactionCount: transactions.length,
      userAddress,
    });

    // Validate transactions
    const validationError = validateTransactions(transactions, userAddress);
    if (validationError) {
      console.error("[Jito] Validation failed:", validationError);
      return NextResponse.json(
        { error: validationError.message, details: validationError.details },
        { status: 400 },
      );
    }

    console.log("[Jito] Validation passed");

    // Initialize Jito client
    const jitoClient = new JitoJsonRpcClient(JITO_RELAY_URL, JITO_UUID);
    console.log("[Jito] Client initialized");

    // Extract transaction signatures for confirmation
    const txSignatures = extractTransactionSignatures(transactions);
    console.log("[Jito] Extracted signatures:", txSignatures);

    // Submit bundle
    console.log(
      "[Jito] Submitting bundle with",
      transactions.length,
      "transactions",
    );

    let result: any;
    try {
      result = await jitoClient.sendBundle([
        transactions,
        { encoding: "base64" },
      ]);

      console.log("[Jito] Bundle submission response:", result);
    } catch (bundleError) {
      // biome-ignore lint/suspicious/noExplicitAny: Axios error doesn't have proper types
      console.error("[Jito] Bundle submission failed:", {
        error: bundleError,
        message: (bundleError as Error)?.message,
        response: (bundleError as any)?.response?.data,
        status: (bundleError as any)?.response?.status,
        config: (bundleError as any)?.config?.url,
      });
      throw bundleError;
    }

    const bundleId = result.result;
    console.log("[Jito] Bundle ID:", bundleId);
    if (!bundleId) {
      return NextResponse.json(
        { error: "Jito did not return bundle_id", details: result },
        { status: 500 },
      );
    }

    // Wait for bundle confirmation
    console.log("[Jito] Waiting for bundle confirmation...");
    try {
      const confirmationResult = await jitoClient.confirmInflightBundle(
        bundleId,
        CONFIRMATION_TIMEOUT_MS,
      );

      console.log("[Jito] Confirmation result:", confirmationResult);

      // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
      const isConfirmed =
        (confirmationResult as any).confirmation_status === "confirmed" ||
        (confirmationResult as any).status === "Landed";

      // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
      const slot =
        (confirmationResult as any).slot ||
        (confirmationResult as any).landed_slot;

      console.log("[Jito] Bundle confirmed:", isConfirmed, "Slot:", slot);

      if (isConfirmed) {
        // Try to get detailed bundle status with transaction signatures
        try {
          const finalStatus = await jitoClient.getBundleStatuses([[bundleId]]);

          if (
            finalStatus?.result?.value?.[0]?.transactions?.length &&
            finalStatus.result.value[0].transactions.length > 0
          ) {
            return NextResponse.json({
              success: true,
              bundleId,
              signatures: finalStatus.result.value[0].transactions,
              slot,
              confirmed: true,
            });
          }
        } catch (_statusError) {
          // Fallback to bundle ID if we can't get detailed status
        }

        return NextResponse.json({
          success: true,
          bundleId,
          signatures: txSignatures,
          slot,
          confirmed: true,
        });
      }

      // Bundle failed
      // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
      const hasError =
        (confirmationResult as any).err ||
        (confirmationResult as any).status === "Failed";

      if (hasError) {
        // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
        const errorDetails =
          (confirmationResult as any).err ||
          `Status: ${(confirmationResult as any).status}`;

        return NextResponse.json(
          {
            error: "Bundle execution failed",
            details: errorDetails,
            bundleId,
          },
          { status: 400 },
        );
      }

      // Unknown status
      return NextResponse.json(
        {
          error: "Bundle status could not be determined",
          bundleId,
          status: confirmationResult,
        },
        { status: 500 },
      );
    } catch (confirmError) {
      const errorMessage =
        (confirmError as Error)?.message || String(confirmError);

      if (
        errorMessage.includes("timeout") ||
        errorMessage.includes("Timeout")
      ) {
        return NextResponse.json(
          {
            error: "Bundle confirmation timeout",
            bundleId,
            timeout: `${CONFIRMATION_TIMEOUT_MS}ms`,
            note: "Bundle may still be processing. Check Jito explorer for status.",
          },
          { status: 408 },
        );
      }

      return NextResponse.json(
        {
          error: "Failed to confirm bundle status",
          bundleId,
          details: errorMessage,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Error in Jito submit endpoint:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

function validateTransactions(
  transactions: string[],
  userAddress: string,
): { message: string; details: unknown } | null {
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];

    if (!tx || typeof tx !== "string") {
      return {
        message: `Transaction ${i} is invalid or empty`,
        details: { transactionIndex: i },
      };
    }

    // Validate base64 format
    try {
      const bytes = Buffer.from(tx, "base64");
      const vtx = VersionedTransaction.deserialize(bytes);

      // Validate fee payer matches user
      const message = vtx.message;
      let payer: string | undefined;

      if (
        "staticAccountKeys" in message &&
        message.staticAccountKeys?.length > 0
      ) {
        payer = message.staticAccountKeys[0]?.toString();
      } else if ("accountKeys" in message && message.accountKeys?.length > 0) {
        payer = message.accountKeys[0]?.toString();
      }

      if (!payer) {
        return {
          message: "Unable to determine fee payer from transaction",
          details: { transactionIndex: i },
        };
      }

      if (payer !== userAddress) {
        return {
          message: "Fee payer does not match authenticated user",
          details: { expected: userAddress, found: payer, index: i },
        };
      }

      // Ensure transaction is signed
      const hasSignatures =
        Array.isArray(vtx.signatures) && vtx.signatures.length > 0;
      if (!hasSignatures) {
        return {
          message: `Transaction ${i} has no signatures`,
          details: { index: i },
        };
      }

      // Check that at least one signature is non-zero
      const anyNonZero = vtx.signatures.some((sig) => sig.some((b) => b !== 0));
      if (!anyNonZero) {
        return {
          message: `Transaction ${i} appears unsigned (all-zero signatures)`,
          details: { index: i },
        };
      }
    } catch (e) {
      return {
        message: `Transaction ${i} is not valid`,
        details: (e as Error)?.message,
      };
    }
  }

  return null;
}

function extractTransactionSignatures(transactions: string[]): string[] {
  const signatures: string[] = [];

  for (const tx of transactions) {
    try {
      const txBuffer = Buffer.from(tx, "base64");
      const versionedTx = VersionedTransaction.deserialize(txBuffer);

      const firstSig = versionedTx.signatures?.[0];
      if (firstSig) {
        const signature = bs58.encode(firstSig);
        signatures.push(signature);
      }
    } catch (_error) {
      // Skip if we can't extract signature
    }
  }

  return signatures;
}
