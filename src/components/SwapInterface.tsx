"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { useState } from "react";

// import { logDecodedTransaction } from "@/utils/decodeTransaction";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 3 branches, each with 3 token swaps
const BRANCHES = [
  [
    "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  ],
  [
    "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  ],
  [
    "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    "XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL",
  ],
];

const MAX_TXS_PER_BUNDLE = 5;
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=6a01c832-320e-4aeb-83d3-af0adaaa3324";

export default function SwapInterface() {
  const { publicKey, signAllTransactions, wallet } = useWallet();
  // Hardcoded: 0.01 USDC = 10,000 (USDC has 6 decimals)
  const SWAP_AMOUNT = "10000";
  const [slippageBps, setSlippageBps] = useState("50");
  const [jitoTip, setJitoTip] = useState("10000");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const handleMultiSwap = async () => {
    if (!publicKey || !signAllTransactions) {
      setError("Please connect your wallet first");
      return;
    }

    setLoading(true);
    setError("");

    const totalSwaps = BRANCHES.reduce((sum, branch) => sum + branch.length, 0);
    setStatus(`Building ${totalSwaps} swap transactions...`);

    try {
      // Call API to build all bundles
      const buildResponse = await fetch("/api/jupiter/build-bundles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          branches: BRANCHES,
          inputMint: USDC_MINT,
          amount: SWAP_AMOUNT,
          slippageBps: Number(slippageBps),
          jitoTip: Number(jitoTip),
          userPublicKey: publicKey.toString(),
        }),
      });

      if (!buildResponse.ok) {
        const errorData = await buildResponse.json();
        throw new Error(errorData.error || "Failed to build bundles");
      }

      const { bundles, totalBundles } = await buildResponse.json();

      setStatus(
        `Signing ${totalSwaps} swap transactions + ${totalBundles} tip transactions...`,
      );

      // Deserialize bundles and measure sizes BEFORE signing
      console.log("\n📦 UNSIGNED BUNDLE SIZES:");
      const unsignedBundles: VersionedTransaction[][] = [];
      let totalUnsignedSize = 0;

      for (let bundleIdx = 0; bundleIdx < bundles.length; bundleIdx++) {
        const bundle = bundles[bundleIdx];
        const transactions = bundle.map((txString: string) => {
          const buffer = Buffer.from(txString, "base64");
          return VersionedTransaction.deserialize(buffer);
        });
        unsignedBundles.push(transactions);

        // Measure each transaction in this bundle
        let bundleSize = 0;
        console.log(`\n  Bundle ${bundleIdx + 1} (${transactions.length} transactions):`);
        transactions.forEach((tx: VersionedTransaction, txIdx: number) => {
          const size = tx.serialize().length;
          bundleSize += size;
          console.log(`    Transaction ${txIdx + 1}: ${size} bytes`);
        });
        console.log(`    → Bundle ${bundleIdx + 1} Total: ${bundleSize} bytes`);
        totalUnsignedSize += bundleSize;
      }

      const totalUnsignedTxs = unsignedBundles.reduce((sum, b) => sum + b.length, 0);
      console.log(`\n  📊 Overall Unsigned Stats:`);
      console.log(`    Total bundles: ${bundles.length}`);
      console.log(`    Total transactions: ${totalUnsignedTxs}`);
      console.log(`    Total size: ${totalUnsignedSize} bytes`);
      console.log(`    Average per bundle: ${(totalUnsignedSize / bundles.length).toFixed(2)} bytes`);
      console.log(`    Average per transaction: ${(totalUnsignedSize / totalUnsignedTxs).toFixed(2)} bytes`);
      // Flatten for signing
      const allTransactions = unsignedBundles.flat();

      // Sign all transactions at once
      const signedTransactions = await signAllTransactions(allTransactions);

      // Measure sizes AFTER signing and group back into bundles
      console.log("\n� SIGNED BUNDLE SIZES:");
      let txIndex = 0;
      const signedBundles: string[][] = [];
      let totalSignedSize = 0;
      for (let bundleIdx = 0; bundleIdx < bundles.length; bundleIdx++) {
        const bundle = bundles[bundleIdx];
        const signedBundle = signedTransactions.slice(
          txIndex,
          txIndex + bundle.length,
        );

        // Measure each transaction in this signed bundle
        let bundleSize = 0;
        console.log(`\n  Bundle ${bundleIdx + 1} (${signedBundle.length} transactions):`);

        // Serialize the signed transactions
        const serializedBundle = signedBundle.map((tx, txIdx) => {
          const serialized = Buffer.from(tx.serialize()).toString("base64");
          const size = tx.serialize().length;
          bundleSize += size;
          console.log(`    Transaction ${txIdx + 1}: ${size} bytes`);

          // Log first transaction of each bundle for inspection
          if (txIdx === 0) {
            // logDecodedTransaction(
            //   serialized,
            //   `Bundle ${bundleIdx + 1}, Transaction ${txIdx + 1} (Swap)`,
            // );
          }
          // Log tip transaction (last in each bundle)
          if (txIdx === signedBundle.length - 1) {
            // logDecodedTransaction(
            //   serialized,
            //   `Bundle ${bundleIdx + 1}, Transaction ${txIdx + 1} (Jito Tip)`,
            // );
          }

          return serialized;
        });
        console.log(`    → Bundle ${bundleIdx + 1} Total: ${bundleSize} bytes`);
        totalSignedSize += bundleSize;
        signedBundles.push(serializedBundle);
        txIndex += bundle.length;
      }

      const totalSignedTxs = signedTransactions.length;
      console.log(`\n  📊 Overall Signed Stats:`);
      console.log(`    Total bundles: ${bundles.length}`);
      console.log(`    Total transactions: ${totalSignedTxs}`);
      console.log(`    Total size: ${totalSignedSize} bytes`);
      console.log(`    Average per bundle: ${(totalSignedSize / bundles.length).toFixed(2)} bytes`);
      console.log(`    Average per transaction: ${(totalSignedSize / totalSignedTxs).toFixed(2)} bytes`);

      // Calculate size difference
      const sizeDifference = totalSignedSize - totalUnsignedSize;
      const avgBundleDifference = sizeDifference / bundles.length;
      const avgTxDifference = sizeDifference / totalSignedTxs;
      console.log(`\n  📈 Size Increase After Signing:`);
      console.log(`    Total increase: ${sizeDifference} bytes (+${((sizeDifference / totalUnsignedSize) * 100).toFixed(2)}%)`);
      console.log(`    Average per bundle: ${avgBundleDifference.toFixed(2)} bytes`);
      console.log(`    Average per transaction: ${avgTxDifference.toFixed(2)} bytes`);
      console.log(`\n🔍 Wallet: ${wallet?.adapter.name || "Unknown"}\n`);

      setStatus(`Submitting ${signedBundles.length} bundles to Jito...`);

      // Submit all bundles via API
      const submitResponse = await fetch("/api/jito/submit-bundles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bundles: signedBundles,
          userAddress: publicKey.toString(),
        }),
      });

      const submitData = await submitResponse.json();

      if (!submitResponse.ok) {
        console.error("\n❌ JITO BUNDLE SUBMISSION FAILED:");
        console.error(`  Status: ${submitResponse.status}`);
        console.error(`  Error: ${submitData.error}`);

        if (submitData.failedBundles) {
          console.error(`\n  Failed Bundles: ${submitData.failedBundles.length}/${signedBundles.length}`);
          submitData.failedBundles.forEach((bundle: any) => {
            console.error(`    Bundle ${bundle.bundleIndex}: ${bundle.error}`);
          });
        }

        if (submitData.successfulBundles && submitData.successfulBundles.length > 0) {
          console.log(`\n  ✅ Successful Bundles: ${submitData.successfulBundles.length}/${signedBundles.length}`);
          submitData.successfulBundles.forEach((bundle: any) => {
            console.log(`    Bundle ${bundle.bundleIndex}: ${bundle.bundleId} (slot: ${bundle.slot})`);
          });
        }

        if (submitData.timeoutBundles) {
          console.warn(`\n  ⏱️  Timeout Bundles: ${submitData.timeoutBundles.join(", ")}`);
          console.warn(`  Note: ${submitData.note}`);
        }

        // Simulate failed transactions
        console.log("\n🔍 SIMULATING FAILED TRANSACTIONS...");
        setStatus("Simulating failed transactions...");

        const connection = new Connection(RPC_ENDPOINT);
        const failedBundleIndices = submitData.failedBundles?.map((b: any) => b.bundleIndex - 1) || [];

        for (const bundleIdx of failedBundleIndices) {
          const bundle = signedBundles[bundleIdx];
          console.log(`\n  Simulating Bundle ${bundleIdx + 1} (${bundle.length} transactions):`);

          for (let txIdx = 0; txIdx < bundle.length; txIdx++) {
            const txString = bundle[txIdx];
            try {
              const buffer = Buffer.from(txString, "base64");
              const tx = VersionedTransaction.deserialize(buffer);

              const simulation = await connection.simulateTransaction(tx, {
                sigVerify: false,
              });

              if (simulation.value.err) {
                console.error(`    ❌ Transaction ${txIdx + 1} simulation failed:`);
                console.error(`       Error: ${JSON.stringify(simulation.value.err, null, 2)}`);
                if (simulation.value.logs) {
                  console.error(`       Logs:`);
                  simulation.value.logs.forEach((log: string) => {
                    console.error(`         ${log}`);
                  });
                }
              } else {
                console.log(`    ✅ Transaction ${txIdx + 1} simulation passed`);
                if (simulation.value.unitsConsumed) {
                  console.log(`       Compute units: ${simulation.value.unitsConsumed}`);
                }
              }
            } catch (simError) {
              console.error(`    ⚠️  Transaction ${txIdx + 1} simulation error:`);
              console.error(`       ${simError instanceof Error ? simError.message : String(simError)}`);
            }
          }
        }

        throw new Error(
          `${submitData.error}. ${submitData.failedBundles?.length || 0} bundle(s) failed. Check console for detailed simulation results.`
        );
      }

      setStatus(
        `Success! Submitted ${submitData.totalBundles} bundles. Total swaps: ${totalSwaps}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred");
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  // Calculate total swaps for display
  const totalSwaps = BRANCHES.reduce((sum, branch) => sum + branch.length, 0);
  // One bundle per branch
  const estimatedBundles = BRANCHES.length;

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-4">
          USDC Multi-Swap Bundle ({BRANCHES.length} Branches)
        </h1>
        <WalletMultiButton className="!bg-purple-600 hover:!bg-purple-700" />
      </div>

      {publicKey && (
        <div className="space-y-4">
          <div className="bg-gray-50 p-4 rounded-lg">
            <h2 className="text-lg font-semibold mb-3">
              {BRANCHES.length} Branches - {totalSwaps} Total Swaps (0.01 USDC
              each)
            </h2>
            <p className="text-sm text-gray-600 mb-3">
              Will be submitted as {estimatedBundles} separate bundle
              {estimatedBundles > 1 ? "s" : ""} (1 bundle per branch)
            </p>

            {BRANCHES.map((branch, branchIndex) => (
              <div key={branchIndex} className="mb-4 last:mb-0">
                <h3 className="font-semibold text-purple-700 mb-2">
                  Branch #{branchIndex + 1} ({branch.length} swaps)
                </h3>
                {branch.map((token, tokenIndex) => (
                  <div key={tokenIndex} className="ml-4 mb-1 text-sm">
                    <span className="font-medium">Swap {tokenIndex + 1}:</span>{" "}
                    0.01 USDC → {token.slice(0, 8)}...{token.slice(-8)}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="border-t-2 border-gray-300 pt-4 space-y-4">
            <h2 className="text-lg font-semibold">Settings</h2>

            <div>
              <label
                htmlFor="slippageBps"
                className="block text-sm font-medium mb-2"
              >
                Slippage (bps) - Applied to all swaps
              </label>
              <input
                id="slippageBps"
                type="text"
                value={slippageBps}
                onChange={(e) => setSlippageBps(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-600"
                placeholder="50"
              />
            </div>

            <div>
              <label
                htmlFor="jitoTip"
                className="block text-sm font-medium mb-2"
              >
                Jito Tip per bundle (lamports)
              </label>
              <input
                id="jitoTip"
                type="text"
                value={jitoTip}
                onChange={(e) => setJitoTip(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-600"
                placeholder="10000"
              />
              <p className="text-xs text-gray-500 mt-1">
                Recommended: 10000-100000 lamports (0.00001-0.0001 SOL). Each
                bundle gets its own tip.
              </p>
            </div>

            <button
              type="button"
              onClick={handleMultiSwap}
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {loading
                ? "Processing..."
                : `Execute ${totalSwaps} Swaps (${estimatedBundles} bundle${estimatedBundles > 1 ? "s" : ""})`}
            </button>
          </div>

          {status && (
            <div className="p-3 bg-blue-100 text-blue-800 rounded-lg">
              {status}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-100 text-red-800 rounded-lg">
              {error}
            </div>
          )}
        </div>
      )}

      {!publicKey && (
        <p className="text-center text-gray-600 mt-4">
          Please connect your wallet to start swapping
        </p>
      )}
    </div>
  );
}
