import { JitoJsonRpcClient } from "jito-js-rpc";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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

    // Validate all bundles first
    for (let i = 0; i < bundles.length; i++) {
      const bundle = bundles[i];
      if (!Array.isArray(bundle) || bundle.length === 0) {
        return NextResponse.json(
          { error: `Bundle ${i + 1} is empty or invalid` },
          { status: 400 },
        );
      }
    }

    console.log(`[Jito] Submitting ${bundles.length} bundles in parallel`);

    // Submit all bundles in parallel
    const bundlePromises = bundles.map(async (bundle, i) => {
      const bundleIndex = i + 1;
      console.log(`[Jito] Submitting bundle ${bundleIndex}/${bundles.length} (${bundle.length} txs)`);

      try {
        // Submit bundle to Jito
        const result = await jitoClient.sendBundle([
          bundle,
          { encoding: "base64" },
        ]);

        const bundleId = result.result;
        if (!bundleId) {
          console.error(`[Jito] Bundle ${bundleIndex}: No bundle ID returned`, result);
          throw new Error(`Bundle ${bundleIndex}: Jito did not return bundle_id`);
        }

        console.log(`[Jito] Bundle ${bundleIndex} submitted. ID: ${bundleId}`);

        // Wait for bundle confirmation (30 seconds timeout)
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
          console.log(`[Jito] Bundle ${bundleIndex} confirmed in slot ${slot}`);
          return {
            bundleId,
            slot,
            confirmed: true,
            bundleIndex,
            success: true,
          };
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

          console.error(`[Jito] Bundle ${bundleIndex} failed:`, errorDetails);
          throw new Error(`Bundle ${bundleIndex} execution failed: ${JSON.stringify(errorDetails)}`);
        }

        // Unknown status
        throw new Error(`Bundle ${bundleIndex} status could not be determined: ${JSON.stringify(confirmationResult)}`);
      } catch (error) {
        const errorMessage = (error as Error)?.message || String(error);
        console.error(`[Jito] Bundle ${bundleIndex} error:`, errorMessage);

        return {
          bundleIndex,
          success: false,
          error: errorMessage,
          isTimeout: errorMessage.includes("timeout") || errorMessage.includes("Timeout"),
        };
      }
    });

    // Wait for all bundles to complete
    const bundleResults = await Promise.all(bundlePromises);

    // Check if any bundles failed
    const failedBundles = bundleResults.filter(result => !result.success);
    const successfulBundles = bundleResults.filter(result => result.success);

    if (failedBundles.length > 0) {
      const timeoutBundles = failedBundles.filter(result => result.isTimeout);

      if (timeoutBundles.length > 0) {
        return NextResponse.json(
          {
            error: `${timeoutBundles.length} bundle(s) timed out`,
            timeoutBundles: timeoutBundles.map(b => b.bundleIndex),
            failedBundles,
            successfulBundles,
            timeout: "30000ms",
            note: "Bundles may still be processing. Check Jito explorer for status.",
          },
          { status: 408 },
        );
      }

      return NextResponse.json(
        {
          error: `${failedBundles.length} bundle(s) failed`,
          failedBundles,
          successfulBundles,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      totalBundles: bundles.length,
      results: successfulBundles,
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
