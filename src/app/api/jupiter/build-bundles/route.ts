import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const JUPITER_ULTRA_BASE_URL = "https://api.jup.ag/ultra/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

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

    // Fetch quotes for each branch separately
    const bundles: string[][] = [];
    let totalSwaps = 0;
    let recentBlockhash = "";

    for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
      const branch = branches[branchIdx];

      if (!Array.isArray(branch) || branch.length === 0) {
        return NextResponse.json(
          { error: `Branch ${branchIdx + 1} is empty or invalid` },
          { status: 400 },
        );
      }

      console.log(`[Build] Processing branch ${branchIdx + 1} with ${branch.length} swaps`);

      // Fetch all quotes for this branch in parallel
      const branchQuotePromises = branch.map((outputMint: string) => {
        const params = new URLSearchParams({
          inputMint,
          outputMint,
          amount: amount.toString(),
          taker: userPublicKey,
          // excludeRouters: "okx,dflow",
          excludeRouters: "iris,dflow,jupiterz",
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

      const branchQuoteResponses = await Promise.all(branchQuotePromises);

      // Check for errors and parse responses for this branch
      const branchQuotesData = [];
      for (let i = 0; i < branchQuoteResponses.length; i++) {
        if (!branchQuoteResponses[i].ok) {
          const error = await branchQuoteResponses[i].text();
          return NextResponse.json(
            {
              error: `Failed to get quote for branch ${branchIdx + 1}, swap ${i + 1}`,
              details: error,
            },
            { status: branchQuoteResponses[i].status },
          );
        }

        const orderData = await branchQuoteResponses[i].json();

        const router = (orderData as any)?.router;
        console.log(router, ">>>>>>")

        if (orderData.errorCode !== undefined && orderData.errorCode !== 0) {
          return NextResponse.json(
            {
              error: `Jupiter Ultra API error for branch ${branchIdx + 1}, swap ${i + 1}`,
              errorCode: orderData.errorCode,
              errorMessage: orderData.errorMessage,
            },
            { status: 400 },
          );
        }

        if (!orderData.transaction || orderData.transaction === "") {
          return NextResponse.json(
            {
              error: `Jupiter Ultra returned empty transaction for branch ${branchIdx + 1}, swap ${i + 1}`,
            },
            { status: 400 },
          );
        }

        branchQuotesData.push(orderData);
      }

      // Deserialize swap transactions and fetch address lookup tables
      const connection = new Connection(SOLANA_RPC_URL);

      // First pass: deserialize all transactions and collect unique ALT addresses
      const deserializedTxs = branchQuotesData.map((quoteData) => {
        const buffer = Buffer.from(quoteData.transaction, "base64");
        return VersionedTransaction.deserialize(buffer);
      });

      // Collect all unique address lookup table addresses
      const altAddresses = new Set<string>();
      for (const tx of deserializedTxs) {
        for (const lookup of tx.message.addressTableLookups) {
          altAddresses.add(lookup.accountKey.toBase58());
        }
      }

      // Fetch all address lookup tables
      const altAccountsMap = new Map<string, AddressLookupTableAccount>();
      if (altAddresses.size > 0) {
        const altPublicKeys = Array.from(altAddresses).map(addr => new PublicKey(addr));
        const altAccountInfos = await connection.getMultipleAccountsInfo(altPublicKeys);

        altPublicKeys.forEach((pubkey, index) => {
          const accountInfo = altAccountInfos[index];
          if (accountInfo) {
            const alt = new AddressLookupTableAccount({
              key: pubkey,
              state: AddressLookupTableAccount.deserialize(accountInfo.data),
            });
            altAccountsMap.set(pubkey.toBase58(), alt);
          }
        });
      }

      // Second pass: add compute budget instructions to each transaction
      const branchSwapTransactions: VersionedTransaction[] = deserializedTxs.map(
        (tx) => {
          // Resolve address lookup tables for this transaction
          const lookupTableAccounts = tx.message.addressTableLookups.map(
            (lookup) => altAccountsMap.get(lookup.accountKey.toBase58())!
          ).filter(Boolean);

          // Decompile with resolved lookup tables
          const message = TransactionMessage.decompile(tx.message, {
            addressLookupTableAccounts: lookupTableAccounts,
          });

          // Add compute budget instructions
          const computeUnitLimit = ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_400_000,
          });
          const computeUnitPrice = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 1_000_000,
          });

          message.instructions = [
            computeUnitLimit,
            computeUnitPrice,
            ...message.instructions,
          ];

          // Recompile with the same lookup tables
          const newMessage = message.compileToV0Message(lookupTableAccounts);
          return new VersionedTransaction(newMessage);
        },
      );

      // Get recent blockhash from the first swap transaction (same for all)
      if (branchIdx === 0) {
        recentBlockhash = branchSwapTransactions[0].message.recentBlockhash;
      }

      // Create tip transaction for this branch's bundle
      const randomTipAccount =
        JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

      const tipInstruction = SystemProgram.transfer({
        fromPubkey: new PublicKey(userPublicKey),
        toPubkey: new PublicKey(randomTipAccount),
        lamports: Number(jitoTip || 100000),
      });

      const tipMessage = new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash,
        instructions: [tipInstruction],
      }).compileToV0Message();

      const tipTransaction = new VersionedTransaction(tipMessage);

      // Create bundle for this branch (all swaps + tip)
      const bundleTransactions = [
        ...branchSwapTransactions.map((tx) =>
          Buffer.from(tx.serialize()).toString("base64")
        ),
        Buffer.from(tipTransaction.serialize()).toString("base64"),
      ];

      bundles.push(bundleTransactions);
      totalSwaps += branch.length;

      console.log(`[Build] Branch ${branchIdx + 1} bundle created: ${branch.length} swaps + 1 tip = ${bundleTransactions.length} txs`);
    }

    console.log(`[Build] Created ${bundles.length} bundles for ${totalSwaps} total swaps`);

    return NextResponse.json({
      bundles,
      totalSwaps,
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
