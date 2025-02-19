import { Comment, PriceHistory } from "../db/models.js";
import { getAgentById, getAgents } from "../db/repositories.js";
import {
  getLastSignature,
  getPriceHistory,
} from "../db/repositories/priceHistory.js";
import { getBucketedData } from "../solana/dexscreener.js";
import { getHistoricalTransactionData } from "../solana/market.js";
import { getTokenMarketData } from "../solana/token.js";
import { logger } from "../utils/logger.js";

interface HistoricPrice {
  time: number;
  price: number;
}
export async function getAgentResponse(id: number, expanded = false) {
  const agent = await getAgentById(id);

  if (!agent) {
    return null;
  }

  const marketData = await getTokenMarketData(agent.mint);

  const response = {
    id: agent.id,
    name: agent.name,
    mint: agent.mint,
    ticker: agent.ticker,
    owner: agent.owner,
    photo: agent.image_url,
    bio: agent.bio,
    twitter: agent.tw_handle,
    telegram: agent.telegram,
    volume: {},
    history: [] as HistoricPrice[],
    comments: [] as Comment[],
    ...(marketData[agent.mint] || {}),
  };

  if (expanded) {
    const history: Record<number, PriceHistory[]> = {};
    const agentHistory = await getPriceHistory(agent.id, 1000);
    agentHistory.forEach((agentHistory) => {
      if (!history[agentHistory.blockTime]) {
        history[agentHistory.blockTime] = [];
      }
      history[agentHistory.blockTime].push(agentHistory);
    });

    const flattendHistory = Object.entries(history).map(([time, prices]) => {
      return {
        time: parseInt(time),
        price:
          prices.reduce((acc, price) => {
            let paresedPrice = parseFloat(price.price);
            if (isNaN(paresedPrice)) {
              return acc;
            }
            return acc + paresedPrice;
          }, 0) ?? 0,
      };
    });

    response.history = flattendHistory.sort((a, b) => a.time - b.time);
    response.history = flattendHistory;

    response.comments = agent.comments.map((comment) => comment.toJSON());
    response.volume = (await getBucketedData([agent.mint]))[agent.mint];
  }

  return response;
}

export async function syncAgentTransactionHistory() {
  const agents = await getAgents();
  for (const agent of agents) {
    const lastSignature = await getLastSignature(agent.id);
    const history = await getHistoricalTransactionData(
      agent.mint,
      lastSignature
    );
    for (const item of history) {
      await PriceHistory.create({
        price: "" + item.price,
        blockTime: item.date,
        agentId: agent.id,
        signature: item.signature,
      });
    }

    logger.info(
      `Found ${history.length} historical transactions for ${agent.mint}`
    );
  }
}
