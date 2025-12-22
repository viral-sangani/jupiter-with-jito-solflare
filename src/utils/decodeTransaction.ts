import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export interface DecodedInstruction {
  programId: string;
  programName?: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
  dataHex: string;
}

export interface DecodedTransaction {
  signatures: string[];
  recentBlockhash: string;
  feePayer: string;
  numInstructions: number;
  instructions: DecodedInstruction[];
  accountKeys: string[];
}

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
  // Add more as needed
};

function getProgramName(programId: string): string {
  return PROGRAM_NAMES[programId] || "Unknown Program";
}

export function decodeTransaction(
  serializedTx: string,
): DecodedTransaction {
  const buffer = Buffer.from(serializedTx, "base64");
  const tx = VersionedTransaction.deserialize(buffer);

  const message = tx.message;
  const signatures = tx.signatures.map((sig) => bs58.encode(sig));

  // Extract account keys
  let accountKeys: string[] = [];
  if ("staticAccountKeys" in message) {
    accountKeys = message.staticAccountKeys.map((key) => key.toString());
  } else if ("accountKeys" in message) {
    accountKeys = message.accountKeys.map((key) => key.toString());
  }

  const feePayer = accountKeys[0] || "Unknown";
  const recentBlockhash = message.recentBlockhash;

  // Decode instructions
  const compiledInstructions = message.compiledInstructions;
  const instructions: DecodedInstruction[] = compiledInstructions.map(
    (instruction) => {
      const programId = accountKeys[instruction.programIdIndex];
      const programName = getProgramName(programId);

      // Get account indices and map to actual pubkeys
      const accounts = instruction.accountKeyIndexes.map((index) => {
        const pubkey = accountKeys[index];
        // Determine if signer/writable based on message header
        const isSigner = index < message.header.numRequiredSignatures;
        const isWritable =
          index <
          message.header.numRequiredSignatures -
            message.header.numReadonlySignedAccounts ||
          (index >= message.header.numRequiredSignatures &&
            index <
              accountKeys.length -
                message.header.numReadonlyUnsignedAccounts);

        return {
          pubkey,
          isSigner,
          isWritable,
        };
      });

      const data = bs58.encode(instruction.data);
      const dataHex = Buffer.from(instruction.data).toString("hex");

      return {
        programId,
        programName,
        accounts,
        data,
        dataHex,
      };
    },
  );

  return {
    signatures,
    recentBlockhash,
    feePayer,
    numInstructions: instructions.length,
    instructions,
    accountKeys,
  };
}

export function logDecodedTransaction(
  serializedTx: string,
  label: string = "Transaction",
): void {
  try {
    const decoded = decodeTransaction(serializedTx);

    console.log(`\n📝 ${label}`);
    console.log(`Instructions (${decoded.numInstructions}):`);

    decoded.instructions.forEach((instruction, i) => {
      const dataLength = instruction.dataHex.length / 2;

      // Decode compute budget instructions
      let decodedInfo = "";
      if (instruction.programId === "ComputeBudget111111111111111111111111111111") {
        if (instruction.dataHex.startsWith("00")) {
          const units = Number.parseInt(instruction.dataHex.slice(2, 10), 16);
          decodedInfo = ` → RequestHeapFrame(${units} bytes)`;
        } else if (instruction.dataHex.startsWith("01")) {
          const units = Number.parseInt(instruction.dataHex.slice(2, 10), 16);
          decodedInfo = ` → SetComputeUnitLimit(${units} units)`;
        } else if (instruction.dataHex.startsWith("02")) {
          const microLamports = BigInt(`0x${instruction.dataHex.slice(2, 18)}`);
          decodedInfo = ` → SetComputeUnitPrice(${microLamports} microlamports)`;
        } else if (instruction.dataHex.startsWith("03")) {
          const bytes = Number.parseInt(instruction.dataHex.slice(2, 10), 16);
          decodedInfo = ` → SetLoadedAccountsDataSizeLimit(${bytes} bytes)`;
        }
      }

      console.log(`  ${i + 1}. ${instruction.programName}${decodedInfo}`);
      console.log(`     Program: ${instruction.programId}`);
      console.log(
        `     Data: ${instruction.dataHex.slice(0, 64)}${dataLength > 32 ? "..." : ""} (${dataLength} bytes)`,
      );
    });
    console.log("");
  } catch (error) {
    console.error(`Failed to decode transaction:`, error);
  }
}

export function compareTransactions(
  tx1: string,
  tx2: string,
  label1: string = "Transaction 1",
  label2: string = "Transaction 2",
): void {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔍 COMPARING TRANSACTIONS`);
  console.log(`${"=".repeat(80)}\n`);

  try {
    const decoded1 = decodeTransaction(tx1);
    const decoded2 = decodeTransaction(tx2);

    console.log(`${label1}:`);
    console.log(`  Instructions: ${decoded1.numInstructions}`);
    console.log(
      `  Programs: ${decoded1.instructions.map((i) => i.programName).join(", ")}`,
    );

    console.log(`\n${label2}:`);
    console.log(`  Instructions: ${decoded2.numInstructions}`);
    console.log(
      `  Programs: ${decoded2.instructions.map((i) => i.programName).join(", ")}`,
    );

    if (decoded1.numInstructions !== decoded2.numInstructions) {
      console.log(
        `\n⚠️  DIFFERENCE: Number of instructions differ (${decoded1.numInstructions} vs ${decoded2.numInstructions})`,
      );
    }

    // Compare each instruction
    const maxInstructions = Math.max(
      decoded1.numInstructions,
      decoded2.numInstructions,
    );
    for (let i = 0; i < maxInstructions; i++) {
      const inst1 = decoded1.instructions[i];
      const inst2 = decoded2.instructions[i];

      if (!inst1 || !inst2) {
        console.log(
          `\n⚠️  Instruction #${i + 1}: Only exists in ${!inst1 ? label2 : label1}`,
        );
        continue;
      }

      if (inst1.programId !== inst2.programId) {
        console.log(`\n⚠️  Instruction #${i + 1}: Different programs`);
        console.log(`  ${label1}: ${inst1.programName} (${inst1.programId})`);
        console.log(`  ${label2}: ${inst2.programName} (${inst2.programId})`);
      }

      if (inst1.dataHex !== inst2.dataHex) {
        console.log(
          `\n⚠️  Instruction #${i + 1}: Different instruction data`,
        );
        console.log(`  ${label1} data: ${inst1.dataHex}`);
        console.log(`  ${label2} data: ${inst2.dataHex}`);
      }
    }

    console.log(`\n${"=".repeat(80)}\n`);
  } catch (error) {
    console.error(`Failed to compare transactions:`, error);
  }
}
