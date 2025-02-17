import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import agentRouter from "./controllers/agent.js";
import authRouter from "./controllers/auth.js";
import { notifyAgentCreation } from "./helpers/socket.js";
import { InternalRequestError } from "./utils/errors.js";

const app = express();
const server = createServer(app);
export const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(import.meta.dirname + "/../public"));

app.use("/api/auth", authRouter);
app.use("/api/agent", agentRouter);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = "Internal Server Error";
  if (err instanceof InternalRequestError) {
    status = err.status;
    message = err.message;
  }

  res.status(status).json({ error: message });
});

io.on("connection", (socket) => {
  console.log("a user connected");
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

server.listen(8080, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

setInterval(() => {
  const rand = Math.random();
  const ids = [1, 66];
  const agentId = ids[Math.floor(Math.random() * ids.length)];
  notifyAgentCreation(agentId);
}, 5000);
