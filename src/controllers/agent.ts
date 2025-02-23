import { Router } from "express";
import { getAgentByIdAndOwner, getAgents } from "../db/repositories.js";
import { InternalValidationError } from "../utils/errors.js";

import { Keypair } from "@solana/web3.js";
import multer from "multer";
import { Agent, AgentInfo } from "../db/models.js";
import { getAgentResponse } from "../helpers/agent.js";
import { getAgentFee } from "../helpers/agentFee.js";
import { checkAuth } from "../middleware/auth.js";
import { getBucketedData } from "../solana/dexscreener.js";
import {
  createTokenMetadata,
  getCreateAndBuyTransaction,
} from "../solana/pumpfun.js";
import { getTokenMarketData } from "../solana/token.js";
import { pollFeeAccount } from "../solana/transactionListener.js";
import { DISABLE_LAUNCH } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { launchSchema } from "../validators/launch.js";
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
});

const router = Router();

router.get("/", async (req, res, next) => {
  const { order = "", filter = "" } = req.query || {};

  if (typeof order !== "string" || typeof filter !== "string") {
    return next(new InternalValidationError("Invalid query parameters"));
  }
  const agents = await getAgents();
  if (!agents || !agents.length) {
    res.status(200).json([]);
  } else {
    const mints = agents.map((agent) => agent.mint);
    const marketData = await getTokenMarketData(mints);
    const volume = await getBucketedData(mints);
    const response = agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      mint: agent.mint,
      owner: agent.owner,
      photo: agent.image_url,
      bio: agent.bio,
      twitter: agent.tw_handle,
      telegram: agent.telegram,
      ticker: agent.ticker,
      ...(marketData[agent.mint] || {}),
      volume: volume[agent.mint],
    }));
    res.status(200).json(response);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return next(new InternalValidationError("Invalid agent ID"));
  }

  const response = await getAgentResponse(id, true);
  if (!response) {
    return next(new InternalValidationError("Agent not found"));
  }

  res.status(200).json(response);
});

router.post(
  "/launch",
  checkAuth,
  upload.single("image"),
  async (req, res, next) => {
    if (DISABLE_LAUNCH) {
      return next(
        new InternalValidationError(
          "Launchpad is going live Feb 19 @ 12PM PST/3PM EST"
        )
      );
    }
    const owner = req.address;

    if (!owner) {
      return next(new InternalValidationError("Sign in to launch an agent"));
    }
    const { success, data, error } = await launchSchema.safeParseAsync(
      req.body
    );
    if (!success) {
      const messages = error?.errors.map((error) => error.message).join(", ");
      return next(new InternalValidationError(messages));
    }

    logger.info(
      `Creating agent for owner ${owner} with name ${data.name} and ticker ${data.ticker} and ${data.twitterConfig?.email} and ${data.telegramConfig?.botToken}`
    );
    const {
      name,
      ticker,
      bio,
      api,
      twitterConfig,
      telegramConfig,
      knowledge,
      style,
      twitterStyle,
      telegramStyle,
      devBuy,
    } = data;

    let agentBio = `${bio}\nLaunched on $CUBIE (https://cubie.fun)`;
    if (!req.file || !req.file.buffer || !req.file.mimetype) {
      return next(new InternalValidationError("Image is required"));
    }

    if (!twitterConfig && !telegramConfig) {
      return next(
        new InternalValidationError("Enable at least one social media platform")
      );
    }
    const agentInfo: AgentInfo[] = [];

    knowledge.forEach((data: string) => {
      agentInfo.push(AgentInfo.build({ type: "knowledge", data }));
    });
    style.forEach((data: string) => {
      agentInfo.push(AgentInfo.build({ type: "style", data }));
    });
    twitterStyle.forEach((data: string) => {
      agentInfo.push(AgentInfo.build({ type: "twitter_style", data }));
    });
    telegramStyle.forEach((data: string) => {
      agentInfo.push(AgentInfo.build({ type: "telegram_style", data }));
    });

    const mint = Keypair.generate();
    const userFeeAccount = Keypair.generate();

    const agentFee = await getAgentFee();
    // For now we assume it is a fixed sol amount to launch an agent
    pollFeeAccount(userFeeAccount.publicKey, agentFee);

    let xConfig = {};
    if (twitterConfig) {
      xConfig = {
        tw_email: twitterConfig.email,
        tw_password: twitterConfig.password,
        tw_handle: twitterConfig.username,
      };
    }

    let tgConfig = {};
    if (telegramConfig) {
      tgConfig = {
        telegram_bot_token: telegramConfig.botToken,
        telegram: telegramConfig.username,
      };
    }

    const agentData = {
      name,
      ticker,
      bio: agentBio,
      api,
      owner,
      mint: mint.publicKey.toBase58(),
      status: "pending",
      feeAccountPublicKey: userFeeAccount.publicKey.toBase58(),
      feeAccountPrivateKey: Buffer.from(userFeeAccount.secretKey).toString(
        "base64"
      ),
      ...xConfig,
      ...tgConfig,
      private_key: Buffer.from(Keypair.generate().secretKey).toString("base64"),
    } as Agent;

    const tokenMetadata = await createTokenMetadata(
      name,
      ticker,
      agentBio,
      req.file.buffer,
      req.file.mimetype,
      twitterConfig?.username,
      telegramConfig?.username
    );

    agentData.image_url = tokenMetadata.imageUri;
    const agent = Agent.build({ ...agentData });

    logger.info("Saving agent");
    await agent.save();
    for (const info of agentInfo) {
      info.agentId = agent.id;
      await info.save();
    }
    logger.info("Agent saved");

    const transaction = await getCreateAndBuyTransaction(
      owner,
      tokenMetadata,
      mint,
      devBuy,
      userFeeAccount.publicKey,
      agentFee
    );

    if (!transaction) {
      return next(new InternalValidationError("Failed to create agent"));
    }
    transaction?.sign([mint]);
    res.status(200).json({
      id: agent.id,
      mint: mint.publicKey.toBase58(),
      transaction: Buffer.from(transaction.serialize()).toString("base64"),
    });
  }
);

router.put("/:id", checkAuth, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const data = req.body;
  const agent = await getAgentByIdAndOwner(id, req.address);

  if (!agent) {
    return next(new InternalValidationError("Agent not found"));
  }

  await Agent.update(data, {
    where: { id },
  });

  res.status(200).json({ status: agent.status });
});

export default router;
