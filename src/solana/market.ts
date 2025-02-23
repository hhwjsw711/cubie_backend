import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  ConfirmedSignatureInfo,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { PUMPFUN_PROGRAM } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { raydium, solanaConnection } from "./connection.js";

export async function getHistoricalTransactionData(
  mint: string,
  lastSignature: string
) {
  return await getTokenPoolInfo(mint, lastSignature);
}

export async function getAllTransactionsUntilLastSignature(
  mint: PublicKey,
  lastSignature?: string
) {
  const params = {
    ...(lastSignature && { until: lastSignature }),
  };
  const allSignatures = [];

  let current = await solanaConnection.getSignaturesForAddress(mint, params);
  allSignatures.push(...current);
  while (current.length > 0) {
    current = await solanaConnection.getSignaturesForAddress(mint, {
      ...params,
      before: current[current.length - 1].signature,
    });

    allSignatures.push(...current);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return allSignatures;
}

// Get pool address for a given mint. Returns raydium pool address if available, otherwise returns pumpfun bonding curve pool address
export async function getPoolInfo(mint: string) {
  let poolInfo = await raydium.api.fetchPoolByMints({
    mint1: mint,
    mint2: NATIVE_MINT,
  });

  let poolAddress: PublicKey;
  if (!poolInfo || poolInfo.data.length === 0) {
    poolAddress = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMPFUN_PROGRAM)
    )[0];
  } else {
    poolAddress = new PublicKey(poolInfo.data[0].id);
  }

  return poolAddress;
}

export async function getTokenPoolInfo(mint: string, lastSignature?: string) {
  const poolPublicKey = await getPoolInfo(mint);

  const transactions = (
    await getAllTransactionsUntilLastSignature(poolPublicKey, lastSignature)
  ).slice(0, 5000);

  const successfullTransactions = transactions.filter(
    (transaction) => transaction.err === null
  );

  const BATCH_SIZE = 100;
  const batches = [];
  for (let i = 0; i < successfullTransactions.length; i += BATCH_SIZE) {
    batches.push(successfullTransactions.slice(i, i + BATCH_SIZE));
  }

  let priceHistory: ParsedTokenHistory[] = [];
  for (const batch of batches) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    priceHistory.push(...(await processTransactionBatch(batch, mint)));
  }

  return priceHistory;
}

async function getTransactionsWithRetries(batch: ConfirmedSignatureInfo[]) {
  let retries = 0;
  let transactions: ParsedTransactionWithMeta[] = [];
  while (retries < 5) {
    try {
      const tx = await solanaConnection.getParsedTransactions(
        batch.map((transaction) => transaction.signature),
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }
      );
      if (tx) {
        tx.forEach((transaction) => {
          if (transaction) {
            transactions.push(transaction);
          }
        });
      }
      break;
    } catch (error) {
      logger.error(`Error fetching transactions: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    retries++;
  }
  return transactions;
}

async function processTransactionBatch(
  batch: ConfirmedSignatureInfo[],
  mint: string
) {
  const parsedTransactions = await getTransactionsWithRetries(batch);

  let priceHistory: ParsedTokenHistory[] = [];
  if (parsedTransactions.length > 0) {
    parsedTransactions.forEach((tx) => {
      if (!tx) return;
      const priceForAccounts = computeTokenPrice(tx, mint);
      if (priceForAccounts) priceHistory.push(...priceForAccounts);
    });
  }
  NATIVE_MINT;

  return priceHistory;
}

interface ParsedTokenHistory {
  signature: string;
  mint: string;
  type: string;
  owner: string;
  preTokenBalance: number;
  postTokenBalance: number;
  preSolBalance: number;
  postSolBalance: number;
  price: number;
  date: number;
}

function computeTokenPrice(
  parsedTranstion: ParsedTransactionWithMeta,
  mint: string
) {
  const preTokenBalances = parsedTranstion?.meta?.preTokenBalances;
  const postTokenBalances = parsedTranstion?.meta?.postTokenBalances;
  const preBalances = parsedTranstion?.meta?.preBalances;
  const postBalances = parsedTranstion?.meta?.postBalances;
  const fee = parsedTranstion?.meta?.fee || 0;

  if (
    !preTokenBalances ||
    !postTokenBalances ||
    !preBalances ||
    !postBalances ||
    !parsedTranstion.blockTime
  ) {
    return;
  }
  const signers: { key: string; index: number }[] = [];

  parsedTranstion?.transaction.message.accountKeys.forEach((key, index) => {
    if (key.signer) {
      signers.push({ key: key.pubkey.toBase58(), index });
    }
  });

  const accountIndexes: ParsedTokenHistory[] = [];
  signers.forEach((signer) => {
    const preTokenBalance =
      Number(
        preTokenBalances?.find(
          (preTokenBalance) =>
            preTokenBalance.owner === signer.key &&
            preTokenBalance.mint === mint
        )?.uiTokenAmount.amount || 0
      ) / Math.pow(10, 6);
    const postTokenBalance =
      Number(
        postTokenBalances?.find(
          (postTokenBalance) =>
            postTokenBalance.owner === signer.key &&
            postTokenBalance.mint === mint
        )?.uiTokenAmount.amount || 0
      ) / Math.pow(10, 6);

    if (preTokenBalance === postTokenBalance || !parsedTranstion.blockTime) {
      return;
    }

    // PROPERLY : Parse the Instructions to find where the buy is happening on various programs
    // and compute the cost ....
    const instructions =
      parsedTranstion.transaction.message.instructions.filter((ins) =>
        ins.programId.equals(ComputeBudgetProgram.programId)
      ) as PartiallyDecodedInstruction[];

    let priorityFee = 0;
    if (instructions.length > 0) {
      let microLamports: BigInt | number = 0n;
      instructions.forEach((ins) => {
        const transactionInstruction = new TransactionInstruction({
          programId: ins.programId,
          keys: [],
          data: Buffer.from(bs58.decode(ins.data)),
        });
        const type = ComputeBudgetInstruction.decodeInstructionType(
          transactionInstruction
        );

        if (type === "SetComputeUnitPrice") {
          microLamports = ComputeBudgetInstruction.decodeSetComputeUnitPrice(
            transactionInstruction
          ).microLamports;
        }
      });
      const computeUsage = parsedTranstion.meta?.computeUnitsConsumed || 0;
      priorityFee = Math.floor((computeUsage * Number(microLamports)) / 1e6);
    }
    const preSolBalance = preBalances[signer.index] / LAMPORTS_PER_SOL;
    const postSolBalance =
      (postBalances[signer.index] + fee + priorityFee) / LAMPORTS_PER_SOL;

    let type = "buy";
    if (postTokenBalance < preTokenBalance) {
      type = "sell";
    }

    const price =
      Math.abs(preTokenBalance - postTokenBalance) /
      Math.abs(preSolBalance - postSolBalance);
    accountIndexes.push({
      signature: parsedTranstion.transaction.signatures[0],
      mint,
      date: parsedTranstion.blockTime,
      type,
      owner: signer.key,
      preTokenBalance,
      postTokenBalance,
      preSolBalance,
      postSolBalance,
      price: price && !isNaN(price) && isFinite(price) ? price : 0,
    });
  });

  return accountIndexes;
}
