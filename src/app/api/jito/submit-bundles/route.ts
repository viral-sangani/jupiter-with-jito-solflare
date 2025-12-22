import { JitoJsonRpcClient } from "jito-js-rpc";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logDecodedTransactionServer } from "@/utils/decodeTransactionServer";

const JITO_RELAY_URL =
  process.env.JITO_RELAY_URL || "https://ny.mainnet.block-engine.jito.wtf";
const JITO_UUID = process.env.JITO_UUID || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { bundles, userAddress } = body;

    if (!bundles || !Array.isArray(bundles) || bundles.length === 0) {
      return NextResponse.json(
        { error: "Missing or invalid bundles array" },
        { status: 400 },
      );
    }

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing userAddress parameter" },
        { status: 400 },
      );
    }

    // Initialize Jito client
    const jitoClient = new JitoJsonRpcClient(JITO_RELAY_URL, JITO_UUID);

    // Submit each bundle sequentially
    const bundleResults = [];
    for (let i = 0; i < bundles.length; i++) {
      const bundle = bundles[i];

      if (!Array.isArray(bundle) || bundle.length === 0) {
        return NextResponse.json(
          { error: `Bundle ${i + 1} is empty or invalid` },
          { status: 400 },
        );
      }

      // Log first and last transaction of each bundle
      if (bundle.length > 0) {
        logDecodedTransactionServer(
          bundle[0],
          `[API] Bundle ${i + 1}, Transaction 1 (Swap)`,
        );
        if (bundle.length > 1) {
          logDecodedTransactionServer(
            bundle[bundle.length - 1],
            `[API] Bundle ${i + 1}, Transaction ${bundle.length} (Jito Tip)`,
          );
        }
      }

      try {
        // Submit bundle to Jito
        const result = await jitoClient.sendBundle([
          bundle,
          { encoding: "base64" },
        ]);

        const bundleId = result.result;
        if (!bundleId) {
          return NextResponse.json(
            {
              error: `Bundle ${i + 1}: Jito did not return bundle_id`,
              details: result,
            },
            { status: 500 },
          );
        }

        // Wait for bundle confirmation (30 seconds timeout)
        try {
          const confirmationResult = await jitoClient.confirmInflightBundle(
            bundleId,
            30000, // 30 second timeout
          );

          // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
          const isConfirmed =
            (confirmationResult as any).confirmation_status === "confirmed" ||
            (confirmationResult as any).status === "Landed";

          // biome-ignore lint/suspicious/noExplicitAny: Jito client doesn't provide proper types
          const slot =
            (confirmationResult as any).slot ||
            (confirmationResult as any).landed_slot;

          if (isConfirmed) {
            bundleResults.push({
              bundleId,
              slot,
              confirmed: true,
              bundleIndex: i + 1,
            });
          } else {
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
                  error: `Bundle ${i + 1} execution failed`,
                  details: errorDetails,
                  bundleId,
                  successfulBundles: bundleResults,
                },
                { status: 400 },
              );
            }

            // Unknown status
            return NextResponse.json(
              {
                error: `Bundle ${i + 1} status could not be determined`,
                bundleId,
                status: confirmationResult,
                successfulBundles: bundleResults,
              },
              { status: 500 },
            );
          }
        } catch (confirmError) {
          const errorMessage =
            (confirmError as Error)?.message || String(confirmError);

          if (
            errorMessage.includes("timeout") ||
            errorMessage.includes("Timeout")
          ) {
            return NextResponse.json(
              {
                error: `Bundle ${i + 1} confirmation timeout`,
                bundleId,
                timeout: "30000ms",
                note: "Bundle may still be processing. Check Jito explorer for status.",
                successfulBundles: bundleResults,
              },
              { status: 408 },
            );
          }

          return NextResponse.json(
            {
              error: `Failed to confirm bundle ${i + 1} status`,
              bundleId,
              details: errorMessage,
              successfulBundles: bundleResults,
            },
            { status: 500 },
          );
        }
      } catch (bundleError) {
        return NextResponse.json(
          {
            error: `Bundle ${i + 1} submission failed`,
            details:
              (bundleError as Error)?.message || String(bundleError),
            successfulBundles: bundleResults,
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      success: true,
      totalBundles: bundles.length,
      results: bundleResults,
    });
  } catch (error) {
    console.error("Error in submit-bundles endpoint:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
