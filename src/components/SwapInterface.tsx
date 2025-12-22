"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { useState } from "react";
import { logDecodedTransaction } from "@/utils/decodeTransaction";

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

export default function SwapInterface() {
  const { publicKey, signAllTransactions } = useWallet();
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

      // Flatten all transactions for signing
      const allTransactionStrings: string[] = bundles.flat();

      // Deserialize all transactions
      const allTransactions = allTransactionStrings.map((txString) => {
        const buffer = Buffer.from(txString, "base64");
        return VersionedTransaction.deserialize(buffer);
      });

      // Sign all transactions at once
      const signedTransactions = await signAllTransactions(allTransactions);

      console.log(`\n🔍 Wallet: ${publicKey.wallet?.adapter.name || "Unknown"}\n`);

      // Group signed transactions back into bundles
      let txIndex = 0;
      const signedBundles: string[][] = [];
      for (let bundleIdx = 0; bundleIdx < bundles.length; bundleIdx++) {
        const bundle = bundles[bundleIdx];
        const signedBundle = signedTransactions.slice(
          txIndex,
          txIndex + bundle.length,
        );
        // Serialize the signed transactions
        const serializedBundle = signedBundle.map((tx, txIdx) => {
          const serialized = Buffer.from(tx.serialize()).toString("base64");

          // Log first transaction of each bundle for inspection
          if (txIdx === 0) {
            logDecodedTransaction(
              serialized,
              `Bundle ${bundleIdx + 1}, Transaction ${txIdx + 1} (Swap)`,
            );
          }
          // Log tip transaction (last in each bundle)
          if (txIdx === signedBundle.length - 1) {
            logDecodedTransaction(
              serialized,
              `Bundle ${bundleIdx + 1}, Transaction ${txIdx + 1} (Jito Tip)`,
            );
          }

          return serialized;
        });
        signedBundles.push(serializedBundle);
        txIndex += bundle.length;
      }

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

      if (!submitResponse.ok) {
        const errorData = await submitResponse.json();
        throw new Error(errorData.error || "Failed to submit bundles");
      }

      const submitData = await submitResponse.json();

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
  const estimatedBundles = Math.ceil(totalSwaps / (MAX_TXS_PER_BUNDLE - 1));

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
              {estimatedBundles > 1 ? "s" : ""} (max {MAX_TXS_PER_BUNDLE} txs
              per bundle)
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
