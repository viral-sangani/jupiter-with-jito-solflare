import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Common Solana program IDs
const PROGRAM_NAMES: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget Program",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "Jupiter V6",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Whirlpool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
};

function getProgramName(programId: string): string {
  return PROGRAM_NAMES[programId] || "Unknown Program";
}

export function logDecodedTransactionServer(
  serializedTx: string,
  label: string = "Transaction",
): void {
  try {
    const buffer = Buffer.from(serializedTx, "base64");
    const tx = VersionedTransaction.deserialize(buffer);

    const message = tx.message;

    // Extract account keys
    let accountKeys: string[] = [];
    if ("staticAccountKeys" in message) {
      accountKeys = message.staticAccountKeys.map((key) => key.toString());
    } else if ("accountKeys" in message) {
      accountKeys = message.accountKeys.map((key) => key.toString());
    }

    console.log(`\n📝 ${label}`);
    console.log(`Instructions (${message.compiledInstructions.length}):`);

    message.compiledInstructions.forEach((instruction, i) => {
      const programId = accountKeys[instruction.programIdIndex];
      const programName = getProgramName(programId);
      const dataHex = Buffer.from(instruction.data).toString("hex");
      const dataLength = instruction.data.length;

      // Decode compute budget instructions
      let decodedInfo = "";
      if (programId === "ComputeBudget111111111111111111111111111111") {
        if (dataHex.startsWith("00")) {
          // Request heap frame
          const units = instruction.data.readUInt32LE(1);
          decodedInfo = ` → RequestHeapFrame(${units} bytes)`;
        } else if (dataHex.startsWith("01")) {
          // Set compute unit limit
          const units = instruction.data.readUInt32LE(1);
          decodedInfo = ` → SetComputeUnitLimit(${units} units)`;
        } else if (dataHex.startsWith("02")) {
          // Set compute unit price
          const microLamports = instruction.data.readBigUInt64LE(1);
          decodedInfo = ` → SetComputeUnitPrice(${microLamports} microlamports)`;
        } else if (dataHex.startsWith("03")) {
          // Set loaded accounts data size limit
          const bytes = instruction.data.readUInt32LE(1);
          decodedInfo = ` → SetLoadedAccountsDataSizeLimit(${bytes} bytes)`;
        }
      }

      console.log(
        `  ${i + 1}. ${programName}${decodedInfo}`,
      );
      console.log(`     Program: ${programId}`);
      console.log(`     Data: ${dataHex.slice(0, 64)}${dataLength > 32 ? "..." : ""} (${dataLength} bytes)`);
    });
    console.log("");
  } catch (error) {
    console.error(`Failed to decode transaction:`, error);
  }
}
