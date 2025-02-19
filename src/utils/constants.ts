import { PublicKey } from "@solana/web3.js";

export const DATABASE_HOST = process.env.DATABASE_HOST || "";
export const DATABASE_NAME = process.env.DATABASE_NAME || "";
export const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || "";
export const DATABASE_PORT = process.env.DATABASE_PORT || "";
export const DATABASE_USER = process.env.DATABASE_USER || "";

export const SOLANA_RPC_URL =
  "https://palpable-flashy-water.solana-mainnet.quiknode.pro/a24d45a88242df8cc4f32c8070df47b66e287c25";
export const SOLANA_WSS_URL =
  "wss://palpable-flashy-water.solana-mainnet.quiknode.pro/a24d45a88242df8cc4f32c8070df47b66e287c25";
export const CUBIE_AGENT_FEE = 0.05;

export const JWT_SECRET = process.env.JWT_SECRET || "";

export const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const CUBIE_FEE_ACCOUNT = new PublicKey(
  "EKRo46r9hTkSgRdcGBTXWvkJTpF94DGb9tbtQUVvHH9S"
);

export const MAIAR_RUNNER_SERVICE =
  process.env.MAIAR_RUNNER_SERVICE || "http://localhost:8081";

export const DISABLE_LAUNCH = process.env.DISABLE_LAUNCH === "true";
